/**
 * Reproducible AssemblyScript/Rust comparison against the built public API.
 *
 * node proofs/rust-migration-20261115/benchmark.mjs --pairs 7
 * Set RUSTC to the compiler used for the candidate build when it is not on PATH.
 * --baseline/--candidate accept checkout directories; --output selects JSON.
 * --only accepts comma-separated workload names for a focused diagnostic.
 *
 * Every baseline/candidate sample runs in its own fresh Node process. Pairs
 * alternate order. Each workload resets its writer; each cold read attaches a
 * fresh shared reader. Timing excludes setup, warmup, verification and hashing.
 * No benchmark claims that ordinary JS values, persistent writes, or explicit
 * materialization are allocation-free. Only shared-arena growth/writes are
 * checked directly; JS caches, view wrappers and result arrays still allocate.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const script = fileURLToPath(import.meta.url);
const defaultCandidate = resolve(dirname(script), '../..');
function arg(name, fallback) {
  const position = process.argv.indexOf(`--${name}`);
  return position < 0 ? fallback : process.argv[position + 1];
}
function integer(name, fallback, minimum, maximum) {
  const value = Number(arg(name, fallback));
  assert.ok(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Invalid --${name}`);
  return value;
}
const config = {
  count: integer('count', 10000, 1024, 100000),
  pairs: integer('pairs', 7, 5, 30),
  warmups: integer('warmups', 2, 0, 20),
  warmupCount: 1024,
  warmWorkingSet: 1024,
};
const only = new Set((arg('only', '') || '').split(',').filter(Boolean));
const workloads = [
  ...['map', 'list'].flatMap(collection => ['number', 'string'].flatMap(type => [
    { name: `${collection}.${type}.write.scalar`, collection, type, operation: 'write', bulk: false },
    { name: `${collection}.${type}.write.bulk`, collection, type, operation: 'write', bulk: true },
    { name: `${collection}.${type}.read.sequential`, collection, type, operation: 'read' },
  ])),
  { name: 'map.json.native.select.cold', collection: 'map', operation: 'json', mode: 'native' },
  { name: 'map.json.view.fields.select.cold', collection: 'map', operation: 'json', mode: 'fields' },
  { name: 'map.json.view.equals.select.cold', collection: 'map', operation: 'json', mode: 'equals' },
  { name: 'map.json.native.select.cached', collection: 'map', operation: 'json', mode: 'native', cached: true },
  { name: 'map.json.view.equals.select.repeated', collection: 'map', operation: 'json', mode: 'equals', cached: true },
  { name: 'map.json.view.materialize.mutable', collection: 'map', operation: 'json', mode: 'materialize' },
  { name: 'map.json.view.materialize.frozen', collection: 'map', operation: 'json', mode: 'materialize-frozen' },
  { name: 'list.json.native.select.cold', collection: 'list', operation: 'json', mode: 'native' },
  { name: 'list.json.view.equals.select.cold', collection: 'list', operation: 'json', mode: 'equals' },
  { name: 'list.json.native.select.cached', collection: 'list', operation: 'json', mode: 'native', cached: true },
  { name: 'list.json.view.equals.select.repeated', collection: 'list', operation: 'json', mode: 'equals', cached: true },
].filter(workload => !only.size || only.has(workload.name));
assert.ok(workloads.length > 0, 'No matching workloads');
for (const name of only) assert.ok(workloads.some(workload => workload.name === name), `Unknown workload: ${name}`);

function products(count) {
  const categories = ['books', 'home', 'tools', 'games'];
  return Array.from({ length: count }, (_, id) => ({
    id,
    name: `Product ${id} — 道路 🙂`,
    category: categories[id % categories.length],
    price: (1000 + (id * 37) % 39000) / 100,
    active: id % 11 !== 0,
    description: `Item ${id}: a reusable product description with a quoted \"label\", a newline\n, and Unicode café. `.repeat(3),
    tags: ['catalogue', categories[id % categories.length], `group-${id % 19}`],
    seller: { id: id % 97, name: `Seller ${id % 97}`, rating: 3 + (id % 20) / 10 },
    dimensions: { width: 10 + id % 30, height: 20 + id % 17, depth: 5 + id % 11, unit: 'cm' },
    history: Array.from({ length: 4 }, (_, index) => ({ day: index, stock: (id + index) % 43, available: (id + index) % 5 !== 0 })),
  }));
}
function matches(product) { return product.category === 'books' && product.active && product.price < 125; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function arenaState(lib, data, includeDigest = false) {
  const payload = lib.getWorkerData({ data }, { copy: false });
  const arenas = payload.arenas.map(arena => {
    assert.ok(arena.memory instanceof WebAssembly.Memory, 'Benchmark requires a shared-memory attachment');
    assert.equal(arena.copy, undefined, 'A copied attachment would change the workload');
    return {
      usedBytes: arena.used,
      capacityBytes: arena.memory.buffer.byteLength,
      ...(includeDigest ? { sha256: hash(new Uint8Array(arena.memory.buffer, 0, arena.used)) } : {}),
    };
  });
  return { usedBytes: arenas.reduce((sum, arena) => sum + arena.usedBytes, 0),
    capacityBytes: arenas.reduce((sum, arena) => sum + arena.capacityBytes, 0), arenas };
}
function reset(lib, collection) { (collection === 'map' ? lib.resetMap : lib.resetSharedList)(); }
function build(lib, collection, type, values, keys) {
  reset(lib, collection);
  return collection === 'map'
    ? new lib.SharedMap(type).setMany(values.map((value, index) => [keys[index], value]))
    : new lib.SharedList(type).pushMany(values);
}
async function attach(lib, writer) {
  return (await lib.initWorker(lib.getWorkerData({ data: writer }, { copy: false }))).data;
}
function selectNative(data, selectors) {
  const ids = [];
  for (let i = 0; i < selectors.length; i++) {
    const value = data.get(selectors[i]);
    if (matches(value)) ids.push(value.id);
  }
  return ids;
}
function selectFields(data, selectors) {
  const ids = [];
  for (let i = 0; i < selectors.length; i++) {
    const value = data.getView(selectors[i]);
    if (value.get('category') === 'books' && value.get('active') && value.get('price') < 125) ids.push(value.get('id'));
  }
  return ids;
}
function selectEquals(data, selectors) {
  const ids = [];
  for (let i = 0; i < selectors.length; i++) {
    const value = data.getView(selectors[i]);
    if (value.equals('category', 'books') && value.get('active') && value.get('price') < 125) ids.push(value.get('id'));
  }
  return ids;
}
function materializeNative(data, selectors) {
  const values = new Array(selectors.length);
  for (let i = 0; i < selectors.length; i++) values[i] = data.get(selectors[i]);
  return values;
}
function materializeView(data, selectors) {
  const values = new Array(selectors.length);
  for (let i = 0; i < selectors.length; i++) values[i] = data.getView(selectors[i]).toObject();
  return values;
}
function materializeFrozenView(data, selectors) {
  const values = new Array(selectors.length);
  for (let i = 0; i < selectors.length; i++) values[i] = data.getView(selectors[i]).toObject({ freeze: true });
  return values;
}
async function trial(lib, variant, workload, count, measured) {
  const recordCount = workload.cached ? Math.min(config.warmWorkingSet, count) : count;
  const keys = Array.from({ length: recordCount }, (_, index) => `product/${index}`);
  if (workload.operation === 'write') {
    const values = Array.from({ length: count }, (_, index) => workload.type === 'number' ? index * 1.25 : `value-${index}-道路`);
    const entries = workload.collection === 'map' ? values.map((value, index) => [keys[index], value]) : undefined;
    reset(lib, workload.collection);
    let result = workload.collection === 'map' ? new lib.SharedMap(workload.type) : new lib.SharedList(workload.type);
    const before = arenaState(lib, result);
    if (measured) global.gc?.();
    const start = performance.now();
    if (workload.bulk) result = workload.collection === 'map' ? result.setMany(entries) : result.pushMany(values);
    else if (workload.collection === 'map') for (let i = 0; i < count; i++) result = result.set(keys[i], values[i]);
    else for (let i = 0; i < count; i++) result = result.push(values[i]);
    const elapsedMs = performance.now() - start;
    const after = arenaState(lib, result);
    assert.equal(result.size, count);
    const actual = new Array(count);
    for (let i = 0; i < count; i++) actual[i] = result.get(workload.collection === 'map' ? keys[i] : i);
    assert.deepEqual(actual, values, `${variant} ${workload.name}`);
    return { elapsedMs, operations: count, records: count, reader: false,
      arenaBefore: before, arenaAfter: after, arenaAllocationDeltaBytes: after.usedBytes - before.usedBytes };
  }
  const values = workload.operation === 'json' ? products(recordCount)
    : Array.from({ length: recordCount }, (_, index) => workload.type === 'number' ? index * 1.25 : `value-${index}-道路`);
  const type = workload.operation === 'json' ? 'object' : workload.type;
  const writer = build(lib, workload.collection, type, values, keys);
  const reader = await attach(lib, writer);
  const selectors = Array.from({ length: count }, (_, index) => workload.collection === 'map' ? keys[index % recordCount] : index % recordCount);
  let run = materializeNative;
  let mode = 'get';
  if (workload.operation === 'json') {
    run = selectNative;
    if (workload.mode.startsWith('materialize')) run = materializeNative;
    if (variant === 'rust') {
      if (workload.mode === 'fields') { run = selectFields; mode = 'getView/get'; }
      if (workload.mode === 'equals') { run = selectEquals; mode = 'getView/equals'; }
      if (workload.mode === 'materialize') { run = materializeView; mode = 'getView/toObject mutable'; }
      if (workload.mode === 'materialize-frozen') { run = materializeFrozenView; mode = 'getView/toObject frozen'; }
    }
  }
  const materializes = workload.operation !== 'json' || workload.mode.startsWith('materialize');
  const expected = materializes
    ? Array.from({ length: count }, (_, index) => values[index % recordCount])
    : Array.from({ length: count }, (_, index) => values[index % recordCount]).filter(matches).map(product => product.id);
  // Warm native JSON reads stay within the actual 2048-record / 2-MiB cache.
  // A repeated view query has no decoded-object cache; it is labelled separately.
  if (workload.cached) assert.deepEqual(run(reader, selectors), expected);
  if (measured) global.gc?.();
  const before = arenaState(lib, reader, measured);
  const start = performance.now();
  const actual = run(reader, selectors);
  const elapsedMs = performance.now() - start;
  const after = arenaState(lib, reader, measured);
  assert.deepEqual(after, before, 'A reader changed shared storage or allocated in the arena');
  assert.deepEqual(actual, expected, `${variant} ${workload.name}`);
  if (workload.mode?.startsWith('materialize')) {
    const frozen = variant === 'assemblyscript' || workload.mode === 'materialize-frozen';
    assert.equal(Object.isFrozen(actual[0]), frozen);
    assert.equal(Object.isFrozen(actual[0].seller), frozen);
  }
  return { elapsedMs, operations: count, records: recordCount, reader: true, mode,
    resultCount: actual.length, arenaBefore: before, arenaAfter: after, arenaAllocationDeltaBytes: 0,
    ...(workload.operation === 'json' ? { jsonPayloadBytes: values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0) } : {}) };
}

if (process.argv.includes('--worker')) {
  const variant = arg('variant'), checkout = resolve(arg('checkout'));
  assert.ok(variant === 'assemblyscript' || variant === 'rust');
  const lib = await import(pathToFileURL(resolve(checkout, 'dist/shared.js')).href);
  if (variant === 'rust') assert.equal(typeof lib.SharedMap.prototype.getView, 'function', 'Build the candidate public bundle first');
  const rows = [];
  const rotation = integer('rotation', 0, 0, 1000000) % workloads.length;
  const order = [...workloads.slice(rotation), ...workloads.slice(0, rotation)];
  for (const workload of order) {
    for (let i = 0; i < config.warmups; i++) await trial(lib, variant, workload, config.warmupCount, false);
    rows.push({ name: workload.name, ...await trial(lib, variant, workload, config.count, true) });
  }
  process.stdout.write(JSON.stringify({ variant, runtime: process.versions, gcExposed: typeof global.gc === 'function', rows }));
} else {
  const baseline = resolve(arg('baseline', resolve(defaultCandidate, '../zerocopy-rust-baseline')));
  const candidate = resolve(arg('candidate', defaultCandidate));
  const output = resolve(arg('output', resolve(dirname(script), 'results.json')));
  mkdirSync(dirname(output), { recursive: true });
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const command = (program, args, cwd) => {
    try { return execFileSync(program, args, { cwd, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch (error) { return { unavailable: true, error: error.message }; }
  };
  function compilationSources(checkout) {
    // Include all production root TS/AS sources, not merely the modules used
    // by one workload, plus the Rust crate and both build pipelines.
    const names = readdirSync(checkout).filter(name => name.endsWith('.ts')
      && !name.endsWith('.test.ts') && !name.startsWith('vitest.') && !name.startsWith('benchmark'));
    names.push(...['package.json', 'bun.lock', 'asconfig.json', 'rust-toolchain.toml',
      'scripts/build-wasm.mjs', 'scripts/build-browser.ts', 'scripts/rust-wasm.mjs',
      'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/wasm-abi.json'].filter(name => existsSync(resolve(checkout, name))));
    function visit(directory) {
      for (const entry of readdirSync(resolve(checkout, directory), { withFileTypes: true })) {
        const name = `${directory}/${entry.name}`;
        if (entry.isDirectory()) visit(name);
        else if (entry.name.endsWith('.rs')) names.push(name);
      }
    }
    if (existsSync(resolve(checkout, 'rust/src'))) visit('rust/src');
    const files = [...new Set(names)].sort().map(file => {
      const bytes = readFileSync(resolve(checkout, file));
      return { file, bytes: bytes.length, sha256: hash(bytes) };
    });
    return { sha256: hash(Buffer.from(files.map(file => `${file.file}\0${file.sha256}\n`).join(''))), files };
  }
  function payload(checkout) {
    const seen = new Set(), files = [], embeddedWasm = [];
    function visit(path) {
      if (seen.has(path)) return; seen.add(path);
      const bytes = readFileSync(path), source = bytes.toString('utf8');
      files.push({ file: relative(checkout, path), bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length, sha256: hash(bytes) });
      for (const match of source.matchAll(/\batob\((["'])([A-Za-z0-9+/=]+)\1\)/g)) {
        const module = Buffer.from(match[2], 'base64');
        if (module.length >= 8 && module.readUInt32LE(0) === 0x6d736100) embeddedWasm.push({
          source: relative(checkout, path), bytes: module.length, gzipBytes: gzipSync(module, { level: 9 }).length, sha256: hash(module),
        });
      }
      for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)(["'])(\.{1,2}\/[^"']+)\1/g)) {
        if (/\.m?js$/.test(match[2])) visit(resolve(dirname(path), match[2]));
      }
    }
    visit(resolve(checkout, 'dist/shared.js'));
    files.sort((a, b) => a.file.localeCompare(b.file));
    const wasm = ['persistent-core', 'numeric-kernels', 'numeric-kernels-simd', 'geometry-kernels'].map(name => {
      const bytes = readFileSync(resolve(checkout, `${name}.wasm`));
      return { file: `${name}.wasm`, bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length, sha256: hash(bytes) };
    });
    const packageJson = JSON.parse(readFileSync(resolve(checkout, 'package.json'), 'utf8'));
    assert.ok(embeddedWasm.some(module => module.sha256 === wasm[0].sha256),
      'The public bundle must embed the current persistent-core.wasm; rebuild the browser bundle after Wasm');
    return { commit: command('git', ['rev-parse', 'HEAD'], checkout),
      changes: command('git', ['status', '--short'], checkout),
      packageVersion: packageJson.version, wasm, embeddedWasm, compilationSources: compilationSources(checkout),
      sharedEntryReachableJs: { bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0), files },
      buildScript: readFileSync(resolve(checkout, 'scripts/build-wasm.mjs'), 'utf8'),
      ...(existsSync(resolve(checkout, 'rust/Cargo.toml')) ? {
        cargoManifest: readFileSync(resolve(checkout, 'rust/Cargo.toml'), 'utf8'),
        rustToolchain: readFileSync(resolve(checkout, 'rust-toolchain.toml'), 'utf8'),
      } : { assemblyScript: packageJson.devDependencies.assemblyscript }),
    };
  }
  const report = {
    schema: 'zerocopy-rust-migration-benchmark/v1', complete: false, startedAt: new Date().toISOString(),
    benchmarkSha256: hash(readFileSync(script)),
    config: { ...config, workloads, baseline, candidate, freshProcessPerVariantPerPair: true,
      sampleOrder: 'Alternate AssemblyScript/Rust and Rust/AssemblyScript; rotate workload order each pair',
      timing: 'One measured trial after per-workload warmups; setup, reader attachment, GC, correctness and byte hashes outside timing' },
    machine: { platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), loadAtStart: loadavg() },
    runtime: process.versions,
    compiler: { rust: command(process.env.RUSTC || 'rustc', ['--version', '--verbose'], candidate),
      assemblyscript: command(process.execPath, ['node_modules/assemblyscript/bin/asc.js', '--version'], baseline) },
    variants: { assemblyscript: payload(baseline), rust: payload(candidate) },
    notes: [
      'Native rows compare existing get() behavior between compilers without JSON API/schema changes.',
      'View rows compare the same query or full materialized values. Baseline uses get(); Rust uses the named opt-in view API.',
      'Cold JSON scans visit 10,000 distinct products by default; every scan starts with a new attached reader and no decoded cache.',
      'Cached/repeated rows perform 10,000 reads over 1,024 records by default. Native objects fit the bounded JSON cache; views still scan shared bytes.',
      'Product fixtures contain decimal prices, Unicode, escaped description text, arrays and nested objects. Selected scalar fields appear before the larger description/nested fields.',
      'Mutable materialization intentionally omits the deep freeze of legacy get(); the frozen materialization control preserves it.',
      'All correctness checks compare every returned value or exact matching product IDs. Hashes check the complete used shared-memory prefix before and after reads.',
      'A zero arena-allocation delta excludes JS wrappers, decoded values, caches, result arrays and runtime-internal allocations. Persistent writes intentionally allocate new records.',
      'JS payload sizes include every statically reachable chunk of dist/shared.js, which already embeds core Wasm; do not add the raw core size to that payload total.',
      'The built JS payload is snapshotted once before sampling, with its recorded hashes checked. Rebuilding either checkout during sampling cannot mix different bundles into one report.',
      'This is a Node/V8 benchmark of these fixtures; it does not establish browser-engine performance or universal migration speedups.',
    ], samples: [],
  };
  const snapshotRoot = mkdtempSync(resolve(tmpdir(), 'zerocopy-rust-benchmark-'));
  process.once('exit', () => rmSync(snapshotRoot, { recursive: true, force: true }));
  const snapshots = {};
  for (const [variant, checkout] of Object.entries({ assemblyscript: baseline, rust: candidate })) {
    const snapshot = resolve(snapshotRoot, variant);
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(resolve(snapshot, 'package.json'), '{"type":"module"}\n');
    for (const file of report.variants[variant].sharedEntryReachableJs.files) {
      const bytes = readFileSync(resolve(checkout, file.file));
      assert.equal(hash(bytes), file.sha256, 'Bundle changed while taking the benchmark snapshot; rerun after the build finishes');
      mkdirSync(dirname(resolve(snapshot, file.file)), { recursive: true });
      writeFileSync(resolve(snapshot, file.file), bytes);
    }
    snapshots[variant] = snapshot;
  }
  const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  save();
  for (let pair = 0; pair < config.pairs; pair++) {
    const order = pair % 2 ? ['rust', 'assemblyscript'] : ['assemblyscript', 'rust'];
    for (const variant of order) {
      const args = ['--expose-gc', script, '--worker', '--variant', variant, '--checkout', snapshots[variant],
        '--count', String(config.count), '--pairs', String(config.pairs), '--warmups', String(config.warmups), '--rotation', String(pair)];
      if (only.size) args.push('--only', [...only].join(','));
      const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 }));
      report.samples.push({ pair, order: order.indexOf(variant), ...result }); save();
      process.stderr.write(`Pair ${pair + 1}/${config.pairs}: ${variant} complete\n`);
    }
  }
  report.summary = workloads.map(workload => {
    const rows = Object.fromEntries(['assemblyscript', 'rust'].map(variant => [variant,
      report.samples.filter(sample => sample.variant === variant).map(sample => sample.rows.find(row => row.name === workload.name))]));
    const baselineTimes = rows.assemblyscript.map(row => row.elapsedMs), rustTimes = rows.rust.map(row => row.elapsedMs);
    const pairedRatios = rustTimes.map((elapsed, index) => elapsed / baselineTimes[index]);
    const baselineMedianMs = median(baselineTimes), rustMedianMs = median(rustTimes);
    return { name: workload.name, baselineMedianMs, rustMedianMs, rustVsBaselineRatio: rustMedianMs / baselineMedianMs,
      medianPairedRatio: median(pairedRatios), pairedRatios,
      samplesMs: { assemblyscript: baselineTimes, rust: rustTimes },
      baselineArenaAllocationBytes: rows.assemblyscript.map(row => row.arenaAllocationDeltaBytes),
      rustArenaAllocationBytes: rows.rust.map(row => row.arenaAllocationDeltaBytes),
      baselineArenaUsedBytes: rows.assemblyscript.map(row => row.arenaAfter.usedBytes),
      rustArenaUsedBytes: rows.rust.map(row => row.arenaAfter.usedBytes),
    };
  });
  report.complete = true; report.finishedAt = new Date().toISOString(); report.machine.loadAtEnd = loadavg(); save();
  console.table(report.summary.map(row => ({ workload: row.name, 'AS ms': +row.baselineMedianMs.toFixed(3),
    'Rust ms': +row.rustMedianMs.toFixed(3), 'Rust/AS': +row.rustVsBaselineRatio.toFixed(3) })));
  console.log(`Saved ${relative(process.cwd(), output)}`);
}
