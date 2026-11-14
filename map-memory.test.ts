import { describe, expect, test } from 'vitest';
import { Arena, arenaOf, HEAP_START, hashBytes } from './arena';
import { SharedMap, SharedOrderedMap, SharedList, SharedStack, getWorkerData, initWorker, compact } from './shared';

const ownerMap = (type: 'string' | 'number' | 'boolean' = 'number') => new SharedMap(type, 0, 0, new Arena());
const attached = (m: any) => {
  const a = arenaOf(m);
  return SharedMap.fromWorkerData(m.root, m.valueType, m.size, new Arena({ memory: a.memory, used: a.used, readOnly: true }));
};

describe('compact immutable HAMT records', () => {
  test('scalar construction has bounded allocation without compaction or dropping snapshots', () => {
    let map: any = ownerMap('string');
    const retained: any[] = [];
    for (let i = 0; i < 10000; i++) {
      if (i % 250 === 0) retained.push(map);
      map = map.set(`key${i}`, `val${i}`);
    }
    // Deterministic arena allocation, not a claim about total process memory.
    expect(arenaOf(map).used - HEAP_START).toBeLessThan(1100000);
    for (let i = 0; i < 10000; i++) expect(map.get(`key${i}`)).toBe(`val${i}`);
    for (const old of retained) {
      expect(old.has(`key${old.size}`)).toBe(false);
      if (old.size) expect(old.get(`key${old.size - 1}`)).toBe(`val${old.size - 1}`);
    }
  });
  test('long-distance forks materialize pointers without truncating their addresses', () => {
    let map: any = ownerMap();
    for (let i = 0; i < 300; i++) map = map.set(`key${i}`, i);
    const a = arenaOf(map), oldBytes = a.buf.slice(HEAP_START, a.used);
    a.alloc(300000);
    const fork = map.set('key42', -42).set('new', 999).delete('key43');
    const reader = attached(fork);
    expect(reader.get('key42')).toBe(-42); expect(reader.get('new')).toBe(999); expect(reader.has('key43')).toBe(false);
    expect(map.get('key42')).toBe(42); expect(map.get('key43')).toBe(43);
    expect(Buffer.compare(Buffer.from(oldBytes), Buffer.from(a.buf.subarray(HEAP_START, HEAP_START + oldBytes.length)))).toBe(0);
  });
  test('batch ownership is local to the call and published payload bytes never change', () => {
    let map: any = ownerMap();
    for (let i = 0; i < 2000; i++) map = map.set(`k${i}`, i);
    const a = arenaOf(map), bytes = a.buf.slice(HEAP_START, a.used);
    const changes = Array.from({ length: 400 }, (_, i) => [`k${i}`, -i] as const);
    const next = map.setMany(changes).set('after', 1);
    const branch = map.setMany([['k1', 999], ['new', 1000]]).delete('k2');
    expect(next.get('k399')).toBe(-399); expect(map.get('k399')).toBe(399);
    expect(branch.get('k1')).toBe(999); expect(branch.has('k2')).toBe(false);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(a.buf.subarray(HEAP_START, HEAP_START + bytes.length)))).toBe(0);
    expect([...compact(next).entries()].sort()).toEqual([...next.entries()].sort());
  });
  test('unaligned map records can interleave with aligned vector and stack records', () => {
    const a = new Arena();
    let map = new SharedMap('number', 0, 0, a), list = new SharedList('number', 0, 0, 0, a), stack = new SharedStack('number', 0, 0, undefined, a);
    for (let i = 0; i < 257; i++) { map = map.set('x'.repeat(i % 7) + i, i + 0.25); list = list.push(i + 0.5); stack = stack.push(i + 0.75); }
    for (let i = 0; i < 257; i++) { expect(map.get('x'.repeat(i % 7) + i)).toBe(i + 0.25); expect(list.get(i)).toBe(i + 0.5); }
    for (let i = 256; i >= 0; i--) { expect(stack.peek()).toBe(i + 0.75); stack = stack.pop(); }
  });
  test('coalesced changes preserve negative size deltas and empty branches', () => {
    let map: any = ownerMap(); const versions: any[] = [];
    for (let i = 0; i < 400; i++) { versions.push(map); map = map.set(`k${i}`, i); }
    for (let i = 0; i < 400; i++) { const old = map; map = map.delete(`k${i}`); expect(old.has(`k${i}`)).toBe(true); expect(map.size).toBe(399 - i); }
    expect([...map.entries()]).toEqual([]);
    for (let i = 1; i < versions.length; i += 17) expect(versions[i].get(`k${i - 1}`)).toBe(i - 1);
  });
});

