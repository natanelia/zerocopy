import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, HEAP_START, popcount } from './arena';
import { SharedMap, SharedList, SharedSortedMap, SharedSortedSet, compact, getWorkerData, initWorker } from './shared';
import { encodeZerocopyState, decodeZerocopyState } from './redux-checkpoint';
import { createSharedState } from './worker';

const JOURNAL = 0xffffffff;
const encoder = new TextEncoder();
const compare = (a: string, b: string) => Buffer.compare(encoder.encode(a), encoder.encode(b));
const sorted = (entries: Iterable<readonly [string, number]>) => [...new Map(entries)].sort(([a], [b]) => compare(a, b));
const payload = (a: Arena, end = a.used) => a.buf.slice(HEAP_START, end);
const fresh = (a = new Arena()) => new SharedSortedMap('number', undefined, 0, 0, a);
function canonical(entries: readonly (readonly [string, number])[]) {
  let map = fresh(); for (const [key, value] of entries) map = map.set(key, value);
  return compact(map);
}
function pending(map: SharedSortedMap<'number'>, count: number) {
  const a = arenaOf(map), dv = a.dv;
  expect(dv.getUint32(map.root, true)).toBe(JOURNAL);
  expect(dv.getUint32(map.root + 12, true)).toBe(count);
  return dv.getUint32(map.root + 4, true);
}
function canonicalShape(map: SharedSortedMap<any>) {
  const a = arenaOf(map), dv = a.dv;
  const visit = (root: number, previous = -1): Set<number> => {
    if (!root) return new Set();
    const tag = dv.getUint32(root, true);
    expect(tag).not.toBe(JOURNAL);
    if (!tag) return new Set([root]);
    const critical = tag - 3, bitmap = dv.getUint32(root + 4, true), leaves = new Set<number>();
    expect(critical).toBeGreaterThan(previous); expect(bitmap & ~0x1ffff).toBe(0);
    expect(popcount(bitmap)).toBeGreaterThanOrEqual(2);
    let offset = 0;
    for (let digit = 0; digit <= 16; digit++) if (bitmap & (1 << digit)) {
      const child = dv.getUint32(root + 16 + offset++ * 4, true);
      for (const leaf of visit(child, critical)) {
        const n = dv.getUint32(leaf + 8, true), i = critical >>> 1;
        const actual = i < n ? ((a.buf[leaf + 16 + i] >>> ((critical & 1) ? 0 : 4)) & 15) + 1 : 0;
        expect(actual).toBe(digit); leaves.add(leaf);
      }
    }
    expect(leaves.has(dv.getUint32(root + 12, true))).toBe(true);
    expect(dv.getUint32(root + 8, true)).toBe(leaves.size);
    return leaves;
  };
  expect(visit(map.root).size).toBe(map.size);
  expect(a.wasm.radixSize(map.root)).toBe(map.size);
}
function check(map: SharedSortedMap<'number'>, model: Map<string, number>) {
  expect([...map.entries()]).toEqual(sorted(model)); expect(map.size).toBe(model.size);
  for (const [key, value] of model) { expect(map.has(key)).toBe(true); expect(map.get(key)).toBe(value); }
  canonicalShape(map);
}
function journal(a: Arena, base: number, leaves: readonly number[], size: number) {
  const root = a.alloc(16 + leaves.length * 4), dv = a.dv;
  dv.setUint32(root, JOURNAL, true); dv.setUint32(root + 4, base, true);
  dv.setUint32(root + 8, size, true); dv.setUint32(root + 12, leaves.length, true);
  leaves.forEach((leaf, i) => dv.setUint32(root + 16 + i * 4, leaf, true));
  return new SharedSortedMap('number', undefined, root, size, a);
}

