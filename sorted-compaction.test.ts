import { expect, test } from 'vitest';
import { SharedMap, SharedSortedMap, compact, compactMany } from './shared';
import { Arena, HEAP_START, arenaOf, hashBytes, popcount } from './arena';

const encoder = new TextEncoder();
function byteOrder(a: string, b: string): number {
  const left = encoder.encode(a), right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
function numericMap(keys: string[]) {
  let map = new SharedSortedMap('number', undefined, 0, 0, new Arena());
  for (const [i, key] of keys.entries()) map = map.set(key, i);
  return map;
}
function payload(arena: Arena): Uint8Array { return arena.buf.slice(HEAP_START, arena.used); }
function unchanged(arena: Arena, before: Uint8Array): void {
  expect(arena.buf.slice(HEAP_START, HEAP_START + before.length)).toEqual(before);
}
function pointers(arena: Arena, leaves: number[]): number {
  const input = arena.alloc(leaves.length * 4);
  for (const [i, leaf] of leaves.entries()) arena.dv.setUint32(input + i * 4, leaf, true);
  return input;
}
function fixture(entries: [string, number][], repeated = false) {
  const arena = new Arena();
  const leaves = entries.map(([key, value]) => {
    const bytes = encoder.encode(key), leaf = arena.wasm.mapLeaf(bytes.length, 8) >>> 0;
    arena.dv.setUint32(leaf + 4, hashBytes(bytes), true);
    arena.buf.set(bytes, leaf + 16); arena.dv.setFloat64(leaf + 16 + bytes.length, value, true);
    return leaf;
  });
  if (repeated) leaves[1] = leaves[0];
  return { arena, leaves, input: pointers(arena, leaves) };
}

test('compaction preserves UTF-8 byte order, prefixes and pending overrides', () => {
  for (const keys of [[], ['one']]) {
    const source = numericMap(keys), before = payload(arenaOf(source)), copy = compact(source);
    expect([...copy.entries()]).toEqual([...source.entries()]); unchanged(arenaOf(source), before);
    if (!keys.length) expect(copy.root).toBe(0);
    else expect(arenaOf(copy).dv.getUint32(copy.root, true)).toBe(0);
  }
  // The astral/BMP pair has opposite UTF-16 and UTF-8 relative order.
  const keys = ['\u{10000}', '\uE000', 'ab', 'aa', 'a', '\0a', '\0', ''];
  let source = numericMap(keys);
  source = source.set('aa', 99);
  expect(arenaOf(source).dv.getUint32(source.root, true)).toBe(0xffffffff);
  const before = payload(arenaOf(source)), expected = [...new Map(keys.map((key, i): [string, number] => [key, key === 'aa' ? 99 : i]))].sort((a, b) => byteOrder(a[0], b[0]));
  const copy = compact(source);
  expect([...copy.entries()]).toEqual(expected);
  for (const [key, value] of expected) { expect(copy.get(key)).toBe(value); expect(copy.has(key)).toBe(true); }
  unchanged(arenaOf(source), before);
  let calls = 0;
  const comparator = (a: string, b: string) => { calls++; return byteOrder(b, a); };
  const custom = new SharedSortedMap('number', comparator, source.root, source.size, arenaOf(source));
  const customCopy = compact(custom); expect(calls).toBe(0);
  expect([...customCopy.entries()]).toEqual([...expected].reverse()); expect(calls).toBeGreaterThan(0);
});

test('duplicate and descending traversal retain the arbitrary-input builder behavior', () => {
  const cases: { entries: [string, number][]; repeated?: boolean }[] = [
    { entries: [['b', 1], ['a', 2], ['b', 3]] },
    { entries: [['a', 1], ['a', 2]] },
    { entries: [['a', 1], ['a', 1]], repeated: true },
  ];
  for (const { entries, repeated } of cases) {
    const checked = fixture(entries, repeated), legacy = fixture(entries, repeated), before = payload(checked.arena);
    const root = checked.arena.wasm.radixBuildSorted(checked.input, entries.length) >>> 0;
    const oldRoot = legacy.arena.wasm.radixBuild(legacy.input, entries.length) >>> 0;
    expect(root).toBe(oldRoot); expect(checked.arena.used).toBe(legacy.arena.used);
    expect(payload(checked.arena)).toEqual(payload(legacy.arena)); unchanged(checked.arena, before);
    const source = new SharedSortedMap('number', undefined, root, 100, checked.arena), sourceBytes = payload(checked.arena);
    const originalTraversal = checked.arena.radixLeaves; let calls = 0;
    checked.arena.radixLeaves = function*(inputRoot: number) { calls++; expect(inputRoot).toBe(root); yield* checked.leaves; };
    try {
      const copy = compact(source);
      expect(calls).toBe(1); expect(copy.size).toBe(entries.length);
      for (const [key, value] of new Map(entries)) expect(copy.get(key)).toBe(value);
      unchanged(checked.arena, sourceBytes);
    } finally { checked.arena.radixLeaves = originalTraversal; }
  }
});

test('completed branches have descendant sizes and greatest-key representatives', () => {
  const copy = compact(numericMap(['bc', 'aa', 'bb', 'ac', 'ba', 'ab'])), arena = arenaOf(copy), pending = [copy.root];
  let branches = 0;
  while (pending.length) {
    const root = pending.pop()!;
    if (!arena.dv.getUint32(root, true)) continue;
    branches++;
    const descendants = [...arena.radixLeaves(root)], greatest = descendants.reduce((a, b) => byteOrder(arena.leafKey(a), arena.leafKey(b)) > 0 ? a : b);
    expect(arena.wasm.radixSize(root)).toBe(descendants.length);
    expect(arena.dv.getUint32(root + 12, true)).toBe(greatest);
    const degree = popcount(arena.dv.getUint32(root + 4, true)); expect(degree).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < degree; i++) pending.push(arena.dv.getUint32(root + 16 + i * 4, true));
  }
  expect(branches).toBe(3);
  const wide = compact(numericMap(Array.from({ length: 16 }, (_, i) => String.fromCharCode(32 + i)))), wideArena = arenaOf(wide);
  expect(popcount(wideArena.dv.getUint32(wide.root + 4, true))).toBe(16);
  // Sixteen 28-byte number leaves and the retained 64-byte pointer input.
  expect(wideArena.used - HEAP_START - 16 * 28 - 16 * 4).toBe(80);
});

