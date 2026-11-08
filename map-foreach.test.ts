import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, HEAP_START, arenaOf } from './arena';
import { structureRegistry } from './codec';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';
import { fixtures, journal, reference } from './proofs/trie-view-fixtures';

function collect<T extends string>(map: SharedMap<T>): [string, unknown][] {
  const result: [string, unknown][] = [];
  const returned = map.forEach((value, key) => result.push([key, value]));
  assert.equal(returned, undefined);
  return result;
}

describe('SharedMap direct forEach', () => {
  it('preserves exact traversal order for dense nodes, overlays, collisions and nested journals', () => {
    for (const fixture of fixtures().filter(item => item.method === 'leaves')) {
      const { a, root, name } = fixture;
      const map = new SharedMap('number', root, undefined, a);
      const expected = reference(a, root, 'leaves').map(leaf => [a.leafKey(leaf), a.leafValue('number', leaf)]);
      const bytes = a.buf.slice(HEAP_START, a.used), used = a.used;
      assert.deepEqual(collect(map), expected, name);
      assert.deepEqual(collect(map), [...map.entries()], name);
      assert.equal(a.used, used);
      assert.deepEqual(a.buf.subarray(HEAP_START, used), bytes);
    }
  });

  it('keeps arbitrary short/long UTF-8 keys, special numbers and primitive values', () => {
    const keys = ['', '\0', '\ufeff', '🙂', 'é', '界', 'costarring', 'liquid', 'x'.repeat(66000)];
    const numbers = [0, -0, NaN, Infinity, -Infinity, Math.PI, Number.MIN_VALUE, Number.MAX_VALUE, -13.5];
    for (const type of ['number', 'boolean', 'string'] as const) {
      const values = type === 'number' ? numbers : type === 'boolean' ? keys.map((_, i) => i % 3 === 0)
        : keys.map((key, i) => i % 2 ? `${key}🙂\ufeff` : '');
      const map = new SharedMap(type, 0, 0, new Arena()).setMany(keys.map((key, i) => [key, values[i] as never] as const));
      const expected = [...map.entries()];
      assert.deepEqual(collect(map), expected);
      const actual = new Map(collect(map));
      for (let i = 0; i < keys.length; i++) assert.ok(Object.is(actual.get(keys[i]), values[i]));
    }
  });

  it('keeps traversal local when callbacks reenter, grow, edit and fork the same arena', () => {
    const a = new Arena();
    const base = new SharedMap('number', 0, 0, a).setMany(Array.from({ length: 1025 }, (_, i) => [`key/${i}`, i] as const));
    const fork = base.set('key/8', -8).delete('key/19');
    const expected = [...base.entries()], forkExpected = [...fork.entries()];
    const bytes = a.buf.slice(HEAP_START, a.used), original = a.memory.buffer;
    const seen: [string, number][] = []; let updated: SharedMap<'number'> | undefined;
    base.forEach((value, key) => {
      if (seen.length === 7) {
        assert.deepEqual(collect(base), expected);
        assert.deepEqual(collect(fork), forkExpected);
        updated = fork.set('added-in-callback', 800);
        a.alloc(original.byteLength * 2);
        assert.notEqual(a.memory.buffer, original);
        assert.deepEqual(collect(updated), [...updated.entries()]);
      }
      seen.push([key, value]);
    });
    assert.deepEqual(seen, expected);
    assert.deepEqual(collect(fork), forkExpected);
    assert.equal(updated!.get('added-in-callback'), 800);
    assert.equal(base.has('added-in-callback'), false);
    assert.deepEqual(a.buf.subarray(HEAP_START, HEAP_START + bytes.length), bytes);
  });

  it('starts with the current view when the root was allocated after shared memory growth', () => {
    const a = new Arena(), old = a.dv;
    a.alloc(old.byteLength * 2);
    const map = new SharedMap('number', 0, 0, a).setMany([['one', 1], ['two', 2], ['three', 3]]);
    assert.ok(map.root >= old.byteLength);
    assert.deepEqual(collect(map), [...map.entries()]);
  });

  it('does not access the view or invoke a callback for an empty default map', () => {
    const a = new Arena(), map = new SharedMap('number', 0, 0, a);
    Object.defineProperty(a, 'dv', { get() { throw new Error('unexpected empty read'); } });
    assert.equal(map.forEach(() => assert.fail('unexpected callback')), undefined);
    assert.equal(map.forEach(null as never), undefined);
  });

  it('calls callbacks with the same arguments and undefined receiver, and stops on the original exception', () => {
    const map = new SharedMap('number', 0, 0, new Arena()).setMany([['one', 1], ['two', 2], ['three', 3]]);
    const expected = [...map.entries()], seen: [string, number][] = [], failure = new Error('callback stopped');
    assert.throws(() => map.forEach(function (value, key) {
      assert.equal(this, undefined);
      assert.equal(arguments.length, 2);
      seen.push([key, value]);
      if (seen.length === 2) throw failure;
    }), error => error === failure);
    assert.deepEqual(seen, expected.slice(0, 2));
    assert.deepEqual(collect(map), expected);
    assert.throws(() => map.forEach(null as never), TypeError);
  });

  it('retains custom arena traversals and closes their iterators when a callback throws', () => {
    const a = new Arena(), map = new SharedMap('number', 0, 0, a).setMany([['one', 1], ['two', 2]]);
    const leaves = [...a.leaves(map.root)].reverse(), expected = leaves.map(leaf => [a.leafKey(leaf), a.leafValue('number', leaf)]);
    let closed = 0;
    a.leaves = function* (root) {
      assert.equal(this, a); assert.equal(root, map.root);
      try { yield* leaves; } finally { closed++; }
    };
    assert.deepEqual(collect(map), expected);
    const failure = new Error('stop custom traversal');
    assert.throws(() => map.forEach(() => { throw failure; }), error => error === failure);
    assert.equal(closed, 2);
  });

  it('retains custom value-decoder arguments, receiver and callback-time replacement', () => {
    const a = new Arena(), map = new SharedMap('number', 0, 0, a).setMany(Array.from({ length: 8 }, (_, i) => [`k${i}`, i] as const));
    const expected = [...map.entries()], original = a.leafValue;
    const seen: [string, number][] = [];
    let customCalls = 0;
    function custom(type: string, leaf: number) {
      assert.equal(this, a);
      assert.equal(arguments.length, 2);
      customCalls++;
      return original.call(this, type, leaf);
    }
    map.forEach((value, key) => {
      seen.push([key, value]);
      if (seen.length === 1) a.leafValue = custom;
      if (seen.length === 4) a.leafValue = original;
    });
    assert.deepEqual(seen, expected);
    assert.equal(customCalls, 3);
    a.leafValue = custom;
    assert.deepEqual(collect(map), expected);
    assert.equal(customCalls, 11);
  });

  it('retains legacy journal duplicate filtering when a callback grows the owner', () => {
    const a = new Arena();
    const base = new SharedMap('number', 0, 0, a).setMany([['costarring', 1], ['liquid', 2], ['a', 3], ['b', 4]]);
    const one = journal(a, base.root, [['a', 10], ['new', 5]], 'leaves');
    const root = journal(a, one, [['liquid', 20], ['new', 25]], 'leaves');
    const map = new SharedMap('number', root, undefined, a), expected = [...map.entries()];
    const seen: [string, number][] = [];
    map.forEach((value, key) => { if (seen.length === 1) a.alloc(a.memory.buffer.byteLength); seen.push([key, value]); });
    assert.deepEqual(seen, expected);
  });

  for (const copy of [false, true]) it(`preserves read-only attachments across owner edits and growth (copy=${copy})`, async () => {
    const a = new Arena(), map = new SharedMap('number', 0, 0, a).setMany(Array.from({ length: 257 }, (_, i) => [`k${i}`, i] as const));
    const expected = [...map.entries()], reader = (await initWorker(getWorkerData({ map }, { copy }))).map;
    const seen: [string, number][] = [];
    reader.forEach((value, key) => {
      if (seen.length === 5) { map.set('k0', -100).delete('k1'); a.alloc(a.memory.buffer.byteLength * 2); }
      seen.push([key, value]);
    });
    assert.deepEqual(seen, expected);
    assert.deepEqual(collect(reader), expected);
    assert.throws(() => reader.set('x', 99), /read-only/);
  });

  it('preserves frozen JSON and nested snapshot values', () => {
    const object = { id: 2, data: [1, { inner: '界' }] };
    const objects = new SharedMap('object', 0, 0, new Arena()).setMany([['object', object], ['null', null]]);
    assert.deepEqual(collect(objects), [...objects.entries()]);
    const found = new Map(collect(objects)).get('object') as typeof object;
    assert.equal(Object.isFrozen(found), true);
    assert.equal(Object.isFrozen(found.data), true);
    assert.equal(Object.isFrozen(found.data[1]), true);
    const inner = new SharedList('number', 0, 0, 0, new Arena()).pushMany([1, 2, 3]);
    const outer = new SharedMap('SharedList<number>', 0, 0, new Arena()).set('child', inner);
    outer.forEach((value, key) => { assert.equal(key, 'child'); assert.deepEqual(value.toArray(), [1, 2, 3]); });
  });

  it('decodes the value before its key while nested reconstruction reenters and grows', () => {
    const a = new Arena(), inner = new SharedMap('number', 0, 0, new Arena());
    const map = new SharedMap('SharedMap<number>', 0, 0, a).setMany(Array.from({ length: 70 }, (_, i) => [`child-${i}`, inner.set('id', i)] as const));
    const expected = [...map.keys()], bytes = a.buf.slice(HEAP_START, a.used), originalBuffer = a.memory.buffer;
    const factory = structureRegistry.SharedMap, original = factory.fromWorkerData;
    const leafKey = a.leafKey.bind(a), events: string[] = [];
    let calls = 0;
    factory.fromWorkerData = (data, owner) => {
      events.push('value');
      if (calls++ === 0) {
        a.alloc(originalBuffer.byteLength * 2);
        assert.notEqual(a.memory.buffer, originalBuffer);
        assert.deepEqual(collect(inner), []);
      }
      return original(data, owner);
    };
    a.leafKey = leaf => { events.push('key'); return leafKey(leaf); };
    try {
      const seen: string[] = [];
      map.forEach((value, key) => { assert.equal(value.get('id'), Number(key.slice(6))); seen.push(key); });
      assert.deepEqual(seen, expected);
      assert.equal(calls, 70);
      assert.deepEqual(events, Array.from({ length: 70 }, () => ['value', 'key']).flat());
      assert.deepEqual(a.buf.subarray(HEAP_START, HEAP_START + bytes.length), bytes);
      assert.equal(arenaOf(map), a);
    } finally { factory.fromWorkerData = original; }
  });
});
