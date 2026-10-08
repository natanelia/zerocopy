import assert from 'node:assert/strict';
import { CONFIG } from './geometry-parent-screen-protocol.mjs';
function positiveDuration(ms) { assert.ok(Number.isFinite(ms) && ms > 0, 'Timer returned a nonpositive/nonfinite duration'); }

function fail(result, flag) {
  result.flags.push(flag);
  throw new Error(flag);
}
// Synthetic tests supply invented durations and a fake clock; production is
// wired to timedBatch/performance.now immediately below in subject().
export function runPilot(result, batch, now) {
  const prewarm = result.prewarm = { targetMs: CONFIG.pilotWarmupMs, elapsedMs: 0,
    wallElapsedMs: 0, operations: 0, batches: [], capped: false };
  result.probes = [];
  const start = now();
  let repeat = CONFIG.pilotWarmupMinCalls;
  // Pilot-only adaptation is bounded by frozen time and operation limits. It
  // stops only after BOTH the duration target and minimum call count are met.
  while (prewarm.elapsedMs < CONFIG.pilotWarmupMs || prewarm.operations < CONFIG.pilotWarmupMinCalls) {
    if (prewarm.operations + repeat > CONFIG.maxWarmupCalls) {
      prewarm.capped = true; fail(result, 'pilot prewarm work cap');
    }
    const ms = batch(repeat); positiveDuration(ms);
    prewarm.batches.push({ repeat, ms }); prewarm.operations += repeat; prewarm.elapsedMs += ms;
    prewarm.wallElapsedMs = now() - start;
    if (prewarm.wallElapsedMs > CONFIG.pilotWarmupMaxMs) {
      prewarm.capped = true; fail(result, 'pilot prewarm time cap');
    }
    repeat = Math.min(CONFIG.maxRepeat, Math.max(CONFIG.pilotWarmupMinCalls,
      Math.ceil(repeat * Math.min(8, CONFIG.pilotCalibrationTargetMs / ms))));
  }
  repeat = 1;
  for (let step = 0; step < CONFIG.pilotCalibrationSteps; step++) {
    const probe = { repeat, samples: [] };
    result.probes.push(probe);
    for (let sample = 0; sample < CONFIG.pilotSamples; sample++) {
      const ms = batch(repeat); positiveDuration(ms); probe.samples.push(ms);
    }
    // Include every completed post-prewarm sample, including the final step.
    result.estimateMsPerOperation = Math.min(...result.probes.flatMap(p => p.samples.map(ms => ms / p.repeat)));
    if (Math.min(...probe.samples) >= CONFIG.pilotCalibrationTargetMs) return;
    if (repeat === CONFIG.maxRepeat) fail(result, 'pilot calibration repeat cap');
    repeat = Math.min(CONFIG.maxRepeat, Math.max(repeat + 1,
      Math.ceil(repeat * Math.min(8, Math.max(1.2, CONFIG.pilotCalibrationTargetMs / Math.min(...probe.samples) * 1.05)))));
  }
  fail(result, 'pilot calibration step cap');
}
