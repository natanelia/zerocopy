import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, SharedMap, compact, getWorkerData, initWorker } from './shared';
import { createSharedMapEntrySelector, createSharedMapValueSelector } from './redux';

function numbers(value = 1): SharedMap<'number'> {
  return new SharedMap('number', 0, 0, new Arena()).setMany([['selected', value], ['other', 2]]);
}
function entrySelector() {
  return createSharedMapEntrySelector((map: SharedMap<'number'>) => map, (_map, key: string) => key);
}

describe('entry selector map validation', () => {
  it('handles changing keys, missing keys and empty maps without retaining an old result', () => {
    const source = numbers(), select = entrySelector();
    for (let pass = 0; pass < 3; pass++) {
      assert.equal(select(source, 'selected'), 1);
      assert.equal(select(source, 'other'), 2);
      assert.equal(select(source, 'absent'), undefined);
      assert.equal(select(source, 'selected'), 1);
    }
    const empty = new SharedMap('number', 0, 0, new Arena());
    assert.equal(select(empty, 'selected'), undefined);
    assert.equal(select(empty, 'selected'), undefined);
    assert.equal(select(source, 'selected'), 1);
  });

  it('runs both input selectors in their original order on every call', () => {
    const source = numbers(), calls: unknown[] = [], error = new Error('input selector failed');
    const select = createSharedMapEntrySelector(
      (state: { data: SharedMap<'number'>; fail?: boolean }, key: string, version: number) => {
        calls.push(['map', key, version]);
        if (state.fail) throw error;
        return state.data;
      },
      (_state, key: string, version: number) => { calls.push(['key', key, version]); return key; },
    );
    assert.equal(select({ data: source }, 'selected', 0), 1);
    assert.equal(select({ data: source }, 'selected', 1), 1);
    assert.throws(() => select({ data: source, fail: true }, 'selected', 2), thrown => thrown === error);
    assert.deepEqual(calls, [['map', 'selected', 0], ['key', 'selected', 0], ['map', 'selected', 1], ['key', 'selected', 1], ['map', 'selected', 2]]);
    assert.equal(select({ data: source }, 'other', 3), 2);
  });

  it('validates every different map and preserves the exact errors after a cache hit', () => {
    const source = numbers(), select = entrySelector();
    const invalid = [undefined, null, {}, Object.freeze(Object.create(SharedMap.prototype)),
      new Proxy(source, {}), new SharedList('number')];
    for (const value of invalid) {
      assert.throws(() => select(value as any, 'selected'), error => error instanceof TypeError && error.message === 'Expected a frozen SharedMap');
      assert.equal(select(source, 'selected'), 1);
      assert.throws(() => select(value as any, 'selected'), error => error instanceof TypeError && error.message === 'Expected a frozen SharedMap');
      assert.equal(select(source, 'selected'), 1);
    }
    for (const key of [undefined, null, 1, {}, new String('selected'), Symbol('selected')]) {
      assert.throws(() => select(source, key as any), error => error instanceof TypeError && error.message === 'Map keys must be strings');
      assert.equal(select(source, 'selected'), 1);
    }
  });

  it('keeps dynamic find overrides and their errors on a previously selected map', () => {
    const source = numbers(), arena = arenaOf(source), select = entrySelector(), original = arena.find;
    assert.equal(select(source, 'selected'), 1);
    const other = original.call(arena, source.root, 'other'), error = new Error('custom lookup failed');
    let reads = 0;
    Object.defineProperty(arena, 'find', { configurable: true, get() {
      reads++;
      return function (this: Arena, root: number, key: string) {
        assert.equal(this, arena); assert.equal(root, source.root); assert.equal(key, 'selected');
        if (reads === 2) throw error;
        return other;
      };
    } });
    try {
      assert.equal(select(source, 'selected'), 2);
      assert.throws(() => select(source, 'selected'), thrown => thrown === error);
      assert.equal(select(source, 'selected'), 2);
      assert.equal(reads, 3);
    } finally { Reflect.deleteProperty(arena, 'find'); }
    assert.equal(select(source, 'selected'), 1);
  });

  it('preserves value identity across unrelated edits after the decode cache fills', () => {
    const source = compact(new SharedMap('object').setMany(Array.from({ length: 2050 }, (_, i) => [`k${i}`, { index: i }] as const)));
    for (let i = 0; i < 2048; i++) source.get(`k${i}`);
    const select = createSharedMapValueSelector((map: SharedMap<'object'>) => map, () => 'k2049');
    const selected = select(source), fork = source.set('unrelated', { index: -1 });
    assert.equal(select(source), selected); assert.equal(select(fork), selected);
    assert.equal(select(fork), selected); assert.equal(select(source), selected);
    const changed = fork.set('k2049', { index: 99 });
    assert.deepEqual(select(changed), { index: 99 }); assert.notEqual(select(changed), selected);
    assert.deepEqual(select(source), { index: 2049 }); assert.equal(source.has('unrelated'), false);
  });

  it('distinguishes arenas, value types and retained forks with the same selector', () => {
    const source = numbers(), other = numbers(9), select = entrySelector();
    assert.equal(source.root, other.root);
    assert.equal(select(source, 'selected'), 1); assert.equal(select(other, 'selected'), 9);
    assert.equal(select(source, 'selected'), 1); assert.equal(select(compact(other), 'selected'), 9);
    const fork = source.set('selected', -0);
    assert.ok(Object.is(select(fork, 'selected'), -0)); assert.equal(select(source, 'selected'), 1);
    const retyped = new SharedMap('boolean', source.root, source.size, arenaOf(source));
    assert.equal(select(retyped as any, 'selected'), false);
    assert.equal(select(source, 'selected'), 1);
  });

  it('does not corrupt the cache when an input selector reenters it', () => {
    const source = numbers(), other = numbers(7);
    const select = createSharedMapEntrySelector(
      (state: { data: SharedMap<'number'>; reenter?: boolean }) => state.data,
      (state, key: string): string => {
        if (state.reenter) assert.equal(select({ data: other }, 'selected'), 7);
        return key;
      },
    );
    assert.equal(select({ data: source }, 'selected'), 1);
    assert.equal(select({ data: source, reenter: true }, 'selected'), 1);
    assert.equal(select({ data: source }, 'other'), 2);
    assert.equal(select({ data: source, reenter: true }, 'selected'), 1);
  });

  it('does not change its successful cache after a new map fails to decode', () => {
    const source = numbers(), other = numbers(3), arena = arenaOf(other), select = entrySelector();
    const error = new Error('custom decoder failed');
    assert.equal(select(source, 'selected'), 1);
    Object.defineProperty(arena, 'leafValue', { configurable: true, value() { throw error; } });
    try {
      assert.throws(() => select(other, 'selected'), thrown => thrown === error);
      assert.equal(select(source, 'selected'), 1);
    } finally { Reflect.deleteProperty(arena, 'leafValue'); }
    assert.equal(select(other, 'selected'), 3); assert.equal(select(source, 'selected'), 1);
  });

  for (const copy of [false, true]) it(`preserves read-only attachments and growth (copy=${copy})`, async () => {
    const source = numbers(), attached = (await initWorker(getWorkerData({ source }, { copy }))).source;
    const arena = arenaOf(attached), used = arena.used, bytes = arena.buf.slice(HEAP_START, used), select = entrySelector();
    assert.equal(arena.readOnly, true); assert.equal(select(attached, 'selected'), 1);
    arenaOf(source).memory.grow(2);
    const later = source.set('selected', 12);
    assert.equal(select(attached, 'selected'), 1); assert.equal(select(later, 'selected'), 12);
    assert.equal(select(attached, 'other'), 2); assert.equal(select(attached, 'selected'), 1);
    assert.equal(arena.used, used); assert.deepEqual(arena.buf.subarray(HEAP_START, used), bytes);
  });
});
