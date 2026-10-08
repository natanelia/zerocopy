import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASES, runChecks, checkBrowserWorkers } from './block-traversal-workloads.mjs';
import { sha256 } from './block-traversal-source.mjs';
import { PIN, verifyHelpers } from './block-traversal-empty-controls.mjs';

export const SUPPLEMENT = Object.freeze({
  run: '37840231430', proofCommit: 'e58e49f5bb981257d2403ed4b7d9aebf5b8d9ec6',
  artifact: '11577770777', zipSha256: 'b228e45627f7156bea0320374a0e8e3b6d000aa50de3b856a89d3a9c2ce2dfe0',
  chromiumJob: '113528465037',
});
export const CONTEXT = Object.freeze({
  original: 'One Chromium browser process per source: all 40 fixtures, then all 6 worker scenarios. Baseline worker compactMany failed with WebAssembly.Memory allocation RangeError after fixture checks. The candidate was not reached in that Chromium job.',
  diagnostic: 'One fresh Chromium browser process per individual fixture or worker scenario; 46 scenarios per source, 92 processes. Sources alternate AB/BA by scenario, without retries. The original assertions and case sizes are retained. An observational API/Worker wrapper records transport and cleanup; no browser flags or timing study are added.',
  interpretation: 'The original Chromium failure remains a failure in its original context. This separate context can establish correctness under process isolation only. It cannot identify the allocation failure cause, erase original evidence, establish performance, or authorize adoption.',
});
export const WORKER_CASES = Object.freeze(['linked', 'doubly'].flatMap(kind => [false, true].flatMap(copy =>
  (kind === 'doubly' ? [false, true] : [false]).map(reverse => Object.freeze({ kind, copy, reverse,
    name: `${kind}/${copy ? 'copy' : 'shared'}/${reverse ? 'reverse' : 'forward'}` })))));
export const SCENARIOS = Object.freeze([
  ...CASES.map(workload => Object.freeze({ type: 'fixture', name: workload.name, workload })),
  ...WORKER_CASES.map(workload => Object.freeze({ type: 'worker', name: workload.name, workload })),
]);
export function schedule() {
  return SCENARIOS.flatMap((scenario, index) => (index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
    .map((role, position) => ({ sequence: index * 2 + position, scenarioIndex: index, position, role, ...scenario })));
}
export const REPLACEMENTS = Object.freeze([
  { original: runChecks.toString(), changes: [
    ['async function runChecks(S)', 'async function runSingleFixture(S, selectedWorkload)'],
    ['for (const workload of CASES) {', 'for (const workload of [selectedWorkload]) {'],
  ] },
  { original: checkBrowserWorkers.toString(), changes: [
    ['async function checkBrowserWorkers(S, module, workerUrl)', 'async function runSingleWorker(S, module, workerUrl, selectedWorkload)'],
    ["for (const kind of ['linked', 'doubly']) for (const copy of [false, true]) for (const reverse of kind === 'doubly' ? [false, true] : [false]) {", 'for (const { kind, copy, reverse } of [selectedWorkload]) {'],
  ] },
]);
export function replaceExactlyOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one exact selector: ${before}`);
  return source.replace(before, after);
}
export function deriveModule() {
  verifyHelpers();
  const original = readFileSync(new URL('./block-traversal-workloads.mjs', import.meta.url), 'utf8');
  assert.equal(sha256(original), PIN.helpers['block-traversal-workloads.mjs']);
  const functions = REPLACEMENTS.map(({ original: body, changes }) => {
    assert(original.includes(body), 'Function must be an exact original source substring');
    return changes.reduce((source, [before, after]) => replaceExactlyOnce(source, before, after), body);
  });
  return { source: original + '\n// Derived selectors only; the original functions above remain unchanged.\n' + functions.map(body => `export ${body}\n`).join('\n'),
    originalSha256: sha256(original), functions,
    transformations: REPLACEMENTS.map(({ original: body, changes }, index) => ({ originalFunctionSha256: sha256(body), derivedFunctionSha256: sha256(functions[index]), changes })) };
}
export function coverage() {
  return { perSource: { fixtures: CASES.length, workers: WORKER_CASES.length,
    fixtureGrowthChecks: CASES.filter(c => c.size > 32).length, fixtureGrowthPages: 1,
    fixtureTransports: CASES.length * 2, fixtureSharedTransports: CASES.length, fixtureCopyTransports: CASES.length,
    fixtureReadOnlyRejections: CASES.filter(c => c.size > 0).length * 2,
    retainedEditedFixtures: CASES.filter(c => c.edited).length,
    noteOnRetainedFixtures: 'fixture() retains the pre-edit item; original runChecks does not independently assert retained. This diagnostic adds no replacement assertion.',
    workerItems: 129, workerForkItems: 130, nestedSnapshotsPerWorker: 65,
    nestedSnapshotChecksPerWorker: 130, workerGrowthPagesPerArena: 2,
    workerSharedTransports: WORKER_CASES.filter(c => !c.copy).length,
    workerCopyTransports: WORKER_CASES.filter(c => c.copy).length,
    workerReadOnlyRejections: WORKER_CASES.length, workerPauses: WORKER_CASES.length },
    totalProcesses: schedule().length, scenarioCount: SCENARIOS.length,
    sourceFirstPositions: { baseline: 23, candidate: 23 } };
}
