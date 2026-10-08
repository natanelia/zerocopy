import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { CASES, runChecks, checkBrowserWorkers } from './block-traversal-workloads.mjs';
import { PIN, verifyHelpers } from './block-traversal-empty-controls.mjs';
import { sha256 } from './block-traversal-source.mjs';
import { REPLACEMENTS, deriveModule, replaceExactlyOnce, coverage, schedule, WORKER_CASES } from './block-traversal-chromium-adapter.mjs';
import { executeSchedule, executeCase, prepare, verifyPrepared, assertExecutionContext } from './block-traversal-chromium-isolation.mjs';
import { runCase } from './block-traversal-chromium-page.mjs';

const derived = deriveModule();
const checks = await import(`data:text/javascript;base64,${Buffer.from(derived.source).toString('base64')}`);

test('derived module retains the entire pinned original; only selector headers differ', () => {
  verifyHelpers();
  const original = readFileSync(new URL('./block-traversal-workloads.mjs', import.meta.url), 'utf8');
  assert(derived.source.startsWith(original));
  assert.equal(sha256(original), PIN.helpers['block-traversal-workloads.mjs']);
  for (let i = 0; i < REPLACEMENTS.length; i++) {
    let restored = derived.functions[i];
    for (const [before, after] of [...REPLACEMENTS[i].changes].reverse()) restored = replaceExactlyOnce(restored, after, before);
    assert.equal(restored, REPLACEMENTS[i].original, 'Every original assertion and inner loop must be byte-identical');
    const originalAssertions = REPLACEMENTS[i].original.match(/\b(?:equal|assert)\(/g) ?? [];
    assert.deepEqual(derived.functions[i].match(/\b(?:equal|assert)\(/g), originalAssertions);
  }
  assert.deepEqual(checks.CASES, CASES);
  assert.throws(() => replaceExactlyOnce('x x', 'x', 'y'), /one exact selector/);
});

test('92 process schedule covers all original cases once per source with balanced first positions', () => {
  const plan = schedule(); assert.equal(plan.length, 92);
  for (const role of ['baseline', 'candidate']) {
    const rows = plan.filter(row => row.role === role);
    assert.deepEqual(rows.filter(row => row.type === 'fixture').map(row => row.workload), CASES);
    assert.deepEqual(rows.filter(row => row.type === 'worker').map(row => row.workload), WORKER_CASES);
    assert.equal(rows.filter(row => row.position === 0).length, 23);
  }
  assert.deepEqual(plan.map(row => row.sequence), Array.from({ length: 92 }, (_, i) => i));
  for (let i = 0; i < plan.length; i += 2) {
    assert.equal(plan[i].name, plan[i + 1].name); assert.notEqual(plan[i].role, plan[i + 1].role);
    if (i) assert.notEqual(plan[i].role, plan[i - 2].role);
  }
  const counts = coverage().perSource;
  assert.equal(counts.fixtureGrowthChecks, 22); assert.equal(counts.fixtureTransports, 80);
  assert.equal(counts.fixtureReadOnlyRejections, 68); assert.equal(counts.retainedEditedFixtures, 4);
  assert.equal(counts.workerItems, 129); assert.equal(counts.workerForkItems, 130);
  assert.equal(counts.nestedSnapshotsPerWorker, 65); assert.equal(counts.nestedSnapshotChecksPerWorker, 130);
  assert.equal(counts.workerSharedTransports, 3); assert.equal(counts.workerCopyTransports, 3);
});

test('execution requires this CI branch and the same immutable proof/run/first-attempt context', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/proof/block-chromium-isolation', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123' };
  const frozen = { proofCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: '1' };
  assert.doesNotThrow(() => assertExecutionContext(frozen, env));
  for (const changes of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '124' }]) {
    assert.throws(() => assertExecutionContext(frozen, { ...env, ...changes }));
  }
});

