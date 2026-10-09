// Deterministic protocol/transport fixtures only. No browser or latency run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CONTEXT, CASES, CASE_NAMES, LANES, CONFIG, planFor, requireCI, diagnosticOutcome } from './heap-portability-protocol.mjs';
import { summarize, interval, controlDrift } from './heap-entry-protocol.mjs';
import { freezePlan } from './heap-portability-plan.mjs';
import { deriveBrowser, deriveNode, section, transform } from './heap-portability-adapter.mjs';
import { observeWorkers, validateBrowserLifecycle } from './heap-portability-lifecycle.mjs';
import { executeStudy, validateMeasured, validatePilot, prospectiveManifest, verifyProspective } from './heap-portability-runner.mjs';
import { sha256 as browserHash } from './heap-portability-browser-shims.mjs';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
test('exact selected original cases and five lanes, no catalogue expansion', () => {
  assert.deepEqual(CASE_NAMES, ['number-1057-min', 'string-4097-min-ties', 'empty-next']);
  assert.deepEqual(CASES.map(row => row.operation), ['full', 'full', 'next']);
  assert.deepEqual(LANES.map(row => row.name), ['node-arm64', 'bun-arm64', 'chromium-x64', 'firefox-x64', 'webkit-x64']);
  assert.equal(CONTEXT.candidate, '994c0fc3929f64df6303739c79f71d45252350d9');
  assert.equal(CONFIG.samples, 21); assert.equal(CONFIG.quartets, 4); assert.equal(CONFIG.margin, 1.02);
});
test('two LRRL and two RLLR quartets per AB and matched AA, 96 subjects per lane', () => {
  for (const lane of LANES) {
    const plan = planFor(lane.name); assert.deepEqual(plan, planFor(lane.name));
    assert.equal(plan.rows.length, 3); assert.equal(plan.correctness.length, 10);
    for (const row of plan.rows) for (const mode of ['ab', 'aa-baseline']) {
      const sequences = row.schedule.filter(block => block.mode === mode).map(block => block.roles.map(role => role[0]).join(''));
      assert.deepEqual(sequences.sort(), ['lrrl', 'lrrl', 'rllr', 'rllr']);
    }
    assert.equal(plan.rows.flatMap(row => row.schedule.flatMap(block => block.roles)).length, 96);
  }
});
test('transport close barrier waits for exact worker before teardown', async () => {
  const page = new EventEmitter(), receipts = [], worker = new EventEmitter(); worker.url = () => 'exact-worker';
  const observer = observeWorkers(page, receipts); page.emit('worker', worker);
  const barrier = {}, waiting = observer.waitForClose(1, 1000, barrier);
  assert.equal(barrier.completed, false); worker.emit('close'); await waiting;
  assert.equal(barrier.completed, true); assert.equal(receipts[0].closed, true);
});
test('unrelated worker cannot satisfy exact close; late teardown does not repair timeout', async () => {
  const page = new EventEmitter(), receipts = [], worker = new EventEmitter(); worker.url = () => 'exact-worker';
  const observer = observeWorkers(page, receipts); page.emit('worker', worker);
  const unrelated = new EventEmitter(), barrier = {}; unrelated.emit('close');
  await assert.rejects(observer.waitForClose(1, 1, barrier), /deadline/);
  worker.emit('close'); assert.equal(receipts[0].closed, true); assert.equal(barrier.completed, false);
  const raw = { status: 'completed', workers: receipts, workerCloseBarrier: barrier, serverClosed: true,
    browser: { closeRequested: true, closeCompleted: true, disconnected: true } };
  assert.throws(() => validateBrowserLifecycle(raw, { kind: 'worker' }, 1));
});
test('missing and extra worker counts fail even if browser closes', async () => {
  const page = new EventEmitter(), receipts = [], observer = observeWorkers(page, receipts);
  await assert.rejects(observer.waitForClose(1, 1000, {}), /Unexpected browser worker count/);
  const worker = new EventEmitter(); worker.url = () => 'unexpected'; page.emit('worker', worker); worker.emit('close');
  await assert.rejects(observer.waitForClose(0, 1000, {}), /Unexpected browser worker count/);
});
test('workload and measured scan/sink kernel stay byte-for-byte unchanged', () => {
  const browser = deriveBrowser(), node = deriveNode(), workload = read('heap-entry-workloads.mjs'), source = read('heap-entry-subject.mjs');
  const workloadBody = workload.slice(workload.indexOf('// Sizes'));
  assert.equal(browser.workload.source.slice(browser.workload.source.indexOf('// Sizes')), workloadBody);
  const timed = section(source, '  const timed = repeat => {', '  const warm =');
  for (const derived of [browser.subject, node.subject]) assert.equal(section(derived.source, '  const timed = repeat => {', '  const warm ='), timed);
  const worker = section(read('heap-entry-worker.mjs'), 'if (!isMainThread) {', '\nexport async function checkBuiltEntries');
  assert(browser.worker.source.endsWith(worker));
  assert.equal(node.subject.source.includes('positivePrewarm'), false);
});
test('source edits reject absent or duplicated sites and reverse exactly', () => {
  assert.equal(transform('a-b-c', [['b', 'x']]).source, 'a-x-c');
  assert.throws(() => transform('a-b-b', [['b', 'x']]));
  assert.throws(() => transform('a-c', [['b', 'x']]));
});
test('browser hash matches node for empty, Unicode and unaligned byte views', () => {
  for (const value of ['', '界🙂-heap', new Uint8Array([0, 1, 2, 255]).subarray(1)])
    assert.equal(browserHash(value), createHash('sha256').update(value).digest('hex'));
});
const pilot = (repeat = 10, ms = 60) => {
  const warmup = { scans: repeat * 10, ms: 600, batches: [{ repeat: repeat * 10, ms: 600 }], capped: false, wallMs: 600 };
  const calibration = [{ repeat, samples: [ms, ms, ms] }];
  return { status: 'passed', phase: 'pilot', expected: {}, identity: {}, invalid: [], repeat, minMsPerIteration: ms / repeat,
    capped: false, warmup, calibration, progress: { warmup, calibration } };
};
test('fixed common work uses maximum repeat and fastest pilot, including AA', () => {
  const plan = freezePlan([pilot(10, 60), pilot(20, 60)]);
  assert.equal(plan.repeat, 20); assert.equal(plan.warmupScans, 220);
  assert.throws(() => freezePlan([{ ...pilot(), invalid: ['capped'] }, pilot()]));
});
test('all six pilots precede 96 measurements and no seventh pilot can appear', async () => {
  const record = { rows: [] }, plan = planFor('node-arm64'), calls = []; let frozen = false;
  await executeStudy(record, plan, async (build, request) => {
    calls.push({ build, request });
    if (request.phase === 'pilot') { assert.equal(frozen, false); return pilot(); }
    assert(frozen); const warmup = { scans: request.warmupScans, ms: 660, capped: false };
    return { status: 'passed', phase: 'measure', repeat: request.repeat, prescribedWarmupScans: request.warmupScans,
      expected: {}, identity: {}, warmup, samples: Array(21).fill(60), invalid: [], targetMisses: { batches: 0, warmup: false },
      progress: { warmup, samples: Array(21).fill(60) } };
  }, () => {}, plans => { assert.equal(plans.length, 3); frozen = true; });
  assert.equal(calls.length, 102); assert(calls.slice(0, 6).every(row => row.request.phase === 'pilot'));
  assert(calls.slice(6).every(row => row.request.phase === 'measure'));
  assert.equal(record.rows.flatMap(row => row.blocks.flatMap(block => block.subjects)).length, 96);
  assert.equal(diagnosticOutcome(record.rows, true), 'selected-cells-within-margin-only');
});
test('pilot failure leaves partial record and starts zero measured subjects', async () => {
  const record = { rows: [] }, requests = [];
  await assert.rejects(executeStudy(record, planFor('node-arm64'), async (build, request) => {
    requests.push(request); if (requests.length === 3) throw new Error('retained-failure'); return pilot();
  }, () => {}, () => assert.fail('No plan freeze on failure')), /retained-failure/);
  assert(requests.every(row => row.phase === 'pilot')); assert.equal(record.rows.length, 2);
  assert.equal(Object.keys(record.rows[0].pilots).length, 2);
});
test('floor miss is retained and invalid, never recalibrated', () => {
  const plan = freezePlan([pilot(), pilot()]), warmup = { scans: plan.warmupScans, ms: 100, capped: false };
  const subject = { status: 'passed', phase: 'measure', repeat: plan.repeat, prescribedWarmupScans: plan.warmupScans,
    expected: {}, identity: {}, warmup, samples: [5, ...Array(20).fill(60)], invalid: ['warmup-below-floor', 'sample-below-floor'],
    targetMisses: { batches: 1, warmup: true }, progress: { warmup, samples: [5, ...Array(20).fill(60)] } };
  validateMeasured(subject, plan); assert.throws(() => validateMeasured({ ...subject, invalid: [] }, plan));
  assert.throws(() => validateMeasured({ ...subject, repeat: plan.repeat + 1 }, plan));
  assert.throws(() => validateMeasured({ ...subject, samples: Array(20).fill(60) }, plan));
});
test('four quartet inference and original small-control caveats remain explicit', () => {
  assert.equal(interval([0, 0, 0]).classification, 'incomplete');
  const drift = interval([0.979811691, 0.987916759, 0.975748754, 0.971604550].map(Math.log));
  assert(controlDrift(drift)); assert.match(CONTEXT.priorOutcome, /Node empty-full.*Node empty-next.*Bun empty-next/);
  assert.match(CONTEXT.priorOutcome, /nested-65-first-close.*AA drift/);
});
test('CI-only entry rejects local invocation before browser/timing', () => {
  assert.throws(() => requireCI(LANES[0], {}, {}), /No local timing or browser launch/);
});
test('fake quantized clock keeps positive recorded warmup repeat and partial failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heap-protocol-fake-')), derived = deriveBrowser();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const oldIsolation = globalThis.crossOriginIsolated, oldLocation = globalThis.location;
  let clock = 0, failAt = Infinity, calls = 0;
  globalThis.__heapFakeScan = repeat => { if (++calls === failAt) throw new Error('fake-scan-failure'); clock += repeat * 0.09; return { repeat }; };
  Object.defineProperty(globalThis, 'performance', { value: { now: () => Math.floor(clock) }, configurable: true });
  globalThis.crossOriginIsolated = true; globalThis.location = { origin: 'http://fixture' };
  try {
    writeFileSync(join(dir, 'shims.mjs'), derived.shims.source); writeFileSync(join(dir, 'protocol.mjs'), derived.protocol.source);
    writeFileSync(join(dir, 'workloads.mjs'), "export const fixture = () => ({ item: {}, expected: {} }); export const consume = () => ({}); export const fixtureIdentity = () => ({}); export const expectedBatch = (expected, repeat) => ({ repeat }); export const scan = (item, workload, repeat) => globalThis.__heapFakeScan(repeat);\n");
    writeFileSync(join(dir, 'api.mjs'), 'export const fake = true;\n');
    // Only entry-location validation is changed for this fake-clock fixture.
    const fixtureSource = transform(derived.subject.source, [["  assert.equal(request.entryUrl, location.origin + '/subject/dist/shared.js');", "  assert.equal(request.entryUrl, request.fixtureEntry);"]]).source;
    writeFileSync(join(dir, 'subject.mjs'), fixtureSource);
    const { subject } = await import(pathToFileURL(join(dir, 'subject.mjs'))), entryUrl = pathToFileURL(join(dir, 'api.mjs')).href;
    const request = { phase: 'pilot', entryUrl, fixtureEntry: entryUrl, authorization: 'frozen-ci-subject', workload: { size: 4097 } };
    const result = await subject(request); assert.equal(result.status, 'completed');
    assert.equal(result.progress.calibrationStart.repeat, result.warmup.batches.findLast(batch => batch.ms > 0).repeat);
    assert.equal(result.progress.calibrationStart.repeat, 1); assert(result.calibration.at(-1).samples.every(ms => ms >= 50));
    validatePilot({ ...result, status: 'passed' });
    failAt = calls + 4;
    const failed = await subject({ ...request, phase: 'measure', repeat: 1000, warmupScans: 1000 });
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /fake-scan-failure/);
    assert.equal(failed.progress.warmup.scans, 1000); assert.equal(failed.progress.samples.length, 2);
  } finally {
    Object.defineProperty(globalThis, 'performance', descriptor); globalThis.crossOriginIsolated = oldIsolation; globalThis.location = oldLocation;
    delete globalThis.__heapFakeScan; delete globalThis.__heapEntrySink; rmSync(dir, { recursive: true, force: true });
  }
});
test('frozen prospective manifest matches every source and adapter byte', () => {
  assert.equal(prospectiveManifest().expectedTotal.measuredBatches, 10080); assert.match(verifyProspective(), /^[0-9a-f]{64}$/);
});
