import { equalValues } from './primitive-scan-checks.mjs';
export async function checkWorker(api, worker, module, node = false) {
  function request(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Worker scan check timed out')), 30000);
      const receive = value => finish(null, node ? value : value.data);
      const fail = error => finish(error instanceof Error ? error : new Error(String(error.message ?? error)));
      function finish(error, result) {
        clearTimeout(timer);
        if (node) { worker.off('message', receive); worker.off('error', fail); }
        else { worker.removeEventListener('message', receive); worker.removeEventListener('error', fail); }
        if (error) reject(error);
        else if (result?.type === 'error') reject(new Error(result.error));
        else resolve(result);
      }
      if (node) { worker.on('message', receive); worker.on('error', fail); }
      else { worker.addEventListener('message', receive); worker.addEventListener('error', fail); }
      try { worker.postMessage(message); } catch (error) { finish(error); }
    });
  }
  try {
    const expected = Array.from({ length: 1057 }, (_, i) => i + 0.5);
    const item = api.compact(new api.SharedList('number')).pushMany(expected);
    const data = api.getWorkerData({ item }, { copy: false });
    const paused = await request({ type: 'attach', data, module });
    if (paused.type !== 'paused') throw new Error('Worker did not pause');
    const before = data.arenas[0].memory.buffer.byteLength;
    item.pushMany(Array(100000).fill(1));
    if (data.arenas[0].memory.buffer.byteLength <= before) throw new Error('Writer did not grow');
    const result = await request({ type: 'resume' });
    if (result.type !== 'done' || !result.writeRejected) throw new Error('Worker snapshot invariant failed');
    for (const values of [result.values, result.array, result.visited]) equalValues(values, expected, 'worker');
    return 'passed: real worker resumed the original snapshot after writer growth';
  } finally { await worker.terminate(); }
}