// These deterministic stand-ins exercise the unchanged proof's assertions and
// call counts. They are protocol tests, never evidence of browser correctness.
function fakeApi(fault = '') {
  const trace = [], memories = [];
  const memory = () => {
    const entry = { buffer: { byteLength: 65536 }, grow(pages) { trace.push(['grow', pages]); if (fault !== 'no-growth') entry.buffer = { byteLength: entry.buffer.byteLength + pages * 65536 }; } };
    memories.push(entry); return entry;
  };
  class List {
    constructor(type, values = [], arena = memory(), readOnly = false) { this.type = type; this.values = values; this.memory = arena; this.readOnly = readOnly; }
    get size() { return this.values.length; }
    next(values) { return new this.constructor(this.type, values, this.memory, this.readOnly); }
    append(value) {
      trace.push(['append', this.size, this.readOnly]);
      if (this.readOnly && fault !== 'writable-attachment') throw new Error('read-only');
      return this.next([...this.values, value]);
    }
    prepend(value) { trace.push(['prepend', this.size]); return this.next([value, ...this.values]); }
    insertAfter(index, value) { trace.push(['insertAfter', index]); return this.next([...this.values.slice(0, index + 1), value, ...this.values.slice(index + 1)]); }
    removeFirst() { trace.push(['removeFirst']); return this.next(this.values.slice(1)); }
    toArray() { trace.push(['toArray', this.size, this.readOnly]); const values = this.values.slice(); if (fault === 'wrong-array' && values.length) values[0] = 'wrong'; return values; }
    toArrayReverse() { trace.push(['toArrayReverse', this.size]); return this.values.slice().reverse(); }
    forEach(callback) { trace.push(['forEach', this.size, this.readOnly]); this.values.forEach((value, index) => callback(value, fault === 'wrong-index' ? index + 1 : index)); }
    forEachReverse(callback) { trace.push(['forEachReverse', this.size]); for (let i = this.size - 1; i >= 0; i--) callback(this.values[i], fault === 'wrong-index' ? i + 1 : i); }
  }
  class SharedLinkedList extends List {}
  class SharedDoublyLinkedList extends List {}
  const S = { SharedLinkedList, SharedDoublyLinkedList,
    compact(item) { trace.push(['compact', item.size]); return new item.constructor(item.type, item.values.slice()); },
    getWorkerData(structures, { copy }) {
      trace.push(['getWorkerData', Object.keys(structures), copy]);
      return { structures, copy, arenas: [...new Set(Object.values(structures).map(item => item.memory))].map(memory => ({ memory })) };
    },
    async initWorker(data) {
      trace.push(['initWorker', data.copy]);
      return Object.fromEntries(Object.entries(data.structures).map(([name, item]) => [name, new item.constructor(item.type, item.values.slice(), item.memory, true)]));
    },
  };
  return { S, trace, memories };
}
function fakeWorkerClass(trace, mutate = () => {}, options = {}) {
  return class FakeWorker {
    constructor(url, config) { this.listeners = []; trace.push(['worker-new', url, config]); }
    addEventListener(type, handler) { this.listeners.push([type, handler]); }
    emit(data) { for (const [type, handler] of this.listeners) if (type === 'message') handler({ data }); this.onmessage?.({ data }); }
    postMessage({ data, reverse }) {
      trace.push(['worker-post', data.copy, reverse]);
      queueMicrotask(() => {
        if (!options.missingPause) this.emit({ type: 'paused', index: 1 });
        if (options.duplicatePause) this.emit({ type: 'paused', index: 1 });
        const { item, fork, nested } = data.structures;
        const values = item.values.slice(), indices = values.map((_, index) => index);
        const result = { type: 'done', values: reverse ? values.slice().reverse() : values.slice(), indices: reverse ? indices.reverse() : indices,
          array: values.slice(), compacted: values.slice(), fork: fork.values.slice(), compactedFork: fork.values.slice(),
          nested: nested.values.map(item => item.values.slice()), compactedNested: nested.values.map(item => item.values.slice()), writeRejected: true };
        mutate(result); this.emit(result);
      });
    }
    terminate() { trace.push(['worker-terminate']); }
  };
}

