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
    const coords = Float64Array.from({ length: 1026 }, (_, i) => i / 7);
    const list = new SharedList('number').pushMany(coords);
    const nested = new SharedMap('SharedList<number>').set('list', list);
    const first = await send(getWorkerData({ map, list, nested }));
    expect(first.map).toEqual(input); expect(first.list).toEqual(Array.from(coords)); expect(first.nested).toEqual(first.list);
    expect(first.packed).toEqual(coords);
    first.packed[0] = 100;
    const edited = list.setMany([[0, -0], [31, 9], [1025, -3.25]]);
    expect(first.frozen && first.blocked && first.shared).toBe(true);
    resetMap();
    const second = await send(getWorkerData({ map: map.set('value', { text: 'new' }), list: edited, nested }));
    expect(second.map).toEqual({ text: 'new' }); expect(second.original).toEqual(input);
    const expected = coords.slice();
    expected[0] = -0; expected[31] = 9; expected[1025] = -3.25;
    expect(second.packed).toEqual(expected);
    expect(Object.is(second.packed[0], -0)).toBe(true);
    expect(second.nested).toEqual(Array.from(coords));
    expect(list.get(0)).toBe(0);
    expect(map.get('value')).toEqual(input);
  } finally { worker.terminate(); }
}, 20000);