describe('sorted journal deletion', () => {
  for (const count of [1, 2, 3, 4]) for (const mode of ['new', 'replacement'] as const) {
    it(`${count} pending ${mode} keys preserve every deletion position and fork`, () => {
      for (let target = 0; target < count; target++) {
        const entries = Array.from({ length: 24 }, (_, i) => [`base/${i.toString().padStart(2, '0')}`, i] as const);
        const base = canonical(entries), a = arenaOf(base), original = [...base.entries()];
        let map = base; const model = new Map<string, number>(entries), keys: string[] = [];
        for (let i = 0; i < count; i++) {
          const key = mode === 'new' ? `new/${i}` : entries[i][0];
          keys.push(key); map = map.set(key, 100 + i); model.set(key, 100 + i);
        }
        expect(pending(map, count)).toBe(base.root);
        const end = a.used, before = payload(a), old = [...map.entries()];
        const next = map.delete(keys[target]); model.delete(keys[target]);
        check(next, model); expect(next.has(keys[target])).toBe(false); expect(next.get(keys[target])).toBeUndefined();
        const future = next.set('future', 91).delete('future'); check(future, model);
        expect([...map.entries()]).toEqual(old); expect([...base.entries()]).toEqual(original);
        expect(payload(a, end)).toEqual(before);
      }
    });
  }

  it('keeps canonical, base-only, absent, and delete-to-empty behavior', () => {
    const base = canonical([['aa', 1], ['ab', 2], ['ac', 3]]), a = arenaOf(base);
    check(base.delete('ab'), new Map([['aa', 1], ['ac', 3]]));
    const map = base.set('pending', 4); pending(map, 1);
    expect(map.delete('missing')).toBe(map);
    check(map.delete('ab'), new Map([['aa', 1], ['ac', 3], ['pending', 4]]));
    const singleton = fresh(a).set('only', 1).set('only', 2);
    pending(singleton, 1); const empty = singleton.delete('only');
    expect(empty.root).toBe(0); expect(empty.size).toBe(0); expect([...empty.entries()]).toEqual([]);
    check(empty.set('again', 5).delete('missing'), new Map([['again', 5]]));
  });

  it('omits every byte-equal target and preserves unrelated duplicate write order', () => {
    const base = canonical([['a', 1], ['target', -1]]), a = arenaOf(base);
    const first = a.leaf('number', 'target', 2), survivor1 = a.leaf('number', 'other', 3);
    const last = a.leaf('number', 'target', 4), survivor2 = a.leaf('number', 'other', 5);
    a.dv.setUint32(last + 4, 123, true); // Radix equality is full bytes, independent of this synthetic hash.
    const map = journal(a, base.root, [first, survivor1, last, survivor2], 999);
    expect(map.get('target')).toBe(2); const end = a.used, before = payload(a);
    const next = map.delete('target');
    check(next, new Map([['a', 1], ['other', 5]])); expect(next.has('target')).toBe(false);
    expect(payload(a, end)).toEqual(before); expect(map.get('target')).toBe(2);
    const repeated = journal(a, base.root, [first, first], 2);
    check(repeated.delete('target'), new Map([['a', 1]]));
  });

  it('handles zero-base journals and corrects native and wrapper count metadata', () => {
    const a = new Arena(), x = a.leaf('number', 'x', 1), y = a.leaf('number', 'y', 2);
    const raw = journal(a, 0, [x, y], 999);
    const wrapped = new SharedSortedMap('number', undefined, raw.root, 1234, a);
    const next = wrapped.delete('x'); check(next, new Map([['y', 2]])); expect(next.root).toBe(y);
    expect(next.delete('y').root).toBe(0);
  });

  it('keeps scratch, raw-copy, outside-used, length, and oversized-count fallbacks', () => {
    for (const mode of ['stage', 'fold-scratch', 'copy', 'outside-used', 'wrong-length'] as const) {
      const base = fresh().set('a', 1), map = base.set('b', 2), a = arenaOf(map), leaf = a.radixFind(map.root, 'b');
      let key = leaf + 16, length = 1;
      if (mode === 'stage') key = 16384;
      if (mode === 'fold-scratch') key = 1024;
      if (mode === 'copy') key = a.alloc(8);
      if (mode === 'outside-used') key = a.used + 128;
      if (mode === 'wrong-length') length = 2;
      if (mode !== 'wrong-length') a.buf[key] = 98;
      if (mode === 'fold-scratch') expect(leaf & 255).not.toBe(98);
      const end = a.used, before = payload(a), root = a.wasm.radixDelete(map.root, key, length) >>> 0;
      const next = new SharedSortedMap('number', undefined, root, undefined, a);
      const unchanged = mode === 'fold-scratch' || mode === 'wrong-length';
      check(next, new Map(unchanged ? [['a', 1], ['b', 2]] : [['a', 1]]));
      expect(payload(a, end)).toEqual(before); expect(map.get('b')).toBe(2);
    }
    const base = fresh().set('a', 1), a = arenaOf(base);
    const leaves = ['b', 'c', 'd', 'e', 'f'].map((key, i) => a.leaf('number', key, i));
    const large = journal(a, base.root, leaves, 6);
    check(large.delete('b'), new Map([['a', 1], ['c', 1], ['d', 2], ['e', 3], ['f', 4]]));
  });

  it('handles encoded-key boundaries and full hash collisions', () => {
    const keys = ['', '\0', '\ufeff', 'costarring', 'liquid', '\ud800', '界🙂'.repeat(8000) + 'x'];
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    for (const key of keys) {
      const base = canonical([['anchor', 1], ['costarring', 2], ['liquid', 3]]);
      const normalized = decoder.decode(encoder.encode(key));
      const map = base.set(key, 9).set('survivor', 10), model = new Map([...base.entries(), [normalized, 9], ['survivor', 10]] as [string, number][]);
      pending(map, 2); model.delete(normalized); check(map.delete(key), model);
      expect(map.get(key)).toBe(9);
    }
  });

  it('keeps read caches, same-value writes, and same-arena interleaving valid', () => {
    const base = canonical([['a', 1], ['target', 2], ['z', 3]]), a = arenaOf(base);
    const map = base.set('target', 9).set('survivor', 4), fork = base.set('fork', 8);
    for (let i = 0; i < 20; i++) { expect(map.get('target')).toBe(9); expect(base.get('target')).toBe(2); expect(fork.has('target')).toBe(true); }
    const next = map.delete('target');
    let other = new SharedMap('number', 0, 0, a).setMany([['x', 1], ['y', 2]]);
    for (let i = 0; i < 20; i++) {
      expect(next.get('target')).toBeUndefined(); expect(map.get('target')).toBe(9); expect(base.get('target')).toBe(2);
      expect(next.get('survivor')).toBe(4); other = other.set('x', i);
    }
    expect(next.set('survivor', 4)).toBe(next); expect(other.get('y')).toBe(2);
    check(next, new Map([['a', 1], ['z', 3], ['survivor', 4]]));
    const one = fresh(a).set('old', 7), returned = one.set('temporary', 8).delete('temporary');
    expect(returned.root).toBe(one.root); expect(returned.get('old')).toBe(7); expect(one.get('temporary')).toBeUndefined();
  });

  it('preserves custom comparator ties, projection order, and sorted-set keys', () => {
    for (const tied of [false, true]) {
      let calls = 0;
      const comparator = (a: string, b: string) => { calls++; return tied ? 0 : compare(b, a); };
      const base = new SharedSortedMap('string', comparator).set('a', 'A').set('c', 'C');
      const map = base.set('b', 'B').set('d', 'D'); calls = 0;
      const next = map.delete('b'); expect(calls).toBe(0); canonicalShape(next);
      const expected = tied ? [['a', 'A'], ['c', 'C'], ['d', 'D']] : [['d', 'D'], ['c', 'C'], ['a', 'A']];
      expect([...next.entries()]).toEqual(expected); expect([...next.keys()]).toEqual(expected.map(([key]) => key));
      expect([...next.values()]).toEqual(expected.map(([, value]) => value));
      const visited: string[][] = []; next.forEach((value, key) => { visited.push([key, value]); expect(next.has(key)).toBe(true); });
      expect(visited).toEqual(expected); expect(() => next.toWorkerData()).toThrow(/comparator/);
    }
    let set = new SharedSortedSet<string | number>();
    for (const value of [1, '1', NaN, '', '🙂']) set = set.add(value);
    const before = [...set.values()], next = set.delete('1');
    expect([...next.values()]).toEqual(before.filter(value => value !== '1')); expect(next.has(1)).toBe(true);
    expect(set.has('1')).toBe(true); expect(next.has('1')).toBe(false);
  });

  it('preserves paused iterators, object values, forks, and old bytes across growth', () => {
    const base = compact(new SharedSortedMap('object').set('a', { value: 1 }).set('z', { value: 2 }));
    const map = base.set('target', { value: 3 }).set('kept', { nested: [4] }), a = arenaOf(map);
    const expected = [...map.entries()], iterator = map.entries(), first = iterator.next();
    const end = a.used, before = payload(a), next = map.delete('target'), nextExpected = [...next.entries()];
    const second = next.entries(), secondFirst = second.next(), buffer = a.memory.buffer;
    new SharedMap('string', 0, 0, a).set('growth', 'x'.repeat(buffer.byteLength * 2));
    expect(a.memory.buffer).not.toBe(buffer);
    expect([first.value, ...iterator]).toEqual(expected); expect([secondFirst.value, ...second]).toEqual(nextExpected);
    expect(payload(a, end)).toEqual(before); expect(Object.isFrozen(next.get('kept')!.nested)).toBe(true);
    expect([...base.entries()]).toEqual([['a', { value: 1 }], ['z', { value: 2 }]]); canonicalShape(next);
  });

  it('round-trips old/new nested snapshots through attachment, compaction, and checkpoints', async () => {
    const child = new SharedList('number').pushMany([1, 2, 3]);
    const base = compact(new SharedSortedMap('SharedList<number>').set('a', child).set('z', child));
    const map = base.set('target', child).set('kept', child), next = map.delete('target');
    const logical = (m: typeof next) => [...m.entries()].map(([key, value]) => [key, value.toArray()]);
    const expected = logical(next), old = logical(map);
    for (const copy of [false, true]) {
      const reader = await initWorker(getWorkerData({ old: map, next }, { copy }));
      expect(logical(reader.next)).toEqual(expected); expect(logical(reader.old)).toEqual(old);
      expect(() => reader.next.delete('a')).toThrow(/read-only/);
      expect(logical(compact(reader.next))).toEqual(expected);
    }
    const restored = decodeZerocopyState(encodeZerocopyState({ old: map, next })) as { old: typeof map; next: typeof next };
    expect(logical(restored.next)).toEqual(expected); expect(logical(restored.old)).toEqual(old); canonicalShape(restored.next);
  });

  it('preserves old prefixes and readers through real allocation failures', async () => {
    const capacity = 2 * 65536;
    const fixture = () => {
      const a = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }) });
      let base = fresh(a);
      for (let i = 0; i < 65; i++) base = base.set(`key/${i.toString().padStart(3, '0')}`, i);
      base = base.set('force-canonical', -1).delete('force-canonical'); canonicalShape(base);
      const map = base.set('key/032', -32).set('new/survivor', 100); pending(map, 2);
      return { a, base, map };
    };
    const probe = fixture(), query = probe.a.radixFind(probe.base.root, 'key/032'), mark = probe.a.used;
    probe.a.wasm.radixDelete(probe.base.root, query + 16, probe.a.dv.getUint32(query + 8, true));
    const baseRemovalBytes = probe.a.used - mark; expect(baseRemovalBytes).toBeGreaterThan(0);
    let failures = 0, successes = 0, partialFailures = 0, afterBaseFailures = 0;
    for (const headroom of [...Array.from({ length: 25 }, (_, i) => i * 8), 256, 384, 512, 768, 1024]) {
      const { a, map } = fixture(), expected = [...map.entries()], end = a.used, before = payload(a), descriptor = map.toWorkerData();
      const reader = await initWorker(getWorkerData({ map }, { copy: false }));
      a.alloc(0); a.alloc(capacity - a.used - headroom); const frontier = a.used;
      let next: typeof map | undefined;
      try { next = map.delete('key/032'); successes++; }
      catch (error) {
        expect(error).toBeInstanceOf(WebAssembly.RuntimeError); failures++;
        if (a.used > frontier) partialFailures++;
        if (a.used - frontier >= baseRemovalBytes) afterBaseFailures++;
        const leaf = a.radixFind(map.root, 'new/survivor');
        const smaller = new SharedSortedMap('number', undefined, leaf, 1, a).delete('new/survivor');
        expect(smaller.root).toBe(0); expect(smaller.size).toBe(0);
      }
      if (next) check(next, new Map(expected.filter(([key]) => key !== 'key/032')));
      expect(a.used).toBeGreaterThanOrEqual(frontier); expect(a.used).toBeLessThanOrEqual(capacity);
      expect(map.toWorkerData()).toEqual(descriptor); expect([...map.entries()]).toEqual(expected);
      expect([...reader.map.entries()]).toEqual(expected); expect(payload(a, end)).toEqual(before);
      const copied = await initWorker(getWorkerData({ map }, { copy: true })); expect([...copied.map.entries()]).toEqual(expected);
    }
    expect(failures).toBeGreaterThan(0); expect(successes).toBeGreaterThan(0); expect(partialFailures).toBeGreaterThan(0);
    if (process.env.ZEROCOPY_SORTED_DELETE_ARM === 'candidate') expect(afterBaseFailures).toBeGreaterThan(0);
  });

  it('preserves old-root equality and session versions for composite updates', () => {
    const base = canonical([['aa', 1], ['ab', 2]]);
    const leaf = fresh().set('a', 1), three = canonical([['aa', 1], ['ab', 2], ['z', 3]]);
    const oldChild = three.delete('z');
    const cases = [
      { before: base, next: base.set('ac', 3).delete('ac'), equal: false },
      { before: base, next: base.set('z', 3).delete('z'), equal: true },
      { before: oldChild, next: three.set('z', 9).delete('z'), equal: true },
      { before: base, next: base.set('ac', 3).set('aa', 9).delete('ac'), equal: false },
      { before: leaf, next: leaf.set('b', 2).delete('b'), equal: true },
    ];
    for (const { before, next, equal } of cases) {
      expect(next.root === before.root).toBe(equal); canonicalShape(next);
      const nested = new SharedMap('SharedSortedMap<number>').set('inner', before);
      for (const record of [false, true]) {
        const state = createSharedState(record ? { map: before, nested } : before, { publish: { strategy: 'immediate' } });
        const versions: number[] = []; state.subscribe((_, version) => versions.push(version));
        try {
          expect(state.publish(record ? { map: next, nested } : next)).toBe(equal ? 0 : 1);
          expect(versions).toEqual(equal ? [] : [1]); expect(state.flush()).toBe(equal ? 0 : 1);
          expect(nested.get('inner')!.root).toBe(before.root);
        } finally { state.dispose(); }
      }
    }
    const state = createSharedState(leaf), versions: number[] = []; state.subscribe((_, v) => versions.push(v));
    try {
      const added = leaf.set('b', 2); expect(state.publish(added)).toBe(1);
      expect(state.publish(added.delete('b'))).toBe(2); expect(versions).toEqual([1, 2]);
    } finally { state.dispose(); }
  });

  it('accounts separately for the two-key allocation and zero-saving replacement', () => {
    const arm = process.env.ZEROCOPY_SORTED_DELETE_ARM;
    expect(['baseline', 'candidate']).toContain(arm);
    const base = fresh().set('a', 1), map = base.set('b', 2), a = arenaOf(map); pending(map, 1);
    const before = a.used, next = map.delete('b'), allocatedBytes = a.used - before;
    expect(next.root).toBe(base.root); expect(allocatedBytes).toBe(arm === 'candidate' ? 0 : 24);
    const replacement = base.set('a', 2), mark = a.used, empty = replacement.delete('a');
    expect(empty.root).toBe(0); expect(a.used - mark).toBe(0);
    console.log('SORTED_DELETE_ALLOCATION ' + JSON.stringify({ arm, allocatedBytes }));
  });
});
