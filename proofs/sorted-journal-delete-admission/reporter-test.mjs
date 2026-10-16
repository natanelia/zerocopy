// Synthetic reporter checks: mocked filesystem, timers and clock; no collection imports.
// Run with Node --experimental-vm-modules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const source = readFileSync(new URL('./reporter.mjs', import.meta.url), 'utf8');
const FAILURE = 'Admission diagnostic reporter failure';
const failsClosed = (fn) => assert.throws(fn, error => error.message === FAILURE);
async function fixture({ rejectOpen = false, rejectAppend = false, rejectClose = false, fromEnv = false } = {}) {
  const lines = [], warnings = [];
  let now = 0, timer, opened = 0, closed = 0, bytes = 0;
  const context = createContext({
    Buffer,
    setInterval(fn, ms) { assert.equal(ms, 1000); timer = fn; return { unref() {} }; },
    clearInterval() { timer = undefined; },
    process: { pid: 4242, env: { ZEROCOPY_ADMISSION_DIAGNOSTIC_FILE: '/synthetic/telemetry.jsonl' },
      stderr: { write(text) { warnings.push(text); } } },
  });
  const ports = {
    'node:fs': {
      openSync(path, flags, mode) {
        assert.equal(path, '/synthetic/telemetry.jsonl');
        assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
        if (rejectOpen) throw new Error('PRIVATE_OPEN_ERROR');
        opened++; return 7;
      },
      appendFileSync(fd, line, encoding) {
        assert.equal(fd, 7); assert.equal(encoding, 'utf8');
        if (rejectAppend) throw new Error('PRIVATE_APPEND_ERROR');
        bytes += Buffer.byteLength(line);
        assert.ok(bytes <= 8 * 1024 * 1024); assert.ok(lines.length < 16_000);
        lines.push(line);
      },
      closeSync(fd) {
        assert.equal(fd, 7); closed++;
        if (rejectClose) throw new Error('PRIVATE_CLOSE_ERROR');
      },
    },
    'node:crypto': { createHash }, 'node:path': { isAbsolute },
    'node:perf_hooks': { performance: { now: () => now } },
  };
  const entry = new SourceTextModule(source, { context });
  await entry.link((name) => {
    assert.ok(Object.hasOwn(ports, name), 'Only four approved Node built-ins may be linked.');
    const values = ports[name];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await entry.evaluate();
  return {
    reporter: fromEnv ? new entry.namespace.default()
      : new entry.namespace.default({ outputFile: '/synthetic/telemetry.jsonl' }),
    lines, warnings,
    advance(ms) { now += ms; },
    pulse() { assert.equal(typeof timer, 'function'); timer(); },
    status() { return { opened, closed, timer: typeof timer, bytes }; },
  };
}
const moduleA = {
  relativeModuleId: 'sorted-journal-delete.test.ts', id: 'PRIVATE_module_a_id',
  state: () => 'passed',
  diagnostic: () => ({ heap: 2048, duration: 40, startTime: 999, privateValue: 'PRIVATE' }),
};
const caseA = {
  module: moduleA, id: 'PRIVATE_case_a_id', name: 'PRIVATE', fullName: 'synthetic suite > duplicate title',
  result: () => ({ state: 'passed', errors: [{ message: 'PRIVATE_ERROR' }] }),
  diagnostic: () => ({ heap: 1024, duration: 12, startTime: 1700000000000, privateValue: 'PRIVATE' }),
};
const f = await fixture(), r = f.reporter;
r.onTestRunStart();
r.onTestModuleQueued(moduleA); r.onTestModuleCollected(moduleA); r.onTestModuleStart(moduleA);
r.onTestCaseReady(caseA); f.advance(1000); f.pulse(); r.onTestCaseResult(caseA);
r.onTestCaseResult({ ...caseA, id: 'PRIVATE_case_b_id', diagnostic: () => undefined });
r.onTestModuleEnd(moduleA); r.onTestRunEnd([], [], 'passed');
const rows = f.lines.map(JSON.parse);
assert.deepEqual(rows.map(x => x.event), ['run-start', 'module-queued', 'module-collected',
  'module-start', 'case-map', 'test-ready', 'reporter-liveness', 'test-result', 'case-map', 'test-result', 'module-end', 'run-end']);
const allowed = new Set(['v', 'seq', 'event', 'deliveredMs', 'module', 'test', 'testId', 'title', 'state',
  'runtimeHeapUsedSnapshotBytes', 'durationMs', 'reportedStartTimeMs', 'reason', 'reporterPid', 'moduleName', 'fullName']);
for (const [i, row] of rows.entries()) {
  assert.equal(row.seq, i + 1); assert.ok(row.deliveredMs >= (rows[i - 1]?.deliveredMs ?? 0));
  for (const [key, value] of Object.entries(row)) {
    assert.ok(allowed.has(key)); assert.ok(['string', 'number'].includes(typeof value));
  }
  if (row.module) assert.match(row.module, /^m[0-9a-f]{64}$/);
  if (row.title) assert.match(row.title, /^t[0-9a-f]{64}$/);
  if (row.testId) assert.match(row.testId, /^i[0-9a-f]{64}$/);
}
assert.ok(!f.lines.join('').includes('PRIVATE'));
assert.equal(rows[5].test, rows[7].test); assert.equal(rows[9].test, 2);
assert.equal(rows[5].title, 't' + createHash('sha256').update(moduleA.relativeModuleId)
  .update('\0').update(caseA.fullName).digest('hex'));
assert.equal(rows[7].title, rows[9].title); // Duplicate public titles share a title hash, not an ordinal.
assert.equal(rows[5].testId, rows[7].testId); assert.notEqual(rows[7].testId, rows[9].testId);
assert.equal(rows[7].testId, 'i' + createHash('sha256').update(moduleA.relativeModuleId)
  .update('\0').update(caseA.id).digest('hex'));
assert.equal(rows[7].runtimeHeapUsedSnapshotBytes, 1024);
assert.equal(rows[7].reportedStartTimeMs, 1700000000000);
assert.equal(rows[9].durationMs, undefined); assert.equal(rows[10].reportedStartTimeMs, undefined);
assert.equal(rows[6].deliveredMs, 1000); assert.equal(rows[0].reporterPid, 4242);
assert.equal(rows.filter(row => Object.hasOwn(row, 'reporterPid')).length, 1);
for (const row of rows.filter(row => row.event === 'case-map')) {
  assert.equal(row.moduleName, moduleA.relativeModuleId); assert.equal(row.fullName, caseA.fullName);
}
assert.equal(rows.filter(row => Object.hasOwn(row, 'fullName')).length, 2);
assert.deepEqual(f.status(), { opened: 1, closed: 1, timer: 'undefined', bytes: f.status().bytes });
r.onTestRunStart(); r.onTestCaseReady(caseA); assert.equal(f.lines.length, 12);

const capped = await fixture(); capped.reporter.onTestRunStart();
for (let i = 0; i < 7_999; i++) capped.reporter.onTestCaseReady({ ...caseA, id: `synthetic-${i}` });
failsClosed(() => capped.reporter.onTestCaseReady({ ...caseA, id: 'synthetic-cap' }));
assert.equal(capped.lines.length, 16_000);
assert.equal(JSON.parse(capped.lines.at(-1)).reason, 'event-cap');
assert.equal(capped.reporter.tests.size, 0); assert.equal(capped.status().timer, 'undefined');

const byteBoundary = await fixture(); byteBoundary.reporter.onTestRunStart();
// White-box counter injection checks the independent byte-limit branch without generating huge inputs.
byteBoundary.reporter.bytes = 8 * 1024 * 1024 - 256;
failsClosed(() => byteBoundary.reporter.onTestCaseResult(caseA));
assert.equal(JSON.parse(byteBoundary.lines.at(-1)).reason, 'byte-cap');
assert.ok(byteBoundary.reporter.bytes <= 8 * 1024 * 1024);

const invalid = await fixture(); invalid.reporter.onTestRunStart();
invalid.reporter.onTestCaseResult({ ...caseA, result: () => ({ state: 'PRIVATE_STATE' }),
  diagnostic: () => ({ heap: NaN, duration: Infinity, startTime: -1 }) });
invalid.reporter.onTestRunEnd([], [], 'PRIVATE_REASON');
assert.deepEqual(Object.keys(JSON.parse(invalid.lines[2])), ['v', 'seq', 'event', 'deliveredMs', 'module', 'test', 'testId', 'title', 'state']);
assert.ok(!invalid.lines.join('').includes('PRIVATE'));

for (const options of [{ rejectOpen: true }, { rejectAppend: true }]) {
  const failed = await fixture(options); failsClosed(() => failed.reporter.onTestRunStart());
  assert.equal(failed.lines.length, 0); assert.equal(failed.status().timer, 'undefined');
  assert.equal(failed.reporter.tests.size, 0);
  assert.deepEqual(failed.warnings, [FAILURE + '\n']);
}
const closeFailure = await fixture({ rejectClose: true }); closeFailure.reporter.onTestRunStart();
failsClosed(() => closeFailure.reporter.onTestRunEnd([], [], 'passed'));
assert.equal(closeFailure.status().timer, 'undefined'); assert.equal(closeFailure.reporter.tests.size, 0);
const heartbeatFailure = await fixture(); heartbeatFailure.reporter.onTestRunStart();
heartbeatFailure.reporter.events = 15_999;
failsClosed(() => heartbeatFailure.pulse());
assert.equal(heartbeatFailure.status().timer, 'undefined');
const environmentDefault = await fixture({ fromEnv: true }); environmentDefault.reporter.onTestRunStart();
environmentDefault.reporter.onTestRunEnd([], [], 'passed');
assert.equal(environmentDefault.status().opened, 1);
for (const badCase of [
  { ...caseA, module: { ...moduleA, relativeModuleId: '/private/absolute.test.ts' } },
  { ...caseA, fullName: 'x'.repeat(2049) },
  { ...caseA, fullName: null },
]) {
  const invalidMap = await fixture(); invalidMap.reporter.onTestRunStart();
  failsClosed(() => invalidMap.reporter.onTestCaseReady(badCase));
  assert.equal(invalidMap.lines.length, 1); assert.equal(invalidMap.status().timer, 'undefined');
  assert.deepEqual(invalidMap.warnings, [FAILURE + '\n']);
}

// Existing public descriptor fixtures put LF, CR and NUL inside formatted titles.
for (const control of ['\n', '\r', '\0']) {
  const title = `complete descriptor validation > rejects SharedMap<number>${control} consistently`;
  const publicControls = await fixture(); publicControls.reporter.onTestRunStart();
  const entry = { ...caseA, module: { ...moduleA, relativeModuleId: 'descriptor-validation.test.ts' }, fullName: title };
  publicControls.reporter.onTestCaseReady(entry); publicControls.reporter.onTestCaseResult(entry);
  publicControls.reporter.onTestRunEnd([], [], 'passed');
  assert.equal(publicControls.lines.length, 5);
  for (const line of publicControls.lines) {
    assert.equal(line.at(-1), '\n');
    assert.ok(!/[\n\r\0]/u.test(line.slice(0, -1)), 'Public controls must be JSON-escaped within one record.');
  }
  const mapping = JSON.parse(publicControls.lines[1]);
  assert.equal(mapping.fullName, title);
  assert.equal(mapping.title, 't' + createHash('sha256').update('descriptor-validation.test.ts').update('\0').update(title).digest('hex'));
  assert.equal(publicControls.warnings.length, 0);
}

console.log(JSON.stringify({status: 'passed', groups: ['lifecycle', 'public-mapping', 'scalar-fields', 'stable-identities', 'event-cap', 'byte-cap', 'invalid-diagnostics', 'open-failure', 'append-failure', 'close-failure', 'heartbeat-failure', 'environment-default', 'invalid-mapping', 'public-control-titles']}));
