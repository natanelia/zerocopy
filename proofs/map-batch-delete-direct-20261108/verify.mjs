import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Recompute saved statistics and validate provenance without retiming.
const [input, candidate] = process.argv.slice(2);
assert.ok(input, 'Usage: node verify.mjs RECORD.json [CANDIDATE_ROOT]');
const record = JSON.parse(readFileSync(input, 'utf8'));
assert.equal(record.status, 'complete');
assert.equal(record.schema, 'zerocopy-paired-public-operation/v1');
const median = xs => {
  const values = [...xs].sort((a, b) => a - b), center = (values.length - 1) / 2;
  return (values[Math.floor(center)] + values[Math.ceil(center)]) / 2;
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const near = (actual, expected) => assert.ok(
  Math.abs(actual - expected) <= Math.max(1e-13, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
const { method, runs } = record;
assert.equal(runs.length, method.pairs * method.cases.length * 4);
assert.equal(record.summary.length, method.cases.length * 2);
assert.match(record.host.affinity, /^\d+$/);
assert.equal(record.source.before.commit, record.study.baseline);
assert.equal(method.samples, 9);
const expectedSchedule = [];
for (let pair = 0; pair < method.pairs; pair++) {
  const cases = pair % 2 ? [...method.cases].reverse() : method.cases;
  for (const runtime of pair % 2 ? ['bun', 'node'] : ['node', 'bun']) {
    for (const spec of cases) for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
      expectedSchedule.push({ pair, runtime, caseName: spec.name, variant });
    }
  }
}
assert.deepEqual(runs.map(({ pair, runtime, caseName, variant }) => ({ pair, runtime, caseName, variant })), expectedSchedule);
let timedBatches = 0, outputs = 0, below2ms = 0;
for (const run of runs) {
  const spec = method.cases.find(row => row.name === run.caseName);
  assert.deepEqual(run.spec, spec);
  assert.equal(run.affinity, record.host.affinity);
  assert.match(run.expectedDigest, /^[0-9a-f]{64}$/);
  assert.ok(run.warmupBatchMs.length >= method.minimumWarmupBatches);
  assert.ok(run.warmupBatchMs.reduce((a, b) => a + b, 0) >= method.minimumWarmupMs);
  assert.equal(run.sampleBatchMs.length, method.samples);
  for (const value of [...run.warmupBatchMs, ...run.sampleBatchMs]) assert.ok(Number.isFinite(value) && value > 0);
  near(run.medianMs, median(run.sampleBatchMs) / spec.repetitions);
  assert.equal(run.verifiedOutputs, (run.warmupBatchMs.length + method.samples) * spec.repetitions);
  assert.equal(run.batchTiming.measuredBelow2ms, run.sampleBatchMs.filter(value => value < 2).length);
  near(run.batchTiming.minimumMeasuredMs, Math.min(...run.sampleBatchMs));
  timedBatches += run.sampleBatchMs.length;
  outputs += run.verifiedOutputs;
  below2ms += run.batchTiming.measuredBelow2ms;
}
const critical = { 4: 3.182446305284263, 6: 2.5705818356363155 }[method.pairs];
for (const row of record.summary) {
  const points = [];
  for (let pair = 0; pair < method.pairs; pair++) {
    const find = variant => runs.find(run => run.pair === pair && run.runtime === row.runtime && run.caseName === row.name && run.variant === variant);
    const before = find('before'), after = find('after');
    assert.deepEqual(before.versions, after.versions);
    assert.deepEqual(before.fixture, after.fixture);
    assert.equal(before.expectedDigest, after.expectedDigest);
    points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
  }
  assert.deepEqual(row.points, points);
  near(row.beforeMs, median(points.map(point => point.before)));
  near(row.afterMs, median(points.map(point => point.after)));
  const logs = points.map(point => Math.log(point.ratio));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  near(row.pairedRatio, Math.exp(mean));
  assert.equal(row.fasterPairs, points.filter(point => point.ratio < 1).length);
  if (critical) {
    const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logs.length - 1);
    const margin = critical * Math.sqrt(variance / logs.length);
    near(row.interval95[0], Math.exp(mean - margin));
    near(row.interval95[1], Math.exp(mean + margin));
  } else assert.equal(row.interval95, null);
}
for (const [name, snapshots] of Object.entries(record.snapshots)) for (const variant of ['before', 'after']) {
  if (snapshots[variant] !== null) assert.equal(digest(snapshots[variant]), record.source[variant].sources[name]);
}
if (record.mode === 'aa') {
  assert.deepEqual(record.source.before.sources, record.source.after.sources);
  assert.deepEqual(record.source.before.wasm, record.source.after.wasm);
  assert.deepEqual(record.source.before.bundles, record.source.after.bundles);
}
if (candidate) {
  const root = resolve(candidate), selected = record.mode === 'aa' ? record.source.before : record.source.after;
  for (const [name, hash] of Object.entries(selected.sources)) assert.equal(digest(readFileSync(join(root, name))), hash, name);
  for (const [name, hash] of Object.entries(selected.wasm)) assert.equal(digest(readFileSync(join(root, name))), hash, name);
  for (const [name, hash] of Object.entries(selected.bundles)) assert.equal(digest(readFileSync(join(root, 'dist', name))), hash, name);
  const folder = dirname(new URL(import.meta.url).pathname);
  assert.equal(digest(readFileSync(join(folder, basename(record.driver.name)))), record.driver.sha256);
  assert.equal(digest(readFileSync(join(folder, basename(record.workload.name)))), record.workload.sha256);
}
console.log(JSON.stringify({ verified: true, record: resolve(input), mode: record.mode,
  processes: runs.length, timedBatches, verifiedOutputs: outputs, measuredBatchesBelow2ms: below2ms,
  exactCurrentBuild: Boolean(candidate), rows: record.summary.map(({ runtime, name, pairedRatio, interval95 }) => ({ runtime, name, pairedRatio, interval95 })) }, null, 2));
