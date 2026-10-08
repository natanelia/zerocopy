import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const protocol = JSON.parse(readFileSync(new URL('./registry-attachment-controls.manifest.json', import.meta.url)));
export const median = values => {
  assert(values.length > 0 && values.every(v => Number.isFinite(v) && v > 0));
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export function randomSource(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
export function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function scheduleCase(seed) {
  const random = randomSource(seed), orders = Object.fromEntries(protocol.modes.map(mode => [mode, shuffle(['ABBA', 'ABBA', 'ABBA', 'ABBA', 'BAAB', 'BAAB', 'BAAB', 'BAAB'], random)]));
  return Array.from({ length: protocol.quartetsPerMode }, (_, quartet) => shuffle(protocol.modes, random).map(mode => ({ quartet: quartet + 1, mode, order: orders[mode][quartet], roles: [...orders[mode][quartet]] }))).flat();
}
export function variantFor(mode, role) {
  assert(protocol.modes.includes(mode) && ['A', 'B'].includes(role));
  return mode === 'aa-baseline' ? 'baseline' : mode === 'aa-candidate' ? 'candidate' : role === 'A' ? 'baseline' : 'candidate';
}
export function interval(logs) {
  assert.equal(logs.length, 8); assert(logs.every(Number.isFinite));
  const mean = logs.reduce((a, b) => a + b, 0) / 8;
  const variance = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 7;
  const standardError = Math.sqrt(variance / 8), halfWidth = protocol.tCritical * standardError;
  const ratio = Math.exp(mean), lower = Math.exp(mean - halfWidth), upper = Math.exp(mean + halfWidth);
  return { ratio, ci95: [lower, upper], meanLog: mean, standardError, quartetLogs: logs, df: 7, tCritical: protocol.tCritical,
    classification: lower > 1.02 ? 'material-slowdown-signal' : upper <= 1.02 ? 'within-2%-margin' : 'inconclusive',
    materialRoleDrift: (ratio < 1 / 1.02 || ratio > 1.02) && (upper < 1 || lower > 1) };
}
export function summarizeCase(blocks) {
  const arms = {};
  for (const mode of protocol.modes) {
    const complete = blocks.filter(b => b.mode === mode && b.subjects.length === 4), pairs = [], logs = [];
    for (const block of complete) {
      const pairLogs = [];
      for (const index of [0, 2]) {
        const pair = block.subjects.slice(index, index + 2);
        const a = pair.find(s => s.role === 'A'), b = pair.find(s => s.role === 'B');
        assert(a && b);
        const aMs = median(a.result.measured.map(x => x.msPerOperation)), bMs = median(b.result.measured.map(x => x.msPerOperation));
        const log = Math.log(bMs / aMs); pairLogs.push(log);
        pairs.push({ quartet: block.quartet, order: block.order, firstRole: pair[0].role, aMs, bMs, ratio: bMs / aMs });
      }
      logs.push((pairLogs[0] + pairLogs[1]) / 2);
    }
    const subjects = blocks.filter(b => b.mode === mode).flatMap(b => b.subjects);
    const shortBatches = subjects.reduce((n, s) => n + [...s.result.warmup, ...s.result.measured].filter(b => b.elapsedMs < protocol.minimumBatchMs).length, 0);
    arms[mode] = { completeQuartets: complete.length, pairs, shortBatches, inference: complete.length === 8 ? interval(logs) : null };
  }
  const reasons = [];
  if (protocol.modes.some(mode => !arms[mode].inference)) reasons.push('incomplete');
  if (protocol.modes.some(mode => arms[mode].shortBatches > 0)) reasons.push('short-warmup-or-measured-batch');
  for (const mode of ['aa-baseline', 'aa-candidate']) if (arms[mode].inference?.materialRoleDrift) reasons.push(`${mode}-material-role-drift`);
  return { arms, inferenceValid: reasons.length === 0, invalidationReasons: reasons,
    interpretation: reasons.length ? 'inference-invalid; retain all raw results' : arms.ab.inference.classification,
    normalization: 'none; A/B and both A/A arms reported directly' };
}
export function applyRunIntegrity(summary, { status, integrityComplete }) {
  const measurementFlagsClear = summary.inferenceValid;
  const runVerified = status === 'completed' && integrityComplete === true;
  const invalidationReasons = [...summary.invalidationReasons];
  if (!runVerified) invalidationReasons.push(status === 'failed' ? 'run-failed' : 'final-integrity-not-completed');
  return { ...summary, measurementFlagsClear, runVerified, inferenceValid: measurementFlagsClear && runVerified, invalidationReasons,
    interpretation: measurementFlagsClear && runVerified ? summary.interpretation : 'inference-invalid; retain all raw results' };
}
