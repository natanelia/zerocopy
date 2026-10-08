import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join, basename, relative } from 'node:path';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, cpSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

export const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
export const sha256 = text => createHash('sha256').update(text).digest('hex');

export function benchmarkConfig(defaultSamples = 21) {
  const number = (name, fallback, min = 1, max = 10000) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}: ${value}`);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const value = number(name, fallback, min, max);
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    return value;
  };
  const order = name => {
    const value = process.env[name] ?? 'alternating';
    if (!['alternating', 'baseline-first', 'candidate-first'].includes(value)) throw new Error(`Invalid ${name}: ${value}`);
    return value;
  };
  const mode = process.env.BENCH_MODE ?? 'ab';
  if (!['ab', 'aa-baseline', 'aa-candidate'].includes(mode)) throw new Error(`Invalid BENCH_MODE: ${mode}`);
  const caseClass = process.env.CASE_CLASS ?? 'all';
  if (!['all', 'target', 'control'].includes(caseClass)) throw new Error(`Invalid CASE_CLASS: ${caseClass}`);
  return {
    mode, rounds: integer('ROUNDS', 4, 1, 100), samples: integer('SAMPLES', defaultSamples, 2, 1000),
    targetBatchMs: number('TARGET_BATCH_MS', 10, 0.1, 1000),
    warmupMs: number('WARMUP_MS', 150, 0, 5000), warmupMinElements: integer('WARMUP_MIN_ELEMENTS', 1048576, 0, 100000000),
    maxWarmupMs: number('MAX_WARMUP_MS', 5000, 1, 30000),
    importOrder: order('IMPORT_ORDER'), warmOrder: order('WARM_ORDER'),
    orderOffset: integer('ORDER_OFFSET', 0, 0, 1000), caseFilter: process.env.CASE_FILTER ?? null, caseClass,
  };
}

export function workloadCounts(rows) {
  return { total: rows.length, targets: rows.filter(row => row.classification === 'target').length, controls: rows.filter(row => row.classification === 'control').length };
}

export function workloadCases(filter, caseClass = 'all') {
  if (!['all', 'target', 'control'].includes(caseClass)) throw new Error(`Invalid case class: ${caseClass}`);
  const cases = [];
  for (const size of [32, 4096]) for (const kind of ['ordered', 'ordered-updated', 'sorted', 'sorted-custom']) for (const type of ['number', 'object']) {
    for (const operation of ['keys', 'values', 'entries']) cases.push({ size, kind, type, operation, collection: 'map', name: `${kind}/${type}/${size}/${operation}` });
  }
  for (const size of [32, 4096]) for (const kind of ['ordered-set', 'sorted-set', 'sorted-set-custom']) for (const type of ['number', 'string']) {
    cases.push({ size, kind, type, operation: 'values', collection: 'set', name: `${kind}/${type}/${size}/values` });
  }
  // Only sorted projections changed. Ordered maps/sets, every entries()
  // workload, and comparator-backed values() remain regression controls.
  for (const row of cases) {
    const target = row.collection === 'set'
      ? row.kind === 'sorted-set' || row.kind === 'sorted-set-custom'
      : row.kind === 'sorted' && ['keys', 'values'].includes(row.operation)
        || row.kind === 'sorted-custom' && row.operation === 'keys';
    row.classification = target ? 'target' : 'control';
  }
  assert.deepEqual(workloadCounts(cases), { total: 60, targets: 20, controls: 40 });
  const selected = cases.filter(row => (caseClass === 'all' || row.classification === caseClass) && (!filter || new RegExp(filter).test(row.name)));
  if (!selected.length) throw new Error(`CASE_FILTER/CASE_CLASS selected no workloads: ${filter}/${caseClass}`);
  return selected;
}

export function roundOrders(round, config) {
  const pair = (mode, phase) => mode === 'candidate-first' || (mode === 'alternating' && phase % 2)
    ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
  const phase = round + config.orderOffset;
  return { importOrder: pair(config.importOrder, phase), warmOrder: pair(config.warmOrder, phase), sampleFirst: phase % 2 ? 'candidate' : 'baseline' };
}

// This self-contained function also runs in a fresh browser page via Playwright.
// It must not close over Node imports or helpers from this module.
export async function measureCase({ workload, paths, config, orders }) {
  const { size, kind, type, operation, collection } = workload;
  const variants = {}, fixtures = {};
  for (const variant of orders.importOrder) variants[variant] = await import(paths[variant]);
  for (const variant of orders.importOrder) {
    const S = variants[variant];
    S.resetOrderedMap(); S.resetSortedMap();
    if (collection === 'set') {
      let set = kind === 'ordered-set' ? new S.SharedOrderedSet()
        : new S.SharedSortedSet(kind === 'sorted-set-custom' ? (a, b) => b.localeCompare(a) : undefined);
      for (let i = 0; i < size; i++) set = set.add(type === 'number' ? i : `item-${i}`);
      fixtures[variant] = set;
    } else {
      let map = kind.startsWith('ordered') ? new S.SharedOrderedMap(type)
        : new S.SharedSortedMap(type, kind === 'sorted-custom' ? (a, b) => b.localeCompare(a) : undefined);
      for (let i = 0; i < size; i++) map = map.set(`key-${i}`, type === 'number' ? i : { i, text: 'Résumé 🙂 '.repeat(12), values: [i, i + 1, i + 2] });
      if (kind === 'ordered-updated') for (let i = 0; i < size; i += 8) {
        map = map.delete(`key-${i}`).set(`key-${i}`, type === 'number' ? -i : { i: -i, text: 'replacement' });
      }
      fixtures[variant] = map;
    }
  }
  // Validate only the operation being measured. Calling another projection here
  // would reintroduce unequal entry-generator warmup between the two builds.
  // The controlled fixtures include -0 after delete/reinsert; plain JSON
  // equality would silently treat it as +0. Tag non-JSON numeric values.
  const encode = iterator => JSON.stringify([...iterator], (_key, value) => typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value)) ? { projectionNumber: Object.is(value, -0) ? '-0' : String(value) } : value);
  const expectedJson = encode(fixtures.baseline[operation]());
  if (encode(fixtures.candidate[operation]()) !== expectedJson) throw new Error(`Projection differs: ${workload.name}`);
  const baselineFixture = fixtures.baseline, candidateFixture = fixtures.candidate;
  // Separate lexical functions (not closures from a shared factory) prevent
  // collection/method inline-cache feedback from mixing the two bundles.
  const scanBaseline = repeat => {
    let count = 0;
    for (let r = 0; r < repeat; r++) for (const value of baselineFixture[operation]()) if (value !== undefined) count++;
    return count;
  };
  const scanCandidate = repeat => {
    let count = 0;
    for (let r = 0; r < repeat; r++) for (const value of candidateFixture[operation]()) if (value !== undefined) count++;
    return count;
  };
  const timed = (variant, repeat) => {
    const scan = variant === 'baseline' ? scanBaseline : scanCandidate;
    const start = performance.now(), count = scan(repeat), elapsed = performance.now() - start;
    // Count assertions, fixture construction, and differential checks are untimed.
    if (count !== size * repeat) throw new Error(`Count mismatch: ${workload.name}/${variant}`);
    return elapsed;
  };
  const paired = (repeat, index) => {
    const result = {}, order = index % 2 ? [...orders.warmOrder].reverse() : orders.warmOrder;
    for (const variant of order) result[variant] = timed(variant, repeat);
    return { ...result, order };
  };
  const calibration = [], warmup = { baselineMs: 0, candidateMs: 0, pairs: 0, scansPerVariant: 0, capped: false, orders: [] };
  let repeat = size === 32 ? 128 : 2, pairIndex = 0;
  const calibrate = phase => {
    // A 25% margin reduces batches falling below the requested duration after
    // optimization. All calibration, warmup, and timed pairs use equal repeats.
    for (let attempt = 0; attempt < 16; attempt++) {
      const trials = [];
      for (let trial = 0; trial < 3; trial++) {
        const elapsed = paired(repeat, pairIndex++);
        calibration.push({ phase, attempt, trial, repeat, ...elapsed });
        trials.push(elapsed.baseline, elapsed.candidate);
      }
      // One descheduled/GC-stalled pair must not select an undersized batch.
      const faster = Math.min(...trials);
      if (faster >= config.targetBatchMs * 1.25) return;
      repeat = Math.ceil(repeat * Math.min(16, Math.max(1.1, config.targetBatchMs * 1.5 / Math.max(faster, 0.001))));
      if (repeat > 10000000) throw new Error(`Calibration repeat limit exceeded: ${workload.name}`);
    }
    throw new Error(`Could not calibrate: ${workload.name}`);
  };
  calibrate('initial');
  const warmupStart = performance.now();
  while (Math.min(warmup.baselineMs, warmup.candidateMs) < config.warmupMs || warmup.scansPerVariant * size < config.warmupMinElements) {
    if (performance.now() - warmupStart >= config.maxWarmupMs || warmup.pairs >= 128) { warmup.capped = true; break; }
    const elapsed = paired(repeat, pairIndex++);
    warmup.baselineMs += elapsed.baseline; warmup.candidateMs += elapsed.candidate;
    warmup.scansPerVariant += repeat; warmup.pairs++; warmup.orders.push(elapsed.order);
  }
  calibrate('post-warmup');
  const samples = { baseline: [], candidate: [] }, sampleOrders = [];
  for (let sample = 0; sample < config.samples; sample++) {
    const baselineFirst = (sample % 2 === 0) === (orders.sampleFirst === 'baseline');
    const order = baselineFirst ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    sampleOrders.push(order);
    for (const variant of order) samples[variant].push(timed(variant, repeat));
  }
  const belowTargetBatches = Object.fromEntries(Object.entries(samples).map(([variant, values]) => [variant, values.filter(ms => ms < config.targetBatchMs).length]));
  return { ...workload, repeat, samples, sampleOrders, orders, calibration, warmup, belowTargetBatches, expectedJson };
}

export function finishRow(row) {
  const { expectedJson, ...result } = row;
  return { ...result, digest: sha256(expectedJson) };
}

export function summarize(runs) {
  return runs[0].rows.map((first, index) => {
    for (const run of runs) {
      assert.equal(run.rows[index].name, first.name);
      assert.equal(run.rows[index].classification, first.classification);
      assert.equal(run.rows[index].digest, first.digest, first.name);
    }
    // Calibrated repeat counts can differ across fresh rounds. Normalize before
    // aggregation; never compare pooled durations representing unequal work.
    const before = runs.flatMap(run => run.rows[index].samples.baseline.map(ms => ms / run.rows[index].repeat));
    const after = runs.flatMap(run => run.rows[index].samples.candidate.map(ms => ms / run.rows[index].repeat));
    const spread = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { p10Ms: sorted[Math.floor(sorted.length * 0.1)], p90Ms: sorted[Math.floor(sorted.length * 0.9)] };
    };
    const roundSpeedups = runs.map(run => median(run.rows[index].samples.baseline) / median(run.rows[index].samples.candidate));
    return {
      name: first.name, classification: first.classification, digest: first.digest, baselineMs: median(before), candidateMs: median(after), speedup: median(roundSpeedups), pooledMedianRatio: median(before) / median(after),
      baselineSpread: spread(before), candidateSpread: spread(after),
      roundSpeedups,
      medianPairedSpeedup: median(before.map((ms, i) => ms / after[i])),
      belowTargetBatches: Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, runs.reduce((sum, run) => sum + run.rows[index].belowTargetBatches[variant], 0)])),
      warmupCappedRounds: runs.filter(run => run.rows[index].warmup.capped).length,
    };
  });
}

export function bundleManifest(entry) {
  const root = dirname(resolve(entry)), files = [];
  const walk = dir => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (/\.(js|wasm)$/.test(item.name)) files.push(path);
    }
  };
  walk(root);
  return Object.fromEntries(files.sort().map(path => [relative(root, path), sha256(readFileSync(path))]));
}

export function sourceManifest(entry) {
  const root = dirname(dirname(resolve(entry)));
  const files = readdirSync(root).filter(file => (file.endsWith('.ts') && !file.endsWith('.test.ts')) || ['package.json', 'bun.lock'].includes(file));
  files.push('scripts/build-wasm.mjs', 'scripts/build-browser.ts');
  return { root, files: Object.fromEntries(files.sort().map(file => [file, sha256(readFileSync(join(root, file)))])) };
}

export function prepareComparison(baseline, candidate, mode) {
  const sourcePaths = { baseline: resolve(baseline), candidate: resolve(candidate) };
  const measuredSourcePaths = mode === 'ab' ? { ...sourcePaths } : Object.fromEntries(['baseline', 'candidate'].map(name => [name, sourcePaths[mode === 'aa-baseline' ? 'baseline' : 'candidate']]));
  const sourceManifests = Object.fromEntries(Object.entries(measuredSourcePaths).map(([name, path]) => [name, sourceManifest(path)]));
  const sourceFiles = new Set([...Object.keys(sourceManifests.baseline.files), ...Object.keys(sourceManifests.candidate.files)]);
  const sourceDiff = [...sourceFiles].filter(file => file !== 'bun.lock' && sourceManifests.baseline.files[file] !== sourceManifests.candidate.files[file]).sort();
  const expectedSourceDiff = mode === 'ab' ? ['shared-sorted-map.ts'] : [];
  assert.deepEqual(sourceDiff, expectedSourceDiff, 'Sorted-only proof requires exactly shared-sorted-map.ts to differ for A/B, and identical sources for A/A');

  let temporary;
  const paths = { ...sourcePaths };
  if (mode !== 'ab') {
    // Copy the entire dist tree twice: changing only the shared.js URL can still
    // alias imported chunks, WASM globals, arenas, caches, and JIT state.
    temporary = mkdtempSync(join(os.tmpdir(), 'map-projection-control-'));
    const source = sourcePaths[mode === 'aa-baseline' ? 'baseline' : 'candidate'];
    for (const variant of ['baseline', 'candidate']) {
      const root = join(temporary, variant);
      cpSync(dirname(source), root, { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
      paths[variant] = join(root, basename(source));
    }
  } else if (realpathSync(dirname(paths.baseline)) === realpathSync(dirname(paths.candidate))) {
    throw new Error('A/B requires independent bundles; use BENCH_MODE=aa-baseline for a matched A/A control');
  }
  const manifests = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, bundleManifest(path)]));
  if (mode !== 'ab') assert.deepEqual(manifests.baseline, manifests.candidate, 'A/A bundle hashes differ');
  return { paths, sourcePaths, measuredSourcePaths, manifests, sourceManifests, sourceDiff, cleanup: () => { if (temporary) rmSync(temporary, { recursive: true, force: true }); } };
}

export const method = isolation => `Only natural-sorted keys/values, custom-sorted keys, and sorted-set projections are targets; all ordered APIs, entries, and custom-sorted values are controls. Each workload/operation has a fresh ${isolation} in every round, with independent baseline/candidate bundles. Only the measured operation is called before timing. Separate lexical scan functions keep baseline/candidate method-call feedback monomorphic; dispatch occurs outside the hot loops. Equal-scan calibration and warmup alternate order. Import/construction and initial warm/sample order are reversed across rounds by default and can be controlled independently. Repeats are calibrated using the minimum elapsed duration over three equal-work pairs for a target batch duration with a 25% margin, then held equal for both variants and fixed throughout measured samples. Warmup requires elapsed time on both sides and a minimum equal element count, with a recorded cap. Construction, full differential validation, and count assertions are outside timings. Raw batch milliseconds, repeats, all samples, order, calibration and warmup are retained; summaries use milliseconds per full scan because repeats can differ across rounds. Primary speedup is the median of per-round baseline/candidate median-duration ratios; pooled median ratios are retained separately and may differ under cross-round drift. Within-round samples are not independent process replicates. A/A modes use two byte-identical copies of the complete selected bundle. Every slowdown is retained. Shared-runner results are evidence, not universal guarantees.`;

async function main() {
  if (process.argv[2] === '--case') {
    const request = JSON.parse(process.argv[3]);
    console.log(JSON.stringify({ runtime: process.version, bun: process.versions.bun ?? null, row: finishRow(await measureCase(request)) }));
    return;
  }
  const [baseline, candidate, output = `proofs/results/map-projection-${Date.now()}.json`] = process.argv.slice(2);
  if (!baseline || !candidate) throw new Error('Usage: node proofs/map-projection-performance.mjs BASELINE/dist/shared.js CANDIDATE/dist/shared.js OUTPUT.json; env: BENCH_MODE=ab|aa-baseline|aa-candidate, CASE_FILTER, CASE_CLASS=all|target|control, ROUNDS, IMPORT_ORDER, WARM_ORDER, ORDER_OFFSET');
  const config = benchmarkConfig(), workloads = workloadCases(config.caseFilter, config.caseClass), comparison = prepareComparison(baseline, candidate, config.mode), runs = [];
  try {
    for (let round = 0; round < config.rounds; round++) {
      const orders = roundOrders(round, config), rows = [];
      for (const workload of workloads) {
        const request = { workload, paths: Object.fromEntries(Object.entries(comparison.paths).map(([name, path]) => [name, pathToFileURL(path).href])), config, orders };
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--case', JSON.stringify(request)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (child.status !== 0) throw new Error(`${workload.name}: ${child.stderr || child.stdout}`);
        rows.push(JSON.parse(child.stdout).row);
      }
      runs.push({ runtime: process.version, bun: process.versions.bun ?? null, round, orders, rows });
      console.log(`round ${round + 1}/${config.rounds}: ${rows.length} isolated workloads (${config.mode})`);
    }
    const summary = summarize(runs);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, JSON.stringify({
      schemaVersion: 2, date: new Date().toISOString(), runtime: process.version, bun: process.versions.bun ?? null,
      platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
      baseline: comparison.sourcePaths.baseline, candidate: comparison.sourcePaths.candidate,
      measuredSourcePaths: comparison.measuredSourcePaths, manifests: comparison.manifests, sourceManifests: comparison.sourceManifests, sourceDiff: comparison.sourceDiff, harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      config, workloadCounts: workloadCounts(workloads), rounds: config.rounds, samplesPerRound: config.samples, summaryTimingUnit: 'milliseconds per full scan', rawTimingUnit: 'milliseconds per batch',
      method: method('child process'), summary, runs,
    }, null, 2) + '\n');
    for (const row of summary) console.log(`${row.name.padEnd(46)} ${row.speedup.toFixed(2)}x (${row.baselineMs.toFixed(6)} -> ${row.candidateMs.toFixed(6)} ms/scan); rounds ${row.roundSpeedups.map(x => x.toFixed(2)).join(', ')}`);
  } finally { comparison.cleanup(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
