import { validateConfig, verifyChecksums, summarize, orderFor } from './bench-core.mjs';
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
    let start = performance.now();
    const native = new Map(); for (let i = 0; i < config.entries; i++) native.set(keys[i], i);
    const nativeBuildMs = performance.now() - start;
    start = performance.now();
    let shared = new SharedMap('number'); for (let i = 0; i < config.entries; i++) shared = shared.set(keys[i], i);
    const sharedBuildMs = performance.now() - start;
    const initial = getWorkerData({ values: shared }, { copy: false });
    if (initial.arenas.some(arena => !(arena.memory?.buffer instanceof SharedArrayBuffer) || arena.copy)) throw new Error('Expected shared backing memory, not a copy fallback');
    for (let index = 0; index < config.readers; index++) peers.push(new Worker(new URL('./bench-reader.mjs', import.meta.url), { type: 'module' }));
    await Promise.all(peers.map(peer => request(peer, { type: 'init', entries: config.entries })));
    const samples = { shared: [], native: [] }, raw = [], total = (config.warmups + config.samples) * 2;
    let completed = 0;
    for (let round = -config.warmups; round < config.samples; round++) {
      for (const path of orderFor(round + config.warmups)) {
        const begun = performance.now();
        const payload = path === 'shared' ? getWorkerData({ values: shared }, { copy: false }) : native;
        const answers = await Promise.all(peers.map(peer => request(peer, { type: path, payload })));
        const elapsed = performance.now() - begun;
        // Validate after timing. All reader results must agree with the input.
        verifyChecksums(answers, config.readers, config.entries);
        if (round >= 0) { samples[path].push(elapsed); raw.push({ round, path, elapsedMs: elapsed, readers: answers.map(({ checksum, readMs }) => ({ checksum, readMs })) }); }
        self.postMessage({ type: 'status', completed: ++completed, total, message: round < 0 ? 'Warming both paths. Checking every answer…' : `Measured pair ${round + 1} of ${config.samples}. Checksums match.` });
      }
    }
    self.postMessage({ type: 'result', result: {
      schema: 'zerocopy-browser-benchmark/v1', timestamp: new Date().toISOString(), sourceCommit: data.source,
      environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated: self.crossOriginIsolated, coordinatorWorkers: 1 },
      config, construction: { nativeMs: nativeBuildMs, sharedMs: sharedBuildMs },
      summary: { shared: summarize(samples.shared), native: summarize(samples.native) }, samples, raw,
      method: 'Wall time from descriptor creation through parallel reader replies. Workers, module loading and dataset construction excluded. Each publication reattaches shared views. Both paths perform a get for every deterministic string key. Native data is structured-cloned. Order alternates; all checksums checked. No memory measurement.'
    } });
  } catch (error) { self.postMessage({ type: 'error', message: error.message ?? String(error) }); }
  finally { dispose(); running = false; self.close(); }
};
