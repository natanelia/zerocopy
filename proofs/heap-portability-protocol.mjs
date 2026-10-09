import assert from 'node:assert/strict';
import { CASES as ORIGINAL_CASES } from './heap-entry-workloads.mjs';
import { CONFIG, randomSource, shuffle, makeSchedule } from './heap-entry-protocol.mjs';
export { CONFIG } from './heap-entry-protocol.mjs';
export const CONTEXT = Object.freeze({
  baseline: '3773c6e519c7c0958da13727ed1082f449f3ee25',
  candidate: '994c0fc3929f64df6303739c79f71d45252350d9',
  candidateTree: '7eac99fc07b61f7731ec68cede2a2e878432f46e',
  runtimeEquivalent: '4dea268e4c64acac832bb310efc83de597b27abc',
  originalProof: 'cdcbab425fb6b3ff2f648f9d222e965dc5682783',
  originalProofTree: '3ed54c7f4d873b5a033b0950ddee867f8a382df0',
  originalRun: '37873278465', originalArtifact: '11592629063',
  correctedBrowserTransport: '7fe90c039ef6fdfa3f1bac85655df7b9979ab63c',
  correctedBrowserTransportTree: 'b3fa6631efbec2f926b153ca69ff837262622285',
  publishedBrowserRecovery: '8b8e6d78ee444ce07b1ee59a652106e0221c7a69',
  browserRecoveryRun: '37882888216',
  branch: 'proof/heap-entry-portability-20261009',
  priorOutcome: 'hold-invalid-cells: Node empty-full, Node empty-next and Bun empty-next remain inconclusive; Node nested-65-first-close remains invalid due to baseline-AA drift. All 14 original large full-consumption cells showed valid gains.',
  scope: 'Three selected cases on five new lanes; diagnostic only. No universal speedup, full-screen clearance, resolution of original controls, or automatic publication.',
});
export const CASE_NAMES = Object.freeze(['number-1057-min', 'string-4097-min-ties', 'empty-next']);
export const CASES = Object.freeze(CASE_NAMES.map(name => {
  const workload = ORIGINAL_CASES.find(row => row.name === name); assert(workload); return workload;
}));
export const LANES = Object.freeze([
  { name: 'node-arm64', runtime: 'node', arch: 'arm64', browser: false, version: '22.23.3' },
  { name: 'bun-arm64', runtime: 'bun', arch: 'arm64', browser: false, version: '1.4.2' },
  ...['chromium', 'firefox', 'webkit'].map(runtime => ({ name: `${runtime}-x64`, runtime, arch: 'x64', browser: true, playwright: '1.63.0' })),
].map(Object.freeze));
export const LIMITS = Object.freeze({ controllerMs: 25 * 60 * 1000, prerequisiteMs: 300000,
  browserSubjectMs: 240000, browserLaunchMs: 30000, browserCloseMs: 30000, workerCloseMs: 30000,
  correctnessMs: 90000, archiveMs: 120000, retries: 0 });
export function planFor(laneName) {
  const lane = LANES.find(row => row.name === laneName); assert(lane, 'Unknown lane');
  const random = randomSource(CONFIG.seed);
  const rows = shuffle(CASES, random).map(workload => ({ workload,
    pilotOrder: shuffle(['baseline', 'candidate'], random), schedule: makeSchedule(random) }));
  const correctness = CASES.flatMap((workload, index) => (index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
    .map(build => ({ build, kind: 'fixture', name: workload.name })))
    .concat([false, true].flatMap((copy, index) => (index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
      .map(build => ({ build, kind: 'worker', copy, name: copy ? 'copied-heap-semantics' : 'shared-heap-semantics' }))));
  return { schema: 1, context: CONTEXT, lane, limits: LIMITS, config: CONFIG, rows, correctness,
    expected: { cells: 3, pilots: 6, measuredSubjects: 96, measuredBatches: 2016, quartets: 24, correctness: 10 },
    resultRule: 'Retain every cell and failure. Four quartet effects define each pointwise df=3 interval. Matched AA drift invalidates AB, without adjustment. No retries or extra samples.' };
}
export function requireCI(lane, env = process.env, event) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'No local timing or browser launch');
  assert.equal(env.GITHUB_EVENT_NAME, 'push'); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GITHUB_REF, `refs/heads/${CONTEXT.branch}`);
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/); assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.equal(event.before, CONTEXT.candidate); assert.equal(event.after, env.GITHUB_SHA);
  assert.equal(event.created, false); assert.equal(event.deleted, false); assert.equal(event.forced, false);
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, lane.arch);
  assert.equal(process.versions.node, '22.23.3'); assert.deepEqual(process.execArgv, []);
  assert.equal(env.NODE_OPTIONS ?? '', ''); assert.equal(env.BUN_OPTIONS ?? '', '');
  return { proofCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: 1, lane: lane.name };
}
export function diagnosticOutcome(rows, complete) {
  if (!complete || rows.length !== CASES.length || new Set(rows.map(row => row.workload.name)).size !== CASES.length) return 'incomplete';
  if (rows.some(row => row.summary.usable && row.summary.modes.ab.interval.lower > CONFIG.margin)) return 'diagnostic-material-loss';
  if (rows.some(row => !row.summary.usable)) return 'diagnostic-invalid-cells';
  if (rows.some(row => row.summary.modes.ab.interval.upper > CONFIG.margin)) return 'diagnostic-inconclusive-cells';
  return 'selected-cells-within-margin-only';
}
