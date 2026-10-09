import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeWriter, makeReporter, makeRunner, makeSequencer } from './block-correctness-trace.mjs';
import { parseStat, sample, runCommand, TEST_TIMEOUT_MS, CLEANUP_TIMEOUT_MS } from './block-correctness-command.mjs';
import { PINS, BRANCH, sha256, cacheReceipt, configSource, verifyInvocation } from './block-correctness-identity.mjs';
import { readTrace, validateTrace, validateObservation, sealArtifacts } from './block-correctness-diagnostic.mjs';
const temporary = () => mkdtempSync(join(tmpdir(), 'block-correctness-fake-'));

test('fake reporter events retain exact file/test lifecycle and fields without mutation', () => {
  const events = [], Reporter = makeReporter((event, fields) => events.push({ event, ...fields }));
  const reporter = new Reporter();
  const module = Object.freeze({ id: 'm', moduleId: '/root/a.test.ts', relativeModuleId: 'a.test.ts', state: () => 'passed' });
  const subject = Object.freeze({ id: 't', module, fullName: 'suite > test', result: () => ({ state: 'passed' }), options: Object.freeze({ timeout: 5000, mode: 'run' }) });
  reporter.onInit({ config: { root: '/root', sequence: {} } });
  reporter.onTestRunStart([{ moduleId: module.moduleId, taskId: module.id, pool: 'threads', project: { name: '' } }]);
  reporter.onTestModuleQueued(module); reporter.onTestModuleCollected(module); reporter.onTestModuleStart(module);
  reporter.onTestCaseReady(subject); reporter.onTestCaseResult(subject); reporter.onTestModuleEnd(module);
  reporter.onTestRunEnd([module], [], 'passed');
  assert.deepEqual(events.map(x => x.event), ['reporter-init', 'run-discovered', 'module-queued', 'module-collected', 'module-start', 'test-ready', 'test-result', 'module-end', 'run-end']);
  assert.equal(events[5].timeout, 5000); assert.equal(events[6].name, 'suite > test'); assert.equal(events[8].reason, 'passed');
});

test('runner observes default delegation once, retains return values and original failures', async () => {
  const delegated = [], events = [];
  class Base {
    onCollectStart(t) { delegated.push(['collect', t]); return 'collect-result'; }
    importFile(f, s) { delegated.push(['import', f, s]); return Promise.resolve(42); }
    onBeforeRunSuite(t) { delegated.push(['before-suite', t]); return Promise.resolve('before'); }
    onAfterRunSuite(t) { delegated.push(['after-suite', t]); return Promise.resolve('after'); }
    onBeforeRunTask(t) { delegated.push(['before-test', t]); return Promise.resolve('ready'); }
    onBeforeTryTask(t) { delegated.push(['try', t]); return 'try-result'; }
    onAfterRunTask(t) { delegated.push(['after-test', t]); return 'test-result'; }
  }
  const Runner = makeRunner(Base, (event, fields) => events.push({ event, ...fields })), runner = new Runner();
  const file = Object.freeze({ id: 'm', type: 'suite', name: 'a.test.ts', filepath: '/root/a.test.ts' });
  const subject = Object.freeze({ id: 't', type: 'test', name: 'case', file, mode: 'run', result: Object.freeze({ state: 'pass' }) });
  runner.onBeforeCollect([file.filepath]); assert.equal(runner.onCollectStart(file), 'collect-result');
  assert.equal(await runner.importFile(file.filepath, 'collect'), 42); runner.onCollected([file]);
  assert.equal(await runner.onBeforeRunSuite(file), 'before'); assert.equal(await runner.onBeforeRunTask(subject), 'ready');
  assert.equal(runner.onBeforeTryTask(subject, { retry: 0, repeats: 0 }), 'try-result');
  assert.equal(runner.onAfterRunTask(subject), 'test-result'); assert.equal(await runner.onAfterRunSuite(file), 'after');
  assert.deepEqual(delegated.map(x => x[0]), ['collect', 'import', 'before-suite', 'before-test', 'try', 'after-test', 'after-suite']);
  assert.deepEqual(events.map(x => x.event), ['worker-before-collect', 'worker-collect-start', 'worker-import-start', 'worker-import-end', 'worker-collected', 'worker-module-start', 'worker-test-ready', 'worker-test-attempt', 'worker-test-result', 'worker-module-end']);
  const failure = new Error('original failure');
  class Failing { importFile() { return Promise.reject(failure); } }
  await assert.rejects(new (makeRunner(Failing, () => {}))().importFile('/a', 'collect'), error => error === failure);
});

