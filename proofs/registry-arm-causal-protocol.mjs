import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { median, interval, randomSource, shuffle } from './registry-attachment-protocol.mjs';
export { median, interval };
export const protocol = JSON.parse(readFileSync(new URL('./registry-arm-causal.manifest.json', import.meta.url)));
export function schedule(seed = protocol.seed) {
  const random = randomSource(seed), arms = Object.keys(protocol.arms);
  const orders = Object.fromEntries(arms.map(arm => [arm, shuffle(['ABBA', 'ABBA', 'ABBA', 'ABBA', 'BAAB', 'BAAB', 'BAAB', 'BAAB'], random)]));
  return Array.from({ length: 8 }, (_, i) => shuffle(arms, random).map(arm => ({ quartet: i + 1, arm, order: orders[arm][i], roles: [...orders[arm][i]] }))).flat();
}
export function stateFor(arm, role) {
  assert(Object.hasOwn(protocol.arms, arm) && ['A', 'B'].includes(role));
  return protocol.arms[arm][role === 'A' ? 0 : 1];
}
export function pilotOrder() { return shuffle(Object.keys(protocol.states), randomSource(protocol.seed + 100)); }
export function summarize(blocks, { status, integrityComplete }) {
  const arms = {};
  for (const arm of Object.keys(protocol.arms)) {
    const own = blocks.filter(block => block.arm === arm), complete = own.filter(block => block.subjects.length === 4), logs = [], pairs = [];
    for (const block of complete) {
      const pairLogs = [];
      for (const start of [0, 2]) {
        const pair = block.subjects.slice(start, start + 2), a = pair.find(s => s.role === 'A'), b = pair.find(s => s.role === 'B');
        assert(a && b);
        const aMs = median(a.result.measured.map(row => row.msPerOperation)), bMs = median(b.result.measured.map(row => row.msPerOperation));
        pairLogs.push(Math.log(bMs / aMs)); pairs.push({ quartet: block.quartet, order: block.order, aMs, bMs, ratio: bMs / aMs });
      }
      logs.push((pairLogs[0] + pairLogs[1]) / 2);
    }
    const shortBatches = own.flatMap(block => block.subjects).reduce((sum, subject) => sum + [...subject.result.warmup, ...subject.result.measured].filter(row => row.elapsedMs < protocol.minimumBatchMs).length, 0);
    arms[arm] = { completeQuartets: complete.length, pairs, shortBatches, inference: complete.length === 8 ? interval(logs) : null };
  }
  for (const [arm, result] of Object.entries(arms)) {
    const relevant = [...new Set([arm, ...protocol.arms[arm].map(state => `aa_${state}`)])];
    const reasons = [];
    for (const name of relevant) {
      if (!arms[name].inference) reasons.push(`${name}-incomplete`);
      if (arms[name].shortBatches) reasons.push(`${name}-short-batch`);
      if (name.startsWith('aa_') && arms[name].inference?.materialRoleDrift) reasons.push(`${name}-material-role-drift`);
    }
    if (status !== 'completed' || integrityComplete !== true) reasons.push(status === 'failed' ? 'run-failed' : 'final-integrity-incomplete');
    result.invalidationReasons = reasons; result.inferenceValid = reasons.length === 0;
    result.interpretation = reasons.length ? 'inference-invalid; retain raw estimates' : result.inference.classification;
  }
  return { arms, normalization: 'none', scope: 'Pointwise exploratory causal contrasts, not production acceptance or architecture attribution' };
}