test('all 40 derived fixture runs have exactly the original results and operation traces', async () => {
  const original = fakeApi(), isolated = fakeApi();
  const expected = await runChecks(original.S), actual = [];
  for (const workload of CASES) actual.push(...await checks.runSingleFixture(isolated.S, workload));
  assert.deepEqual(actual, expected); assert.deepEqual(isolated.trace, original.trace);
  assert.equal(isolated.trace.filter(([op]) => op === 'grow').length, 22);
  assert.equal(isolated.trace.filter(([op]) => op === 'initWorker').length, 80);
  assert.equal(isolated.trace.filter(([op]) => op === 'insertAfter').length, 64);
  assert.equal(isolated.trace.filter(([op]) => op === 'removeFirst').length, 64);
});

test('fixture value, callback index, live growth and read-only checks reject corrupt outcomes', async () => {
  const workload = CASES.find(row => row.size === 33 && row.operation === 'forEach');
  for (const [fault, pattern] of [['wrong-array', /mismatch/], ['wrong-index', /callback indices/], ['no-growth', /did not grow/], ['writable-attachment', /accepted a write/]]) {
    await assert.rejects(checks.runSingleFixture(fakeApi(fault).S, workload), pattern, fault);
  }
});

test('all six derived worker scenarios preserve exact original traces, growth, forks and nested checks', async () => {
  const NativeWorker = globalThis.Worker;
  try {
    const original = fakeApi(), isolated = fakeApi();
    globalThis.Worker = fakeWorkerClass(original.trace);
    const expected = await checkBrowserWorkers(original.S, 'source', 'worker');
    globalThis.Worker = fakeWorkerClass(isolated.trace);
    const actual = [];
    for (const workload of WORKER_CASES) actual.push(...await checks.runSingleWorker(isolated.S, 'source', 'worker', workload));
    assert.deepEqual(actual, expected); assert.deepEqual(isolated.trace, original.trace);
    assert.equal(isolated.trace.filter(([op]) => op === 'worker-terminate').length, 6);
    assert.equal(isolated.trace.filter(([op]) => op === 'grow').length, 12);
    assert(isolated.trace.filter(([op]) => op === 'grow').every(([, pages]) => pages === 2));
    assert.equal(isolated.trace.filter(([op]) => op === 'worker-post').length, 6);
  } finally { globalThis.Worker = NativeWorker; }
});

test('every worker result family, pause, growth and read-only assertion still rejects errors and terminates', async () => {
  const NativeWorker = globalThis.Worker;
  try {
    const mutations = [
      ['values', result => { result.values[0] = 99; }], ['indices', result => { result.indices[0] = -1; }],
      ...['array', 'compacted', 'fork', 'compactedFork'].map(key => [key, result => { result[key].pop(); }]),
      ...['nested', 'compactedNested'].flatMap(key => [[`${key}-count`, result => { result[key].pop(); }], [`${key}-value`, result => { result[key][32][0] = 999; }]]),
      ['write-rejection', result => { result.writeRejected = false; }],
      ['worker-error', result => { result.type = 'error'; result.error = 'worker failure'; }],
    ];
    for (const [name, mutate] of mutations) {
      const fake = fakeApi(); globalThis.Worker = fakeWorkerClass(fake.trace, mutate);
      await assert.rejects(checks.runSingleWorker(fake.S, 'source', 'worker', WORKER_CASES[0]), undefined, name);
      assert.equal(fake.trace.filter(([op]) => op === 'worker-terminate').length, 1, name);
    }
    for (const [options, fault, pattern] of [[{ missingPause: true }, '', /Missing worker pause/], [{ duplicatePause: true }, '', /Duplicate pause/], [{}, 'no-growth', /Writer did not grow/]]) {
      const fake = fakeApi(fault); globalThis.Worker = fakeWorkerClass(fake.trace, () => {}, options);
      await assert.rejects(checks.runSingleWorker(fake.S, 'source', 'worker', WORKER_CASES[0]), pattern);
      assert.equal(fake.trace.filter(([op]) => op === 'worker-terminate').length, 1);
    }
  } finally { globalThis.Worker = NativeWorker; }
});