test('read-only sequencer returns the default array and refuses warm result entries', async () => {
  let calls = 0; const events = [], input = [{ moduleId: '/r/a.test.ts', pool: 'threads', project: { name: '', config: { isolate: false, sequence: { groupOrder: 0 } } } }];
  const sorted = [...input];
  class Base { constructor(ctx) { this.ctx = ctx; } async sort(files) { assert.equal(files, input); calls++; return sorted; } }
  let prior;
  const ctx = { config: { root: '/r' }, cache: { getFileStats: () => ({ size: 5 }), getFileTestResults: () => prior } };
  const Seq = makeSequencer(Base, (event, fields) => events.push({ event, ...fields }), [{ path: 'a.test.ts' }]);
  assert.equal(await new Seq(ctx).sort(input), sorted); assert.equal(calls, 1); assert.equal(events[0].output[0].stats.size, 5);
  prior = { duration: 7, failed: false }; await assert.rejects(new Seq(ctx).sort(input), /historical results/);
});

test('trace writes survive absent run-end, retain a truncated tail, and checksum every partial byte', () => {
  const dir = temporary(), trace = join(dir, 'trace'); mkdirSync(trace);
  try {
    let tick = 0;
    const emit = makeWriter('reporter', { directory: trace, now: () => '2026-10-09T00:00:00.000Z', monotonic: () => String(++tick) });
    emit('module-queued', { id: 'm', file: 'worker-tasks.test.ts' }); emit('test-ready', { id: 't' });
    const records = readTrace(trace); assert.equal(records.length, 2); assert.deepEqual(records.map(x => x.sequence), [1, 2]);
    assert(records.every(x => Number.isInteger(x.pid) && Number.isInteger(x.threadId)));
    assert.throws(() => validateTrace(records, 'candidate'), /Missing|completed full run/);
    writeFileSync(join(trace, 'worker-truncated.jsonl'), '{"event":"worker-test');
    writeFileSync(join(dir, 'raw.stdout.log'), Buffer.from([0, 1, 255, 10]));
    const files = sealArtifacts(dir); const partial = files.find(x => x.path === 'trace/worker-truncated.jsonl');
    assert.equal(partial.sha256, sha256(Buffer.from('{"event":"worker-test')));
    assert.throws(() => readTrace(trace, 'worker'), /Partial trace/);
    for (const item of files) assert.equal(item.sha256, sha256(readFileSync(join(dir, item.path))));
    assert(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').includes('artifacts.json'));
  } finally { rmSync(dir, { recursive: true }); }
});

test('cache receipts require separate real empty roots and detect baseline pollution', () => {
  const dir = temporary();
  try {
    const a = join(dir, 'baseline'), b = join(dir, 'candidate'); mkdirSync(a); mkdirSync(b);
    const before = cacheReceipt(a), other = cacheReceipt(b);
    assert.notEqual(before.realpath, other.realpath); assert.equal(before.inventorySha256, other.inventorySha256);
    writeFileSync(join(a, 'results.json'), '{"duration":8}');
    assert.notEqual(cacheReceipt(a).inventorySha256, before.inventorySha256); assert.deepEqual(cacheReceipt(b), other);
  } finally { rmSync(dir, { recursive: true }); }
});

test('CPU/liveness sampling includes independent monitor and process/thread tick fields', () => {
  const f = ['R', '1', '77', '77', ...Array(7).fill('0'), '12', '7', ...Array(4).fill('0'), '3', '0', '99', '100', '200'];
  const row = parseStat('123 (name with ) paren) ' + f.join(' '));
  assert.equal(row.pid, 123); assert.equal(row.group, 77); assert.equal(row.userTicks, 12); assert.equal(row.systemTicks, 7);
  const result = sample(77, { members: () => [row], stat: () => row, list: () => ['123', '124'], read: () => '1.0 2.0\n' });
  assert.equal(result.processes[0].tasks.length, 2); assert.equal(result.monitorPid, process.pid); assert.equal(result.loadavg, '1.0 2.0');
});

test('owned process timeout retains raw partial logs and verified cleanup', async () => {
  const dir = temporary();
  try {
    const result = await runCommand({ name: 'fake-busy-worker', command: process.execPath, args: ['-e', "process.stdout.write('partial\\n'); while (true) {}"], cwd: dir, prefix: join(dir, 'busy'), timeoutMs: 300 });
    assert.equal(result.timedOut, true); assert.equal(result.complete, false); assert.equal(result.cleanup.status, 'verified-no-live-processes');
    assert.equal(readFileSync(result.stdout, 'utf8'), 'partial\n');
    const samples = readFileSync(result.samples, 'utf8').trim().split('\n').map(JSON.parse);
    assert(samples.some(x => x.event === 'deadline')); assert(samples.some(x => x.processes.length));
    assert.equal(TEST_TIMEOUT_MS, 600000); assert.equal(CLEANUP_TIMEOUT_MS, 1000);
  } finally { rmSync(dir, { recursive: true }); }
});

test('first-push invocation rejects reruns, replacement pushes, and local execution', () => {
  const head = 'a'.repeat(40), env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/' + BRANCH, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head };
  const event = { ref: env.GITHUB_REF, after: head, before: '0'.repeat(40), created: true, deleted: false, forced: false };
  assert.equal(verifyInvocation(env, event, head).runAttempt, 1);
  assert.throws(() => verifyInvocation({ ...env, GITHUB_RUN_ATTEMPT: '2' }, event, head));
  assert.throws(() => verifyInvocation(env, { ...event, created: false }, head)); assert.throws(() => verifyInvocation({}, event, head));
});

test('config keeps original config and changes only observation/cache inputs; suites remain original', () => {
  const config = configSource('/task/baseline', '/task/cache');
  assert(config.includes('...base, root:')); assert(config.includes('...base.test, reporters:')); assert(config.includes('...base.test?.sequence'));
  assert(!/testTimeout:|maxWorkers:|isolate:|include:|exclude:|retry:/.test(config));
  const baseline = new Set(PINS.baseline.testFiles.map(x => x.path)), candidate = new Set(PINS.candidate.testFiles.map(x => x.path));
  assert.deepEqual([...candidate].filter(x => !baseline.has(x)), ['block-rotation.test.ts']);
  assert.deepEqual([...baseline].filter(x => !candidate.has(x)), []);
  for (const file of PINS.baseline.testFiles) assert.deepEqual(PINS.candidate.testFiles.find(x => x.path === file.path), file);
});

test('complete fake lifecycle seals only when every original module and test finishes', () => {
  const records = [];
  for (const file of PINS.baseline.testFiles) for (const event of ['module-queued', 'module-collected', 'module-start', 'module-end']) records.push({ event, relativeFile: file.path, state: 'passed' });
  for (let index = 0; index < 774; index++) for (const event of ['test-ready', 'test-result']) records.push({ event, id: String(index), state: 'passed' });
  records.push({ event: 'run-end', reason: 'passed', unhandledErrors: [] });
  assert.deepEqual(validateTrace(records, 'baseline'), { modules: 41, tests: 774, reason: 'passed' });
  assert.throws(() => validateTrace(records.filter(r => r.event !== 'run-end'), 'baseline'));
  const failed = records.map(r => r.event === 'test-result' && r.id === '9' ? { ...r, state: 'failed' } : r);
  assert.throws(() => validateTrace(failed, 'baseline'));
  assert.throws(() => validateTrace(records.filter(r => !(r.event === 'test-ready' && r.id === '9')), 'baseline'));
});

test('full fake observation requires worker identities, matching transitions and untouched default ordering inputs', () => {
  const dir = temporary(), reporter = [], workers = [], root = '/fake/root';
  const worker = row => ({ isMainThread: false, workerId: '0', poolId: '1', ...row });
  try {
    for (const file of PINS.baseline.testFiles) {
      for (const event of ['module-queued', 'module-collected', 'module-start', 'module-end']) reporter.push({ event, relativeFile: file.path, state: 'passed' });
      for (const event of ['worker-collect-start', 'worker-module-start', 'worker-module-end', 'worker-import-start', 'worker-import-end']) workers.push(worker({ event, file: join(root, file.path), importSource: 'collect' }));
    }
    for (let index = 0; index < 774; index++) {
      for (const event of ['test-ready', 'test-result']) reporter.push({ event, id: String(index), state: 'passed' });
      for (const event of ['worker-test-ready', 'worker-test-result']) workers.push(worker({ event, id: String(index), state: 'pass' }));
    }
    reporter.push({ event: 'run-end', reason: 'passed', unhandledErrors: [] });
    const order = PINS.baseline.testFiles.map(f => ({ file: f.path, priorResult: null, stats: { size: f.bytes } }));
    const write = (source, records) => writeFileSync(join(dir, source + '-fake.jsonl'), records.map(r => JSON.stringify(r) + '\n').join(''));
    write('reporter', reporter); write('worker', workers); write('sequencer', [{ event: 'default-sequencer-order', input: order, output: order }]);
    assert.equal(validateObservation(dir, 'baseline', root).tests, 774);
    write('worker', workers.map((r, index) => index === 0 ? { ...r, poolId: null } : r));
    assert.throws(() => validateObservation(dir, 'baseline', root), /worker identity/);
    write('worker', workers.filter(r => !(r.event === 'worker-module-end' && r.file.endsWith('worker-tasks.test.ts'))));
    assert.throws(() => validateObservation(dir, 'baseline', root), /worker-module-end/);
  } finally { rmSync(dir, { recursive: true }); }
});
