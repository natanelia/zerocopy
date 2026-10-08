import assert from 'node:assert/strict';
import { median } from './noop-sequence-source.mjs';
export const MARGIN = 0.02;
export function summarizeQuartets(subjects) {
  assert.equal(subjects.length, 16, 'Exactly four quartets required');
  const quartets = [], pairs = [];
  for (let block = 0; block < 4; block++) {
    const rows = subjects.filter(s => s.block === block);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(s => s.label).join(''), block % 2 ? 'BAAB' : 'ABBA', 'Unbalanced subject order');
    const logs = [];
    for (let pair = 0; pair < 2; pair++) {
      const members = rows.filter(s => s.pair === pair);
      assert.equal(members.length, 2);
      const a = members.find(s => s.label === 'A').result.medianMs, b = members.find(s => s.label === 'B').result.medianMs;
      assert(a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b));
      const ratio = b / a; pairs.push({ block, pair, latencyRatio: ratio }); logs.push(Math.log(ratio));
    }
    quartets.push((logs[0] + logs[1]) / 2);
  }
  const mean = quartets.reduce((a, b) => a + b, 0) / 4;
  const variance = quartets.reduce((sum, n) => sum + (n - mean) ** 2, 0) / 3;
  const width = 3.182446305284263 * Math.sqrt(variance / 4);
  const ratio = Math.exp(mean), interval = [Math.exp(mean - width), Math.exp(mean + width)];
  const intervalClassification = interval[0] > 1 + MARGIN ? 'material-loss' : interval[1] <= 1 + MARGIN ? 'within-margin' : 'inconclusive';
  const repeat = subjects[0].result.repeat;
  assert(subjects.every(s => s.result.repeat === repeat));
  const batchMedian = role => median(subjects.filter(s => s.label === role).map(s => s.result.medianMs));
  const flags = [...new Set(subjects.flatMap(s => s.result.flags))];
  return { independentQuartets: 4, descriptivePairs: pairs, degreesOfFreedom: 3, quartetLatencyRatios: quartets.map(Math.exp),
    latencyRatio: ratio, latencyChangePercent: (ratio - 1) * 100, confidenceLevel: 0.95, interval, margin: MARGIN,
    intervalClassification, conclusion: flags.length ? 'timing-inconclusive' : intervalClassification, flags,
    repeat, baselineBatchMedianMs: batchMedian('A'), candidateBatchMedianMs: batchMedian('B'),
    baselineNsPerWrite: batchMedian('A') * 1e6 / repeat, candidateNsPerWrite: batchMedian('B') * 1e6 / repeat };
}
export function applyControl(aa, ab) {
  const materialRoleDrift = (aa.latencyRatio < 1 / (1 + MARGIN) || aa.latencyRatio > 1 + MARGIN) && (aa.interval[1] < 1 || aa.interval[0] > 1);
  return { ...ab, materialRoleDrift, aaLatencyRatio: aa.latencyRatio, aaInterval: aa.interval,
    conclusion: aa.flags.length || ab.flags.length ? 'timing-inconclusive' : materialRoleDrift ? 'control-drift-inconclusive' : ab.intervalClassification };
}
