import { describe, expect, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedList, SharedMap, compact, getWorkerData, initWorker, list } from './shared';

function unchanged(arena: Arena, published: Uint8Array): void {
  const bytes = arena.buf;
  for (let i = 0; i < published.length; i++) {
    if (bytes[HEAP_START + i] !== published[i]) throw new Error(`Published byte changed at ${HEAP_START + i}`);
  }
}

describe('SharedList.setMany', () => {
  it('returns the original snapshot for empty batches and invalid indexes', () => {
    const arena = new Arena(), source = new SharedList('number', 0, 0, 0, arena).pushMany([1, 2, 3]);
    const used = arena.used;
    expect(source.setMany([])).toBe(source);
    const indexes = [-1, 1.5, NaN, Infinity, -Infinity, 3, 2 ** 32, '1', null, undefined, Symbol('index')];
    const entries = indexes.map(index => [index, 'not a number'] as never);
    expect(source.setMany(entries)).toBe(source);
    expect(new SharedList('number', 0, 0, 0, arena).setMany([[0, 99]])).toHaveProperty('size', 0);
    expect(arena.used).toBe(used);
  });

  it('uses the final value for duplicate indexes, including signed zero', () => {
    const source = new SharedList('number', 0, 0, 0, new Arena()).pushMany([1, 2, 3]);
    const entries = [[0, 'discarded'], [-0, 10], [1, 20], [1, 21], [5, 'ignored']] as never;
    const result = source.setMany(entries);
    expect(result.toArray()).toEqual([10, 21, 3]);
    expect(source.toArray()).toEqual([1, 2, 3]);
    expect(() => source.setMany([[1, 20], [1, 'invalid']] as never)).toThrow('Expected a number');
  });

  it('encodes surviving values in first-occurrence order before sorting indexes', () => {
    const source = new SharedList('object', 0, 0, 0, new Arena()).pushMany(Array.from({ length: 65 }, (_, id) => ({ id })));
    const calls: string[] = [];
    const value = (name: string, id: number) => ({ toJSON() { calls.push(name); return { id }; } });
    const never = { toJSON() { throw new Error('An overwritten or invalid value was serialized'); } };
    const result = source.setMany([[32, never], [0, value('zero', 10)], [31, value('thirty-one', 20)],
      [-1, never], [32, value('thirty-two-final', 30)], [100, never]]);
    expect(calls).toEqual(['thirty-two-final', 'zero', 'thirty-one']);
    expect(result.get(0)).toEqual({ id: 10 });
    expect(result.get(31)).toEqual({ id: 20 });
    expect(result.get(32)).toEqual({ id: 30 });
    expect(source.get(32)).toEqual({ id: 32 });
  });

  for (const size of [1, 17, 32, 33, 64, 65, 1024, 1056, 1057, 32768, 32800, 32801]) {
    it(`edits tree and tail boundaries while retaining forks at size ${size}`, () => {
      const arena = new Arena(), input = Array.from({ length: size }, (_, i) => i + 0.25);
      const source = new SharedList('number', 0, 0, 0, arena).pushMany(input);
      const published = arena.buf.slice(HEAP_START, arena.used);
      const indexes = [...new Set([0, 1, 31, 32, 63, 64, 1023, 1024, 32767, 32768, size - 33, size - 1])]
        .filter(index => index >= 0 && index < size).reverse();
      const entries = indexes.map(index => [index, -index - 0.5] as const);
      const expected = [...input];
      for (const [index, value] of entries) expected[index] = value;
      const edited = source.setMany(entries), fork = source.setMany([[0, 99], [size - 1, 100]]);
      expect(edited.size).toBe(size); expect(edited.depth).toBe(source.depth);
      expect(edited.toArray()).toEqual(expected);
      expect(source.toArray()).toEqual(input);
      expect(fork.get(0)).toBe(size === 1 ? 100 : 99);
      expect(fork.get(size - 1)).toBe(100);
      const removed = edited.pop(), restored = removed.push(77);
      expect(removed.toArray()).toEqual(expected.slice(0, -1));
      expect(restored.toArray()).toEqual([...expected.slice(0, -1), 77]);
      unchanged(arena, published);
    });
  }

  it('copies a short tail at its exact length and each touched tree node once', () => {
    for (const size of [1, 17, 32]) {
      const arena = new Arena(), source = new SharedList('number', 0, 0, 0, arena).pushMany(Array(size).fill(1));
      const used = arena.used;
      const result = source.setMany([[0, 5], [size - 1, 9]]);
      expect(result.size).toBe(size);
      expect(arena.used - used).toBe(size * 8);
    }
    const arena = new Arena(), source = new SharedList('number', 0, 0, 0, arena).pushMany(Array(32801).fill(1));
    const used = arena.used;
    const result = source.setMany([[31, 2], [0, 3], [30, 4], [32800, 5]]);
    expect(result.get(0)).toBe(3); expect(result.get(32800)).toBe(5);
    // One path through three branch levels, one 32-value leaf and a one-value tail.
    expect(arena.used - used).toBe(3 * 128 + 256 + 8);
  });

  it('handles both sides of the writer-scratch limit', () => {
    for (const count of [4096, 4097]) {
      const arena = new Arena(), input = Array.from({ length: 8193 }, (_, i) => i);
      const source = new SharedList('number', 0, 0, 0, arena).pushMany(input);
      const entries = Array.from({ length: count }, (_, i) => [count - 1 - i, -count + i] as const);
      const result = source.setMany(entries), expected = [...input];
      for (const [index, value] of entries) expected[index] = value;
      expect(result.toArray()).toEqual(expected);
      expect(source.toArray()).toEqual(input);
    }
  });

  it('keeps number specials, booleans, Unicode and frozen JSON exact', () => {
    const special = [NaN, -0, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE];
    const numbers = new SharedList('number', 0, 0, 0, new Arena()).pushMany(Array(1057).fill(1));
    const indexes = [0, 31, 32, 1023, 1024, 1056];
    const edited = numbers.setMany(indexes.map((index, i) => [index, special[i]] as const));
    for (let i = 0; i < indexes.length; i++) expect(Object.is(edited.get(indexes[i]), special[i])).toBe(true);
    const bools = new SharedList('boolean', 0, 0, 0, new Arena()).pushMany(Array(65).fill(false));
    expect(bools.setMany([[0, true], [32, true], [64, true]]).toArray()).toEqual(Array.from({ length: 65 }, (_, i) => i % 32 === 0));
    const strings = new SharedList('string', 0, 0, 0, new Arena()).pushMany(Array(65).fill('old'));
    const text = strings.setMany([[0, '\u0000é'], [32, '界🙂'], [64, '\ufefftail']]);
    expect([text.get(0), text.get(32), text.get(64)]).toEqual(['\u0000é', '界🙂', '\ufefftail']);
    const objects = new SharedList('object', 0, 0, 0, new Arena()).pushMany(Array(65).fill({ old: true }));
    const records = objects.setMany([[0, { point: [1, 2] }], [32, { point: [3, 4] }], [64, null]]);
    expect(records.get(32)).toEqual({ point: [3, 4] });
    expect(Object.isFrozen(records.get(32))).toBe(true);
    expect(Object.isFrozen((records.get(32) as { point: number[] }).point)).toBe(true);
    expect(records.get(64)).toBe(null);
    expect(() => bools.setMany([[0, 1]] as never)).toThrow('Expected a boolean');
    expect(() => strings.setMany([[0, false]] as never)).toThrow('Expected a string');
    expect(() => objects.setMany([[0, undefined]])).toThrow('Value is not JSON-serializable');
  });

  it('finishes reentrant serialization before staging records in shared writer scratch', () => {
    const arena = new Arena(), input = Array.from({ length: 1057 }, (_, id) => ({ id }));
    const source = new SharedList('object', 0, 0, 0, arena).pushMany(input);
    const map = new SharedMap('number', 0, undefined, arena).setMany(Array.from({ length: 64 }, (_, i) => [`k${i}`, i] as const));
    const published = arena.buf.slice(HEAP_START, arena.used), oldCapacity = arena.memory.buffer.byteLength;
    let fork: typeof source | undefined, mapFork: typeof map | undefined;
    const edited = source.setMany([[1024, { toJSON() {
      arena.memory.grow(1);
      fork = source.setMany([[0, { id: -10 }], [31, { id: -31 }], [64, { id: -64 }]]);
      mapFork = map.setMany(Array.from({ length: 64 }, (_, i) => [`k${i}`, -i - 1] as const));
      return { id: -1024 };
    } }], [0, { id: -1 }], [1056, { id: -1056 }]]);
    expect(arena.memory.buffer.byteLength).toBeGreaterThan(oldCapacity);
    expect(edited.get(0)).toEqual({ id: -1 }); expect(edited.get(1024)).toEqual({ id: -1024 });
    expect(edited.get(1056)).toEqual({ id: -1056 }); expect(edited.get(31)).toEqual({ id: 31 });
    expect(fork!.get(0)).toEqual({ id: -10 }); expect(fork!.get(31)).toEqual({ id: -31 });
    expect(mapFork!.get('k31')).toBe(-32); expect(map.get('k31')).toBe(31);
    expect(source.toArray()).toEqual(input);
    unchanged(arena, published);
  });

  it('preserves old snapshots when serialization throws after reentering the writer', () => {
    const arena = new Arena(), source = new SharedList('object', 0, 0, 0, arena).pushMany(Array(65).fill({ id: 1 }));
    const published = arena.buf.slice(HEAP_START, arena.used);
    let fork: typeof source | undefined;
    expect(() => source.setMany([[0, { id: 2 }], [32, { toJSON() {
      fork = source.setMany([[64, { id: 3 }]]);
      throw new Error('serialization failed');
    } }]])).toThrow('serialization failed');
    expect(source.toArray()).toEqual(Array(65).fill({ id: 1 }));
    expect(fork!.get(64)).toEqual({ id: 3 });
    unchanged(arena, published);
  });

  it('remains compatible with nested values, compaction and shared/copied attachments', async () => {
    const childArena = new Arena();
    const children = Array.from({ length: 65 }, (_, i) => new SharedList('number', 0, 0, 0, childArena).pushMany([i, -i]));
    const source = new SharedList(list('number'), 0, 0, 0, new Arena()).pushMany(children);
    const replacement = new SharedList('number', 0, 0, 0, new Arena()).pushMany([99, -0, NaN]);
    const edited = source.setMany([[0, replacement], [32, children[1]], [64, replacement]]), packed = compact(edited);
    for (const copy of [false, true]) {
      const attached = await initWorker(getWorkerData({ source, edited, packed }, { copy }));
      expect(attached.source.get(32)!.toArray()).toEqual([32, -32]);
      for (const restored of [attached.edited, attached.packed]) {
        expect(restored.get(0)!.toArray()).toEqual([99, -0, NaN]);
        expect(restored.get(32)!.toArray()).toEqual([1, -1]);
        expect(restored.get(64)!.toArray()).toEqual([99, -0, NaN]);
        expect(() => restored.setMany([[0, replacement]])).toThrow(/read-only/);
        expect(restored.setMany([])).toBe(restored);
        expect(restored.setMany([[-1, replacement]])).toBe(restored);
      }
    }
    expect(packed.setMany([[32, replacement]]).get(32)!.toArray()).toEqual([99, -0, NaN]);
  });

  it('does not serialize valid edits when the owner is read-only', async () => {
    const source = new SharedList('object', 0, 0, 0, new Arena()).pushMany([{ id: 1 }]);
    const { source: reader } = await initWorker(getWorkerData({ source }, { copy: false }));
    let calls = 0;
    expect(() => reader.setMany([[0, { toJSON() { calls++; return { id: 2 }; } }]])).toThrow(/read-only/);
    expect(calls).toBe(0);
  });

  it('preserves every published byte after real allocation failures and permits recovery', () => {
    let failures = 0, successes = 0, partialFailures = 0;
    for (const headroom of [0, 128, 256, 512, 1024, 1152, 1160, 2048]) {
      const capacity = 2 * 65536;
      const arena = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }) });
      const input = Array.from({ length: 1057 }, (_, i) => i);
      const source = new SharedList('number', 0, 0, 0, arena).pushMany(input);
      const published = arena.buf.slice(HEAP_START, arena.used);
      arena.alloc(capacity - arena.used - headroom);
      const mark = arena.used;
      try {
        const edited = source.setMany([[0, -1], [32, -2], [1024, -3], [1056, -4]]);
        expect([edited.get(0), edited.get(32), edited.get(1024), edited.get(1056)]).toEqual([-1, -2, -3, -4]);
        successes++;
      } catch (error) {
        expect(error).toBeInstanceOf(WebAssembly.RuntimeError);
        failures++; if (arena.used > mark) partialFailures++;
      }
      expect(source.toArray()).toEqual(input);
      unchanged(arena, published);
      if (capacity - arena.used >= 8) {
        const recovered = source.setMany([[1056, -99]]);
        expect(recovered.get(1056)).toBe(-99);
        expect(source.get(1056)).toBe(1056);
      }
    }
    expect(failures).toBeGreaterThan(0); expect(successes).toBeGreaterThan(0); expect(partialFailures).toBeGreaterThan(0);
  });
});
