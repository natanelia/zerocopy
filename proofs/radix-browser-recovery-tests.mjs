// Deterministic synthetic tests only. No browser, real workload or latency loop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CONTEXT, LANES, LIMITS, CONFIG, planFor, requireCI, validateRecoveryPilot } from './radix-browser-recovery-protocol.mjs';
import { planFor as originalPlan, CONTEXT as ORIGINAL_CONTEXT } from './radix-portability-protocol.mjs';
import { verifyProspective as verifyOriginal } from './radix-portability-runner.mjs';
import { prospectiveManifest, executeStudy } from './radix-browser-recovery-runner.mjs';
import { deriveBrowser, CALIBRATION_EDITS, section } from './radix-browser-recovery-adapter.mjs';
import { deriveBrowser as deriveOriginal, replaceOnce } from './radix-portability-adapter.mjs';
import { runPilot as originalPilot, runFixedMeasure as originalMeasure } from './trie-view-subject.mjs';
import { observeWorkers, validateBrowserLifecycle } from './radix-browser-recovery-lifecycle.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
async function withAdapted(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'radix-browser-recovery-synthetic-'));
  try {
    const derived = deriveBrowser();
    for (const [file, kind] of [['subject','subject'], ['workloads','workload'], ['shims','shims']]) writeFileSync(join(directory, `${file}.mjs`), derived[kind].source);
    return await callback(await import(pathToFileURL(join(directory, 'subject.mjs'))));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function fakeWorker(url = 'http://127.0.0.1:4173/proofs/trie-view-worker.mjs') {
  const worker = new EventEmitter(); worker.url = () => url; return worker;
}
function fakeLifecycle() {
  const page = new EventEmitter(), workers = [], receipt = { completed: false };
  return { page, workers, receipt, observer: observeWorkers(page, workers) };
}
test('original failed study files and manifest remain frozen and independently verifiable', () => {
  assert.equal(verifyOriginal(), hash(read('radix-portability-manifest.json')));
  assert.equal(CONTEXT.originalPortabilityProof, '44b6b88f3773731438356b4826914be12040a6b4');
  assert.equal(CONTEXT.originalPortabilityRun, '37881676434');
  assert.notEqual(CONTEXT.branch, ORIGINAL_CONTEXT.branch);
});
test('only three browser lanes; all cases, orders, prerequisites and statistics retain the original protocol', () => {
  assert.deepEqual(LANES.map(lane => lane.name), ['chromium-x64', 'firefox-x64', 'webkit-x64']);
  for (const lane of LANES) {
    const plan = planFor(lane.name), original = originalPlan(lane.name);
    for (const key of ['lane', 'study', 'correctness', 'expected', 'resultRule']) assert.deepEqual(plan[key], original[key]);
    assert.equal(plan.correctness.length, 10); assert.equal(plan.study.rows.length, 3);
  }
  for (const name of ['node-arm64', 'bun-arm64']) assert.throws(() => planFor(name), /cannot run an ARM lane/);
  assert.equal(LIMITS.workerCloseMs, 30000); assert.equal(LIMITS.retries, 0);
  const prospective = prospectiveManifest();
  assert.deepEqual(prospective.expectedTotal, { lanes: 3, cells: 9, pilots: 18, measuredSubjects: 288, measuredBatches: 6048, quartets: 72 });
  assert.equal(prospective.originalManifestSha256, verifyOriginal());
});
test('reversible calibration exception preserves timedBatch, fixed measurement and fixture execute bytes', () => {
  const adapted = deriveBrowser(), original = deriveOriginal(), subject = read('trie-view-subject.mjs');
  for (const name of ['workload','worker','parent','shims']) assert.deepEqual(adapted[name], original[name]);
  let reversed = adapted.subject.source;
  for (const [before, after] of [...adapted.subject.receiptEdits, ...CALIBRATION_EDITS].reverse()) reversed = replaceOnce(reversed, after, before);
  assert.equal(reversed, original.subject.source);
  assert.equal(adapted.subject.originalAdapterSha256, hash(original.subject.source));
  assert.notEqual(adapted.subject.originalTimedCoreSha256, adapted.subject.derivedTimedCoreSha256);
  for (const [name, start, end] of [
    ['timedBatch', 'function timedBatch(', 'function fail('],
    ['fixedMeasure', 'export function runFixedMeasure(', 'export async function subject'],
    ['positiveDuration', 'function positiveDuration(', '\n\n// Timed bodies'],
  ]) {
    const expected = section(subject, start, end);
    assert.equal(section(adapted.subject.source, start, end), expected);
    assert.equal(adapted.subject.preservedSha256[name], hash(expected));
  }
  const execute = section(read('trie-view-workloads.mjs'), '  const execute = repeat =>', '\n  const result =');
  assert.equal(section(adapted.workload.source, '  const execute = repeat =>', '\n  const result ='), execute);
  assert.equal(adapted.subject.preservedSha256.fixtureExecute, hash(execute));
  for (const value of Object.values(adapted)) assert.equal(value.sourceSha256, hash(value.source));
});
test('calibration starts at final retained prewarm repeat and keeps all completed probes', async () => withAdapted(({ runPilot }) => {
  const result = { flags: [] }, calls = []; let now = 0;
  runPilot(result, repeat => {
    const index = result.probes.length ? result.probes.at(-1).samples.length : 0;
    const ms = result.probes.length === 0 ? 39.9 : result.probes.length === 1 ? [35,39,42][index] : [40,42,43][index];
    calls.push({ repeat, ms }); now += ms; return ms;
  }, () => now);
  const last = result.prewarm.batches.at(-1);
  assert(last.repeat > CONFIG.pilotWarmupMinCalls);
  assert.equal(result.probes[0].repeat, last.repeat);
  assert.notEqual(result.probes[0].repeat, Math.ceil(last.repeat * CONFIG.pilotCalibrationTargetMs / last.ms));
  assert.deepEqual(result.probes.map(probe => probe.samples), [[35,39,42], [40,42,43]]);
  assert.deepEqual(calls, [...result.prewarm.batches, ...result.probes.flatMap(probe => probe.samples.map(ms => ({ repeat: probe.repeat, ms })))]);
  assert.equal(result.estimateMsPerOperation, Math.min(...result.probes.flatMap(probe => probe.samples.map(ms => ms / probe.repeat))));
  assert.equal(validateRecoveryPilot({ ...result, phase: 'pilot', status: 'completed' }), result.estimateMsPerOperation);
}));
test('quantized fake clock reproduces original repeat=1 failure and recovered positive start', async () => withAdapted(({ runPilot }) => {
  function simulate(run) {
    const result = { flags: [] }; let now = 0;
    const invoke = () => run(result, repeat => { const ms = Math.floor(repeat / 50000 * 50) / 50; now += ms; return ms; }, () => now);
    return { result, invoke };
  }
  const original = simulate(originalPilot); assert.throws(original.invoke, /nonpositive/);
  assert.equal(original.result.probes[0].repeat, 1); assert.equal(original.result.probes[0].samples.length, 0);
  const recovery = simulate(runPilot); recovery.invoke();
  assert.deepEqual(recovery.result.prewarm, original.result.prewarm);
  assert.equal(recovery.result.probes[0].repeat, recovery.result.prewarm.batches.at(-1).repeat);
  assert(recovery.result.probes.every(probe => probe.samples.length === 3 && probe.samples.every(ms => ms > 0)));
}));
test('later zero/nonfinite durations still fail and preserve completed samples', async () => withAdapted(({ runPilot }) => {
  for (const invalid of [0,-1,NaN,Infinity]) {
    const result = { flags: [] }; let now = 0;
    assert.throws(() => runPilot(result, () => {
      const ms = !result.probes.length ? 500 : result.probes[0].samples.length === 0 ? 40 : invalid;
      now += ms; return ms;
    }, () => now), /nonpositive\/nonfinite/);
    assert.deepEqual(result.prewarm.batches, [{ repeat: 1024, ms: 500 }]);
    assert.deepEqual(result.probes, [{ repeat: 1024, samples: [40] }]);
  }
}));
test('fixed measurement is identical, including every sample and strict duration rejection', async () => withAdapted(({ runFixedMeasure }) => {
  const request = { repeat: 20, warmupOperations: 160 }, a = { flags: [] }, b = { flags: [] };
  originalMeasure(request, a, repeat => repeat); runFixedMeasure(request, b, repeat => repeat);
  assert.deepEqual(b, a); assert.equal(b.samples.length, 21);
  for (const run of [originalMeasure, runFixedMeasure]) assert.throws(() => run(request, { flags: [] }, () => 0), /nonpositive/);
}));
test('pilot receipt rejects a reset, missing history, or altered prewarm sums', () => {
  const valid = { phase: 'pilot', status: 'completed', flags: [],
    prewarm: { targetMs: 500, elapsedMs: 500, operations: 1024, capped: false, batches: [{ repeat: 1024, ms: 500 }] },
    probes: [{ repeat: 1024, samples: [40,41,42] }], estimateMsPerOperation: 40 / 1024 };
  assert.doesNotThrow(() => validateRecoveryPilot(valid));
  for (const mutate of [value => { value.probes[0].repeat = 1; value.estimateMsPerOperation = 40; },
    value => { value.prewarm.batches = []; }, value => { value.prewarm.operations++; }, value => { value.prewarm.elapsedMs++; },
    value => { value.prewarm.batches[0].ms = 0; }]) {
    const value = structuredClone(valid); mutate(value); assert.throws(() => validateRecoveryPilot(value));
  }
});
test('worker close is observed before browser teardown even when termination returns earlier', async () => {
  const { page, workers, receipt, observer } = fakeLifecycle(), worker = fakeWorker(), events = [];
  page.emit('worker', worker);
  const waiting = observer.waitForClose(1, LIMITS.workerCloseMs, receipt).then(() => { events.push('barrier'); events.push('browser-close'); });
  await Promise.resolve(); assert.deepEqual(events, []); assert.equal(workers[0].closed, false);
  events.push('worker-close'); worker.emit('close'); await waiting;
  assert.deepEqual(events, ['worker-close','barrier','browser-close']); assert.equal(receipt.completed, true);
});
test('already observed exact-worker close is retained before waiting', async () => {
  const { page, workers, receipt, observer } = fakeLifecycle(), worker = fakeWorker();
  page.emit('worker', worker); worker.emit('close');
  await observer.waitForClose(1, LIMITS.workerCloseMs, receipt);
  assert.equal(workers[0].closed, true); assert.equal(receipt.completed, true);
});
test('missing close or another worker close fails at the frozen deadline without real waiting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { page, workers, receipt, observer } = fakeLifecycle(), worker = fakeWorker(), unrelated = fakeWorker();
  page.emit('worker', worker);
  const waiting = observer.waitForClose(1, LIMITS.workerCloseMs, receipt);
  const rejected = assert.rejects(waiting, /Worker close deadline exceeded/);
  unrelated.emit('close'); await Promise.resolve(); assert.equal(receipt.completed, false);
  t.mock.timers.tick(LIMITS.workerCloseMs); await rejected;
  assert.equal(workers[0].closed, false); assert.equal(receipt.completed, false);
  // A teardown-triggered late close must not retroactively make this successful.
  worker.emit('close'); assert.equal(workers[0].closed, true); assert.equal(receipt.completed, false);
});
test('missing, extra or unexpected workers cannot satisfy the barrier', async () => {
  for (const count of [0,2]) {
    const { page, receipt, observer } = fakeLifecycle();
    for (let i=0; i<count; i++) { const worker = fakeWorker(); page.emit('worker', worker); worker.emit('close'); }
    await assert.rejects(observer.waitForClose(1, LIMITS.workerCloseMs, receipt), /worker count/);
    assert.equal(receipt.completed, false);
  }
  const fixture = fakeLifecycle(); await fixture.observer.waitForClose(0, LIMITS.workerCloseMs, fixture.receipt);
  assert.equal(fixture.receipt.completed, true);
});
test('a worker appearing while the barrier waits fails exact-count enforcement', async () => {
  const { page, receipt, observer } = fakeLifecycle(), first = fakeWorker(), extra = fakeWorker();
  page.emit('worker', first);
  const waiting = observer.waitForClose(1, LIMITS.workerCloseMs, receipt);
  const rejected = assert.rejects(waiting, /Worker appeared during close barrier/);
  page.emit('worker', extra); first.emit('close'); extra.emit('close');
  await rejected; assert.equal(receipt.completed, false);
});
test('browser disconnect and close completion cannot substitute for the exact-worker close barrier', () => {
  const good = { status: 'completed', browser: { closeRequested: true, closeCompleted: true, disconnected: true }, serverClosed: true,
    workers: [{ url: 'worker', closed: true }], workerCloseBarrier: { expectedWorkers: 1, timeoutMs: LIMITS.workerCloseMs, completed: true } };
  assert.doesNotThrow(() => validateBrowserLifecycle(good, { kind: 'worker' }, LIMITS.workerCloseMs));
  for (const mutate of [raw => { raw.workers[0].closed = false; }, raw => { raw.workerCloseBarrier.completed = false; },
    raw => { raw.browser.disconnected = false; }, raw => { raw.browser.closeCompleted = false; }, raw => { raw.serverClosed = false; }]) {
    const raw = structuredClone(good); mutate(raw); assert.throws(() => validateBrowserLifecycle(raw, { kind: 'worker' }, LIMITS.workerCloseMs));
  }
});
test('controller registers before navigation, awaits barrier before close, and retains outer cleanup checks', () => {
  const browser = read('radix-browser-recovery-browser.mjs'), runner = read('radix-browser-recovery-runner.mjs');
  assert(browser.indexOf('observeWorkers(page, result.workers)') < browser.indexOf('await page.goto('));
  assert(browser.indexOf('await workerObserver.waitForClose(') < browser.indexOf('await deadline(browser.close()'));
  assert(browser.includes('!result.browser.disconnected || result.workers.some(worker => !worker.closed)'));
  assert.equal((runner.match(/validateBrowserLifecycle\(raw,/g) ?? []).length, 2);
  assert(runner.includes("receipt.cleanup?.status, 'verified-no-live-processes'"));
});
test('all retained recovery pilots precede frozen common work and every measured subject', async () => {
  const record = { status: 'completed', rows: [] }, chronology = []; let frozen = false;
  await executeStudy(record, planFor('chromium-x64'), async (build, request) => {
    chronology.push({ build, ...request });
    if (request.phase === 'pilot') {
      assert.equal(frozen, false);
      return { phase: 'pilot', status: 'completed', expectedDigest: 'same', flags: [],
        prewarm: { targetMs: 500, elapsedMs: 500, operations: 1024, capped: false, batches: [{ repeat: 1024, ms: 500 }] },
        probes: [{ repeat: 1024, samples: [40,41,42] }], estimateMsPerOperation: 40 / 1024 };
    }
    assert.equal(frozen, true);
    return { phase: 'measure', status: 'completed', expectedDigest: 'same', flags: [], repeat: request.repeat,
      prescribedWarmupOperations: request.warmupOperations,
      warmup: { operations: request.warmupOperations, elapsedMs: request.warmupOperations,
        batches: Array.from({ length: request.warmupOperations / request.repeat }, () => ({ repeat: request.repeat, ms: request.repeat })) },
      samples: Array(21).fill(request.repeat) };
  }, () => {}, plans => { assert.equal(chronology.length, 6); assert.equal(plans.length, 3); frozen = true; });
  assert.equal(chronology.length, 102); assert(chronology.slice(0,6).every(item => item.phase === 'pilot'));
  assert(chronology.slice(6).every(item => item.phase === 'measure'));
});
test('new workflow is browser-only and rejects local runs, old branch and reruns', () => {
  const workflow = read('../.github/workflows/radix-browser-recovery.yml');
  assert(!workflow.includes('arm64')); assert(!workflow.includes('ubuntu-24.04-arm'));
  assert.equal((workflow.match(/- lane:/g) ?? []).length, 3);
  for (const lane of LANES) assert(workflow.includes(`lane: ${lane.name}`));
  assert(workflow.includes(`branches: ['${CONTEXT.branch}']`));
  assert(workflow.includes('github.run_attempt == 1')); assert(workflow.includes(`github.event.before == '${CONTEXT.candidate}'`));
  assert(workflow.includes('node --test proofs/radix-portability-tests.mjs proofs/radix-browser-recovery-tests.mjs'));
  assert(workflow.includes('if: always()')); assert(workflow.includes('persist-credentials: false'));
  assert.equal((workflow.match(/runner\.temp/g) ?? []).length, 2);
  assert.throws(() => requireCI(LANES[0], {}, {}), /No local timing/);
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: `refs/heads/${ORIGINAL_CONTEXT.branch}` };
  assert.throws(() => requireCI(LANES[0], env, {}));
  assert.throws(() => requireCI(LANES[0], { ...env, GITHUB_RUN_ATTEMPT: '2', GITHUB_REF: `refs/heads/${CONTEXT.branch}` }, {}));
});
