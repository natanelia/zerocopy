import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { structureRegistry } from './codec';
import { SharedMap, SharedList, getWorkerData, initWorker } from './shared';
import { journal } from './proofs/trie-view-fixtures';

function expected(map: SharedMap<any>): unknown[] {
  return [...map.entries()].map(([, value]) => value);
}

describe('map values with one captured view', () => {
  for (const type of ['number', 'boolean'] as const) {
    it(`keeps ${type} value order across leaf shapes, edits and forks`, () => {
      for (const size of [0, 1, 2, 31, 32, 33, 4097]) {
        const a = new Arena();
        const keys = Array.from({ length: size }, (_, i) => `${'x'.repeat(i % 9)}key-${i}${i % 11 ? '' : '🙂'}`);
        let base = new SharedMap(type, 0, 0, a).setMany(keys.map((key, i) => [key, (type === 'number' ? i + 0.5 : i % 3 === 0) as never] as const));
        base = base.set('costarring', (type === 'number' ? 23 : true) as never)
          .set('liquid', (type === 'number' ? -17 : false) as never);
        const edited = base.delete('costarring').set('new', (type === 'number' ? 91 : false) as never);
        const fork = base.set('liquid', (type === 'number' ? 72 : true) as never);
        const before = a.buf.slice(HEAP_START, a.used), used = a.used;
        for (const map of [base, edited, fork]) {
          assert.deepEqual([...map.values()], expected(map));
          assert.equal(Object.isFrozen(map), true);
        }
        assert.equal(a.used, used);
        assert.deepEqual(a.buf.subarray(HEAP_START, used), before);
      }
    });

    it(`keeps paused ${type} iterators independent while the writer grows`, () => {
      const a = new Arena();
      const base = new SharedMap(type, 0, 0, a).setMany(Array.from({ length: 511 }, (_, i) => [`key${i}`, (type === 'number' ? i : i % 2 === 0) as never] as const));
      const fork = base.set('key3', (type === 'number' ? -3 : true) as never).delete('key7');
      const maps = [base, fork], results = maps.map(expected), iterators = maps.map(map => map.values());
      a.memory.grow(1);
      const actual = iterators.map(iterator => [iterator.next().value]);
      const oldBuffer = a.memory.buffer, bytes = a.buf.slice(HEAP_START, a.used);
      new SharedMap('string', 0, 0, a).set('grow', 'x'.repeat(oldBuffer.byteLength * 2));
      assert.notEqual(a.memory.buffer, oldBuffer);
      const used = a.used;
      let active = true;
      while (active) {
        active = false;
        for (let i = 0; i < iterators.length; i++) {
          const next = iterators[i].next();
          if (!next.done) { actual[i].push(next.value); active = true; }
        }
      }
      assert.deepEqual(actual, results);
      assert.equal(a.used, used);
      assert.deepEqual(a.buf.subarray(HEAP_START, HEAP_START + bytes.length), bytes);
    });

    for (const copy of [false, true]) it(`keeps attached ${type} values immutable (copy=${copy})`, async () => {
      const a = new Arena();
      const map = new SharedMap(type, 0, 0, a).setMany(Array.from({ length: 100 }, (_, i) => [`k${i}`, (type === 'number' ? i : i % 3 === 0) as never] as const));
      const wanted = expected(map), reader = (await initWorker(getWorkerData({ map }, { copy }))).map;
      const iterator = reader.values(), first = iterator.next().value;
      a.memory.grow(2);
      map.set('k0', (type === 'number' ? -100 : false) as never);
      assert.deepEqual([first, ...iterator], wanted);
      assert.deepEqual([...reader.values()], wanted);
      assert.throws(() => reader.set('forbidden', 0 as never), /read-only/);
    });
  }

  it('preserves negative zero, infinities, NaN and unaligned numeric payloads', () => {
    const numbers = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MAX_VALUE, Math.PI];
    const map = new SharedMap('number', 0, 0, new Arena()).setMany(numbers.map((n, i) => ['a'.repeat(i), n] as const));
    const values = [...map.values()], wanted = expected(map);
    assert.equal(values.length, numbers.length);
    assert.ok(values.every((value, i) => Object.is(value, wanted[i])));
  });

  it('keeps default and captured-view leaf decoding equivalent with value prefixes', () => {
    const a = new Arena();
    const records = [
      ['number', '🙂', -0], ['boolean', 'é', false], ['string', '', '\ufeff界'], ['object', 'x', { nested: [1, 2] }],
    ] as const;
    const leaves = records.map(([type, key, value]) => a.leaf(type, key, value, 7));
    const view = a.dv;
    a.alloc(a.memory.buffer.byteLength * 2);
    for (let i = 0; i < leaves.length; i++) {
      assert.deepEqual(a.leafValue(records[i][0], leaves[i], 4, view), records[i][2]);
      assert.deepEqual(a.leafValue(records[i][0], leaves[i], 4), records[i][2]);
    }
  });

  it('handles legacy nested journals with a paused traversal', () => {
    const a = new Arena();
    const base = new SharedMap('number', 0, 0, a).setMany([['a', 1], ['b', 2], ['costarring', 3], ['liquid', 4]]);
    const one = journal(a, base.root, [['a', 10], ['new', 5]], 'leaves');
    const two = journal(a, one, [['b', 20], ['é', 6]], 'leaves');
    const map = new SharedMap('number', two, undefined, a), wanted = expected(map);
    const iterator = map.values(), first = iterator.next().value;
    a.memory.grow(1);
    assert.deepEqual([first, ...iterator], wanted);
  });

  it('keeps generator laziness, early return and throw behavior', () => {
    const a = new Arena(), map = new SharedMap('number', 0, 0, a).set('a', 1).set('b', 2);
    const iterator = map.values(), closed = map.values();
    Object.defineProperty(a, 'dv', { configurable: true, get() { throw new Error('eager read'); } });
    assert.deepEqual(closed.return(undefined), { done: true, value: undefined });
    const error = new Error('consumer stopped');
    assert.throws(() => map.values().throw(error), e => e === error);
    assert.deepEqual([...new SharedMap('number', 0, 0, a).values()], []);
    assert.deepEqual([...new SharedMap('boolean', 0, 0, a).values()], []);
    delete (a as any).dv;
    assert.equal(iterator.next().done, false);
    iterator.return(undefined);
    assert.deepEqual(iterator.next(), { done: true, value: undefined });
    const thrown = map.values(); thrown.next();
    assert.throws(() => thrown.throw(error), e => e === error);
    assert.deepEqual(thrown.next(), { done: true, value: undefined });
    assert.deepEqual([...map.values()], expected(map));
  });

  it('retains the string, frozen JSON and nested snapshot decoding paths', async () => {
    const strings = new SharedMap('string', 0, 0, new Arena()).setMany([['a', ''], ['b', '\ufeff🙂'], ['c', '界']]);
    const objects = new SharedMap('object', 0, 0, new Arena()).setMany([['a', { n: [1, 2], ok: true }], ['b', null]]);
    const child = new SharedList('number', 0, 0, 0, new Arena()).pushMany([1, 2, 3]);
    const nested = new SharedMap('SharedList<number>', 0, 0, new Arena()).set('child', child);
    const attached = await initWorker(getWorkerData({ strings, objects, nested }, { copy: false }));
    assert.deepEqual([...attached.strings.values()], expected(strings));
    assert.deepEqual([...attached.objects.values()], expected(objects));
    const object = attached.objects.get('a') as { n: readonly number[] };
    assert.equal(Object.isFrozen(object), true); assert.equal(Object.isFrozen(object.n), true);
    const values = [...attached.nested.values()];
    assert.deepEqual(values[0].toArray(), [1, 2, 3]);
    assert.throws(() => values[0].push(4), /read-only/);
  });

  it('keeps generic value iteration stable when nested reconstruction grows and forks the owning arena', () => {
    const a = new Arena(), inner = new SharedMap('number', 0, 0, new Arena());
    const entries = Array.from({ length: 70 }, (_, i) => [`child-${i}`, inner.set('id', i)] as const);
    const map = new SharedMap('SharedMap<number>', 0, 0, a).setMany(entries);
    const wanted = [...map.keys()].map(key => Number(key.slice(6)));
    const before = a.buf.slice(HEAP_START, a.used), originalBuffer = a.memory.buffer;
    const factory = structureRegistry.SharedMap, original = factory.fromWorkerData;
    let calls = 0, fork: typeof map | undefined;
    factory.fromWorkerData = (data, owner) => {
      if (calls++ === 0) {
        a.alloc(originalBuffer.byteLength * 2);
        fork = map.set('fork', inner.set('id', -1));
        assert.notEqual(a.memory.buffer, originalBuffer);
      }
      return original(data, owner);
    };
    try {
      assert.deepEqual([...map.values()].map(child => child.get('id')), wanted);
      assert.equal(calls, entries.length);
      assert.equal(fork!.get('fork')!.get('id'), -1);
      assert.equal(map.has('fork'), false);
      assert.deepEqual([...map.values()].map(child => child.get('id')), wanted);
      assert.deepEqual(a.buf.subarray(HEAP_START, HEAP_START + before.length), before);
    } finally { factory.fromWorkerData = original; }
  });
});
