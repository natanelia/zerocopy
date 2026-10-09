import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQuartets, assessCell } from './heap-compaction-records-stats.mjs';
import { cases, limits, chunkCompactions, backingBound } from './heap-compaction-records-fixtures.mjs';
import { protocol, subject } from './heap-compaction-records-performance.mjs';
function fixture(ratios, flags = {}) {
  const rows = ratios.flatMap((ratio, block) => [0, 1].map(pair => ({ block, pair, speedup: 1 / ratio })));
  const subjects = ratios.flatMap(ratio => [0, 1].flatMap(() => [
    { label: 'left', result: { iterations: 1000, medianMs: 10, shortBatchCount: 0, warmFloorMet: true } },
    { label: 'right', result: { iterations: 1000, medianMs: 10 * ratio, shortBatchCount: 0, warmFloorMet: true, ...flags } },
  ]));
  return summarizeQuartets(rows, subjects);
}
test('audited quartet estimator retains small-sample uncertainty and units', () => {
  const x = fixture([0.5, 2]);
  assert.equal(x.independentQuartets, 2); assert.equal(x.degreesOfFreedom, 1); assert.equal(x.latencyRatio, 1);
  assert(Math.abs(Math.log(x.interval[1]) - 12.7062047364 * Math.log(2)) < 1e-8);
  const y = fixture([1.01, 1.01, 1.01, 1.01]);
  assert.equal(y.baselineNsPerCompaction, 10000); assert.equal(y.candidateNsPerCompaction, 10100);
  assert.equal(y.independentQuartets, 4); assert.equal(y.descriptiveProcessPairs, 8);
});
test('pairs and batches never add independent observations', () => {
  const rows = [0, 1, 2, 3].flatMap(block => [{ block, pair: 0, speedup: 2 }, { block, pair: 1, speedup: 0.5 }]);
  const subjects = rows.flatMap(row => [{ label: 'left', result: { iterations: 1, medianMs: 10, shortBatchCount: 0, warmFloorMet: true } }, { label: 'right', result: { iterations: 1, medianMs: 10 / row.speedup, shortBatchCount: 0, warmFloorMet: true } }]);
  const x = summarizeQuartets(rows, subjects);
  assert.equal(x.independentQuartets, 4); assert.deepEqual(x.quartetLatencyRatios, [1, 1, 1, 1]); assert.deepEqual(x.interval, [1, 1]);
});
test('distinguishes invalid measurements from valid inconclusive intervals', () => {
  const aa = fixture([1, 1, 1, 1]);
  assert.equal(assessCell(undefined, undefined, 'target').dataStatus, 'incomplete');
  assert.equal(assessCell(aa, fixture([1, 1, 1, 1], { shortBatchCount: 1 }), 'target').dataStatus, 'floor-or-warmup-invalid');
  assert.equal(assessCell(aa, fixture([1, 1, 1, 1], { warmFloorMet: false }), 'target').dataStatus, 'floor-or-warmup-invalid');
  const uncertain = assessCell(aa, fixture([0.8, 1.2, 0.9, 1.1]), 'target');
  assert.equal(uncertain.dataStatus, 'complete-valid'); assert.equal(uncertain.effect, 'statistically-inconclusive'); assert.equal(uncertain.adoptionSignal, false);
});
test('requires a material target benefit and compatible AA, without AA subtraction', () => {
  const stable = fixture([1, 1, 1, 1]), benefit = fixture([0.9, 0.9, 0.9, 0.9]);
  assert(assessCell(stable, benefit, 'target').adoptionSignal);
  assert.equal(assessCell(stable, benefit, 'control').adoptionSignal, false);
  assert.equal(assessCell(fixture([0.9, 0.9, 0.9, 0.9]), benefit, 'target').aaStatus, 'detected-material-drift');
  assert.equal(assessCell(fixture([0.9, 0.9, 0.9, 0.9]), benefit, 'target').adoptionSignal, false);
  assert.equal(assessCell(stable, fixture([1.03, 1.03, 1.03, 1.03]), 'control').effect, 'detected-material-loss');
  assert.equal(assessCell(stable, fixture([0.99, 0.99, 0.99, 0.99]), 'target').adoptionSignal, false);
});
test('predeclared process and budget arithmetic stays bounded', () => {
  assert.equal(Object.keys(cases).length, 8); assert.equal(protocol.blocks, 4); assert.equal(protocol.samples, 5);
  const measured = 8 * 2 * protocol.blocks * 4, pilots = 8 * 2;
  assert.equal(measured, 256); assert.equal(pilots, 16);
  assert.equal(measured * protocol.measureSubjectMs + pilots * protocol.pilotSubjectMs, 592000);
  assert.equal(protocol.engineMs, 720000); assert.equal(protocol.engineMs - 592000, 128000);
  const maximumCompactions = 2 * limits.pilotWarmChunks * limits.chunkCompactions + protocol.samples * limits.batchChunks * limits.chunkCompactions + 16;
  assert(maximumCompactions < 10 ** limits.processArenaCounterDigits);
});
test('churn ceilings are symmetric, conservative, and reject overflow', () => {
  for (const name of Object.keys(cases)) {
    const count = chunkCompactions(name); assert(count <= 64); assert(count * cases[name].backingCeiling <= 8 * 1024 * 1024);
    assert.throws(() => backingBound(cases[name].backingCeiling + 1, name));
  }
  assert.equal(limits.initialArenaBytes, 131072); assert.equal(limits.maximumArenaBytes, 256 * 1024 * 1024);
  assert(backingBound(240000, 'heap-nested128x512').nestedIdAndAlignmentReserve >= 65536 + 128 * 13);
});
test('pilot and measurement modes are disabled before any fixture work by default', async () => {
  const before = process.env.HEAP_ENABLE_TIMING;
  delete process.env.HEAP_ENABLE_TIMING;
  try {
    for (const mode of ['pilot', 'measure']) await assert.rejects(subject({ name: 'heap-empty', mode, module: '/must-not-be-loaded' }), /Timing is disabled/);
  } finally { if (before === undefined) delete process.env.HEAP_ENABLE_TIMING; else process.env.HEAP_ENABLE_TIMING = before; }
});
