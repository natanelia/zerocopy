import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, SharedMap, SharedSortedMap, getWorkerData, initWorker, resetSortedMap } from './shared';
import { journal, reference } from './proofs/trie-view-fixtures';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const normalized = (key: string) => decoder.decode(encoder.encode(key));
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const collected = (map: SharedSortedMap<any>) => {
  const values: [string, any][] = [];
  const result = map.forEach((value, key) => values.push([key, value]));
  assert.equal(result, undefined);
  return values;
};

describe('SharedSortedMap natural-order forEach', () => {
  it('does not visit or obtain a memory view for an empty map', () => {
    const a = new Arena(), map = new SharedSortedMap('number', undefined, 0, 0, a);
    Object.defineProperty(a, 'dv', { get() { throw new Error('empty view'); } });
    assert.equal(map.forEach(() => { throw new Error('empty callback'); }), undefined);
  });

  it('preserves UTF-8 key order and exact numeric values, including normalized duplicates', () => {
    const keys = ['', 'a', 'é', '🙂', '\0', '\ufeff', '\ud800', 'costarring', 'liquid', '\ufffd'];
    const values = [0, -0, NaN, Infinity, -Infinity, 3.5, -7, 2, 1, 99];
    let map = new SharedSortedMap('number', undefined, 0, 0, new Arena());
    const expected = new Map<string, number>();
    keys.forEach((key, i) => { map = map.set(key, values[i]); expected.set(normalized(key), values[i]); });
    assert.deepEqual(collected(map), [...expected].sort(([a], [b]) => compare(a, b)));
  });

  it('keeps old snapshots, updated branches and source bytes unchanged', () => {
    let base = new SharedSortedMap('number', undefined, 0, 0, new Arena());
    const expected = new Map<string, number>();
    for (let i = 0; i < 4096; i++) { const key = `key${(i * 17) % 4096}`; base = base.set(key, i); expected.set(key, i); }
    const fork = base.set('key17', -17).delete('key3').set('new', 5000);
    const forkExpected = new Map(expected); forkExpected.set('key17', -17); forkExpected.delete('key3'); forkExpected.set('new', 5000);
    const a = arenaOf(base), used = a.used, before = a.buf.slice(HEAP_START, used);
    assert.deepEqual(collected(base), [...expected].sort(([a], [b]) => compare(a, b)));
    assert.deepEqual(collected(fork), [...forkExpected].sort(([a], [b]) => compare(a, b)));
    assert.deepEqual(collected(base), [...expected].sort(([a], [b]) => compare(a, b)));
    assert.equal(a.used, used); assert.deepEqual(a.buf.subarray(HEAP_START, used), before);
  });

  for (const type of ['boolean', 'string', 'object', 'SharedMap<number>', 'SharedList<number>']) {
    it(`preserves ${type} values and immutable decoded objects`, () => {
      const keys = ['b', '', 'a', '🙂', 'é'];
      const values: any[] = keys.map((key, i) => type === 'boolean' ? !!(i % 2)
        : type === 'string' ? `${key}🙂${i}`
        : type === 'object' ? { key, i, child: [null, false, { value: '🙂' }] }
        : type.startsWith('SharedMap') ? new SharedMap('number').set('child', i)
        : new SharedList('number').push(i));
      const simplify = (value: any) => type.startsWith('SharedMap') ? [...value.entries()]
        : type.startsWith('SharedList') ? value.toArray() : value;
      let map = new SharedSortedMap(type, undefined, 0, 0, new Arena());
      keys.forEach((key, i) => { map = map.set(key, values[i]); });
      const expected = keys.map((key, i) => [key, simplify(values[i])]).sort(([a], [b]) => compare(a, b));
      const visited = collected(map);
      assert.deepEqual(visited.map(([key, value]) => [key, simplify(value)]), expected);
      if (type === 'object') for (const [, value] of visited) { assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.child[2])); }
    });
  }

  it('keeps custom comparator sorting, tie order and comparator reentry', () => {
    let reentered = false;
    const comparator = (a: string, b: string) => {
      if (!reentered) { reentered = true; assert.equal(map.get('bbb'), 1); }
      return b.length - a.length;
    };
    let map = new SharedSortedMap('number', comparator, 0, 0, new Arena());
    ['ccc', 'bbb', 'a', 'ddd', 'bb'].forEach((key, i) => { map = map.set(key, i); });
    assert.deepEqual(collected(map), [['bbb', 1], ['ccc', 0], ['ddd', 3], ['bb', 4], ['a', 2]]);
    assert.ok(reentered);
  });

  it('preserves callback this, closes traversal after a throw, and can be read again', () => {
    const map = new SharedSortedMap('number', undefined, 0, 0, new Arena()).set('b', 2).set('a', 1).set('c', 3);
    const a = arenaOf(map), original = a.radixLeaves;
    let closed = false;
    a.radixLeaves = function* (root) { try { yield* original.call(this, root); } finally { closed = true; } };
    const error = new Error('stop');
    const seen: [string, number][] = [];
    assert.throws(() => map.forEach(function (this: unknown, value, key) {
      assert.equal(this, undefined); seen.push([key, value]); if (key === 'b') throw error;
    }), thrown => thrown === error);
    assert.ok(closed); assert.deepEqual(seen, [['a', 1], ['b', 2]]);
    assert.deepEqual(collected(map), [['a', 1], ['b', 2], ['c', 3]]);
  });

  it('honors a subclass entries override even on an empty underlying root', () => {
    class Extended extends SharedSortedMap<'number'> {
      *entries(): Generator<[string, number]> {
        assert.ok(this instanceof Extended);
        yield ['virtual', 7];
        yield* super.entries();
      }
    }
    const map = new Extended('number', undefined, 0, 0, new Arena());
    assert.deepEqual(collected(map), [['virtual', 7]]);
  });

  it('honors replacement of the base entries prototype and preserves the receiver', () => {
    const saved = SharedSortedMap.prototype.entries;
    const map = new SharedSortedMap('number', undefined, 0, 0, new Arena()).set('a', 1);
    SharedSortedMap.prototype.entries = function* () {
      assert.equal(this, map);
      yield ['override', 42] as any;
      yield ['continuation', 43] as any;
    };
    try {
      const seen: [string, number][] = [];
      map.forEach((value, key) => {
        seen.push([key, value]);
        SharedSortedMap.prototype.entries = function* () { throw new Error('must keep the active iterator'); };
      });
      assert.deepEqual(seen, [['override', 42], ['continuation', 43]]);
    }
    finally { SharedSortedMap.prototype.entries = saved; }
    assert.deepEqual(collected(map), [['a', 1]]);
  });

  it('looks up entries once and invokes the function even if its call property is replaced', () => {
    const saved = Object.getOwnPropertyDescriptor(SharedSortedMap.prototype, 'entries')!;
    const map = new SharedSortedMap('number', undefined, 0, 0, new Arena()).set('a', 1);
    let gets = 0;
    const entries = function* (this: SharedSortedMap<'number'>): Generator<[string, number]> {
      assert.equal(this, map); yield ['override', 5];
    };
    Object.defineProperty(entries, 'call', { value() { throw new Error('must not access .call'); } });
    Object.defineProperty(SharedSortedMap.prototype, 'entries', {
      configurable: true,
      get() { gets++; assert.equal(this, map); return gets === 1 ? entries : function* () { throw new Error('second lookup'); }; },
    });
    try { assert.deepEqual(collected(map), [['override', 5]]); assert.equal(gets, 1); }
    finally { Object.defineProperty(SharedSortedMap.prototype, 'entries', saved); }
  });

  it('propagates entries getter and callback errors on the override fallback', () => {
    const saved = Object.getOwnPropertyDescriptor(SharedSortedMap.prototype, 'entries')!;
    const map = new SharedSortedMap('number', undefined, 0, 0, new Arena());
    const error = new Error('override stop');
    Object.defineProperty(SharedSortedMap.prototype, 'entries', { configurable: true, get() { throw error; } });
    try { assert.throws(() => map.forEach(() => {}), thrown => thrown === error); }
    finally { Object.defineProperty(SharedSortedMap.prototype, 'entries', saved); }
    let closed = false;
    SharedSortedMap.prototype.entries = function* () {
      try { yield ['override', 1] as any; yield ['never', 2] as any; }
      finally { closed = true; }
    };
    try {
      assert.throws(() => map.forEach(function (this: unknown) { assert.equal(this, undefined); throw error; }), thrown => thrown === error);
      assert.ok(closed);
    } finally { Object.defineProperty(SharedSortedMap.prototype, 'entries', saved); }
  });

  it('survives callback writes, shared-memory growth and recursive reads', () => {
    const a = new Arena();
    let map = new SharedSortedMap('number', undefined, 0, 0, a);
    for (let i = 0; i < 128; i++) map = map.set(`k${i}`, i);
    const expected = Array.from({ length: 128 }, (_, i) => [`k${i}`, i] as const).sort(([a], [b]) => compare(a, b));
    let fork = map, didGrow = false;
    const seen: [string, number][] = [];
    map.forEach((value, key) => {
      if (!didGrow) {
        didGrow = true; const old = a.memory.buffer;
        new SharedMap('string', 0, 0, a).set('grow', 'x'.repeat(old.byteLength * 2));
        assert.notEqual(a.memory.buffer, old);
        fork = map.set('k1', -1).delete('k2');
        resetSortedMap();
        assert.deepEqual(collected(map), expected);
      }
      seen.push([key, value]);
    });
    assert.deepEqual(seen, expected); assert.equal(map.get('k1'), 1); assert.equal(fork.get('k1'), -1);
  });

  it('decodes the key before a cold value decoder reenters and grows memory', () => {
    const a = new Arena();
    let map = new SharedSortedMap('object', undefined, 0, 0, a);
    for (let i = 0; i < 8; i++) map = map.set(`k${i}`, { i });
    const key = a.string.bind(a), decode = a.decodeAt.bind(a), events: string[] = [];
    let didGrow = false;
    a.string = (ptr, length) => { const result = key(ptr, length); events.push(`key:${result}`); return result; };
    a.decodeAt = (type, ptr, length) => {
      events.push('value');
      if (!didGrow) { didGrow = true; a.memory.grow(2); assert.equal(map.has('k7'), true); }
      return decode(type, ptr, length);
    };
    assert.deepEqual(collected(map), Array.from({ length: 8 }, (_, i) => [`k${i}`, { i }]));
    assert.deepEqual(events, Array.from({ length: 8 }, (_, i) => [`key:k${i}`, 'value']).flat());
  });

  it('merges imported nested journals with the same ordering and replacement rules', () => {
    const a = new Arena();
    const base = new SharedSortedMap('number', undefined, 0, 0, a).set('a', 1).set('b', 2).set('c', 3);
    const first = journal(a, base.root, [['b', 20], ['d', 4]], 'radixLeaves');
    const root = journal(a, first, [['a', 10], ['🙂', 5]], 'radixLeaves');
    const expected = reference(a, root, 'radixLeaves').map(p => [a.leafKey(p), a.leafValue('number', p)]);
    const map = new SharedSortedMap('number', undefined, root, undefined, a);
    assert.deepEqual(collected(map), expected);
    assert.deepEqual(collected(base), [['a', 1], ['b', 2], ['c', 3]]);
  });

  for (const copy of [false, true]) it(`reads ${copy ? 'copy' : 'shared'} attachments without allocations`, async () => {
    let map = new SharedSortedMap('object', undefined, 0, 0, new Arena());
    for (let i = 0; i < 64; i++) map = map.set(`k${i}`, { i, text: '🙂' });
    const attached = (await initWorker<{ map: typeof map }>(getWorkerData({ map }, { copy }))).map;
    const a = arenaOf(attached), used = a.used, before = a.buf.slice(HEAP_START, used);
    assert.deepEqual(collected(attached), collected(map));
    assert.equal(a.used, used); assert.deepEqual(a.buf.subarray(HEAP_START, used), before);
    assert.throws(() => attached.set('forbidden', {}), /read-only/);
  });
});
