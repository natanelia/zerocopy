import { expect, test } from 'vitest';
import { SharedMap, getWorkerData, resetMap } from '../dist/shared.js';

test('JSON array cursors remain private and valid in a worker after owner growth', async ({ signal }) => {
  resetMap();
  const map = new SharedMap('object').set('record', {
    items: Array.from({ length: 1024 }, (_, index) => index), after: [9999],
  });
  const worker = new Worker(new URL('./json-array-cursor-worker.ts', import.meta.url), { type: 'module' });
  const ask = (phase: string, payload: any) => new Promise<any>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const onAbort = () => fail(signal.reason ?? new Error('Worker request aborted'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = event => fail(new Error(event.message));
    try { worker.postMessage({ phase, payload }); } catch (error) { fail(error); }
  });
  try {
    const payload = getWorkerData({ map }, { copy: false });
    const capacity = payload.arenas[0].memory.buffer.byteLength;
    expect(await ask('prime', payload)).toEqual({ sum: 127 * 128 / 2, sharedBytesUnchanged: true });
    const next = map.set('padding', { text: 'x'.repeat(capacity + 65536) }).set('record', { items: [-1] });
    const updated = getWorkerData({ map: next }, { copy: false });
    expect(updated.arenas[0].memory.buffer.byteLength).toBeGreaterThan(capacity);
    expect(await ask('finish', updated)).toEqual({ sum: 1023 * 1024 / 2 - 127 * 128 / 2, sharedBytesUnchanged: true });
  } finally { worker.terminate(); }
}, 20000);
