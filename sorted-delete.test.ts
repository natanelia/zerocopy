import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedSortedMap } from './shared-sorted-map';
import { SharedSortedSet } from './shared-sorted-set';
import { SharedList } from './shared-list';
import { compact } from './compaction';

function numbers(count = 31, arena = new Arena()) {
  let map = new SharedSortedMap('number', undefined, 0, 0, arena);
  for (let i = 0; i < count; i++) map = map.set(`key${String(i).padStart(3, '0')}`, i);
  expect(arena.dv.getUint32(map.root, true)).not.toBe(0xffffffff);
  return map;
}
function payload(map: SharedSortedMap<any>) {
  const a = arenaOf(map); return a.buf.slice(HEAP_START, a.used);
}
function unchanged(map: SharedSortedMap<any>, before: Uint8Array) {
  expect(arenaOf(map).buf.slice(HEAP_START, HEAP_START + before.length)).toEqual(before);
}

describe('sorted deletion preserves retained roots and lookup effects', () => {
  it('keeps cold source no-op identity after deleting into a separate snapshot', () => {
    const base = numbers(), before = payload(base), a = arenaOf(base);
    expect((a as any).reads).toBeUndefined();
    const next = base.delete('key005');
    expect(next.size).toBe(30);
    expect(base.set('key005', 5)).toBe(base);
    expect(base.get('key005')).toBe(5);
    expect(next.get('key005')).toBeUndefined();
    expect([...next.keys()]).toEqual([...base.keys()].filter(key => key !== 'key005'));
    unchanged(base, before);
  });

  it('preserves exact-root cached values and cached missing-key identity', () => {
    const base = numbers(), a = arenaOf(base) as any;
    expect(base.get('key005')).toBe(5);
    const slot = a.reads.slot('key005'), oldCode = a.reads.code(slot);
    const next = base.delete('key005');
    expect(a.reads.root(slot)).toBe(base.root);
    expect(a.reads.code(slot)).toBe(oldCode);
    expect(a.reads.value(slot)).toBe(5);
    expect(next.get('key005')).toBeUndefined();
    expect(a.reads.root(slot)).toBe(next.root);
    expect(a.reads.leaf(slot)).toBe(0);
    const used = a.used;
    expect(next.delete('key005')).toBe(next);
    expect(a.used).toBe(used);
    expect(base.get('key005')).toBe(5);
  });

  it('updates stale slots to the source root and invalidates an older leaf value', () => {
    const base = numbers(), a = arenaOf(base) as any;
    expect(base.get('key005')).toBe(5);
    const slot = a.reads.slot('key005'), keyLeaf = a.reads.keyLeaf(slot);
    let branch = base.set('key005', 500);
    for (let i = 0; i < 4; i++) branch = branch.set(`branch${i}`, i);
    expect(a.dv.getUint32(branch.root, true)).not.toBe(0xffffffff);
    const next = branch.delete('key005');
    expect(a.reads.root(slot)).toBe(branch.root);
    expect(a.reads.keyLeaf(slot)).toBe(keyLeaf);
    expect(a.reads.leaf(slot)).not.toBe(keyLeaf);
    expect(a.reads.code(slot)).toBe(0);
    expect(branch.set('key005', 500)).toBe(branch);
    expect(next.get('key005')).toBeUndefined();
    expect(base.get('key005')).toBe(5);
  });

  it('handles Unicode aliases, prefix keys, empty keys, and tail-byte differences', () => {
    const input = ['', '\0', 'a', 'aa', 'ab', 'a\0', '\ufeff', 'é', '界', '🙂', '\ud800', '\udc00', '\ufffd', 'x\ud800y'];
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true }), encoder = new TextEncoder();
    let original = new SharedSortedMap('number');
    const model = new Map<string, number>();
    input.forEach((key, i) => { original = original.set(key, i); model.set(decoder.decode(encoder.encode(key)), i); });
    const base = compact(original), before = payload(base);
    for (const query of [...input, '\udfff', 'x\udfffy', 'absent']) {
      const normalized = decoder.decode(encoder.encode(query)), next = base.delete(query), expected = new Map(model);
      expected.delete(normalized);
      expect(next.size).toBe(expected.size);
      expect(new Map(next.entries())).toEqual(expected);
      if (!model.has(normalized)) expect(next).toBe(base);
      else expect(base.set(query, model.get(normalized)!)).toBe(base);
      unchanged(base, before);
    }
  });

  it.each([16383, 16384, 16385, 49152, 49153])('preserves long-key fallback at %i UTF-16 units', length => {
    for (const unit of ['a', '界', '\ud800']) {
      const key = unit.repeat(length), base = compact(new SharedSortedMap('string').set('', 'empty').set(key, 'kept').set('other', 'other'));
      const next = base.delete(key);
      expect(next.size).toBe(2);
      expect([...next.entries()]).toEqual([['', 'empty'], ['other', 'other']]);
      expect(base.get(key)).toBe('kept');
      expect(base.set(key, 'kept')).toBe(base);
    }
  });

  it('keeps journal hits, misses, base entries, and pending replacements independent', () => {
    const base = numbers();
    for (let count = 1; count <= 4; count++) {
      let journal = base.set('key005', 500);
      for (let i = 1; i < count; i++) journal = journal.set(`pending${i}`, i);
      expect(arenaOf(journal).dv.getUint32(journal.root, true)).toBe(0xffffffff);
      const before = payload(journal), expected = new Map(journal.entries());
      for (const query of ['key005', 'key010', `pending${count - 1}`, 'missing']) {
        const used = arenaOf(journal).used, next = journal.delete(query), wanted = new Map(expected);
        wanted.delete(query);
        expect(new Map(next.entries())).toEqual(wanted);
        expect(next.size).toBe(wanted.size);
        if (!expected.has(query)) { expect(next).toBe(journal); expect(arenaOf(journal).used).toBe(used); }
        else expect(journal.set(query, expected.get(query)!)).toBe(journal);
        unchanged(journal, before);
      }
    }
  });

  it('derives actual result size even when a public source supplied a wrong size', () => {
    const base = numbers(), source = new SharedSortedMap('number', undefined, base.root, 999, arenaOf(base));
    expect(source.size).toBe(999);
    expect(source.delete('key005').size).toBe(30);
    expect(source.delete('missing')).toBe(source);
    expect(source.size).toBe(999);
  });

  it.each([0, 64])('preserves lookup effects when canonical path allocation traps with %i bytes left', reserve => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const a = new Arena({ memory }), base = numbers(126, a), before = payload(base), mark = a.used;
    a.wasm.setHeapEnd(memory.buffer.byteLength - reserve);
    const start = a.used;
    try {
      expect(() => base.delete('key005')).toThrow(WebAssembly.RuntimeError);
      if (reserve) expect(a.used).toBeGreaterThan(start);
      else expect(a.used).toBe(start);
      const reads = (a as any).reads, slot = reads.slot('key005');
      expect(slot).not.toBeUndefined();
      expect(reads.root(slot)).toBe(base.root);
      expect(reads.leaf(slot)).not.toBe(0);
      expect(base.set('key005', 5)).toBe(base);
      unchanged(base, before);
    } finally { a.wasm.setHeapEnd(mark); }
    expect(base.delete('key006').size).toBe(125);
    expect(base.get('key005')).toBe(5);
    unchanged(base, before);
  });

  it('preserves a journal lookup if materialization traps before deletion starts', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const a = new Arena({ memory }), base = numbers(126, a).set('pending', 777), before = payload(base), mark = a.used;
    expect(a.dv.getUint32(base.root, true)).toBe(0xffffffff);
    a.wasm.setHeapEnd(memory.buffer.byteLength);
    try {
      expect(() => base.delete('key005')).toThrow(WebAssembly.RuntimeError);
      expect(base.set('key005', 5)).toBe(base);
      unchanged(base, before);
    } finally { a.wasm.setHeapEnd(mark); }
    expect(base.delete('pending').size).toBe(126);
  });

  it('does not allocate for a canonical miss even with a full arena', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const a = new Arena({ memory }), base = numbers(31, a), mark = a.used;
    a.wasm.setHeapEnd(memory.buffer.byteLength);
    try { expect(base.delete('absent')).toBe(base); expect(a.used).toBe(memory.buffer.byteLength); }
    finally { a.wasm.setHeapEnd(mark); }
  });

  it('reads the result through shared memory growth and keeps attached roots read-only', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
    const a = new Arena({ memory }), base = numbers(126, a), before = payload(base);
    const attached = SharedSortedMap.fromWorkerData(base.toWorkerData(), new Arena({ memory, used: a.used, readOnly: true }));
    const copied = SharedSortedMap.fromWorkerData(base.toWorkerData(), new Arena({ copy: a.copy(), used: a.used, readOnly: true }));
    const oldCapacity = memory.buffer.byteLength;
    a.wasm.setHeapEnd(oldCapacity - 8);
    const next = base.delete('key005');
    expect(memory.buffer.byteLength).toBeGreaterThan(oldCapacity);
    expect(next.size).toBe(125);
    for (const reader of [attached, copied]) {
      expect(reader.get('key005')).toBe(5);
      for (const key of ['key005', 'missing', 7 as any]) expect(() => reader.delete(key)).toThrow(/read-only/);
    }
    unchanged(base, before);
  });

  it('preserves payload kinds, pure comparators, sorted sets, and the old WASM deletion ABI', () => {
    const nested = new SharedList('number').pushMany([1, 2, 3]);
    for (const [type, first, second] of [['number', NaN, -0], ['boolean', false, true], ['string', '\ufeff🙂', 'text'], ['object', { rows: [1, 2] }, { rows: [3] }], ['SharedList<number>', nested, nested.push(4)]] as const) {
      const base = compact(new SharedSortedMap<any>(type).set('a', first).set('b', second).set('c', first));
      const next = base.delete('b');
      expect(next.size).toBe(2);
      if (type === 'SharedList<number>') expect(next.get('a').toArray()).toEqual([1, 2, 3]);
      else expect(next.get('a')).toEqual(first);
      expect([...next.keys()]).toEqual(['a', 'c']);
    }
    const compare = (a: string, b: string) => b.length - a.length;
    const custom = new SharedSortedMap('number', compare).set('aa', 1).set('bb', 2).set('c', 3);
    expect([...custom.delete('aa').keys()]).toEqual(['bb', 'c']);
    const set = new SharedSortedSet().add('x').add(1).add('1').add(NaN).add(-0);
    const smaller = set.delete(1);
    expect(smaller.has('1')).toBe(true); expect(smaller.has(1)).toBe(false);
    expect(smaller.has(NaN)).toBe(true); expect(smaller.has(0)).toBe(true);
    const base = numbers(), a = arenaOf(base), leaf = a.radixFind(base.root, 'key005');
    const root = a.wasm.radixDelete(base.root, leaf + 16, a.dv.getUint32(leaf + 8, true)) >>> 0;
    const direct = new SharedSortedMap('number', undefined, root, undefined, a);
    expect(direct.size).toBe(30); expect(direct.has('key005')).toBe(false); expect(base.get('key005')).toBe(5);
  });

  it('checks key types on empty writers and rejects even empty read-only deletes first', () => {
    const empty = new SharedSortedMap('number');
    expect(empty.delete('missing')).toBe(empty);
    expect(() => empty.delete(7 as any)).toThrow(TypeError);
    const readOnly = new SharedSortedMap('number', undefined, 0, 0, new Arena({ readOnly: true }));
    expect(() => readOnly.delete('missing')).toThrow(/read-only/);
    expect(() => readOnly.delete(7 as any)).toThrow(/read-only/);
  });
});
