// Synthetic orchestration and recorded-input tests only. Never launch Firefox or execute timings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { INFRASTRUCTURE, verifyBudget } from './heap-repair-screen-budget.mjs';
import { CONFIG, CONTEXT, BUILDS, LANE, LIMITS, planFor, freezePlan, summarize, diagnosticOutcome, requireCI, validateMeasured } from './heap-repair-screen-protocol.mjs';
import { CHECKS, executeStudy, requireGlobalBarrier, validateCorrectness, runPrerequisites, verifyProspective } from './heap-repair-screen-runner.mjs';
import { interval, controlDrift } from './heap-entry-protocol.mjs';
import { deriveBrowser, section } from './heap-portability-adapter.mjs';
import { observeWorkers, validateBrowserLifecycle } from './heap-portability-lifecycle.mjs';
import { sha256 } from './heap-repair-screen-source.mjs';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const success = () => ({ status: 0, signal: null, error: null, timedOut: false, interrupted: null, cleanup: { status: 'verified-no-live-processes', survivors: [] } });
function ready() {
 const plan = planFor(), record = { plan, rows: [], pilots: [], correctness: [], prerequisites: { status: 'passed', receipts: BUILDS.flatMap(build => CHECKS.map(check => ({ build, ...check, receipt: success() }))) } };
 record.correctness = plan.correctness.map(task => {
  const result = { status: 'passed', build: task.build, sequence: 0 };
  if (task.kind === 'fixture') Object.assign(result, { workload: task.workload, expected: {}, identity: {} });
  else {
   Object.assign(result, { generator: {}, copy: task.copy, actualWorkers: 1, rows: [0, 33, 65, 1057, 4097].map(size => ({ size, type: 'number', maxHeap: false, ...Object.fromEntries(['expected', 'result'].map(key => {
    const visits = size * (key === 'result' ? 2 : 1), count = { getters: task.build === 'baseline' ? 3 * visits : 0, refreshes: task.build === 'baseline' ? 3 * visits : 0, decodes: visits }; return [key, { count, values: [] }];
   })) })) });
   for (const key of ['generatorLazyAccess', 'customDecoderOrderReceiverReentrantGrowthExceptions', 'sharedCopyMarkers', 'growthBeforeFirstNextAndWhilePaused', 'bytesStateDescriptorsUnchanged']) result[key] = true;
  }
  return { ...task, result };
 });
 record.correctnessSha256 = sha256(JSON.stringify(record.correctness)); return record;
}
const pilot = (build, repeat = 10, ms = 60) => {
 const warmup = { scans: repeat * 10, ms: 600, batches: [{ repeat: repeat * 10, ms: 600 }], capped: false, wallMs: 600 }, calibration = [{ repeat, samples: [ms, ms, ms] }];
 return { status: 'passed', phase: 'pilot', build, expected: {}, identity: {}, invalid: [], repeat, minMsPerIteration: ms / repeat, capped: false, warmup, calibration, progress: { warmup, calibration } };
};
function measurement(build, request, sequence, ms = 60) {
 const warmup = { scans: request.warmupScans, ms: 660, capped: false }, samples = Array(21).fill(ms);
 return { status: 'passed', phase: 'measure', build, sequence, repeat: request.repeat, prescribedWarmupScans: request.warmupScans, expected: {}, identity: {}, warmup, samples, invalid: ms < 10 ? ['sample-below-floor'] : [], targetMisses: { batches: ms < 40 ? 21 : 0, warmup: false }, progress: { warmup, samples } };
}
test('exact retained prospective schedule, workloads and counts', () => {
 const plan = planFor(), retained = JSON.parse(read('heap-repair-screen-history/prospective-plan.json'));
 for (const key of ['pilots', 'correctness', 'cells', 'measured', 'expected']) assert.deepEqual(plan[key], retained[key]);
 assert.deepEqual(plan, planFor()); assert.equal(plan.measured.length, 192); assert.equal(plan.measured.length * CONFIG.samples, 4032); assert.equal(plan.pilots.length, 9); assert.equal(plan.correctness.length, 15);
 assert.deepEqual(plan.cells.map(row => row.pair.name).sort(), ['repair-baseline', 'repair-baseline', 'repair-baseline', 'repair-current', 'repair-current', 'repair-current']);
 for (const cell of plan.cells) for (const mode of ['ab', 'aa-baseline']) assert.deepEqual(cell.schedule.filter(row => row.mode === mode).map(row => row.roles.map(s => s[0]).join('')).sort(), ['lrrl', 'lrrl', 'rllr', 'rllr']);
 for (let slot = 0; slot < 3; slot++) assert.deepEqual([0, 1, 2].map(i => plan.pilots[i * 3 + slot].build).sort(), [...BUILDS]);
});
test('frozen margin, pointwise df3, budgets, no retry or workload substitution', () => {
 assert.deepEqual([CONFIG.confidence, CONFIG.df, CONFIG.tCritical, CONFIG.margin, CONFIG.gainThreshold], [.95, 3, 3.182446305284263, 1.02, .98]);
 assert.deepEqual([CONFIG.batchTargetMs, CONFIG.batchFloorMs, CONFIG.warmupTargetMs, CONFIG.warmupFloorMs, CONFIG.repeatLimit, CONFIG.pilotWarmupLimitMs], [40, 10, 500, 150, 10000000, 10000]);
 assert.equal(LIMITS.controllerMs, 3600000); assert.equal(LIMITS.prerequisiteTotalMs, 3600000); assert.equal(LIMITS.retries, 0); assert.equal(LIMITS.browserSubjectMs, 240000);
 assert.equal(CONTEXT.repair, '7a32ef7006a34202af7cdf5dccca3e2169abfffe'); assert.equal(LANE.version, '155.0'); assert.match(CONTEXT.historicalFirefoxLoss, /2\.8264/);
 assert.equal(planFor().slots.firefoxNslots, null);
});
test('three-arm common plan uses maximum repeat and fastest retained pilot', () => {
 const pilots = [pilot('baseline', 10, 60), pilot('current', 20, 60), pilot('repair', 30, 60)];
 const plan = freezePlan(pilots); assert.equal(plan.repeat, 30); assert.equal(plan.warmupScans, 330);
 assert.throws(() => freezePlan(pilots.slice(1))); assert.throws(() => freezePlan([pilots[0], pilots[0], pilots[2]]));
 assert.throws(() => freezePlan(pilots.map(p => ({ ...p, identity: p.build === 'repair' ? { changed: true } : {} }))));
 assert.throws(() => freezePlan(pilots.map(p => ({ ...p, repeat: CONFIG.repeatLimit + 1 }))));
});
test('full three-arm standard gates fail closed; no changed command or test concurrency', async () => {
 const roots = Object.fromEntries(BUILDS.map(build => [build, build])), calls = [], events = [];
 const result = await runPrerequisites(roots, async (build, check) => { calls.push({ build, ...check }); return success(); }, build => events.push('before:' + build), build => events.push('after:' + build), () => {});
 assert.equal(result.receipts.length, 3 * CHECKS.length); assert.deepEqual(events, BUILDS.flatMap(build => ['before:' + build, 'after:' + build]));
 assert.deepEqual(CHECKS.find(row => row.id === 'test').command, ['bun', 'run', 'test']);
 let executed = 0, archived = false;
 await assert.rejects(runPrerequisites(roots, async (_, check) => { executed++; return check.id === 'test' ? { ...success(), status: 1 } : success(); }, () => {}, () => { archived = true; }, () => {}));
 assert(archived); assert.equal(executed, CHECKS.findIndex(row => row.id === 'test') + 1);
});
test('global barrier rejects missing suite, cache-changed command, semantic mismatch and missing Firefox subject', () => {
 requireGlobalBarrier(ready());
 for (const mutate of [r => { r.prerequisites.status = 'failed'; }, r => { r.prerequisites.receipts.pop(); }, r => { r.prerequisites.receipts[0].command = ['other']; }, r => { r.correctness.pop(); }, r => { r.correctness.find(row => row.build === 'repair' && row.kind === 'fixture').result.expected.changed = true; }]) {
  const record = ready(); mutate(record); assert.throws(() => requireGlobalBarrier(record));
 }
});
test('all 15 semantics before exactly 9 pilots and 192 unique measurements; plan freezes once', async () => {
 const record = ready(), calls = []; let frozen = false;
 await executeStudy(record, record.plan, async (build, request) => {
  const sequence = calls.length; calls.push({ build, request });
  if (request.phase === 'pilot') { assert(!frozen); return { ...pilot(build), sequence }; }
  assert(frozen); return measurement(build, request, sequence);
 }, () => {}, plans => { assert.equal(calls.length, 9); assert.equal(plans.length, 3); assert(!frozen); frozen = true; });
 assert.equal(calls.length, 201); assert(calls.slice(0, 9).every(row => row.request.phase === 'pilot')); assert(calls.slice(9).every(row => row.request.phase === 'measure'));
 assert.equal(record.rows.flatMap(row => row.blocks.flatMap(block => block.subjects)).length, 192); assert.equal(diagnosticOutcome(record.rows, true), 'hold-large-gains-unestablished');
});
test('pilot failure retains partial record and starts zero measurements', async () => {
 const record = ready(), calls = [];
 await assert.rejects(executeStudy(record, record.plan, async (build, request) => { calls.push(request); if (calls.length === 3) throw new Error('failure'); return pilot(build); }, () => {}, () => assert.fail('Must not freeze')), /failure/);
 assert.equal(record.pilots.length, 2); assert.equal(calls.length, 3); assert(calls.every(row => row.phase === 'pilot')); assert(record.rows.every(row => row.blocks.length === 0));
});
test('measured floor failure retains exact subject and stops without retries or replacement', async () => {
 const record = ready(), calls = [];
 await assert.rejects(executeStudy(record, record.plan, async (build, request) => { const sequence = calls.length; calls.push(request); return request.phase === 'pilot' ? pilot(build) : measurement(build, request, sequence, 5); }, () => {}, () => {}), /Measured duration floor/);
 assert.equal(calls.length, 10); const subjects = record.rows.flatMap(row => row.blocks.flatMap(block => block.subjects)); assert.equal(subjects.length, 1); assert.deepEqual(subjects[0].samples, Array(21).fill(5));
});
test('quartet estimator preserves wide AA caveat and original 2% drift rule', () => {
 assert.equal(interval([0, 0, 0]).classification, 'incomplete'); const ci = interval([.01, .02, .03, .04]);
 const half = CONFIG.tCritical * Math.sqrt((.0005 / 3) / 4); assert(Math.abs(ci.upper - Math.exp(.025 + half)) < 1e-12);
 assert(controlDrift(interval(Array(4).fill(Math.log(1.03))))); assert(!controlDrift(interval([-.1, .1, -.1, .1])));
});
test('actual fixture, scan, sink and transport closure remain original bytes', () => {
 const derived = deriveBrowser(), original = read('heap-entry-subject.mjs'); assert.equal(section(derived.subject.source, '  const timed = repeat => {', '  const warm ='), section(original, '  const timed = repeat => {', '  const warm ='));
 const old = read('heap-portability-browser.mjs'), fresh = read('heap-repair-screen-browser.mjs');
 assert.equal(section(old, "    checkpoint('worker-close');", "    result.status = 'completed';"), section(fresh, "    checkpoint('worker-close');", '    result.processIdentity.push'));
});
test('exact worker closure is required before browser closure; extra workers fail', async () => {
 const page = new EventEmitter(), receipts = [], worker = new EventEmitter(); worker.url = () => 'exact'; const observer = observeWorkers(page, receipts); page.emit('worker', worker);
 const barrier = {}, pending = observer.waitForClose(1, 1000, barrier); assert.equal(barrier.completed, false); worker.emit('close'); await pending; assert.equal(barrier.completed, true);
 await assert.rejects(observer.waitForClose(0, 1000, {}));
 assert.throws(() => validateBrowserLifecycle({ status: 'completed', workers: receipts, workerCloseBarrier: { completed: false } }, { kind: 'worker' }, 30000));
});
test('local launch/timing admission is rejected and prospective file hashes verify', () => {
 assert.throws(() => requireCI(LANE, {}, {}), /No local timing or browser launch/); assert.match(verifyProspective(), /^[a-f0-9]{64}$/);
});
test('positive selected-case effects require large gains and empty repair; AA drift stays pair-specific', async () => {
 const record = ready(); let sequence = 0;
 await executeStudy(record, record.plan, async (build, request) => request.phase === 'pilot' ? pilot(build) : measurement(build, request, sequence++, build === 'repair' ? (request.name === 'empty-next' ? 58.5 : 54) : 60), () => {}, () => {});
 assert.equal(diagnosticOutcome(record.rows, true), 'positive-selected-case-effect-only');
 const current = record.rows.find(row => row.pair.name === 'repair-current' && row.workload.name === 'empty-next');
 for (const block of current.blocks.filter(block => block.mode === 'aa-baseline')) for (const subject of block.subjects) if (subject.role === 'right') subject.samples = subject.samples.map(ms => ms * 1.03);
 current.summary = summarize(current); assert.equal(current.summary.usable, false); assert(current.summary.invalid.includes('matched-AA-drift'));
 assert(record.rows.filter(row => row.pair.name === 'repair-baseline').every(row => row.summary.usable)); assert.equal(diagnosticOutcome(record.rows, true), 'hold-invalid-cells');
});
test('outer job envelope protects packaging/upload without extending scientific phase budgets', () => {
 assert.deepEqual(verifyBudget(), { totalStepMinutes: 174, scientificPhaseMinutes: 120, preArtifactMaximumMinutes: 159, artifactReserveMinutes: 15, unallocatedReserveMinutes: 6, jobMinutes: 180 });
 const workflow = read('../.github/workflows/heap-repair-screen.yml');
 assert.deepEqual([...workflow.matchAll(/timeout-minutes: (\d+)/g)].map(row => Number(row[1])), [180, ...Object.values(INFRASTRUCTURE.stepMinutes)]);
 assert(workflow.includes('timeout --signal=TERM --kill-after=30s 7320s node proofs/heap-repair-screen-runner.mjs run'));
});
