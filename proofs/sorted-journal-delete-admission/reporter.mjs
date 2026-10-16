// Bounded Vitest admission reporter; single non-watch run, Node built-ins only.
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_EVENTS = 16_000, MAX_BYTES = 8 * 1024 * 1024, TERMINAL_RESERVE = 256;
const FAILURE = 'Admission diagnostic reporter failure';
const MODULES = new Set(`
allocation-failure.test.ts block-traversal-view.test.ts bulk-input-storage.test.ts
checkpoint-descriptor-validation.test.ts descriptor-validation.test.ts freeze-json.test.ts
geometry.test.ts heap-entry-views.test.ts hot-path.test.ts immutable-proof.test.ts
json-read-cache.test.ts map-memory.test.ts map-projection.test.ts map-set-index.test.ts
map-set-path.test.ts map-set-utf8.test.ts nested.test.ts numeric-spatial.test.ts numeric.test.ts
ordered-empty-regression.test.ts performance-revision.test.ts primitive-scan-portability.test.ts
primitive-sequence-scan.test.ts proof-storage-integrity.test.ts redux-checkpoint.test.ts
redux-jsan.test.ts redux-regression.test.ts redux-rtk.test.ts redux-wide-json.test.ts redux.test.ts
shared-doubly-linked-list.test.ts shared-linked-list.test.ts shared-list.test.ts shared-map.test.ts
shared-priority-queue-insert.test.ts shared-priority-queue.test.ts shared-queue.test.ts
shared-set.test.ts shared-sorted.test.ts shared-stack.test.ts sorted-journal-delete.test.ts
tanstack-db-collection.test.ts trie-view-capture.test.ts typed-json-redux.test.ts typed-values.test.ts
utf8-write.test.ts worker-attachment.test.ts worker-records.test.ts worker-tasks.test.ts worker.test.ts
workers.test.ts
`.trim().split(/\s+/));
const STATES = new Set(['queued', 'pending', 'passed', 'failed', 'skipped']);
const REASONS = new Set(['passed', 'failed', 'interrupted']);
const digest = (a, b = '') => createHash('sha256').update(a).update('\0').update(b).digest('hex');
const scalar = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export default class AdmissionReporter {
  constructor({ outputFile = process.env.ZEROCOPY_ADMISSION_DIAGNOSTIC_FILE } = {}) {
    if (typeof outputFile !== 'string' || !isAbsolute(outputFile))
      throw new Error('Admission reporter requires an absolute outputFile.');
    this.outputFile = outputFile;
    this.tests = new Map(); // Fixed-length digests -> encounter ordinals; never task objects.
    this.events = 0;
    this.bytes = 0;
    this.started = false;
  }
  onTestRunStart() {
    if (this.started) return;
    this.started = true;
    this.origin = performance.now();
    try { this.fd = openSync(this.outputFile, 'wx', 0o600); }
    catch { this.fail(); }
    this.emit('run-start', 0, { reporterPid: process.pid });
    if (this.fd !== undefined) {
      this.timer = setInterval(() => this.emit('reporter-liveness', this.now()), 1000);
      this.timer.unref();
    }
  }
  now() { return performance.now() - this.origin; }
  onTestModuleQueued(module) { this.task('module-queued', module); }
  onTestModuleCollected(module) { this.task('module-collected', module); }
  onTestModuleStart(module) { this.task('module-start', module); }
  onTestModuleEnd(module) { this.task('module-end', module); }
  onTestCaseReady(test) { this.task('test-ready', test.module, test); }
  onTestCaseResult(test) { this.task('test-result', test.module, test); }
  task(event, module, test) {
    if (this.fd === undefined) return;
    const deliveredMs = this.now();
    if (!MODULES.has(module.relativeModuleId)) this.fail();
    const data = { module: 'm' + digest(module.relativeModuleId) };
    if (test) {
      const fullName = test.fullName;
      if (typeof fullName !== 'string' || Buffer.byteLength(fullName, 'utf8') > 2048) this.fail();
      const key = digest(module.relativeModuleId, test.id);
      const first = !this.tests.has(key);
      if (first) this.tests.set(key, this.tests.size + 1);
      data.test = this.tests.get(key);
      data.testId = 'i' + key;
      data.title = 't' + digest(module.relativeModuleId, fullName);
      if (first) this.emit('case-map', deliveredMs, { ...data, moduleName: module.relativeModuleId, fullName });
    }
    const state = test ? test.result().state : module.state();
    data.state = STATES.has(state) ? state : 'unknown';
    const diagnostic = event === 'test-result' ? test.diagnostic()
      : event === 'module-end' ? module.diagnostic() : undefined;
    if (diagnostic) {
      data.runtimeHeapUsedSnapshotBytes = scalar(diagnostic.heap);
      data.durationMs = scalar(diagnostic.duration);
      if (test) data.reportedStartTimeMs = scalar(diagnostic.startTime);
    }
    this.emit(event, deliveredMs, data);
  }
  emit(event, deliveredMs, data = {}) {
    if (this.fd === undefined) return;
    let line = JSON.stringify({ v: 1, seq: this.events + 1, event, deliveredMs, ...data }) + '\n';
    let length = Buffer.byteLength(line, 'utf8');
    const limit = this.events >= MAX_EVENTS - 1 ? 'event-cap'
      : this.bytes + length > MAX_BYTES - TERMINAL_RESERVE ? 'byte-cap' : undefined;
    if (limit) {
      line = JSON.stringify({ v: 1, seq: this.events + 1, event: 'limit', deliveredMs, reason: limit }) + '\n';
      length = Buffer.byteLength(line, 'utf8');
    }
    // The reserved terminal record must also fit. No buffered event backlog.
    if (this.events >= MAX_EVENTS || this.bytes + length > MAX_BYTES) this.fail();
    try { appendFileSync(this.fd, line, 'utf8'); }
    catch { this.fail(); }
    this.events++;
    this.bytes += length;
    if (limit) this.fail();
  }
  onTestRunEnd(_modules, _errors, reason) {
    this.emit('run-end', this.now(), { reason: REASONS.has(reason) ? reason : 'unknown' });
    this.stop();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    const fd = this.fd;
    this.fd = undefined;
    this.tests.clear();
    if (fd !== undefined) {
      try { closeSync(fd); } catch { this.failure(); }
    }
  }
  fail() {
    this.stop();
    this.failure();
  }
  failure() {
    try { process.stderr.write(FAILURE + '\n'); } catch { /* Throw even if stderr is unavailable. */ }
    throw new Error(FAILURE);
  }
}