test('group compaction retains source bytes and descriptor and leaf sharing', () => {
  const source = numericMap(['a', 'b', 'c', 'd', 'e', 'f']), arena = arenaOf(source), leaves = [...arena.radixLeaves(source.root)];
  const alternateRoot = arena.wasm.radixBuild(pointers(arena, leaves), leaves.length) >>> 0;
  const alternate = new SharedSortedMap('number', undefined, alternateRoot, source.size, arena);
  const singleton = new SharedSortedMap('number', undefined, leaves[0], 1, arena);
  const outer = new SharedMap('SharedSortedMap<number>').set('child', source), before = payload(arena), outerBefore = payload(arenaOf(outer));
  const group = compactMany({ source, again: source, alternate, singleton, outer });
  expect(group.source).toBe(group.again); expect(group.source.root).not.toBe(group.alternate.root);
  const target = arenaOf(group.source), copiedLeaves = [...target.radixLeaves(group.source.root)];
  expect([...target.radixLeaves(group.alternate.root)]).toEqual(copiedLeaves);
  expect(group.singleton.root).toBe(copiedLeaves[0]);
  expect(group.outer.get('child')!.toWorkerData()).toEqual(group.source.toWorkerData());
  const targetBefore = payload(target);
  let collapsed = group.source;
  for (const key of ['b', 'c', 'd', 'e', 'f']) collapsed = collapsed.delete(key);
  expect(collapsed.root).toBe(group.singleton.root);
  const fork = group.source.set('new', 7); expect(fork.get('new')).toBe(7); expect(group.source.has('new')).toBe(false);
  // Refresh the retained source's cache slot after all intervening lookups.
  expect(group.source.get('a')).toBe(0); expect(group.source.set('a', 0)).toBe(group.source);
  expect(source.get('a')).toBe(0); expect(source.set('a', 0)).toBe(source);
  unchanged(target, targetBefore); unchanged(arena, before); unchanged(arenaOf(outer), outerBefore);
});
