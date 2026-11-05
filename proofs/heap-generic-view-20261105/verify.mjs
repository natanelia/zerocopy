import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = import.meta.dirname;
const BASE = '77599337867dbf785a5f0311d34637d0b36678fc';
const SCREEN = '442f6a58138c00de0951d7f4592da997700a474e';
const SOURCE_SHA = '9dd91242e8e73774146c5f104bf7c24fd0d863a616f78178048b25dfacbbd863';
const CASES = [
  ['empty-full', 'number', 0, 'full'], ['singleton-close', 'number', 1, 'first'],
  ['number-small', 'number', 32, 'full'], ['number-large', 'number', 65537, 'full'],
  ['max-ties', 'number', 4097, 'full'], ['boolean-full', 'boolean', 4097, 'full'],
  ['string-overflow', 'string', 4097, 'full'], ['object-warm', 'object', 1057, 'full'],
  ['object-overflow', 'object', 4097, 'full'],
  ['materialize', 'number', 4097, 'array'], ['unchanged-peek', 'number', 4097, 'peek'],
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const archives = JSON.parse(readFileSync(resolve(directory, 'archive-manifest.json'), 'utf8'));
assert.equal(archives.schema, 'zerocopy-heap-generic-view-archives/v1');
assert.equal(sha(readFileSync(import.meta.filename)), archives.verifierSha256);
assert.deepEqual(archives.files.map(row => row.path), [
  'results/node-pilot-01.json.gz', 'results/bun-pilot-01.json.gz',
]);

let firstSource, firstPatch, screenPairs = 0, measuredBatches = 0;
for (const archive of archives.files) {
  const compressed = readFileSync(resolve(directory, archive.path));
  assert.equal(compressed.length, archive.bytes); assert.equal(sha(compressed), archive.sha256);
  const plain = gunzipSync(compressed);
  assert.equal(plain.length, archive.originalBytes); assert.equal(sha(plain), archive.originalSha256);
  assert.equal(archive.roundTripVerified, true);
  const record = JSON.parse(plain.toString('utf8'));
  assert.equal(record.schema, 'zerocopy-heap-generic-view-screen/v1');
  assert.equal(record.selectedRuntime, archive.path.startsWith('results/node-') ? 'node' : 'bun');
  const pairs = 2, samples = 7, warmupMs = 500;
  assert.equal(record.status, 'complete'); assert.equal(record.method.pairs, pairs); assert.equal(record.method.samples, samples);
  assert.equal(record.method.subjectWarmupMs, warmupMs); assert.equal(record.method.minimumWarmupBatches, 8);
  assert.equal(record.method.coarseWarmupMs, 100); assert.equal(record.method.fixedWarmupMs, 150);
  assert.equal(record.method.emptyWarmupBatchCap, 256); assert.equal(record.method.targetBatchMs, 8);
  assert.equal(record.method.maxRepeat, 1048576); assert.equal(record.method.maxOutputValues, 524288);
  assert.equal(record.method.maxObjectValues, 131072);
  assert.deepEqual(record.cases.map(row => [row.name, row.type, row.size, row.operation]), CASES);
  assert.equal(record.cases.find(row => row.name === 'max-ties').maxHeap, true);
  assert.equal(record.cases.find(row => row.name === 'max-ties').ties, true);
  assert.equal(record.cases.find(row => row.name === 'boolean-full').maxHeap, true);
  assert.equal(record.cases.find(row => row.name === 'unchanged-peek').reads, 256);
  assert.equal(record.summary.length, CASES.length); assert.equal(record.pairs.length, CASES.length * pairs);
  assert.equal(record.calibrations.length, CASES.length * 2);
  assert.deepEqual(record.calibrations.map(row => [row.name, row.stage]),
    CASES.flatMap(([name]) => [[name, 'coarse'], [name, 'fixed']]));
  assert.equal(record.hardware.affinity, 'Cpus_allowed_list:\t2');
  assert.equal(record.source.before.commit, BASE); assert.equal(record.source.after.commit, SCREEN);
  assert.equal(record.source.after.files['shared-priority-queue.ts'], SOURCE_SHA);
  assert.equal(record.source.driver, sha(readFileSync(resolve(directory, 'pilot.mjs'))));
  assert.deepEqual(Object.keys(record.source.before.files).filter(name => !name.startsWith('dist/')),
    Object.keys(record.source.after.files).filter(name => !name.startsWith('dist/')));
  for (const [name, hash] of Object.entries(record.source.before.files)) {
    if (name.startsWith('dist/') || name === 'shared-priority-queue.ts') continue;
    assert.equal(record.source.after.files[name], hash, `Unrelated input changed: ${name}`);
  }
  if (firstSource) {
    assert.deepEqual(record.source.before.files, firstSource.before.files);
    assert.deepEqual(record.source.after.files, firstSource.after.files);
    assert.equal(record.candidatePatch, firstPatch);
  } else { firstSource = record.source; firstPatch = record.candidatePatch; }

  function checkSubject(subject, spec) {
    assert.equal(subject.name, spec.name); assert.equal(subject.runtime, record.selectedRuntime);
    assert.equal(subject.arch, 'x64'); assert.equal(subject.warmup.length, subject.warmupBatches);
    if (subject.runtime === 'node') assert.equal(subject.versions.node, '24.22.1');
    else assert.equal(subject.versions.bun, '1.4.2');
    const valuesPerOperation = spec.operation === 'peek' ? 256 : spec.operation === 'first' ? 1 : spec.size;
    assert.equal(subject.valuesPerOperation, valuesPerOperation);
    assert.equal(subject.cap, Math.max(1, Math.min(1048576,
      Math.floor((spec.type === 'object' || spec.operation === 'array' ? 131072 : 524288) / Math.max(1, valuesPerOperation)))));
    near(subject.warmupTimedMs, subject.warmup.reduce((sum, row) => sum + row.ms, 0));
    near(subject.measuredTimedMs, subject.samples.reduce((sum, row) => sum + row.ms, 0));
    const allRows = [...subject.warmup, ...subject.samples, ...subject.calibration.flatMap(stage => stage.trials)];
    for (const row of allRows) {
      assert.ok(Number.isInteger(row.repeat) && row.repeat > 0 && row.repeat <= subject.cap);
      assert.ok(row.ms >= 0); near(row.msPerOperation, row.ms / row.repeat);
      assert.equal(row.checkedValues, row.repeat * valuesPerOperation);
      assert.equal(row.checkedPriorities, row.repeat * valuesPerOperation);
      assert.equal(row.sharedAllocatedBytes, 0);
    }
    const trials = subject.mode === 'measure' ? subject.samples : subject.calibration.at(-1).trials;
    near(subject.medianMsPerOperation, median(trials.map(row => row.msPerOperation)));
    if (subject.mode === 'measure') {
      assert.equal(subject.samples.length, samples); assert.ok(subject.warmupBatches >= 8);
      for (const row of [...subject.warmup, ...subject.samples]) assert.equal(row.repeat, subject.repeat);
      assert.equal(subject.warmupTargetMet, subject.warmupTimedMs >= warmupMs);
      assert.equal(subject.emptyWarmupCapHit, !spec.size && subject.warmupBatches === 256 && subject.warmupTimedMs < warmupMs);
      if (spec.size) assert.ok(subject.warmupTargetMet); else assert.ok(subject.warmupBatches <= 256);
    } else {
      assert.ok(subject.warmupBatches >= 5);
      assert.ok(subject.warmupTimedMs >= (subject.mode === 'coarse' ? 100 : 150));
      assert.equal(subject.samples.length, 0);
    }
  }
  for (const calibration of record.calibrations) {
    const spec = record.cases.find(row => row.name === calibration.name); assert.ok(spec);
    for (const side of ['before', 'after']) {
      assert.equal(calibration[side].mode, calibration.stage); checkSubject(calibration[side], spec);
    }
    assert.equal(calibration.before.outputHash, calibration.after.outputHash);
    assert.equal(calibration.before.fixtureUsed, calibration.after.fixtureUsed);
  }
  const expectedOrder = [];
  for (let round = 0; round < pairs; round++) {
    const offset = round % CASES.length;
    expectedOrder.push(...[...CASES.slice(offset), ...CASES.slice(0, offset)].map(([name]) => [round, name]));
  }
  assert.deepEqual(record.pairs.map(row => [row.round, row.name]), expectedOrder);
  for (const spec of record.cases) {
    const rows = record.pairs.filter(pair => pair.name === spec.name);
    assert.equal(rows.length, pairs); assert.deepEqual(rows.map(row => row.round), Array.from({ length: pairs }, (_, i) => i));
    const summary = record.summary.find(row => row.name === spec.name); assert.ok(summary);
    assert.equal(summary.runtime, record.selectedRuntime); assert.equal(summary.pairs, pairs);
    assert.equal(new Set(rows.map(pair => pair.before.repeat)).size, 1);
    const calibration = record.calibrations.find(row => row.name === spec.name && row.stage === 'fixed'); assert.ok(calibration);
    const ratios = [];
    for (const pair of rows) {
      assert.equal(pair.runtime, record.selectedRuntime);
      assert.deepEqual(pair.order, pair.round % 2 ? ['after', 'before'] : ['before', 'after']);
      assert.equal(pair.before.repeat, pair.after.repeat); assert.equal(pair.before.repeat, calibration.repeat);
      assert.equal(pair.before.outputHash, pair.after.outputHash); assert.equal(pair.before.outputHash, calibration.before.outputHash);
      assert.equal(pair.before.fixtureUsed, pair.after.fixtureUsed); assert.equal(pair.before.fixtureUsed, calibration.before.fixtureUsed);
      for (const side of ['before', 'after']) { assert.equal(pair[side].mode, 'measure'); checkSubject(pair[side], spec); }
      ratios.push(pair.after.medianMsPerOperation / pair.before.medianMsPerOperation);
    }
    const logs = ratios.map(Math.log), mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    assert.deepEqual(summary.ratios, ratios); assert.deepEqual(summary.ratioRange, [Math.min(...ratios), Math.max(...ratios)]);
    near(summary.ratio, Math.exp(mean));
    near(summary.beforeMs, median(rows.map(row => row.before.medianMsPerOperation)));
    near(summary.afterMs, median(rows.map(row => row.after.medianMsPerOperation)));
    const se = Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pairs - 1) / pairs);
    const margin = 12.7062047364 * se;
    near(summary.ratioCI95[0], Math.exp(mean - margin)); near(summary.ratioCI95[1], Math.exp(mean + margin));
  }
  screenPairs += record.pairs.length;
  measuredBatches += record.pairs.length * 2 * samples;
  console.log(`${archive.path}: archive hashes, complete subjects, pairing, medians and summary estimates verified`);
}

