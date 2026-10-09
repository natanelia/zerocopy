import assert from 'node:assert/strict';
import { CASES as CATALOGUE } from './trie-view-workloads.mjs';
import { studyFor, CONFIG } from './trie-view-protocol.mjs';
export { CONFIG } from './trie-view-protocol.mjs';
export const CONTEXT = Object.freeze({
  baseline: '3773c6e519c7c0958da13727ed1082f449f3ee25',
  candidate: 'cda6f639faab0ef627fb97ed199864fc4cc2468a',
  runtimeEquivalent: 'c79c803bf7c59a2fc559e43ce7cc74aa4dacde15',
  publishedTimingProof: 'ac7f07a139422bd2fd6e8637c2792c38ece9c4a3',
  publishedTimingRun: '37875343311',
  isolationArchitecture: 'd016ba306375bb9e2146befa68efd112916f34b6',
  portabilityArchitecture: '4640d663eeba989ebebf0623c779ecc447b2920f',
  branch: 'proof/radix-portability-20261009',
  priorOutcome: 'x64 all-catalogue acceptance inconclusive: 15 statistically uncertain cells and one Node baseline-AA drift cell. Canonical 4096 radix entries improved 14.596% Node and 12.264% Bun. Bun empty radix +2.765% [0.708%, 4.864%] remains important.',
  scope: 'Three mechanism-selected cells per platform. Diagnostic only; no catalogue-wide acceptance, equivalence or adoption claim.',
});
export const CASE_NAMES = Object.freeze([
  'map/radix/number/4096/canonical/entries',
  'map/hamt/number/0/canonical/entries',
  'map/radix/number/0/canonical/entries',
]);
export const CASES = Object.freeze(CASE_NAMES.map(name => {
  const workload = CATALOGUE.find(row => row.name === name); assert(workload); return workload;
}));
export const LANES = Object.freeze([
  { name: 'node-arm64', runtime: 'node', arch: 'arm64', browser: false, version: '22.23.3' },
  { name: 'bun-arm64', runtime: 'bun', arch: 'arm64', browser: false, version: '1.4.2' },
  ...['chromium', 'firefox', 'webkit'].map(runtime => ({ name: `${runtime}-x64`, runtime, arch: 'x64', browser: true, playwright: '1.63.0' })),
].map(Object.freeze));
export const LIMITS = Object.freeze({ controllerMs: 25 * 60 * 1000, prerequisiteMs: 300000,
  browserSubjectMs: CONFIG.subjectTimeoutMs + 120000, archiveMs: 120000, cleanupMs: 1000,
  browserLaunchMs: 30000, browserCloseMs: 30000, correctnessMs: 90000, retries: 0 });
export function planFor(laneName) {
  const lane = LANES.find(row => row.name === laneName); assert(lane, 'Unknown lane');
  return { schema: 1, context: CONTEXT, lane, limits: LIMITS, study: studyFor(CASES),
    correctness: CASES.flatMap((workload, index) => (index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
      .map(build => ({ build, kind: 'fixture', name: workload.name })))
      .concat([false, true].flatMap((copy, index) => (index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
        .map(build => ({ build, kind: 'worker', copy, name: copy ? 'copy-growth-paused' : 'shared-growth-paused' })))),
    expected: { cells: 3, pilots: 6, measuredSubjects: 96, measuredBatches: 2016, quartets: 24 },
    resultRule: 'Every selected cell is reported. Any failure, floor miss, cleanup failure or incomplete quartet invalidates inference. AA drift invalidates its matched AB. Pointwise df=3 intervals, 2% loss margin. No retries or extra samples.' };
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
