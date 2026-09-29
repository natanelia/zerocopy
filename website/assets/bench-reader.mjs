let keys, initWorker;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      keys = Array.from({ length: data.entries }, (_, i) => `lane-${i}`);
      ({ initWorker } = await import('../library/shared.js'));
      self.postMessage({ id: data.id, ready: true }); return;
    }
    if (!keys || !initWorker) throw new Error('Reader not initialized');
    const map = data.type === 'shared' ? (await initWorker(data.payload)).values : data.payload;
    if (!map || typeof map.get !== 'function') throw new Error('Invalid dataset');
    let checksum = 0;
    const start = performance.now();
    for (const key of keys) checksum += map.get(key);
    const readMs = performance.now() - start;
    self.postMessage({ id: data.id, checksum, readMs });
  } catch (error) { self.postMessage({ id: data.id, error: error.message ?? String(error) }); }
};