// Archived candidate sources are evidence; current production may evolve independently.
for (const item of archives.measuredInputs) {
  const raw = readFileSync(resolve(directory, item.path));
  assert.equal(raw.length, item.bytes); assert.equal(sha(raw), item.sha256);
}
const baselineSource = readFileSync(resolve(directory, 'measured/baseline-shared-priority-queue.ts.txt'), 'utf8');
const candidateSource = readFileSync(resolve(directory, 'measured/candidate-shared-priority-queue.ts.txt'), 'utf8');
assert.equal(sha(baselineSource), firstSource.before.files['shared-priority-queue.ts']);
assert.equal(sha(candidateSource), SOURCE_SHA);
assert.equal(readFileSync(resolve(directory, 'measured/candidate.patch.txt'), 'utf8'), firstPatch);
const start = baselineSource.indexOf('    while (pending.length) {', baselineSource.indexOf('  *entries()'));
const end = baselineSource.indexOf('  get isEmpty', start);
assert.ok(start >= 0 && end > start);
const fallback = baselineSource.slice(start, end);
assert.equal(sha(fallback), '6f4f04b29b956e17b6885a8229c9e29c8fce1c3603d05af92e0f0aa79984289f');
assert.equal(candidateSource.split(fallback).length, 2);
assert.equal(sha(readFileSync(resolve(directory, 'measured/heap-entry-generic-view.test.ts.txt'))),
  '7327d3ab6a08b81bc7fb97cd813903f3d7b114db562244514a6972f4b7fa4554');
console.log('Archived candidate sources and exact original fallback verified; no live production hash gate');

// Optional: compare saved inputs to their original baseline/candidate builds.
const [beforeRoot, afterRoot] = process.argv.slice(2);
assert.ok((beforeRoot && afterRoot) || (!beforeRoot && !afterRoot), 'Provide both BEFORE and AFTER paths, or neither');
if (beforeRoot) for (const [side, root] of [['before', beforeRoot], ['after', afterRoot]]) {
  for (const [name, hash] of Object.entries(firstSource[side].files)) {
    assert.equal(sha(readFileSync(resolve(root, name))), hash, `${side} file differs: ${name}`);
  }
  console.log(`${side}: all ${Object.keys(firstSource[side].files).length} recorded source/bundle hashes match`);
}
console.log(JSON.stringify({ screenPairs, measuredBatches, allArchiveRoundTripsVerified: true }));
