import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQuartets } from './trie-iterator-performance.mjs';
function fixture(ratios, flags = {}) {
  const rows = ratios.flatMap((ratio, block) => [0, 1].map(pair => ({ block, pair, speedup: 1 / ratio })));
  const subjects = ratios.flatMap(ratio => [0, 1].flatMap(() => [
    { label: 'left', result: { iterations: 1000, medianMs: 10, shortBatchCount: 0, warmFloorMet: true } },
    { label: 'right', result: { iterations: 1000, medianMs: 10 * ratio, shortBatchCount: 0, warmFloorMet: true, ...flags } },
  ]));
  return summarizeQuartets(rows, subjects);
}
test('classifies fixed ratios against the predeclared 2% latency margin', () => {
  assert.equal(fixture([1.03, 1.03, 1.03, 1.03]).intervalClassification, 'detected material loss');
  const smallLoss = fixture([1.01, 1.01, 1.01, 1.01]);
  assert.equal(smallLoss.intervalClassification, 'within declared margin');
  assert.ok(smallLoss.latencyChangePercent > 0);
  assert.equal(smallLoss.baselineNsPerScan, 10000);
  assert.equal(smallLoss.candidateNsPerScan, 10100);
  assert.ok(Math.abs(smallLoss.batchMedianDifferenceMs - 0.1) < 1e-10);
  assert.equal(fixture([0.8, 0.8, 0.8, 0.8]).intervalClassification, 'within declared margin');
});
test('uses quartet-level log ratios and a small-sample t interval', () => {
  const result = fixture([0.5, 2]);
  assert.equal(result.independentQuartets, 2);
  assert.equal(result.latencyRatio, 1);
  assert.equal(result.intervalClassification, 'inconclusive');
  assert.ok(Math.abs(Math.log(result.interval[1]) - 12.7062047364 * Math.log(2)) < 1e-8);
});
test('does not treat batch or warmup timing flags as usable non-inferiority evidence', () => {
  assert.equal(fixture([1, 1], { shortBatchCount: 1 }).inferenceUsable, false);
  assert.equal(fixture([1, 1], { shortBatchCount: 1 }).conclusion, 'inconclusive (timing flags)');
  assert.equal(fixture([1, 1], { warmFloorMet: false }).inferenceUsable, false);
  assert.equal(fixture([1, 1]).inferenceUsable, true);
});
test('does not subtract an A/A result or count pair/batch samples as extra quartets', () => {
  const result = fixture([0.99, 1.01, 0.98, 1.02]);
  assert.equal(result.independentQuartets, 4);
  assert.equal(result.descriptiveProcessPairs, 8);
  assert.equal(result.degreesOfFreedom, 3);
  assert.ok(Math.abs(result.latencyRatio - (0.99 * 1.01 * 0.98 * 1.02) ** 0.25) < 1e-12);
});

test('does not create extra degrees of freedom from pairs within a quartet', () => {
  const rows = [0, 1, 2, 3].flatMap(block => [{ block, pair: 0, speedup: 2 }, { block, pair: 1, speedup: 0.5 }]);
  const subjects = rows.flatMap(row => [{ label: 'left', result: { iterations: 1, medianMs: 10, shortBatchCount: 0, warmFloorMet: true } }, { label: 'right', result: { iterations: 1, medianMs: 10 / row.speedup, shortBatchCount: 0, warmFloorMet: true } }]);
  const result = summarizeQuartets(rows, subjects);
  assert.equal(result.independentQuartets, 4); assert.equal(result.degreesOfFreedom, 3);
  assert.deepEqual(result.quartetLatencyRatios, [1, 1, 1, 1]);
  assert.deepEqual(result.interval, [1, 1]);
});
