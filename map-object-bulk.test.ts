import { expect, test } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedMap, SharedList, getWorkerData, initWorker } from './shared';
import collisions from './proofs/bulk-input-collisions.json';

const fresh = (a = new Arena()) => new SharedMap('object', 0, 0, a);
const entries = (count: number) => Array.from({ length: count }, (_, i) =>
  [`key-${i}`, { i, text: i % 3 ? `value ${i}` : `商品 · 🙂 ${i}`, nested: { values: [i, null, true] } }] as const);

test('packed JSON preserves arbitrary JSON, normalized duplicates, Unicode and historical values', async () => {
  const a = new Arena(), initial = entries(300), old = fresh(a).setMany(initial);
  const before = a.copy().subarray(HEAP_START), end = a.used;
  const tricky = JSON.parse('{"__proto__":{"safe":true},"constructor":1,"text":"\\ud800"}');
  let discarded = 0;
  const changes: any[] = [...entries(300),
    ['\ud800', { toJSON() { discarded++; throw new Error('overwritten value'); } }], ['\ufffd', tricky],
    ['\0\ufeff界🙂', { text: '界🙂\0\ufeff'.repeat(12000) }],
    ['long-' + '🙂'.repeat(20000), [null, -0, 1e100, { value: 'large key' }]],
    ['primitive-null', null], ['primitive-number', 42], ['primitive-boolean', false],
  ];
  const next = old.setMany(changes);
  expect(discarded).toBe(0);
  for (const copy of [false, true]) {
    const reader = await initWorker(getWorkerData({ old, next }, { copy }));
    for (const [key, value] of initial) expect(reader.old.get(key)).toEqual(value);
    for (const [key, value] of changes.slice(301)) {
      const actual = reader.next.get(key);
      expect(actual).toEqual(JSON.parse(JSON.stringify(value)));
      if (actual && typeof actual === 'object') expect(Object.isFrozen(actual)).toBe(true);
    }
    expect(Object.getPrototypeOf(reader.next.get('\ufffd'))).toBe(Object.prototype);
    expect(Object.hasOwn(reader.next.get('\ufffd')!, '__proto__')).toBe(true);
  }
  expect(a.buf.slice(HEAP_START, end)).toEqual(before);
  expect(old.get('primitive-null')).toBeUndefined();
});

test.each([63, 64, 65])('object batch boundary %i preserves inherited toJSON and duplicate-key order', count => {
  const events: string[] = [];
  const prototype = { toJSON(key: string) { events.push(`${(this as any).index}:${key}`); return { index: (this as any).index }; } };
  const input: any[] = Array.from({ length: count }, (_, index) => [`key-${index}`, Object.assign(Object.create(prototype), { index })]);
  input.push(['key-0', Object.assign(Object.create(prototype), { index: count })]);
  const map = fresh().setMany(input);
  expect(map.size).toBe(count);
  expect(events).toEqual([`${count}:`, ...Array.from({ length: count - 1 }, (_, i) => `${i + 1}:`)]);
  expect(map.get('key-0')).toEqual({ index: count });
});

test('100-object edits preserve old snapshots, retained values and shared/copy readers', async () => {
  const initial = entries(1000), old = fresh().setMany(initial), keep = old.get('key-999');
  const edits = Array.from({ length: 100 }, (_, i) => [`key-${i * 7}`, { i: -i - 1, changed: true, text: `edit ${i} · 界🙂` }] as const);
  const next = old.setMany(edits);
  expect(next.size).toBe(old.size);
  expect(next.get('key-999')).toBe(keep);
  for (const copy of [false, true]) {
    const reader = await initWorker(getWorkerData({ old, next }, { copy }));
    for (const [key, value] of initial) expect(reader.old.get(key)).toEqual(value);
    for (const [key, value] of edits) expect(reader.next.get(key)).toEqual(value);
    expect(reader.next.get('key-999')).toEqual(initial[999]![1]);
  }
});

