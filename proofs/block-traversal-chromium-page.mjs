// Browser-only observation. All correctness assertions live in the unchanged
// original function bodies served by the generated single-case module.
export async function runCase({ origin, role, scenario }) {
  const telemetry = { stage: 'cross-origin-isolation', events: [], transports: [], memories: [], workers: [], cleanup: {} };
  const references = [], workers = [], NativeWorker = globalThis.Worker;
  const mark = stage => { telemetry.stage = stage; telemetry.events.push(stage); };
  let result, failure;
  try {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation required');
    mark('source-import');
    const original = await import(`${origin}/${role}/shared.js`);
    const S = { ...original, getWorkerData(...args) {
      const data = original.getWorkerData(...args);
      telemetry.transports.push({ copy: args[1]?.copy ?? false, roots: Object.keys(args[0]), arenas: data.arenas.length });
      for (const arena of data.arenas) if (arena.memory && !references.some(row => row.memory === arena.memory)) {
        references.push({ memory: arena.memory, beforeBytes: arena.memory.buffer.byteLength });
      }
      return data;
    } };
    globalThis.Worker = class ObservedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.receipt = { url: String(args[0]), constructed: true, posted: 0, paused: 0, done: 0, errors: [], terminationCalls: 0, emergencyTerminationCalls: 0 };
        telemetry.workers.push(this.receipt); workers.push(this);
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'paused') { this.receipt.paused++; this.receipt.pauseIndex = data.index; }
          if (data.type === 'error') { this.receipt.errors.push(data.error); mark('worker-reported-error'); }
          if (data.type === 'done') {
            this.receipt.done++;
            this.receipt.resultCounts = Object.fromEntries(['values', 'indices', 'array', 'fork', 'nested', 'compacted', 'compactedFork', 'compactedNested'].map(key => [key, data[key]?.length ?? null]));
            this.receipt.nestedLengths = data.nested?.map(item => item.length);
            this.receipt.compactedNestedLengths = data.compactedNested?.map(item => item.length);
            this.receipt.writeRejected = data.writeRejected;
          }
        });
        this.addEventListener('error', event => { this.receipt.errors.push(event.message); mark('worker-error-event'); });
      }
      postMessage(...args) { this.receipt.posted++; return super.postMessage(...args); }
      terminate(...args) { this.receipt.terminationCalls++; return super.terminate(...args); }
    };
    mark('checks-import');
    const checks = await import(`${origin}/study/single-case.mjs`);
    mark(`${scenario.type}-original-checks`);
    result = scenario.type === 'fixture'
      ? await checks.runSingleFixture(S, scenario.workload)
      : await checks.runSingleWorker(S, `${origin}/${role}/shared.js`, `${origin}/proofs/block-traversal-worker.mjs`, scenario.workload);
    mark('single-result-validation');
    if (result.length !== 1) throw new Error('Expected exactly one original result');
    if (scenario.type === 'fixture' && result[0] !== scenario.name) throw new Error('Wrong fixture executed');
    if (scenario.type === 'worker') {
      for (const key of ['kind', 'copy', 'reverse']) if (result[0][key] !== scenario.workload[key]) throw new Error(`Wrong worker ${key}`);
      if (workers.length !== 1 || workers[0].receipt.terminationCalls !== 1) throw new Error('Original worker cleanup was not observed exactly once');
    } else if (workers.length) throw new Error('Fixture unexpectedly started a worker');
  } catch (error) {
    failure = { stage: telemetry.stage, name: error.name, message: error.message, stack: String(error.stack ?? error) };
  } finally {
    telemetry.cleanup.originalTerminationCalls = workers.reduce((n, worker) => n + worker.receipt.terminationCalls, 0);
    for (const worker of workers) if (!worker.receipt.terminationCalls) {
      worker.receipt.emergencyTerminationCalls++; NativeWorker.prototype.terminate.call(worker);
    }
    telemetry.memories = references.map(({ memory, beforeBytes }) => ({ beforeBytes, afterBytes: memory.buffer.byteLength, grownPages: (memory.buffer.byteLength - beforeBytes) / 65536 }));
    globalThis.Worker = NativeWorker; telemetry.cleanup.globalWorkerRestored = globalThis.Worker === NativeWorker;
  }
  return { status: failure ? 'failed' : 'passed', result, telemetry, error: failure ?? null };
}
