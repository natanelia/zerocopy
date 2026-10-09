import { appendFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { threadId, isMainThread } from 'node:worker_threads';

export function makeWriter(source, { directory = process.env.BLOCK_DIAGNOSTIC_TRACE, now = () => new Date().toISOString(), monotonic = () => process.hrtime.bigint().toString(), append = appendFileSync } = {}) {
  if (!directory) throw new Error('BLOCK_DIAGNOSTIC_TRACE is required');
  const file = join(directory, `${source}-${process.pid}-${threadId}.jsonl`);
  let sequence = 0;
  return (event, fields = {}) => {
    const record = { schema: 1, source, event, sequence: ++sequence, timestamp: now(), monotonicNs: monotonic(),
      pid: process.pid, threadId, isMainThread, poolId: process.env.VITEST_POOL_ID ?? null,
      workerId: process.env.VITEST_WORKER_ID ?? null, ...fields };
    append(file, JSON.stringify(record) + '\n');
    return record;
  };
}
export function taskFields(task) {
  return { id: task.id, file: task.filepath ?? task.file?.filepath ?? null, name: task.name,
    type: task.type, mode: task.mode, state: task.result?.state ?? null };
}
export function moduleFields(module) {
  return { id: module.id, file: module.moduleId, relativeFile: module.relativeModuleId, state: module.state() };
}
export function caseFields(test) {
  return { id: test.id, file: test.module.moduleId, name: test.fullName, state: test.result().state,
    timeout: test.options.timeout ?? null, mode: test.options.mode };
}
export function makeReporter(emit, expected = null) {
  const ensure = (yes, message) => { if (!yes) throw new Error(message); };
  return class DiagnosticReporter {
    onInit(ctx) {
      this.root = ctx.config.root;
      const cfg = ctx.config;
      emit('reporter-init', { root: this.root, config: { pool: cfg.pool, isolate: cfg.isolate,
        fileParallelism: cfg.fileParallelism, globals: cfg.globals, testTimeout: cfg.testTimeout,
        teardownTimeout: cfg.teardownTimeout, minWorkers: cfg.minWorkers, maxWorkers: cfg.maxWorkers,
        cache: cfg.cache, bundler: cfg.bundler, include: cfg.include, exclude: cfg.exclude, retry: cfg.retry, sequence: {
          shuffle: cfg.sequence.shuffle, concurrent: cfg.sequence.concurrent, seed: cfg.sequence.seed,
          hooks: cfg.sequence.hooks, setupFiles: cfg.sequence.setupFiles } } });
      if (expected) {
        for (const [key, value] of Object.entries({ pool: 'threads', isolate: false, fileParallelism: true,
          globals: true, bundler: 'rolldown', testTimeout: 5000, teardownTimeout: 1000, minWorkers: 1, maxWorkers: 4 })) ensure(cfg[key] === value, `Changed standard config: ${key}`);
        ensure(cfg.cache?.dir === join(process.env.BLOCK_DIAGNOSTIC_CACHE, 'vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709'), 'Resolved results cache is outside its task-owned root');
      }
    }
    onTestRunStart(specifications) {
      const files = specifications.map(spec => ({ file: relative(this.root, spec.moduleId), pool: spec.pool,
        project: spec.project.name, taskId: spec.taskId }));
      emit('run-discovered', { files });
      if (expected) ensure(JSON.stringify(files.map(x => x.file).sort()) === JSON.stringify(expected.map(x => x.path).sort()), 'Discovered test list differs from frozen unchanged suite');
    }
    onTestModuleQueued(module) { emit('module-queued', moduleFields(module)); }
    onTestModuleCollected(module) { emit('module-collected', moduleFields(module)); }
    onTestModuleStart(module) { emit('module-start', moduleFields(module)); }
    onTestModuleEnd(module) { emit('module-end', moduleFields(module)); }
    onTestCaseReady(test) { emit('test-ready', caseFields(test)); }
    onTestCaseResult(test) { emit('test-result', caseFields(test)); }
    onTestRunEnd(modules, errors, reason) {
      emit('run-end', { reason, modules: modules.map(moduleFields), unhandledErrors: errors.map(e => ({ name: e.name, message: e.message, stack: e.stack })) });
    }
    onProcessTimeout() { emit('vitest-process-timeout'); }
  };
}
export function expectedFiles() {
  const pins = JSON.parse(readFileSync(process.env.BLOCK_DIAGNOSTIC_PINS, 'utf8'));
  return pins[process.env.BLOCK_DIAGNOSTIC_ARM].testFiles;
}
// Preserve default return values, rejection and delegation. No test/task mutation.
function after(value, callback) {
  if (value && typeof value.then === 'function') return value.then(result => { callback(); return result; });
  callback(); return value;
}
export function makeRunner(Base, emit) {
  return class DiagnosticRunner extends Base {
    onBeforeCollect(paths) { emit('worker-before-collect', { files: paths }); return super.onBeforeCollect?.(paths); }
    onCollectStart(file) { emit('worker-collect-start', taskFields(file)); return super.onCollectStart(file); }
    onCollected(files) { return after(super.onCollected?.(files), () => emit('worker-collected', { files: files.map(taskFields) })); }
    importFile(file, source) {
      emit('worker-import-start', { file, importSource: source });
      return after(super.importFile(file, source), () => emit('worker-import-end', { file, importSource: source }));
    }
    onBeforeRunSuite(suite) {
      if ('filepath' in suite) emit('worker-module-start', taskFields(suite));
      return super.onBeforeRunSuite(suite);
    }
    onAfterRunSuite(suite) {
      return after(super.onAfterRunSuite(suite), () => { if ('filepath' in suite) emit('worker-module-end', taskFields(suite)); });
    }
    onBeforeRunTask(test) { emit('worker-test-ready', taskFields(test)); return super.onBeforeRunTask(test); }
    onBeforeTryTask(test, options) {
      return after(super.onBeforeTryTask(test, options), () => emit('worker-test-attempt', { ...taskFields(test), retry: options?.retry, repeats: options?.repeats }));
    }
    onAfterRunTask(test) { return after(super.onAfterRunTask(test), () => emit('worker-test-result', taskFields(test))); }
  };
}
export function makeSequencer(Base, emit, expected = null) {
  return class DiagnosticSequencer extends Base {
    async sort(files) {
      const sorted = await super.sort(files);
      const record = spec => ({ file: relative(this.ctx.config.root, spec.moduleId), pool: spec.pool,
        project: spec.project.name, isolate: spec.project.config.isolate, groupOrder: spec.project.config.sequence.groupOrder,
        stats: this.ctx.cache.getFileStats(`${spec.project.name}:${relative(this.ctx.config.root, spec.moduleId)}`) ?? null,
        priorResult: this.ctx.cache.getFileTestResults(`${spec.project.name}:${relative(this.ctx.config.root, spec.moduleId)}`) ?? null });
      emit('default-sequencer-order', { input: files.map(record), output: sorted.map(record) });
      if (expected) {
        const paths = sorted.map(spec => relative(this.ctx.config.root, spec.moduleId)).sort();
        if (JSON.stringify(paths) !== JSON.stringify(expected.map(x => x.path).sort())) throw new Error('Sequencer test list differs from frozen suite');
        if (files.some(spec => record(spec).priorResult !== null)) throw new Error('Fresh result cache unexpectedly contains historical results');
      }
      return sorted;
    }
  };
}
