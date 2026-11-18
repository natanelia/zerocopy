import { expect, test } from 'vitest';
import { SharedMap, getWorkerData, resetMap } from '../dist/shared.js';

test('JSON array cursors remain private and valid in a worker after owner growth', async () => {
  resetMap();
  const map = new SharedMap('object').set('record', {
    items: Array.from({ length: 1024 }, (_, index) => index), after: [9999],
  });
  const worker = new Worker(new URL('./json-array-cursor-worker.ts', import.meta.url), { type: 'module' });
  const ask = (phase: string, payload: any) => new Promise<any>((resolve, reject) => {
    worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
    worker.onerror = event => reject(new Error(event.message));
    worker.postMessage({ phase, payload });
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
