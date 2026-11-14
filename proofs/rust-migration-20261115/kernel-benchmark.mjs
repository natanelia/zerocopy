/**
 * Optional-kernel comparison; run only in the agreed idle benchmark window.
 *
 * node proofs/rust-migration-20261115/kernel-benchmark.mjs
 *   [--baseline CHECKOUT] [--candidate CHECKOUT] [--output NEW_JSON]
 *   [--count 262144] [--pairs 7] [--only comma,separated,case,names]
 *
 * Both engines import the SAME shared memory and use the SAME scalar JS call
 * wrappers. Input construction, module compilation, warmup and calibration are
 * outside recorded samples. Every call checks its result inside the timer;
 * geometry includes its four scalar getters. No timed payload copies, value
 * conversions, collection updates, freezing, or result-object allocation.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `Missing --${name} value`);
  return process.argv[index + 1];
}
const candidateRoot = resolve(arg('candidate', resolve(dirname(script), '../..')));
const baselineRoot = resolve(arg('baseline', resolve(candidateRoot, '../zerocopy-rust-baseline')));
const output = resolve(arg('output', resolve(dirname(script), 'kernel-results.json')));
assert.notEqual(baselineRoot, candidateRoot, 'Use separate AssemblyScript and Rust checkouts');
assert.ok(!existsSync(output), 'Use a new output filename; never replace a recorded measurement');
const count = Number(arg('count', '262144'));
const pairs = Number(arg('pairs', '7'));
assert.ok(Number.isSafeInteger(count) && count >= 32768 && count <= 1048576 && count % 32 === 0, '--count must be a multiple of 32 from 32768 through 1048576');
assert.ok(Number.isSafeInteger(pairs) && pairs >= 7 && pairs <= 21, '--pairs must be from 7 through 21');
const only = new Set(arg('only', '').split(',').filter(Boolean));
const minimumBatchMs = 10, targetBatchMs = 20, warmupMs = 75;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const numberJSON = value => Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0'
  : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value;
const gitHead = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const gitStatus = root => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trimEnd().split('\n').filter(Boolean);
const moduleFiles = ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'];
const roots = { assemblyscript: baselineRoot, rust: candidateRoot };
const modules = {}, moduleMetadata = {};
for (const [variant, root] of Object.entries(roots)) {
  modules[variant] = {}; moduleMetadata[variant] = {};
  for (const name of moduleFiles) {
    const bytes = readFileSync(resolve(root, name));
    modules[variant][name] = new WebAssembly.Module(bytes);
    moduleMetadata[variant][name] = { bytes: bytes.length, sha256: hash(bytes) };
  }
}

// One existing producer constructs each fixture once. All tested instances
// subsequently read exactly those bytes, including retained tails beside newer
// appended values. The fixture arrays are never used by a timed call.
const producer = await import(pathToFileURL(resolve(baselineRoot, 'dist/shared.js')));
producer.resetSharedList();
const retained = [], fixtureMetadata = [];
function fixture(name, values, list = new producer.SharedList('number').pushMany(values)) {
  assert.equal(list.size, values.length);
  retained.push(list);
  const descriptor = { root: list.root, depth: list.depth, tail: list.tail, size: list.size };
  const metadata = { name, ...descriptor, tailValues: list.size ? ((list.size - 1) & 31) + 1 : 0,
    nanValues: values.reduce((total, value) => total + Number.isNaN(value), 0) };
  fixtureMetadata.push(metadata);
  return { name, values, list, descriptor, metadata };
}
function ranges(size) {
  const values = new Array(size); let state = 0x7295a10f;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values[i] = i % 97 === 0 ? NaN : i % 257 === 0 ? Infinity : i % 263 === 0 ? -Infinity
      : i % 509 === 0 ? -0 : ((state >>> 8) & 65535) / 16 - 2048;
  }
  return values;
}
function coordinates(size) {
  assert.equal(size & 1, 0);
  const values = new Array(size); let state = 0xc28e3a51;
  for (let i = 0; i < size; i += 2) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = ((state >>> 8) & 65535) / 8 - 4096;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const y = ((state >>> 8) & 65535) / 8 - 4096;
    values[i] = i % 509 === 0 ? NaN : i % 1024 === 0 ? -0 : x;
    values[i + 1] = i % 521 === 0 ? NaN : i % 1024 === 0 ? 0 : y;
  }
  return values;
}
function rangeReference(values, lo, hi) {
  let result = 0;
  for (const value of values) result += value >= lo && value <= hi ? 1 : 0;
  return result;
}
function pointsReference(values, minX, minY, maxX, maxY) {
  let result = 0;
  for (let i = 0; i < values.length; i += 2) {
    result += values[i] >= minX && values[i] <= maxX && values[i + 1] >= minY && values[i + 1] <= maxY ? 1 : 0;
  }
  return result;
}
function boundsReference(values) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < values.length; i += 2) {
    const x = values[i], y = values[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

const rangeFull = fixture('range.full-tail', ranges(count));
const rangeTailValues = ranges(count + 1);
const rangeTail = fixture('range.one-value-tail', rangeTailValues, rangeFull.list.push(rangeTailValues[count]));
const rangeNewer = rangeTail.list.push(0);
assert.equal(rangeNewer.tail, rangeTail.list.tail, 'The retained odd tail must sit beside a newer matching value');
retained.push(rangeNewer); rangeTail.metadata.adjacentAppendedValues = 1;
const pointsFull = fixture('xy.full-tail', coordinates(count));
const pointsTailValues = coordinates(count + 2);
const pointsTail = fixture('xy.one-pair-tail', pointsTailValues, pointsFull.list.push(pointsTailValues[count]).push(pointsTailValues[count + 1]));
let pointsNewer = pointsTail.list;
for (const value of [0, 0, 1e12, -1e12]) pointsNewer = pointsNewer.push(value);
assert.equal(pointsNewer.tail, pointsTail.list.tail, 'The retained point tail must sit beside newer points');
retained.push(pointsNewer); pointsTail.metadata.adjacentAppendedValues = 4;

const rangeEdges = [0, 1, 2, 15, 16, 17, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 32767, 32768, 32769]
  .map(size => fixture(`range.edge.${size}`, Array.from({ length: size }, (_, i) => [NaN, -Infinity, -1, -0, 0, 1, Infinity][i % 7])));
const pointEdges = [0, 2, 30, 32, 34, 62, 64, 66, 1022, 1024, 1026, 32766, 32768, 32770]
  .map(size => fixture(`xy.edge.${size}`, Array.from({ length: size }, (_, i) => [NaN, 1, -0, 0, Infinity, -Infinity, -3, 4][i % 8])));
pointEdges.push(fixture('xy.signed-zero.first-negative', [-0, 0, 0, -0]));
pointEdges.push(fixture('xy.signed-zero.first-positive', [0, -0, -0, 0]));
pointEdges.push(fixture('xy.only-nan', [NaN, NaN, NaN, NaN]));
pointEdges.push(fixture('xy.nan-x', [NaN, -7, NaN, 4]));
pointEdges.push(fixture('xy.nan-y', [-7, NaN, 4, NaN]));
const oddPoints = fixture('xy.invalid-odd-size', [0, 1, 2]);
const transport = producer.getWorkerData({ list: rangeFull.list }, { copy: false });
assert.equal(transport.arenas.length, 1);
const arena = transport.arenas[0], memory = arena.memory;
assert.ok(memory instanceof WebAssembly.Memory && memory.buffer instanceof SharedArrayBuffer);
assert.equal(arena.copy, undefined, 'A copied input would invalidate the zero-copy kernel comparison');
const memoryBytes = memory.buffer.byteLength, usedBytes = arena.used;
const inputSHA256 = hash(new Uint8Array(memory.buffer, 0, usedBytes));
const kernels = Object.fromEntries(Object.entries(modules).map(([variant, group]) => [variant,
  Object.fromEntries(Object.entries(group).map(([name, module]) => [name, new WebAssembly.Instance(module, { env: { memory } }).exports]))]));

function checkedCall(kernel, kind, data, parameters, expected) {
  const { root, depth, tail, size } = data.descriptor;
  if (kind === 'range') {
    const invoke = kernel.countInRange, [lo, hi] = parameters;
    return () => {
      const actual = invoke(root, depth, tail, size, lo, hi);
      if (actual !== expected) throw new Error(`${data.name}: range count ${actual}, expected ${expected}`);
      return actual;
    };
  }
  if (kind === 'points') {
    const invoke = kernel.countPointsInBox, [minX, minY, maxX, maxY] = parameters;
    return () => {
      const actual = invoke(root, depth, tail, size, minX, minY, maxX, maxY);
      if (actual !== expected) throw new Error(`${data.name}: point count ${actual}, expected ${expected}`);
      return actual;
    };
  }
  const invoke = kernel.bboxXY, minX = kernel.bboxMinX, minY = kernel.bboxMinY, maxX = kernel.bboxMaxX, maxY = kernel.bboxMaxY;
  const [expectedMinX, expectedMinY, expectedMaxX, expectedMaxY] = expected;
  return () => {
    invoke(root, depth, tail, size);
    const x0 = minX(), y0 = minY(), x1 = maxX(), y1 = maxY();
    if (!Object.is(x0, expectedMinX) || !Object.is(y0, expectedMinY) || !Object.is(x1, expectedMaxX) || !Object.is(y1, expectedMaxY)) {
      throw new Error(`${data.name}: incorrect bounds, including signed-zero or NaN-axis handling`);
    }
    return x0;
  };
}

let correctnessCalls = 0;
for (const [variant, group] of Object.entries(kernels)) {
  const geometry = group['geometry-kernels.wasm'];
  assert.deepEqual([geometry.bboxMinX(), geometry.bboxMinY(), geometry.bboxMaxX(), geometry.bboxMaxY()],
    [Infinity, Infinity, -Infinity, -Infinity], `${variant}: initial instance globals`);
  for (const name of ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm']) {
    const kernel = group[name];
    for (const data of rangeEdges) for (const limits of [[-Infinity, Infinity], [-1, 1], [-0, 0], [3, -3], [NaN, 1], [-1, NaN]]) {
      checkedCall(kernel, 'range', data, limits, rangeReference(data.values, ...limits))(); correctnessCalls++;
    }
    for (const data of pointEdges) for (const limits of [[-Infinity, -Infinity, Infinity, Infinity], [-5, -5, 5, 5], [1, -1, -1, 1], [NaN, -1, 1, 1], [-1, -1, 1, NaN]]) {
      checkedCall(kernel, 'points', data, limits, pointsReference(data.values, ...limits))(); correctnessCalls++;
    }
    const d = oddPoints.descriptor;
    assert.throws(() => kernel.countPointsInBox(d.root, d.depth, d.tail, d.size, -Infinity, -Infinity, Infinity, Infinity), WebAssembly.RuntimeError);
    assert.throws(() => kernel.countPointsInBox(d.root, d.depth, d.tail, d.size, NaN, 0, 1, 1), WebAssembly.RuntimeError);
    correctnessCalls += 2;
  }
  for (const data of pointEdges) {
    checkedCall(geometry, 'bounds', data, [], boundsReference(data.values))(); correctnessCalls++;
  }
  const d = oddPoints.descriptor;
  assert.throws(() => geometry.bboxXY(d.root, d.depth, d.tail, d.size), WebAssembly.RuntimeError); correctnessCalls++;
}
const allCases = [];
function add(name, file, kind, data, parameters, expected) {
  allCases.push({ name, file, kind, data, parameters, expected });
}
for (const mode of ['scalar', 'simd']) {
  const file = mode === 'scalar' ? 'numeric-kernels.wasm' : 'numeric-kernels-simd.wasm';
  add(`range.${mode}.full`, file, 'range', rangeFull, [-Infinity, Infinity], rangeReference(rangeFull.values, -Infinity, Infinity));
  add(`range.${mode}.odd-tail`, file, 'range', rangeTail, [-250, 250], rangeReference(rangeTail.values, -250, 250));
  add(`points.${mode}.pair-tail`, file, 'points', pointsTail, [-2000, -1500, 2000, 1500], pointsReference(pointsTail.values, -2000, -1500, 2000, 1500));
}
add('bounds.full', 'geometry-kernels.wasm', 'bounds', pointsFull, [], boundsReference(pointsFull.values));
add('bounds.pair-tail', 'geometry-kernels.wasm', 'bounds', pointsTail, [], boundsReference(pointsTail.values));
for (const name of only) assert.ok(allCases.some(spec => spec.name === name), `Unknown --only case: ${name}`);
const cases = allCases.filter(spec => !only.size || only.has(spec.name)).map(spec => ({ ...spec,
  runs: Object.fromEntries(Object.entries(kernels).map(([variant, group]) => [variant, checkedCall(group[spec.file], spec.kind, spec.data, spec.parameters, spec.expected)])),
  samples: [], warmups: {}, calibration: [], iterations: 1,
}));
assert.ok(cases.length);
let sink = 0;
function batch(run, iterations) {
  let result = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) result += run();
  const elapsedMs = performance.now() - start;
  sink += result;
  return elapsedMs;
}
function warm(run) {
  let calls = 0, elapsedMs = 0;
  while (elapsedMs < warmupMs || calls < 32) { elapsedMs += batch(run, 16); calls += 16; }
  return { calls, elapsedMs };
}
function calibrate(spec) {
  let iterations = 1;
  for (let attempt = 0; attempt < 12; attempt++) {
    const assemblyscriptMs = batch(spec.runs.assemblyscript, iterations), rustMs = batch(spec.runs.rust, iterations);
    spec.calibration.push({ iterations, assemblyscriptMs, rustMs });
    const fastest = Math.min(assemblyscriptMs, rustMs);
    if (fastest >= 15) return iterations;
    iterations = Math.min(100000, Math.max(iterations + 1, Math.ceil(iterations * targetBatchMs / Math.max(fastest, 0.01))));
  }
  throw new Error(`${spec.name}: could not calibrate a long enough batch`);
}
for (let index = 0; index < cases.length; index++) {
  const spec = cases[index];
  for (const variant of index % 2 ? ['rust', 'assemblyscript'] : ['assemblyscript', 'rust']) {
    spec.warmups[variant] = warm(spec.runs[variant]);
  }
  spec.iterations = calibrate(spec);
}
const startedAt = new Date().toISOString(), loadBefore = loadavg();
for (let pair = 0; pair < pairs; pair++) {
  const order = pair % 2 ? [...cases].reverse() : cases;
  for (const spec of order) {
    const index = cases.indexOf(spec);
    const variants = (pair + index) % 2 ? ['rust', 'assemblyscript'] : ['assemblyscript', 'rust'];
    const elapsedMs = {};
    for (const variant of variants) elapsedMs[variant] = batch(spec.runs[variant], spec.iterations);
    spec.samples.push({ pair: pair + 1, order: variants, iterations: spec.iterations, elapsedMs,
      millisecondsPerCall: { assemblyscript: elapsedMs.assemblyscript / spec.iterations, rust: elapsedMs.rust / spec.iterations },
      rustOverAssemblyScript: elapsedMs.rust / elapsedMs.assemblyscript,
      shortBatch: Math.min(elapsedMs.assemblyscript, elapsedMs.rust) < minimumBatchMs });
  }
}
assert.equal(memory.buffer.byteLength, memoryBytes, 'A read kernel grew the input memory');
assert.equal(hash(new Uint8Array(memory.buffer, 0, usedBytes)), inputSHA256, 'A kernel changed shared input or scratch bytes');
for (const [variant, root] of Object.entries(roots)) for (const file of moduleFiles) {
  assert.equal(hash(readFileSync(resolve(root, file))), moduleMetadata[variant][file].sha256, `${variant}/${file}: module changed during measurement`);
}
const summary = cases.map(spec => {
  const ratios = spec.samples.map(sample => sample.rustOverAssemblyScript);
  const assemblyscriptMs = median(spec.samples.map(sample => sample.millisecondsPerCall.assemblyscript));
  const rustMs = median(spec.samples.map(sample => sample.millisecondsPerCall.rust));
  const pairedRatio = median(ratios), slowerPairs = ratios.filter(ratio => ratio > 1.1).length;
  const shortBatches = spec.samples.filter(sample => sample.shortBatch).length;
  return { name: spec.name, module: spec.file, numbersPerCall: spec.data.descriptor.size,
    ...(spec.kind === 'range' ? {} : { pointsPerCall: spec.data.descriptor.size / 2 }),
    tailValues: spec.data.metadata.tailValues, expected: Array.isArray(spec.expected) ? spec.expected.map(numberJSON) : numberJSON(spec.expected),
    parameters: spec.parameters.map(numberJSON), iterationsPerSample: spec.iterations, pairs,
    medianMillisecondsPerCall: { assemblyscript: assemblyscriptMs, rust: rustMs },
    medianRustOverAssemblyScript: pairedRatio, medianRustChangePercent: (pairedRatio - 1) * 100,
    pairsSlowerByMoreThanTenPercent: slowerPairs, pairedRatios: ratios, shortBatches,
    reviewRecommended: shortBatches === 0 && pairedRatio > 1.1 && slowerPairs >= pairs - 1,
    interpretation: shortBatches ? 'inconclusive: recorded batches below 10 ms' : 'paired diagnostic; not a statistical equivalence claim' };
});
const report = { schema: 'zerocopy-rust-optional-kernels/v1', status: 'complete', startedAt, completedAt: new Date().toISOString(),
  roots, commits: Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, gitHead(root)])),
  worktreeStatus: Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, gitStatus(root)])),
  host: { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, arch: arch(), platform: platform(), release: release(), cpu: cpus()[0]?.model,
    affinity: existsSync('/proc/self/status') ? readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]?.trim() : null,
    loadBefore, loadAfter: loadavg() },
  method: { count, pairs, warmupMsPerVariantAndCase: warmupMs, minimumBatchMs, targetBatchMs,
    isolation: 'One dedicated benchmark process; run without concurrent tests or benchmarks. Both modules share the exact same input WebAssembly.Memory.',
    order: 'Adjacent AS/Rust samples alternate AB/BA by pair and case; workload order reverses each pair.',
    timed: 'Direct scalar-argument WASM calls, loop/checksum, and exact result checks on every call. Bounding boxes include all four scalar getters.',
    excluded: 'Input construction, encoding, module compile/instantiation, references, warmup, calibration, hashing, and report allocation.',
    sharedInput: 'No timed copies, JS value conversion, collection updates, freezing, or output-object allocation; full shared arena hash is unchanged.',
    scope: 'Warm direct optional-kernel throughput. Does not measure cold startup, public adapter dispatch, worker messaging, or application latency.',
    reviewThreshold: 'Median paired slowdown above 10%, seen in at least all but one pair, with every batch at least 10 ms; a review signal, not a significance test.' },
  modules: moduleMetadata, harnessSHA256: hash(readFileSync(script)),
  input: { usedBytes, capacityBytes: memoryBytes, sha256: inputSHA256, unchangedAfterMeasurement: true, fixtures: fixtureMetadata },
  correctness: { preflightInvocations: correctnessCalls, fixtureCount: fixtureMetadata.length,
    checks: ['empty/one-value/leaf/tree boundaries', 'finite and infinite inclusive ranges', 'NaN inputs and bounds', 'inverted bounds',
      'odd point dimensions trap before NaN-bound short-circuit', 'first signed-zero bounds', 'NaN per coordinate axis', 'retained tails beside appended values'],
    timedInvocationsChecked: cases.reduce((total, spec) => total + spec.iterations * pairs * 2, 0), geometryComponentsCheckedPerCall: 4 },
  summary, raw: cases.map(spec => ({ name: spec.name, fixture: spec.data.name, warmups: spec.warmups, calibration: spec.calibration, samples: spec.samples })), sink,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
for (const row of summary) {
  console.log(`${row.name}: AS ${(row.medianMillisecondsPerCall.assemblyscript * 1000).toFixed(3)} µs; Rust ${(row.medianMillisecondsPerCall.rust * 1000).toFixed(3)} µs; paired Rust/AS ${row.medianRustOverAssemblyScript.toFixed(3)}${row.reviewRecommended ? ' — REVIEW' : ''}${row.shortBatches ? ' — SHORT BATCHES' : ''}`);
}
console.log(`Saved ${output}; ${correctnessCalls} preflight invocations and ${report.correctness.timedInvocationsChecked} timed invocations checked; shared bytes unchanged.`);
