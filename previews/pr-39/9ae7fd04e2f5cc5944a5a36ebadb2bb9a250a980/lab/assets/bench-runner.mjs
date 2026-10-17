import { validateConfig, verifyChecksums, summarize, orderFor, BENCHMARK_PATHS } from './bench-core.mjs';
import { buildReplica, encodeReplica } from './bench-maps.mjs';
import { immutableVersion, immerVersion } from '../vendor/version.mjs';
let peers = [], running = false, requestId = 0;
function dispose() { for (const peer of peers) peer.terminate(); peers = []; }
/** Each request has bounded waiting time and removes all temporary listeners. */
function request(worker, body) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error); worker.removeEventListener('messageerror', error); };
    const message = event => { if (event.data.id !== id) return; clean(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
    const error = event => { clean(); reject(new Error(event.message ?? 'Reader communication failed')); };
    const timer = setTimeout(() => { clean(); reject(new Error('A reader timed out')); }, 30000);
    worker.addEventListener('message', message); worker.addEventListener('error', error); worker.addEventListener('messageerror', error);
    try { worker.postMessage({ ...body, id }); } catch (failure) { clean(); reject(failure); }
  });
}
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { dispose(); self.close(); return; }
  if (data.type !== 'run' || running) return;
  running = true;
  try {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Shared memory unavailable');
    const config = validateConfig(data.config);
    self.postMessage({ type: 'status', message: 'Loading the source build and preparing equal datasets…', completed: 0 });
    const { SharedMap, getWorkerData } = await import('../library/shared.js');
    const keys = Array.from({ length: config.entries }, (_, i) => `lane-${i}`);
    const replicas = {}, construction = {};
    for (const path of ['immutable', 'immer']) {
      const start = performance.now(); replicas[path] = buildReplica(path, keys);
      construction[path + 'Ms'] = performance.now() - start;
    }
    const start = performance.now();
    let shared = new SharedMap('number'); for (let i = 0; i < config.entries; i++) shared = shared.set(keys[i], i);
    construction.sharedMs = performance.now() - start;
    const initial = getWorkerData({ values: shared }, { copy: false });
    if (initial.arenas.some(arena => !(arena.memory?.buffer instanceof SharedArrayBuffer) || arena.copy)) throw new Error('Expected shared backing memory, not a copy fallback');
    for (let index = 0; index < config.readers; index++) peers.push(new Worker(new URL('./bench-reader.mjs', import.meta.url), { type: 'module' }));
    await Promise.all(peers.map(peer => request(peer, { type: 'init', entries: config.entries })));
    const samples = Object.fromEntries(BENCHMARK_PATHS.map(path => [path, []])), raw = [], total = (config.warmups + config.samples) * BENCHMARK_PATHS.length;
    let completed = 0;
    for (let round = -config.warmups; round < config.samples; round++) {
      for (const path of orderFor(round + config.warmups)) {
        const begun = performance.now();
        const payload = path === 'shared' ? getWorkerData({ values: shared }, { copy: false }) : encodeReplica(path, replicas[path]);
        const answers = await Promise.all(peers.map(peer => request(peer, { type: path, payload })));
        const elapsed = performance.now() - begun;
        // Validate after timing. All reader results must agree with the input.
        verifyChecksums(answers, config.readers, config.entries);
        if (round >= 0) { samples[path].push(elapsed); raw.push({ round, path, elapsedMs: elapsed, readers: answers.map(({ checksum, readMs }) => ({ checksum, readMs })) }); }
        self.postMessage({ type: 'status', completed: ++completed, total, message: round < 0 ? 'Warming all three paths. Checking every answer…' : `Measured round ${round + 1} of ${config.samples}. Checksums match.` });
      }
    }
    self.postMessage({ type: 'result', result: {
      schema: 'zerocopy-browser-benchmark/v2', timestamp: new Date().toISOString(), sourceCommit: data.source,
      dependencies: { immutable: immutableVersion, immer: immerVersion },
      environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated: self.crossOriginIsolated, coordinatorWorkers: 1 },
      config, construction,
      summary: Object.fromEntries(BENCHMARK_PATHS.map(path => [path, summarize(samples[path])])), samples, raw,
      method: 'Wall time from snapshot encoding through parallel reader replies. Workers, module loading and dataset construction excluded. Each publication reattaches shared views, or structured-clones full replicas. Immutable.js Map entry encoding and Map reconstruction are included. Immer uses produce with Map support and default auto-freezing; each reader freezes the cloned Map. All three paths perform a get for every deterministic string key. Order rotates; all checksums checked. No memory or immutable-update measurement.'
    } });
  } catch (error) { self.postMessage({ type: 'error', message: error.message ?? String(error) }); }
  finally { dispose(); running = false; self.close(); }
};