test('packed JSON serializes once in surviving-key order while callbacks grow and reenter the arena', () => {
  const a = new Arena(), base = fresh(a).set('retained', { yes: true });
  const events: string[] = [], side: SharedMap<'object'>[] = [];
  const input = entries(300).map(([key], index) => [key, {
    toJSON(jsonKey: string) {
      events.push(`${index}:${jsonKey}`);
      if (index === 100) side.push(fresh(a).setMany(entries(300)));
      if (index === 200) side.push(base.set('large', { text: 'x'.repeat(300000) }));
      return { index, get value() { events.push(`get:${index}`); return index + 1; } };
    },
  }] as const);
  const next = base.setMany(input);
  expect(events).toEqual(Array.from({ length: 300 }, (_, i) => [`${i}:`, `get:${i}`]).flat());
  for (let i = 0; i < 300; i++) expect(next.get(`key-${i}`)).toEqual({ index: i, value: i + 1 });
  expect(side[0]!.get('key-299')).toEqual(entries(300)[299]![1]);
  expect((side[1]!.get('large') as any).text).toHaveLength(300000);
  expect(base.get('retained')).toEqual({ yes: true });
  expect(base.size).toBe(1);
});

test('failed packed JSON callbacks keep reentrant results and allow subsequent writes', () => {
  const a = new Arena(), base = fresh(a).set('retained', { yes: true });
  const failure = new Error('packed JSON failure'); let calls = 0, side: SharedMap<'object'>;
  const input: any[] = entries(300);
  input[299] = ['last', { toJSON() { calls++; side = fresh(a).setMany(entries(300)); throw failure; } }];
  expect(() => base.setMany(input)).toThrow(failure);
  expect(calls).toBe(1); expect(side!.size).toBe(300);
  expect(side!.get('key-299')).toEqual(entries(300)[299]![1]);
  expect(base.setMany(entries(300)).get('key-299')).toEqual(entries(300)[299]![1]);
  expect(base.get('retained')).toEqual({ yes: true });
});

test('packed nested descriptors retain their source arenas on shared and copied readers', async () => {
  const first = new SharedList('string').pushMany(['one', '界🙂']);
  const other = new SharedList('number', 0, 0, 0, new Arena()).pushMany([1, 2, 3]);
  const map = new SharedMap('SharedList<string>').setMany(Array.from({ length: 300 }, (_, i) => [`key-${i}`, first] as const));
  const numbers = new SharedMap('SharedList<number>').setMany(Array.from({ length: 300 }, (_, i) => [`key-${i}`, other] as const));
  for (const copy of [false, true]) {
    const reader = await initWorker(getWorkerData({ map, numbers }, { copy }));
    expect(reader.map.get('key-299')!.toArray()).toEqual(['one', '界🙂']);
    expect(reader.numbers.get('key-299')!.toArray()).toEqual([1, 2, 3]);
    let called = false;
    expect(() => (reader.map as any).setMany(Array.from({ length: 300 }, (_, i) => [`bad-${i}`, { toJSON() { called = true; } }]))).toThrow(/read-only/);
    expect(called).toBe(false);
  }
});

test('packed JSON retains full-hash collisions and unchanged leaves across updates', () => {
  const a = new Arena(), initial: any[] = [...entries(300), ...collisions.keys.map((key, i) => [key, { collision: i }])];
  const old = fresh(a).setMany(initial), keep = old.get('key-299');
  const next = old.setMany([...entries(299), ...collisions.keys.map((key, i) => [key, { replacement: i }] as const)]);
  expect(next.size).toBe(old.size); expect(next.get('key-299')).toBe(keep);
  for (const [i, key] of collisions.keys.entries()) {
    expect(old.get(key)).toEqual({ collision: i }); expect(next.get(key)).toEqual({ replacement: i });
  }
});

test('bounded packing flushes safely around oversized records and reentrant allocation hooks', async () => {
  const a = new Arena(), native = a.wasm, side: SharedMap<'object'>[] = [];
  let inHook = false, calls = 0;
  Object.defineProperty(a, 'wasm', { value: {
    ...native,
    mapLeaf(keyLength: number, valueLength: number) {
      if (!inHook && keyLength === 0) {
        inHook = true; calls++;
        side.push(fresh(a).set('side', { text: `allocation ${calls} ` + 'x'.repeat(300) }));
        inHook = false;
      }
      return native.mapLeaf(keyLength, valueLength);
    },
  } });
  const input: any[] = Array.from({ length: 5000 }, (_, i) => [`record-${i}`, { i, text: `${i} ` + 'y'.repeat(300) }]);
  input.splice(3500, 0, ['huge', { text: '界🙂'.repeat(220000) }]);
  const source = fresh(a).setMany(input);
  const { map } = await initWorker(getWorkerData({ map: source }, { copy: false }));
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(map.size).toBe(input.length);
  for (const [key, expected] of input) expect(map.get(key)).toEqual(expected);
  for (let i = 0; i < side.length; i++) expect((side[i]!.get('side') as any).text).toBe(`allocation ${i + 1} ` + 'x'.repeat(300));
});
