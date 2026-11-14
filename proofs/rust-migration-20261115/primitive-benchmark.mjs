/** Longer-batch diagnostic for the primitive flags in final-results.json.
 * The main benchmark is retained unchanged, including its recorded source hash.
 * node proofs/rust-migration-20261115/primitive-benchmark.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url), directory = dirname(script), checkout = resolve(directory, '../..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const config = { count: 10000, pairs: 9, warmupPasses: 32, preReservedBytes: 1048576, maximumArenaBytes: 4194304 };
const cases = [
  { name: 'map.number.write.bulk', collection: 'map', write: true, iterations: 64 },
  { name: 'map.number.read.fresh', collection: 'map', fresh: true, iterations: 64 },
  { name: 'map.number.read.cached', collection: 'map', fresh: false, iterations: 1024 },
  { name: 'list.number.read.fresh', collection: 'list', fresh: true, iterations: 1024 },
  { name: 'list.number.read.repeated', collection: 'list', fresh: false, iterations: 1024 },
];
const keys = Array.from({ length: config.count }, (_, index) => `product/${index}`);
const values = Array.from({ length: config.count }, (_, index) => index * 1.25);
const entries = values.map((value, index) => [keys[index], value]);
const expectedSum = values.reduce((sum, value) => sum + value, 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function sumMap(data) {
  let sum = 0;
  for (let i = 0; i < keys.length; i++) sum += data.get(keys[i]);
  return sum;
}
function sumList(data) {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += data.get(i);
  return sum;
}
function transport(lib, data) { return lib.getWorkerData({ data }, { copy: false }); }
async function reader(lib, payload) { return (await lib.initWorker(payload)).data; }
function state(lib, data) {
  const payload = transport(lib, data);
  assert.equal(payload.arenas.length, 1);
  const arena = payload.arenas[0];
  assert.ok(arena.memory instanceof WebAssembly.Memory);
  assert.equal(arena.copy, undefined);
  return { used: arena.used, capacity: arena.memory.buffer.byteLength, memory: arena.memory };
}
function emptyReservedMap(lib) {
  lib.resetMap();
  const data = new lib.SharedMap('number'), before = state(lib, data);
  const pages = (config.preReservedBytes - before.capacity) / 65536;
  if (pages > 0) before.memory.grow(pages);
  return data;
}
async function measure(lib, item) {
  if (item.write) {
    for (let i = 0; i < config.warmupPasses; i++) {
      const result = emptyReservedMap(lib).setMany(entries);
      assert.equal(result.size, config.count);
    }
    const empty = Array.from({ length: item.iterations }, () => emptyReservedMap(lib));
    const before = empty.map(data => state(lib, data));
    const results = new Array(item.iterations);
    global.gc();
    const start = performance.now();
    for (let i = 0; i < item.iterations; i++) results[i] = empty[i].setMany(entries);
    const elapsedMs = performance.now() - start;
    const allocation = [];
    for (let i = 0; i < results.length; i++) {
      const after = state(lib, results[i]);
      assert.equal(after.capacity, before[i].capacity, 'Bulk write grew memory inside the timed batch');
      allocation.push(after.used - before[i].used);
      assert.equal(results[i].size, config.count);
      let sum = 0, count = 0;
      for (const value of results[i].values()) { sum += value; count++; }
      assert.equal(count, config.count);
      assert.equal(sum, expectedSum);
    }
    assert.equal(new Set(allocation).size, 1);
    return { elapsedMs, millisecondsPer10000: elapsedMs / item.iterations,
      iterations: item.iterations, operations: item.iterations * config.count,
      arenaAllocationBytesPerBuild: allocation[0], grewMemoryDuringTiming: false };
  }
  let writer;
  if (item.collection === 'map') { lib.resetMap(); writer = new lib.SharedMap('number').setMany(entries); }
  else { lib.resetSharedList(); writer = new lib.SharedList('number').pushMany(values); }
  const payload = transport(lib, writer), sum = item.collection === 'map' ? sumMap : sumList;
  // Fresh-reader warmup trains the same uncached path without warming any
  // measured reader. Cached/repeated paths are deliberately separate cases.
  for (let i = 0; i < config.warmupPasses; i++) assert.equal(sum(await reader(lib, payload)), expectedSum);
  const readers = [];
  if (item.fresh) {
    for (let i = 0; i < item.iterations; i++) readers.push(await reader(lib, payload));
  } else {
    const sharedReader = await reader(lib, payload);
    for (let i = 0; i < config.warmupPasses; i++) assert.equal(sum(sharedReader), expectedSum);
    for (let i = 0; i < item.iterations; i++) readers.push(sharedReader);
  }
  const before = state(lib, readers[0]), digest = hash(new Uint8Array(before.memory.buffer, 0, before.used));
  global.gc();
  let checksum = 0;
  const start = performance.now();
  for (let i = 0; i < readers.length; i++) checksum += sum(readers[i]);
  const elapsedMs = performance.now() - start;
  assert.equal(checksum, expectedSum * item.iterations);
  for (const data of new Set(readers)) {
    const after = state(lib, data);
    assert.equal(after.used, before.used, 'A reader allocated shared bytes');
    assert.equal(after.capacity, before.capacity, 'A reader grew memory');
  }
  assert.equal(hash(new Uint8Array(before.memory.buffer, 0, before.used)), digest, 'A reader changed shared bytes');
  return { elapsedMs, millisecondsPer10000: elapsedMs / item.iterations,
    iterations: item.iterations, operations: item.iterations * config.count,
    freshReaderPerPass: item.fresh, arenaAllocationBytes: 0, grewMemoryDuringTiming: false,
    sharedBytesUnchanged: true, usedBytes: before.used, capacityBytes: before.capacity, checksum };
}

if (process.argv.includes('--worker')) {
  assert.equal(typeof global.gc, 'function', 'Run workers with --expose-gc');
  const lib = await import(pathToFileURL(resolve(option('checkout'), 'dist/shared.js')).href);
  lib.configureMemory({ maximumBytes: config.maximumArenaBytes });
  const rotation = Number(option('rotation', 0)) % cases.length;
  const order = [...cases.slice(rotation), ...cases.slice(0, rotation)];
  const rows = [];
  for (const item of order) rows.push({ name: item.name, ...await measure(lib, item) });
  for (const row of rows) assert.ok(row.elapsedMs >= 20, `${row.name} batch is too short (${row.elapsedMs} ms); increase its fixed iteration count`);
  process.stdout.write(JSON.stringify({ runtime: process.versions, rows }));
} else {
  const sourcePath = resolve(option('source-report', resolve(directory, 'final-results.json')));
  const sourceBytes = readFileSync(sourcePath), source = JSON.parse(sourceBytes);
  assert.equal(source.complete, true);
  const output = resolve(option('output', resolve(directory, 'primitive-results.json')));
  const temp = mkdtempSync(resolve(tmpdir(), 'zerocopy-primitives-'));
  process.once('exit', () => rmSync(temp, { recursive: true, force: true }));
  const snapshots = {};
  for (const variant of ['assemblyscript', 'rust']) {
    const original = variant === 'rust' ? source.config.candidate : source.config.baseline;
    const target = resolve(temp, variant);
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, 'package.json'), '{"type":"module"}\n');
    for (const file of source.variants[variant].sharedEntryReachableJs.files) {
      const bytes = readFileSync(resolve(original, file.file));
      assert.equal(hash(bytes), file.sha256, 'Primitive diagnostic must use the exact main-benchmark bundles');
      mkdirSync(dirname(resolve(target, file.file)), { recursive: true });
      writeFileSync(resolve(target, file.file), bytes);
    }
    snapshots[variant] = target;
  }
  const report = { schema: 'zerocopy-rust-primitive-diagnostic/v1', complete: false, startedAt: new Date().toISOString(),
    scriptSha256: hash(readFileSync(script)), sourceReport: sourcePath, sourceReportSha256: hash(sourceBytes),
    config: { ...config, cases, minimumTimedBatchMs: 20, isolatedProcesses: true, concurrentWorkers: 0 },
    compiler: source.compiler, runtime: process.versions, loadAtStart: loadavg(),
    bundles: Object.fromEntries(Object.entries(source.variants).map(([name, variant]) => [name, variant.sharedEntryReachableJs])),
    notes: [
      'Nine alternating baseline/Rust process pairs. Each worker runs only these numeric workloads, with separate map/list scan functions and 32 untimed warmup passes.',
      'Reported times are normalized per 10,000 operations from longer batches. Raw elapsed times and iteration counts are retained; every timed batch must exceed 20 ms.',
      'Bulk-map arenas reserve 1 MiB before timing; capacity is checked afterward so memory.grow cannot explain a timed build difference.',
      'Fresh reads use a new attached reader for each pass. Cached-map and repeated-list cases deliberately reuse a primed reader; their results are separate.',
      'All outputs are retained or summed and verified. Every read preserves the full used shared-memory prefix, arena used bytes and capacity.',
      'JS allocation and garbage collection inherent in uncached reads or bulk insertion remain part of the workload; this is not a pure Wasm microbenchmark.',
      'This uses exactly the bundled code recorded by the main benchmark; source-only whitespace changes afterward do not alter the measured code.',
    ], samples: [] };
  const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  save();
  for (let pair = 0; pair < config.pairs; pair++) {
    const order = pair % 2 ? ['rust', 'assemblyscript'] : ['assemblyscript', 'rust'];
    for (const variant of order) {
      const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', script, '--worker', '--checkout', snapshots[variant], '--rotation', String(pair)],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 }));
      report.samples.push({ pair, variant, ...result }); save();
      process.stderr.write(`Primitive pair ${pair + 1}/${config.pairs}: ${variant} complete\n`);
    }
  }
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[sorted.length >> 1]; };
  report.summary = cases.map(item => {
    const rows = Object.fromEntries(['assemblyscript', 'rust'].map(variant => [variant,
      report.samples.filter(sample => sample.variant === variant).map(sample => sample.rows.find(row => row.name === item.name))]));
    const baseline = rows.assemblyscript.map(row => row.millisecondsPer10000), rust = rows.rust.map(row => row.millisecondsPer10000);
    const pairedRatios = rust.map((value, index) => value / baseline[index]);
    const baselineMedianMs = median(baseline), rustMedianMs = median(rust);
    return { name: item.name, baselineMedianMs, rustMedianMs, rustVsBaselineRatio: rustMedianMs / baselineMedianMs,
      medianPairedRatio: median(pairedRatios), pairedRatios, pairsOver10Percent: pairedRatios.filter(value => value > 1.1).length,
      samplesMsPer10000: { assemblyscript: baseline, rust },
      timedBatchMs: { assemblyscript: rows.assemblyscript.map(row => row.elapsedMs), rust: rows.rust.map(row => row.elapsedMs) } };
  });
  report.complete = true; report.finishedAt = new Date().toISOString(); report.loadAtEnd = loadavg(); save();
  console.table(report.summary.map(row => ({ workload: row.name, 'AS ms/10k': +row.baselineMedianMs.toFixed(3),
    'Rust ms/10k': +row.rustMedianMs.toFixed(3), 'Rust/AS': +row.rustVsBaselineRatio.toFixed(3),
    'Paired median': +row.medianPairedRatio.toFixed(3), 'Pairs >10%': row.pairsOver10Percent + '/9' })));
  console.log(`Saved ${output}`);
}
