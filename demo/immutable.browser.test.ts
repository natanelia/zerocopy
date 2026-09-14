import { expect, test } from 'vitest';
import { SharedMap, SharedList, getWorkerData, resetMap } from '../dist/shared.js';

test('real browser worker reads shared, immutable, nested snapshots across updates and reset', async () => {
  const worker = new Worker(new URL('./immutable-worker.ts', import.meta.url), { type: 'module' });
  const send = (data: any) => new Promise<any>((resolve, reject) => {
    worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    worker.onerror = event => reject(new Error(event.message)); worker.postMessage(data);
  });
  try {
    const input = { text: '🙂'.repeat(18000), values: [1, 2] };
    const map = new SharedMap('object').set('value', input);
    const list = new SharedList('number').pushMany([1, 2, 3]);
    const nested = new SharedMap('SharedList<number>').set('list', list);
    const first = await send(getWorkerData({ map, list, nested }));
    expect(first.map).toEqual(input); expect(first.list).toEqual([1, 2, 3]); expect(first.nested).toEqual([1, 2, 3]);
    expect(first.frozen && first.blocked && first.shared).toBe(true);
    resetMap();
    const second = await send(getWorkerData({ map: map.set('value', { text: 'new' }), list, nested }));
    expect(second.map).toEqual({ text: 'new' }); expect(second.original).toEqual(input);
    expect(map.get('value')).toEqual(input);
  } finally { worker.terminate(); }
}, 20000);