describe('small root-specific read indexes', () => {
  test.each([false, true])('cold prefixes need no reusable directory lookup (copy=%s)', async copy => {
    const encoder = new TextEncoder(), prefix = (key: string) => hashBytes(encoder.encode(key)) & 255;
    const matching = (first: string) => {
      const keys = [first], wanted = prefix(first);
      for (let i = 0; keys.length < 4; i++) {
        const key = `${first}/${i}`;
        if (prefix(key) === wanted) keys.push(key);
      }
      return keys;
    };
    const keys = matching('present'), absent = matching('absent');
    expect(prefix(keys[0])).not.toBe(prefix(absent[0]));
    const source = ownerMap().setMany(keys.slice(0, 3).map((key, i) => [key, i] as const));
    const owner = arenaOf(source), before = owner.buf.slice();
    const { map } = await initWorker(getWorkerData({ map: source }, { copy }));
    const reader = arenaOf(map), native = reader.wasm;
    const calls = { direct: 0, prefix: 0, reused: 0 };
    Object.defineProperty(reader, 'wasm', { value: {
      ...native,
      mapHashCandidate(...args: number[]) { calls.direct++; return native.mapHashCandidate(...args); },
      mapHashPrefix(...args: number[]) { calls.prefix++; return native.mapHashPrefix(...args); },
      mapHashCandidateFrom(...args: number[]) { calls.reused++; return native.mapHashCandidateFrom(...args); },
    } });
    expect(map.get(keys[0])).toBe(0);
    expect(calls).toEqual({ direct: 1, prefix: 0, reused: 0 });
    // A miss sharing a seen prefix must resolve the subtree, not reuse the
    // first leaf. Later hits still compare their complete keys.
    expect(map.has(keys[3])).toBe(false);
    expect(map.get(keys[1])).toBe(1); expect(map.get(keys[2])).toBe(2);
    expect(calls).toEqual({ direct: 1, prefix: 1, reused: 3 });
    // A genuinely absent subtree is a valid cached zero, distinct from the
    // marker for a prefix that has only been visited once.
    for (const key of absent) expect(map.has(key)).toBe(false);
    expect(calls).toEqual({ direct: 2, prefix: 2, reused: 6 });
    expect(reader.used).toBe(owner.used);
    expect(Buffer.compare(Buffer.from(before), Buffer.from(owner.buf))).toBe(0);
    expect(() => map.set('forbidden', 1)).toThrow(/read-only/);
  });
  test('unresolved prefixes cannot escape their snapshot or directory size', async () => {
    const owner = new Arena();
    const small = new SharedMap('number', 0, 0, owner).setMany([['costarring', 1], ['liquid', 2], ['界🙂', 3]]);
    const large = small.setMany(Array.from({ length: 17000 }, (_, i) => [`key${i}`, i] as const));
    const fork = large.set('costarring', -1).delete('liquid');
    const { a, b, c } = await initWorker(getWorkerData({ a: small, b: large, c: fork }, { copy: false }));
    for (let i = 0; i < 3; i++) {
      expect(a.get('costarring')).toBe(1);
      expect(b.get(`key${16999 - i}`)).toBe(16999 - i);
      expect(c.get('costarring')).toBe(-1); expect(c.has('liquid')).toBe(false);
      expect(a.get('liquid')).toBe(2); expect(b.get('liquid')).toBe(2);
      expect(a.get('界🙂')).toBe(3); expect(b.has(`absent/${i}`)).toBe(false);
    }
  });
  test('presence checks do not replace boolean values or confuse missing keys', () => {
    const map: any = ownerMap('boolean').set('yes', true).set('no', false);
    const read: any = attached(map);
    expect(read.has('no')).toBe(true); expect(read.get('no')).toBe(false);
    expect(read.has('yes')).toBe(true); expect(read.get('yes')).toBe(true);
    expect(read.has('missing')).toBe(false); expect(read.get('missing')).toBeUndefined();
    expect(() => read.set('no', false)).toThrow(/read-only/);
  });
  test('prefix indexes are root-specific through forks, removals, and shared memory growth', () => {
    let base: any = ownerMap();
    for (let i = 0; i < 10000; i++) base = base.set(`key${i}`, i);
    const old: any = attached(base);
    for (let i = 0; i < 10000; i++) expect(old.get(`key${i}`)).toBe(i);
    let next = base;
    for (let i = 0; i < 800; i++) next = next.set(`key${i}`, i + 1);
    next = next.delete('key9999').set('large-range', 5);
    const current: any = attached(next);
    for (let i = 0; i < 10000; i++) {
      expect(old.get(`key${i}`)).toBe(i);
      expect(current.get(`key${i}`)).toBe(i === 9999 ? undefined : i < 800 ? i + 1 : i);
    }
    const a: any = arenaOf(current);
    expect(a.prefixChildren.byteLength + a.prefixValid.byteLength).toBe(1056);
    expect(a.valueMap.size).toBeLessThanOrEqual(16384);
  });
  test('historical roots reuse prefix indexes beyond the value-cache limit', () => {
    let base: any = ownerMap();
    for (let i = 0; i < 20000; i++) base = base.set(`key${i}`, i);
    const newer = base.set('key0', -1), a: any = arenaOf(base);
    const before = a.buf.slice();
    for (let i = 0; i < 20000; i++) expect(base.get(`key${i}`)).toBe(i);
    expect(a.prefixRoot).toBe(base.root);
    expect(a.prefixChildren.byteLength + a.prefixValid.byteLength).toBe(16896);
    expect(newer.get('key0')).toBe(-1);
    for (let i = 19000; i < 20000; i++) expect(base.get(`key${i}`)).toBe(i);
    expect(base.get('key0')).toBe(0);
    expect(Buffer.compare(Buffer.from(before), Buffer.from(a.buf))).toBe(0);
  });
  test('same-prefix and exact-hash collisions retain complete key checks', () => {
    const encoder = new TextEncoder();
    expect(hashBytes(encoder.encode('costarring'))).toBe(hashBytes(encoder.encode('liquid')));
    let map: any = ownerMap('string').set('costarring', 'A').set('liquid', 'B');
    for (let i = 0; i < 1024; i++) map = map.set(`prefix-${i}`, String(i));
    const read: any = attached(map);
    expect(read.has('liquid')).toBe(true); expect(read.get('liquid')).toBe('B'); expect(read.get('costarring')).toBe('A');
    expect(read.has('costarring!')).toBe(false);
    const changed = map.delete('liquid').set('costarring', 'C');
    expect(attached(changed).get('costarring')).toBe('C'); expect(read.get('costarring')).toBe('A');
  });
  test('Unicode aliases and cache-budget replacements do not keep stale values', () => {
    let map: any = ownerMap('string').set('\ud800', 'old').set('plain', 'short');
    expect(map.get('\ufffd')).toBe('old'); expect(map.has('\ud800')).toBe(true);
    map = map.set('\ufffd', 'new'); expect(map.get('\ud800')).toBe('new');
    const old = map; map = map.set('plain', 'x'.repeat(600000));
    expect(map.get('plain').length).toBe(600000); expect(old.get('plain')).toBe('short');
    map = map.set('plain', 'shorter'); expect(map.get('plain')).toBe('shorter');
    const a: any = arenaOf(map); expect(a.valueMapBytes).toBeLessThanOrEqual(1048576);
  });
  test('ordered prefixes, numeric values, and object decoders remain separate', () => {
    const a = new Arena();
    const map = new SharedMap('number', 0, 0, a).set('k', -0);
    const ordered = new SharedOrderedMap('number', 0, 0, 0, 0, a).set('k', 123);
    const objects = new SharedMap('object', 0, 0, a).set('k', { value: 456 });
    for (let i = 0; i < 10; i++) {
      expect(Object.is(map.get('k'), -0)).toBe(true); expect(ordered.get('k')).toBe(123);
      expect(objects.get('k')).toEqual({ value: 456 }); expect(Object.isFrozen(objects.get('k'))).toBe(true);
    }
  });
  test('worker format rejects older map layouts and attachments do not write shared bytes', async () => {
    let map: any = ownerMap(); for (let i = 0; i < 400; i++) map = map.set(`key${i}`, i);
    const data = getWorkerData({ map }, { copy: false }), a = arenaOf(map), before = a.buf.slice();
    expect(data.version).toBe(4);
    for (const version of [1, 2, 3]) await expect(initWorker({ ...data, version } as any)).rejects.toThrow(/Unsupported/);
    const read: any = (await initWorker(data)).map;
    for (let i = 0; i < 400; i++) { expect(read.has(`key${i}`)).toBe(true); expect(read.get(`key${i}`)).toBe(i); }
    expect(Buffer.compare(Buffer.from(before), Buffer.from(a.buf))).toBe(0);
  });
});
