import assert from 'node:assert/strict';
import { CONTEXT as ORIGINAL_CONTEXT, LANES as ORIGINAL_LANES, LIMITS as ORIGINAL_LIMITS, planFor as originalPlanFor } from './radix-portability-protocol.mjs';
import { CONFIG, validatePilot } from './trie-view-protocol.mjs';
export { CONFIG } from './trie-view-protocol.mjs';
export { CASES, CASE_NAMES } from './radix-portability-protocol.mjs';
export const CONTEXT = Object.freeze({ ...ORIGINAL_CONTEXT,
  protocol: 'radix-browser-recovery-v1',
  branch: 'proof/radix-browser-recovery-20261009',
  originalPortabilityProof: '44b6b88f3773731438356b4826914be12040a6b4',
  originalPortabilityTree: '0e4b88e044a350ba95324a590867b597c827ddd0',
  originalPortabilityRun: '37881676434',
  recoveryReason: 'Chromium/WebKit rejected a zero-duration repeat=1 calibration probe after positive prewarm. Firefox worker assertions passed but browser disconnect could dispose the pending worker-close listener.',
  scope: 'New browser-only prospective protocol, three fixed cells on three engines. Preserve the failed original browser study and the independent ARM study; no retries, replacements, pooling, or catalogue-wide claim.',
});
export const LANES = Object.freeze(ORIGINAL_LANES.filter(lane => lane.browser));
export const LIMITS = Object.freeze({ ...ORIGINAL_LIMITS, workerCloseMs: 30000 });
export function planFor(laneName) {
  assert(LANES.some(lane => lane.name === laneName), 'Browser recovery cannot run an ARM lane');
  return { ...originalPlanFor(laneName), context: CONTEXT, limits: LIMITS,
    browserRecovery: { calibrationStart: 'last retained positive prewarm batch repeat',
      workerClosure: 'observe exact worker close before requesting browser close',
      failedOrZeroDuration: 'fail and retain partial evidence; never skip, clamp, retry or infer closure' } };
}
export function validateRecoveryPilot(pilot) {
  const rate = validatePilot(pilot), prewarm = pilot.prewarm;
  assert(prewarm.batches.length > 0, 'Missing retained prewarm batches');
  for (const batch of prewarm.batches) {
    assert(Number.isSafeInteger(batch.repeat) && batch.repeat > 0 && batch.repeat <= CONFIG.maxRepeat);
    assert(Number.isFinite(batch.ms) && batch.ms > 0, 'Nonpositive prewarm duration');
  }
  assert.equal(prewarm.operations, prewarm.batches.reduce((sum, batch) => sum + batch.repeat, 0));
  assert.equal(prewarm.elapsedMs, prewarm.batches.reduce((sum, batch) => sum + batch.ms, 0));
  assert.equal(pilot.probes[0].repeat, prewarm.batches.at(-1).repeat, 'Calibration must start at the last retained prewarm repeat');
  return rate;
}
export function requireCI(lane, env = process.env, event) {
  assert(LANES.some(allowed => allowed.name === lane.name) && lane.browser === true, 'Browser recovery lane required');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'No local timing or browser launch');
  assert.equal(env.GITHUB_EVENT_NAME, 'push'); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GITHUB_REF, `refs/heads/${CONTEXT.branch}`);
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/); assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.equal(event.before, CONTEXT.candidate); assert.equal(event.after, env.GITHUB_SHA);
  assert.equal(event.created, false); assert.equal(event.deleted, false); assert.equal(event.forced, false);
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, lane.arch);
  assert.equal(process.versions.node, '22.23.3'); assert.deepEqual(process.execArgv, []);
  assert.equal(env.NODE_OPTIONS ?? '', ''); assert.equal(env.BUN_OPTIONS ?? '', '');
  return { proofCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: 1, lane: lane.name, protocol: CONTEXT.protocol };
}