test('incremental scheduler continues all 92 scenarios after failures and preserves failure stages', async () => {
  const record = { status: 'running', results: [] }, checkpoints = [], seen = [];
  await executeSchedule(schedule(), async (task, progress) => {
    seen.push(task.sequence); progress({ stage: 'fixture-original-checks' });
    if (task.sequence === 0) throw new RangeError('synthetic allocation failure');
    return { status: task.sequence === 20 ? 'failed' : 'passed', stage: 'terminal', error: task.sequence === 20 ? { stage: 'worker-reported-error', message: 'synthetic error' } : null };
  }, () => checkpoints.push(structuredClone(record)), record);
  assert.equal(seen.length, 92); assert.equal(record.status, 'failed'); assert.equal(record.results.length, 92);
  assert.equal(record.results[0].error.stage, 'fixture-original-checks'); assert.equal(record.results[20].error.stage, 'worker-reported-error');
  assert.equal(checkpoints[0].results[0].status, 'running');
  assert.equal(record.results.filter(row => row.status === 'passed').length, 90);
  const passing = { results: [] }; await executeSchedule(schedule(), async () => ({ status: 'passed' }), () => {}, passing); assert.equal(passing.status, 'passed');
});

test('fresh browser launch and closure occur for each scenario, with failures retained', async () => {
  let launches = 0, closes = 0;
  const engine = { async launch(options) {
    assert.deepEqual(options, { headless: true, timeout: 30000 }); launches++;
    const browser = new EventEmitter(); browser.version = () => 'synthetic-chromium';
    browser.newPage = async () => {
      const page = new EventEmitter(); page.goto = async () => {};
      page.evaluate = async () => ({ status: 'passed', result: ['fixture'], telemetry: { cleanup: {} } }); return page;
    };
    browser.close = async () => { closes++; browser.emit('disconnected'); }; return browser;
  } };
  for (let i = 0; i < 3; i++) {
    const result = await executeCase(engine, 'http://fixture', schedule()[i]);
    assert.equal(result.status, 'passed'); assert.equal(result.browser.closeCompleted, true); assert.equal(result.browser.disconnected, true);
  }
  assert.equal(launches, 3); assert.equal(closes, 3);
  const failed = await executeCase({ async launch() { throw new Error('synthetic launch failure'); } }, 'http://fixture', schedule()[0]);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.stage, 'browser-launch'); assert.equal(failed.browser.launched, false);
  const closeFailure = { async launch() { const browser = await engine.launch({ headless: true, timeout: 30000 }); browser.close = async () => { throw new Error('synthetic cleanup failure'); }; return browser; } };
  const unclosed = await executeCase(closeFailure, 'http://fixture', schedule()[0]);
  assert.equal(unclosed.status, 'failed'); assert.equal(unclosed.browser.closeCompleted, false); assert.match(unclosed.cleanupError, /synthetic cleanup failure/);
});

