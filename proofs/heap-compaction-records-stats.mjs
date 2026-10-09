// Reused without arithmetic changes from the audited compaction quartet helper.
// Provenance: ef1e2a16e687c8af385ddbd735094b9ec00179e9, proofs/compaction-pointer-performance.mjs.
// Source SHA-256: c268376a9bfcc88333d3ad8645384caf75c804bb38004e64a1612e7f5c27b5db.
import assert from 'node:assert/strict';
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
export function summarizeQuartets(rows, subjects, margin = 0.02) {
  const quartets = new Map();
  for (const row of rows) {
    assert.ok(Number.isInteger(row.block) && [0, 1].includes(row.pair));
    const pair = quartets.get(row.block) ?? [];
    assert.ok(!pair.some(previous => previous.pair === row.pair)); pair.push(row); quartets.set(row.block, pair);
  }
  assert.ok(quartets.size >= 2 && quartets.size <= 12);
  assert.ok([...quartets.values()].every(pair => pair.length === 2));
  const t95 = [null, 12.7062047364, 4.30265272975, 3.18244630528, 2.7764451052, 2.57058183564, 2.44691185114, 2.36462425101, 2.3060041352, 2.26215716285, 2.22813885196, 2.20098516008];
  const logs = [...quartets.values()].map(pair => pair.reduce((sum, row) => sum + Math.log(1 / row.speedup), 0) / 2), n = logs.length;
  const mean = logs.reduce((sum, value) => sum + value, 0) / n;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const halfWidth = t95[n - 1] * Math.sqrt(variance / n);
  const lower = Math.exp(mean - halfWidth), upper = Math.exp(mean + halfWidth), ratio = Math.exp(mean);
  const intervalClassification = lower > 1 + margin ? 'detected material loss' : upper <= 1 + margin ? 'within declared margin' : 'inconclusive';
  const baselineMs = subjects.filter(s => s.label === 'left').map(s => s.result.medianMs);
  const candidateMs = subjects.filter(s => s.label === 'right').map(s => s.result.medianMs);
  assert.equal(baselineMs.length, n * 2); assert.equal(candidateMs.length, n * 2);
  const compactionsPerBatch = subjects[0].result.iterations;
  assert.ok(Number.isInteger(compactionsPerBatch) && compactionsPerBatch > 0 && subjects.every(s => s.result.iterations === compactionsPerBatch));
  const shortBatchCount = subjects.reduce((sum, s) => sum + s.result.shortBatchCount, 0);
  const warmFloorMisses = subjects.filter(s => !s.result.warmFloorMet).length;
  return { independentQuartets: n, descriptiveProcessPairs: rows.length, degreesOfFreedom: n - 1, quartetLatencyRatios: logs.map(Math.exp), latencyRatio: ratio, latencyChangePercent: (ratio - 1) * 100,
    confidenceLevel: 0.95, interval: [lower, upper], nonInferiorityMargin: margin, intervalClassification,
    compactionsPerBatch, baselineBatchMedianMs: median(baselineMs), candidateBatchMedianMs: median(candidateMs),
    baselineNsPerCompaction: median(baselineMs) * 1e6 / compactionsPerBatch, candidateNsPerCompaction: median(candidateMs) * 1e6 / compactionsPerBatch,
    batchMedianDifferenceMs: median(candidateMs) - median(baselineMs), shortBatchCount, warmFloorMisses,
    inferenceUsable: shortBatchCount === 0 && warmFloorMisses === 0,
    conclusion: shortBatchCount || warmFloorMisses ? 'inconclusive (timing flags)' : intervalClassification };
}

export function assessCell(aa, ab, role) {
  if (!aa || !ab) return { dataStatus: 'incomplete', adoptionSignal: false };
  if (!aa.inferenceUsable || !ab.inferenceUsable) return { dataStatus: 'floor-or-warmup-invalid', adoptionSignal: false };
  const aaStatus = aa.interval[0] >= 0.98 && aa.interval[1] <= 1.02 ? 'within-materiality-band'
    : aa.interval[0] > 1.02 || aa.interval[1] < 0.98 ? 'detected-material-drift' : 'statistically-inconclusive';
  const effect = ab.interval[1] < 0.98 ? 'detected-material-benefit'
    : ab.interval[0] > 1.02 ? 'detected-material-loss'
    : ab.interval[0] >= 0.98 && ab.interval[1] <= 1.02 ? 'within-materiality-band' : 'statistically-inconclusive';
  return { dataStatus: 'complete-valid', aaStatus, effect,
    adoptionSignal: role === 'target' && aaStatus === 'within-materiality-band' && effect === 'detected-material-benefit' };
}
