import assert from 'node:assert/strict';
import { CONFIG, randomSource, shuffle, makeSchedule, summarize as originalSummarize } from './heap-entry-protocol.mjs';
import { CASES as CATALOGUE } from './heap-entry-workloads.mjs';
export { CONFIG } from './heap-entry-protocol.mjs';
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const CONTEXT = freeze({ protocol: 'heap-repair-screen-v1', branch: 'proof/heap-repair-screen-20261009',
 baseline: '3773c6e519c7c0958da13727ed1082f449f3ee25', current: '994c0fc3929f64df6303739c79f71d45252350d9', repair: '7a32ef7006a34202af7cdf5dccca3e2169abfffe',
 repairTree: '84c0f4135f3292bebf72100588aff432abefea45', transport: 'fdaed105f1016076e08bd31daf062276788122ee',
 transportTree: '23bcd3df9363fea05ee9185c7c28d4e4b3c58be2', threeArmReference: 'f14e6aff3e91d3be6d975b9397033fecd00e62ea',
 historicalFirefoxLoss: 'Current/baseline empty-next +2.8264%; retained adverse evidence, never replaced by this selected-case diagnostic.',
 scope: 'Only repair/baseline and repair/current; no current/baseline rerun, current-main integration, PR metadata edit or merge claim.' });
