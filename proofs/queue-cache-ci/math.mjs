import assert from 'node:assert/strict';

export function median(xs) {
  assert(xs.length && xs.every(Number.isFinite));
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
export function summary(xs) {
  const m = median(xs), mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : null;
  const mad = median(xs.map(x => Math.abs(x - m)));
  return {n: xs.length, median: m, min: Math.min(...xs), max: Math.max(...xs), mean, sd, mad, relativeMad: mad / m};
}
export function logInterval(logs, tCritical) {
  assert.equal(logs.length, 4, 'Four process blocks required; missing blocks are inconclusive');
  const s = summary(logs), radius = tCritical * s.sd / Math.sqrt(logs.length);
  return {ratio: Math.exp(s.mean), low: Math.exp(s.mean - radius), high: Math.exp(s.mean + radius), meanLog: s.mean, sdLog: s.sd, df: 3};
}
export function selectCommonWork(caseSpec, baseline, candidate, target) {
  const count = caseSpec.ladder.find(n => median(baseline[n]) >= target && median(candidate[n]) >= target);
  return {operations: count ?? caseSpec.ladder.at(-1), targetMet: count !== undefined};
}
export function pointwiseDecision(interval, stats, diagnosticsClean) {
  if (!diagnosticsClean) return 'inconclusive: control, warmup, floor, or variability flag';
  if (interval.low > stats.materialLossRatio) return 'material loss supported in this cell';
  if (interval.high < stats.worthwhileGainRatio) return 'worthwhile gain supported in this cell';
  if (interval.high < stats.materialLossRatio) return '2% loss excluded pointwise; worthwhile gain unresolved';
  return 'inconclusive';
}
export function slotPlan(protocol) {
  const result = [];
  for (let block = 0; block < protocol.blocks; block++) for (const runtime of protocol.runtimeOrders[block]) {
    const seen = {baseline: 0, candidate: 0};
    protocol.orders[block].forEach((arm, position) => result.push({id: `${runtime}-b${block}-${position}-${arm}`, runtime, block, position, arm, replicate: seen[arm]++}));
  }
  return result;
}

export function hasCompleteReplicates(medians) {
  return ['baseline', 'candidate'].every(arm => medians[arm]?.length === 2 &&
    [0, 1].every(index => Number.isFinite(medians[arm][index]) && medians[arm][index] > 0));
}
