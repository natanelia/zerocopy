import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedMap, SharedSortedMap } from './shared';
import { structureRegistry } from './codec';

describe('radix empty delegation proposal', () => {
  it('preserves return values and throws before starting and while suspended', () => {
    const arena = new Arena();
    let map = new SharedSortedMap('number', undefined, 0, 0, arena);
    for (let i = 0; i < 33; i++) map = map.set(`key${i}`, i);
    const returned = { token: 'return' }, thrown = { token: 'throw' };
    for (const root of [0, map.root]) for (const started of [false, true]) {
      const iterator = arena.radixLeaves(root);
      if (started) iterator.next('ignored' as never);
      assert.deepEqual(iterator.return(returned), { value: returned, done: true });
      assert.deepEqual(iterator.next(), { value: undefined, done: true });
      const errorIterator = arena.radixLeaves(root);
      if (started) errorIterator.next();
      assert.throws(() => errorIterator.throw(thrown), e => e === thrown);
      assert.deepEqual(errorIterator.next(), { value: undefined, done: true });
    }
  });

  it('allows custom nested reconstruction to grow the arena and reenter traversal', () => {
    const arena = new Arena();
    let child = new SharedMap('number', 0, 0, arena).set('child', 7);
    let map = new SharedSortedMap('SharedMap<number>', undefined, 0, 0, arena);
    for (let i = 0; i < 40; i++) map = map.set(`key${i}`, child);
    const expectedKeys = [...map.keys()];
    // Reading keys decodes nested values, so clear only this diagnostic cache.
    (arena as any).objects.clear();
    const before = arena.buf.slice(HEAP_START, arena.used), used = arena.used;
    const factory = structureRegistry.SharedMap, original = factory.fromWorkerData;
    let calls = 0;
    factory.fromWorkerData = (data, source) => {
      calls++;
      const oldBuffer = arena.memory.buffer;
      arena.memory.grow(1);
      assert.notEqual(arena.memory.buffer, oldBuffer);
      const nested = arena.radixLeaves(map.root);
      assert.equal(nested.next().done, false);
      nested.return(undefined);
      return original(data, source);
    };
    try {
      const actual = [...map.entries()];
      assert.deepEqual(actual.map(([key]) => key), expectedKeys);
      assert.ok(actual.every(([, value]) => value.get('child') === 7));
      assert.equal(calls, 40);
      assert.equal(arena.used, used);
      assert.deepEqual(arena.buf.subarray(HEAP_START, used), before);
      assert.equal(arenaOf(map), arena);
    } finally { factory.fromWorkerData = original; }
  });
});
