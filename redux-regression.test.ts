import { describe, expect, it } from 'vitest';
import jsan from 'jsan';
import { SharedMap, SharedList, SharedPriorityQueue, getWorkerData, initWorker } from './shared';
import { arenaOf } from './arena';
import { createZerocopyCodec, createZerocopyDevToolsOptions } from './redux';
const codec = createZerocopyCodec();

describe('Redux persistence boundary regressions', () => {
  it('supports small limits without counting schema tuples as collection items', () => {
    const small = createZerocopyCodec({ maxCollectionSize: 1 });
    for (const source of [{ a: 1 }, [1], new SharedList('number').push(1), new SharedMap('number').set('a', 1)]) {
      const restored: any = small.parse(small.stringify(source));
      if (source instanceof SharedMap) expect(restored.get('a')).toBe(1);
      else if (source instanceof SharedList) expect(restored.get(0)).toBe(1);
      else expect(restored).toEqual(source);
    }
  });
  it('counts holes and plain record fields on both sides of the codec', () => {
    const small = createZerocopyCodec({ maxNodes: 2 });
    expect(() => small.stringify(new Array(2))).toThrow(); expect(() => small.decode(codec.encode(new Array(2)))).toThrow();
    const fields = createZerocopyCodec({ maxCollectionSize: 1 });
    expect(() => fields.stringify({ a: 1, b: 2 })).toThrow(); expect(() => fields.decode(codec.encode({ a: 1, b: 2 }))).toThrow();
  });
  it('rejects hand-written object payloads that JSON storage would change', () => {
    const envelope = (value: unknown) => ({ $zerocopyRedux: 1, value: ['c', 'SharedList', 'object', null, [value]] });
    for (const value of [['u'], ['n', 'NaN'], ['o', [['x', ['u']]]], ['a', [['h']]]]) expect(() => codec.decode(envelope(value))).toThrow(/JSON/);
  });
  it.each([false, true])('preserves exact tied-priority dequeue behavior, maxHeap=%s', maxHeap => {
    let source = new SharedPriorityQueue('number', { maxHeap });
    for (let i = 0; i < 150; i++) source = source.enqueue(i, i % 4);
    for (let i = 0; i < 17; i++) source = source.dequeue();
    let restored = codec.parse(codec.stringify(source)) as typeof source;
    while (!source.isEmpty) {
      expect(restored.peek()).toBe(source.peek()); expect(restored.peekPriority()).toBe(source.peekPriority());
      restored = restored.dequeue(); source = source.dequeue();
    }
    expect(restored.isEmpty).toBe(true);
  });
  it('rejects malformed heap graphs and wrong heap ordering', () => {
    const envelope = (rows: unknown[]) => ({ $zerocopyRedux: 1, value: ['c', 'SharedPriorityQueue', 'number', false, rows] });
    for (const rows of [
      [[1, 1, 0, -1]], [[1, 1, 2, -1]],
      [[1, 1, -1, -1], [2, 2, -1, -1]],
      [[1, 1, 1, 1], [2, 2, -1, -1]],
      [[1, 2, 1, -1], [2, 1, -1, -1]],
      [[1, 1, -1, 1], [2, 2, -1, -1]],
    ]) expect(() => codec.decode(envelope(rows))).toThrow(/heap/);
  });
  it('iterates priority queues without allocating WASM nodes, including attached views', async () => {
    const heap = new SharedPriorityQueue('object').enqueue({ n: 1 }, 1).enqueue({ n: 2 }, 2), before = arenaOf(heap).used;
    const { heap: attached } = await initWorker<{ heap: typeof heap }>(getWorkerData({ heap }, { copy: true }));
    expect([...attached.entries()]).toEqual([...heap.entries()]); expect(arenaOf(heap).used).toBe(before);
    expect([...attached.entries()].every(([v]) => Object.isFrozen(v))).toBe(true);
  });
  it('round-trips real DevTools JSAN, including our reserved marker', () => {
    const options = createZerocopyDevToolsOptions({ mode: 'portable' }).serialize!;
    const state = { map: new SharedMap('object').set('a', { value: 1, $jsan: 'stored JSON' }), collision: { $zerocopyRedux: 1, value: ['c', 'user-data'] }, optional: undefined, special: NaN };
    const text = jsan.stringify(state, options.replacer, null, options.options), restored = jsan.parse(text, options.reviver);
    expect(restored.map.get('a')).toEqual({ value: 1, $jsan: 'stored JSON' }); expect(restored.collision).toEqual(state.collision);
    expect(restored.map.set('b', {}).size).toBe(2); expect(Object.hasOwn(restored, 'optional')).toBe(true); expect(restored.special).toBeNaN();
  });
  it('rejects raw JSAN marker collisions explicitly, while the application codec preserves them', () => {
    const options = createZerocopyDevToolsOptions({ mode: 'portable' }).serialize!;
    for (const value of [{ $jsan: 'user value' }, { $zerocopyRedux: 1, nested: { $jsan: 'u' } }]) {
      expect(() => jsan.stringify({ value }, options.replacer, null, options.options)).toThrow(/reserved by DevTools/);
      expect(codec.parse(codec.stringify(value))).toEqual(value);
    }
  });
});