export const BUILDS = freeze(['baseline', 'current', 'repair']);
export const PAIRS = freeze([{ name: 'repair-baseline', left: 'baseline', right: 'repair' }, { name: 'repair-current', left: 'current', right: 'repair' }]);
export const CASE_NAMES = freeze(['number-1057-min', 'string-4097-min-ties', 'empty-next']);
export const CASES = freeze(CASE_NAMES.map(name => { const workload = CATALOGUE.find(row => row.name === name); assert(workload); return workload; }));
export const LANE = freeze({ name: 'firefox-x64', runtime: 'firefox', platform: 'linux', arch: 'x64', browser: true, version: '155.0', browserRevision: '1543', playwright: '1.63.0', controllerNode: '22.23.3', defaultFlags: true });
export const LIMITS = freeze({ controllerMs: 3600000, prerequisiteTotalMs: 3600000, prerequisiteMs: 300000, browserSubjectMs: 240000, browserLaunchMs: 30000, browserCloseMs: 30000, workerCloseMs: 30000, correctnessMs: 90000, archiveMs: 120000, retries: 0 });
export function planFor(laneName = LANE.name) {
 assert.equal(laneName, LANE.name); const random = randomSource(CONFIG.seed);
 const cases = shuffle(CASES, random), pilotBase = shuffle(BUILDS, random);
 const cells = cases.flatMap(workload => PAIRS.map(pair => ({ name: workload.name + '/' + pair.name, workload, pair, schedule: makeSchedule(random) })));
 const pilots = cases.flatMap((workload, i) => [...pilotBase.slice(i), ...pilotBase.slice(0, i)].map(build => ({ phase: 'pilot', workload: workload.name, build })));
 const correctness = cases.flatMap(workload => BUILDS.map(build => ({ phase: 'correctness', kind: 'fixture', workload: workload.name, build })))
  .concat([false, true].flatMap(copy => BUILDS.map(build => ({ phase: 'correctness', kind: 'worker', copy, build }))));
 const measured = [];
 for (let block = 0; block < CONFIG.quartets; block++) for (const cell of shuffle(cells, random)) for (const quartet of cell.schedule.filter(x => x.block === block))
  for (const [sequence, role] of quartet.roles.entries()) measured.push({ cell: cell.name, workload: cell.workload.name, mode: quartet.mode, block, sequence, role, build: quartet.mode === 'ab' ? cell.pair[role] : cell.pair.left });
 return freeze({ schema: 1, context: CONTEXT, lane: LANE, config: CONFIG, limits: LIMITS, cases, pilots, correctness, cells, measured,
  expected: { cases: 3, pairwiseCells: 6, pilots: 9, correctness: 15, quartets: 48, measuredSubjects: 192, measuredBatches: 4032, totalBrowserSubjects: 216 },
  scheduling: { globalThreeArmCorrectnessBarrier: true, allPilotsBeforeMeasurement: true, commonPlanPerCase: true, freshBrowserPerSubject: true, retries: 0 },
  slots: { firefoxNfixed: null, firefoxNslots: null, actualAllocationSize: null, allocationBucket: null, status: 'unmeasured; effect-only screen; V8 measurements are not Firefox measurements' } });
}
export function requireCI(lane, env = process.env, event) {
 assert.deepEqual(lane, LANE); assert.equal(env.GITHUB_ACTIONS, 'true', 'No local timing or browser launch');
 assert.equal(env.GITHUB_EVENT_NAME, 'push'); assert.equal(env.GITHUB_RUN_ATTEMPT, '1'); assert.equal(env.GITHUB_REF, `refs/heads/${CONTEXT.branch}`);
 assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/); assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/);
 assert.equal(event.before, CONTEXT.repair); assert.equal(event.after, env.GITHUB_SHA); assert.equal(event.created, false); assert.equal(event.deleted, false); assert.equal(event.forced, false);
 assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.versions.node, '22.23.3'); assert.deepEqual(process.execArgv, []);
 assert.equal(env.NODE_OPTIONS ?? '', ''); assert.equal(env.BUN_OPTIONS ?? '', ''); assert.equal(env.HEAP_REPAIR_EFFECT_ONLY_REVIEW, 'accepted', 'Exact-tree review must accept effect-only scope before execution');
 return { proofCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: 1, lane: lane.name, effectOnlyReview: 'accepted' };
}
export function validatePilot(subject) {
  assert.equal(subject.status, 'passed'); assert.equal(subject.phase, 'pilot'); assert.deepEqual(subject.invalid, []); assert.equal(subject.capped, false);
  assert(Number.isSafeInteger(subject.repeat) && subject.repeat > 0 && subject.repeat <= CONFIG.repeatLimit);
  assert(Number.isFinite(subject.minMsPerIteration) && subject.minMsPerIteration > 0);
  assert.equal(subject.warmup.capped, false); assert(subject.warmup.ms >= CONFIG.warmupFloorMs);
  assert(subject.calibration.length > 0 && subject.calibration.length <= 16);
  const last = subject.calibration.at(-1); assert.equal(last.repeat, subject.repeat);
  assert.equal(last.samples.length, 3); assert(last.samples.every(ms => Number.isFinite(ms) && ms > 0));
  assert.equal(Math.min(...last.samples) / last.repeat, subject.minMsPerIteration);
  assert(Math.min(...last.samples) >= CONFIG.batchTargetMs * 1.25);
  assert.deepEqual(subject.progress.calibration, subject.calibration); assert.deepEqual(subject.progress.warmup, subject.warmup);
}
export function validateMeasured(subject, plan) {
  assert.equal(subject.status, 'passed'); assert.equal(subject.phase, 'measure');
  assert.equal(subject.repeat, plan.repeat); assert.equal(subject.prescribedWarmupScans, plan.warmupScans);
  assert.deepEqual(subject.expected, plan.expected); assert.deepEqual(subject.identity, plan.identity);
  assert.equal(subject.samples.length, 21); assert(subject.samples.every(ms => Number.isFinite(ms) && ms > 0));
  assert.deepEqual(subject.progress.samples, subject.samples); assert.deepEqual(subject.progress.warmup, subject.warmup);
  const invalid = [...(subject.warmup.capped ? ['warmup-capped'] : []), ...(subject.warmup.scans !== plan.warmupScans ? ['warmup-work-short'] : []),
    ...(subject.warmup.ms < CONFIG.warmupFloorMs ? ['warmup-below-floor'] : []), ...(subject.samples.some(ms => ms < CONFIG.batchFloorMs) ? ['sample-below-floor'] : [])];
  assert.deepEqual(subject.invalid, invalid);
  assert.deepEqual(subject.targetMisses, { batches: subject.samples.filter(ms => ms < CONFIG.batchTargetMs).length, warmup: subject.warmup.ms < CONFIG.warmupTargetMs });
}
export function freezePlan(pilots) {
 assert.equal(pilots.length, 3); assert.deepEqual(pilots.map(p => p.build).sort(), [...BUILDS]);
 pilots.forEach(validatePilot);
 for (const pilot of pilots) { assert.deepEqual(pilot.expected, pilots[0].expected, 'pilot oracle differs by arm'); assert.deepEqual(pilot.identity, pilots[0].identity, 'fixture bytes or descriptors differ by arm'); }
 const repeat = Math.max(...pilots.map(p => p.repeat)), fastest = Math.min(...pilots.map(p => p.minMsPerIteration));
 const warmupScans = Math.ceil((CONFIG.warmupTargetMs * 1.25 / fastest) / repeat) * repeat;
 assert(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= CONFIG.repeatLimit); assert(Number.isSafeInteger(warmupScans) && warmupScans > 0);
 return { repeat, warmupScans, fastestPilotMsPerIteration: fastest, expected: pilots[0].expected, identity: pilots[0].identity };
}
export function summarize(row) {
 assert(PAIRS.some(pair => pair.name === row.pair.name && pair.left === row.pair.left && pair.right === row.pair.right));
 const sequences = new Set();
 for (const block of row.blocks) {
  const planned = row.schedule.find(q => q.mode === block.mode && q.block === block.block); assert(planned, 'Unexpected quartet'); assert.deepEqual(block.roles, planned.roles);
  assert(row.blocks.filter(q => q.mode === block.mode && q.block === block.block).length === 1, 'Duplicate quartet');
  assert(block.subjects.length <= 4);
  for (const [slot, subject] of block.subjects.entries()) {
   assert.equal(subject.role, planned.roles[slot]); assert.equal(subject.build, block.mode === 'ab' ? row.pair[subject.role] : row.pair.left);
   assert(Number.isSafeInteger(subject.sequence)); assert(!sequences.has(subject.sequence), 'Reused measured subject'); sequences.add(subject.sequence);
  }
 }
 const summary = originalSummarize(row);
 summary.modes.ab.ratio = row.pair.right + '/' + row.pair.left;
 summary.modes['aa-baseline'].ratio = row.pair.left + '-right/' + row.pair.left + '-left';
 summary.matchedAA = row.pair.left + '/' + row.pair.left;
 return summary;
}
export function diagnosticOutcome(rows, complete) {
 if (!complete || rows.length !== 6 || new Set(rows.map(row => row.name)).size !== 6) return 'incomplete';
 if (rows.some(row => row.summary.usable && row.summary.modes.ab.interval.lower > CONFIG.margin)) return 'hold-material-loss';
 if (rows.some(row => !row.summary.usable)) return 'hold-invalid-cells';
 if (rows.some(row => row.summary.modes.ab.interval.upper > CONFIG.margin)) return 'hold-inconclusive-cells';
 if (rows.filter(row => row.pair.name === 'repair-baseline' && row.workload.name !== 'empty-next').some(row => row.summary.modes.ab.interval.upper >= CONFIG.gainThreshold)) return 'hold-large-gains-unestablished';
 const empty = rows.find(row => row.pair.name === 'repair-current' && row.workload.name === 'empty-next');
 if (!(empty?.summary.modes.ab.interval.upper < 1)) return 'hold-empty-repair-unestablished';
 return 'positive-selected-case-effect-only';
}