test('browser observer records exact growth/transport/nested counts and restores Worker on pass and failure', async () => {
  const temporary = mkdtempSync(join(os.tmpdir(), 'block-isolation-page-'));
  const before = { Worker: globalThis.Worker, crossOriginIsolated: globalThis.crossOriginIsolated, api: globalThis.__blockIsolationTestApi };
  try {
    mkdirSync(join(temporary, 'baseline')); mkdirSync(join(temporary, 'study'));
    writeFileSync(join(temporary, 'study', 'single-case.mjs'), derived.source);
    writeFileSync(join(temporary, 'baseline', 'shared.js'), 'export const { SharedLinkedList, SharedDoublyLinkedList, compact, getWorkerData, initWorker } = globalThis.__blockIsolationTestApi;\n');
    writeFileSync(join(temporary, 'package.json'), '{"type":"module"}\n');
    const fake = fakeApi(); globalThis.__blockIsolationTestApi = fake.S; globalThis.crossOriginIsolated = true;
    const origin = pathToFileURL(temporary).href;
    const FixtureWorker = fakeWorkerClass(fake.trace); globalThis.Worker = FixtureWorker;
    const fixture = await runCase({ origin, role: 'baseline', scenario: schedule().find(row => row.type === 'fixture' && row.workload.size === 33) });
    assert.equal(fixture.status, 'passed'); assert.equal(fixture.telemetry.transports.length, 3);
    assert.equal(fixture.telemetry.memories.filter(row => row.grownPages === 1).length, 1);
    assert.equal(globalThis.Worker, FixtureWorker);
    const worker = await runCase({ origin, role: 'baseline', scenario: schedule().find(row => row.type === 'worker') });
    assert.equal(worker.status, 'passed'); assert.equal(worker.telemetry.workers.length, 1);
    assert.equal(worker.telemetry.cleanup.originalTerminationCalls, 1); assert.equal(worker.telemetry.cleanup.globalWorkerRestored, true);
    assert.equal(worker.telemetry.workers[0].paused, 1); assert.equal(worker.telemetry.workers[0].done, 1);
    assert.equal(worker.telemetry.workers[0].resultCounts.values, 129); assert.equal(worker.telemetry.workers[0].resultCounts.fork, 130);
    assert.equal(worker.telemetry.workers[0].resultCounts.nested, 65); assert.equal(worker.telemetry.workers[0].compactedNestedLengths.length, 65);
    assert.equal(worker.telemetry.memories.filter(row => row.grownPages === 2).length, 2);
    const ErrorWorker = fakeWorkerClass(fake.trace, result => { result.type = 'error'; result.error = 'synthetic compactMany failure'; });
    globalThis.Worker = ErrorWorker;
    const failed = await runCase({ origin, role: 'baseline', scenario: schedule().find(row => row.type === 'worker') });
    assert.equal(failed.status, 'failed'); assert.equal(failed.error.stage, 'worker-reported-error');
    assert.equal(failed.telemetry.cleanup.originalTerminationCalls, 1); assert.equal(globalThis.Worker, ErrorWorker);
  } finally {
    globalThis.Worker = before.Worker; globalThis.crossOriginIsolated = before.crossOriginIsolated; globalThis.__blockIsolationTestApi = before.api;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('preparation preserves a failed partial receipt and rejects an incorrect supplement', () => {
  const temporary = mkdtempSync(join(os.tmpdir(), 'block-isolation-test-'));
  try {
    const output = join(temporary, 'output');
    assert.throws(() => prepare(new URL('./block-traversal-workloads.mjs', import.meta.url), 'missing', 'missing', output), /Wrong successful supplement ZIP/);
    const receipt = JSON.parse(readFileSync(join(output, 'preparation.json')));
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.stage, 'supplement-zip-identity');
    assert.throws(() => prepare('missing', 'missing', 'missing', output), /must be new/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('prepared diagnostic verifies actual supplement and rejects source, bundle, helper and selector tampering', { skip: !process.env.BLOCK_CHROMIUM_PREPARED_EVIDENCE }, () => {
  const original = process.env.BLOCK_CHROMIUM_PREPARED_EVIDENCE;
  verifyPrepared(original);
  const temporary = mkdtempSync(join(os.tmpdir(), 'block-isolation-archive-'));
  try {
    const copy = join(temporary, 'evidence'); cpSync(original, copy, { recursive: true });
    const files = ['single-case.mjs', 'source/baseline/arena.ts', 'source/candidate/arena.ts',
      'supplement/bundles/baseline/dist/shared.js', 'supplement/bundles/candidate/dist/shared.js',
      'original-helpers/block-traversal-worker.mjs', 'proof-source/block-traversal-chromium-page.mjs'];
    for (const file of files) {
      const path = join(copy, file), bytes = readFileSync(path);
      writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n// synthetic tamper\n')]));
      assert.throws(() => verifyPrepared(copy), undefined, file); writeFileSync(path, bytes);
    }
    const path = join(copy, 'frozen-study.json'), frozen = JSON.parse(readFileSync(path));
    frozen.schedule.pop(); writeFileSync(path, JSON.stringify(frozen)); writeFileSync(join(copy, 'frozen-study.sha256'), sha256(readFileSync(path)) + '\n');
    assert.throws(() => verifyPrepared(copy), /Expected values to be strictly deep-equal/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
