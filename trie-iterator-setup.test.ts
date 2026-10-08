import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, hashBytes, HEAP_START, popcount } from './arena';
import { SharedMap, SharedSet, getWorkerData, initWorker } from './shared';

function mapOf(size: number) {
  return new SharedMap('number', 0, 0, new Arena()).setMany(
    Array.from({ length: size }, (_, i) => [`key${i}`, i] as const));
}
function childAt(a: Arena, p: number, digit: number): number {
  const dv = a.dv;
  while (dv.getUint32(p, true) & 0x80000000) {
    const tag = dv.getUint32(p, true);
    if ((dv.getUint32(p + 4, true) & 15) === digit) {
      const distance = (tag >>> 14) & 127;
      return distance ? p - distance * 4 : 0;
    }
    p -= (tag & 16383) * 4;
  }
  const bits = dv.getUint32(p + 4, true), bit = 1 << digit;
  return bits & bit ? dv.getUint32(p + 8 + popcount(bits & (bit - 1)) * 4, true) : 0;
}
// Independent recursive reader resolves each child from newest edit to oldest.
// It deliberately does not copy leaves()'s reverse patch replay or mutable lanes.
function reference(a: Arena, root: number): number[] {
  if (!root) return [];
  const dv = a.dv, tag = dv.getUint32(root, true);
  if (!tag) return [root];
  if (tag === 0xffffffff) {
    const edits = Array.from({ length: dv.getUint32(root + 12, true) }, (_, i) => dv.getUint32(root + 16 + i * 4, true));
    const keys = new Set(edits.map(p => a.leafKey(p)));
    return edits.concat(reference(a, dv.getUint32(root + 4, true)).filter(p => !keys.has(a.leafKey(p))));
  }
  if (tag === 2) return Array.from({ length: dv.getUint32(root + 8, true) }, (_, i) => dv.getUint32(root + 16 + i * 4, true));
  const bits = tag & 0x80000000 ? dv.getUint32(root + 8, true) >>> 16 : dv.getUint32(root + 4, true);
  const result: number[] = [];
  for (let d = 0; d < 16; d++) if (bits & (1 << d)) result.push(...reference(a, childAt(a, root, d)));
  return result;
}
function patchedNodeCount(a: Arena, root: number): number {
  if (!root) return 0;
  const dv = a.dv, tag = dv.getUint32(root, true);
  if (!tag || tag === 2) return 0;
  if (tag === 0xffffffff) return patchedNodeCount(a, dv.getUint32(root + 4, true));
  const patched = !!(tag & 0x80000000);
  const bits = patched ? dv.getUint32(root + 8, true) >>> 16 : dv.getUint32(root + 4, true);
  let count = Number(patched);
  for (let d = 0; d < 16; d++) if (bits & (1 << d)) count += patchedNodeCount(a, childAt(a, root, d));
  return count;
}
function countScratch(run: () => void): number {
  const Original = globalThis.Uint32Array;
  let count = 0;
  globalThis.Uint32Array = new Proxy(Original, {
    construct(target, args, newTarget) {
      if (args.length === 1 && args[0] === 16) count++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try { run(); } finally { globalThis.Uint32Array = Original; }
  return count;
}
function journal(a: Arena, base: number, edits: readonly (readonly [string, number])[]): number {
  const leaves = edits.map(([k, v]) => a.leaf('number', k, v));
  const root = a.alloc(16 + 4 * leaves.length), dv = a.dv;
  dv.setUint32(root, 0xffffffff, true); dv.setUint32(root + 4, base, true);
  const keys = new Set(reference(a, base).map(p => a.leafKey(p)));
  for (const [key] of edits) keys.add(key);
  dv.setUint32(root + 8, keys.size, true); dv.setUint32(root + 12, leaves.length, true);
  leaves.forEach((p, i) => dv.setUint32(root + 16 + 4 * i, p, true));
  return root;
}

describe('HAMT iterator-owned scratch with trivial-root fast exits', () => {
  it('retains the native generator method and iterator prototype ownership', () => {
    const method = Arena.prototype.leaves, descriptor = Object.getOwnPropertyDescriptor(Arena.prototype, 'leaves')!;
    assert.equal(Object.getPrototypeOf(method).constructor.name, 'GeneratorFunction');
    assert.equal(Object.hasOwn(method, 'prototype'), true);
    assert.equal(descriptor.enumerable, false); assert.equal(descriptor.configurable, true); assert.equal(descriptor.writable, true);
    const iterator = new Arena().leaves(0);
    assert.equal(Object.getPrototypeOf(iterator), method.prototype);
    assert.equal(iterator[Symbol.iterator](), iterator);
    assert.equal(Object.getPrototypeOf(method.prototype), Object.getPrototypeOf(function* () {}.prototype));
  });

  it('keeps generator creation and early return lazy, including empty roots', () => {
    for (const size of [0, 1, 128]) {
      const map = mapOf(size), a = arenaOf(map);
      const getter = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
      let reads = 0;
      Object.defineProperty(a, 'dv', { configurable: true, get() { reads++; return getter.call(this); } });
      assert.equal(countScratch(() => { const iterator = a.leaves(map.root); assert.equal(reads, 0); iterator.return(undefined); }), 0);
      assert.equal(reads, 0);
      delete (a as any).dv;
    }
    const a = new Arena();
    Object.defineProperty(a, 'dv', { get() { throw new Error('empty iterator accessed memory'); } });
    assert.deepEqual(a.leaves(0).next(), { value: undefined, done: true });
  });

  it('skips lanes only for empty and leaf roots, retaining canonical and collision scratch', () => {
    const collision = new SharedMap('number', 0, 0, new Arena()).setMany([['costarring', 1], ['liquid', 2]]);
    assert.equal(arenaOf(collision).dv.getUint32(collision.root, true), 2);
    for (const map of [mapOf(0), mapOf(1), mapOf(2), mapOf(32), mapOf(4096), collision]) {
      const a = arenaOf(map), expected = reference(a, map.root);
      assert.equal(patchedNodeCount(a, map.root), 0);
      assert.equal(countScratch(() => assert.deepEqual([...a.leaves(map.root)], expected)), Number(map.size > 1));
    }
  });

  it('allocates exactly one lane buffer per iterator across many patch branches', () => {
    let map = mapOf(512);
    for (let i = 0; i < 47; i++) map = map.set(`key${i * 7}`, -i - 1);
    const a = arenaOf(map), expected = reference(a, map.root);
    assert.ok(patchedNodeCount(a, map.root) > 1);
    assert.equal(countScratch(() => assert.deepEqual([...a.leaves(map.root)], expected)), 1);
    assert.equal(countScratch(() => {
      const first = a.leaves(map.root), second = a.leaves(map.root);
      const x: number[] = [], y: number[] = [];
      for (let p = first.next(), q = second.next(); !p.done || !q.done; p = first.next(), q = second.next()) {
        if (!p.done) x.push(p.value); if (!q.done) y.push(q.value);
      }
      assert.deepEqual(x, expected); assert.deepEqual(y, expected);
    }), 2);
  });

  it('keeps independent eager scratch when stopping before a later patched subtree', () => {
    let map = mapOf(256);
    const key = [...map.keys()].find(k => (hashBytes(new TextEncoder().encode(k)) & 15) === 15)!;
    map = map.set(key, -1);
    const a = arenaOf(map), old = map.root, bits = a.dv.getUint32(old + 8, true) >>> 16;
    assert.ok(a.dv.getUint32(old, true) & 0x80000000);
    const children = Array.from({ length: 16 }, (_, d) => bits & (1 << d) ? childAt(a, old, d) : 0).filter(Boolean);
    // Materialize only the top node, retaining the existing valid subtree pointers.
    const root = a.alloc(8 + children.length * 4), dv = a.dv;
    dv.setUint32(root, (map.size << 2) | 1, true); dv.setUint32(root + 4, bits, true);
    children.forEach((p, i) => dv.setUint32(root + 8 + i * 4, p, true));
    assert.ok(patchedNodeCount(a, root) > 0);
    const expected = reference(a, root);
    assert.equal(countScratch(() => { const iterator = a.leaves(root); assert.equal(iterator.next().value, expected[0]); iterator.return(undefined); }), 1);
    assert.equal(countScratch(() => assert.deepEqual([...a.leaves(root)], expected)), 1);
  });

  it('preserves journal precedence over empty, leaf, collision, and patched bases', () => {
    for (const base of [mapOf(0), mapOf(1), mapOf(64).set('key3', -3), new SharedMap('number', 0, 0, new Arena()).setMany([['costarring', 1], ['liquid', 2]])]) {
      const a = arenaOf(base), root = journal(a, base.root, [['costarring', 3], ['new', 4], ['key0', 5]]);
      assert.deepEqual([...a.leaves(root)], reference(a, root));
      const values = new Map([...a.leaves(root)].map(p => [a.leafKey(p), a.leafValue('number', p)]));
      assert.equal(values.get('costarring'), 3); assert.equal(values.get('new'), 4); assert.equal(values.get('key0'), 5);
      if (base.has('liquid')) assert.equal(values.get('liquid'), 2);
      assert.equal(values.size, base.size + ['costarring', 'new', 'key0'].filter(k => !base.has(k)).length);
    }
  });

  it('keeps forked edits, deletions, collision buckets, and reinsertions independent', () => {
    const base = mapOf(256).setMany([['costarring', 1], ['liquid', 2]]);
    const left = base.set('costarring', 11).delete('key0').set('left', 3);
    const right = base.set('liquid', 22).delete('costarring').set('costarring', 33).delete('key7');
    const a = arenaOf(base), saved = a.buf.slice(HEAP_START, a.used);
    const models = [base, left, right].map(map => reference(a, map.root));
    const iterators = [base, left, right].map(map => a.leaves(map.root));
    const actual: number[][] = [[], [], []];
    for (let pending = true; pending;) {
      pending = false;
      iterators.forEach((iterator, i) => { const p = iterator.next(); if (!p.done) { pending = true; actual[i].push(p.value); } });
    }
    assert.deepEqual(actual, models);
    assert.equal(base.get('costarring'), 1); assert.equal(left.get('costarring'), 11); assert.equal(right.get('costarring'), 33);
    assert.deepEqual(a.buf.subarray(HEAP_START, HEAP_START + saved.length), saved);
  });

  it('resumes paused iterators after writer memory growth and callback reentry', () => {
    const base = mapOf(512), changed = base.set('key17', -17).delete('key3'), a = arenaOf(base);
    const expected = [base, changed].map(map => [...map.entries()]);
    const iterators = [base, changed].map(map => map.entries());
    const first = iterators.map(it => it.next().value);
    const oldBuffer = a.memory.buffer;
    new SharedMap('string', 0, 0, a).set('grow', 'x'.repeat(oldBuffer.byteLength * 2));
    assert.notEqual(a.memory.buffer, oldBuffer);
    iterators.forEach((iterator, i) => assert.deepEqual([first[i], ...iterator], expected[i]));
    const visited: [string, number][] = [];
    changed.forEach((value, key) => { assert.deepEqual([...base.entries()], expected[0]); visited.push([key, value]); });
    assert.deepEqual(visited, expected[1]);
  });

  it('supports close, throw, nested loops, and fresh iterations after early termination', () => {
    const map = mapOf(128).set('key0', -1), expected = [...map.entries()];
    const first = map.entries(); first.next(); assert.equal(first.return(undefined).done, true); assert.equal(first.next().done, true);
    const second = map.entries(); second.next(); const error = new Error('stop'); assert.throws(() => second.throw(error), e => e === error);
    assert.equal(second.next().done, true);
    for (const outer of map.entries()) { for (const inner of map.entries()) { assert.deepEqual(inner, expected[0]); break; } assert.deepEqual(outer, expected[0]); break; }
    assert.deepEqual([...map.entries()], expected);
  });

  for (const copy of [false, true]) it(`preserves read-only ${copy ? 'copied' : 'shared'} attachments, nested values, and sets`, async () => {
    const map = mapOf(128).set('key4', -4), nested = new SharedMap('SharedMap<number>').set('child', map);
    let set = new SharedSet(); for (const x of [1, '1', 0, -1, NaN, Infinity, '', '🙂']) set = set.add(x);
    const a = arenaOf(map), before = a.buf.slice(HEAP_START, a.used);
    const attached = await initWorker<{ map: typeof map; nested: typeof nested; set: typeof set }>(getWorkerData({ map, nested, set }, { copy }));
    assert.deepEqual([...attached.map.entries()], [...map.entries()]);
    assert.deepEqual([...attached.nested.get('child')!.entries()], [...map.entries()]);
    assert.deepEqual([...attached.set.values()], [...set.values()]);
    assert.throws(() => attached.map.set('key4', 4), /read-only/);
    assert.deepEqual(a.buf.subarray(HEAP_START, HEAP_START + before.length), before);
  });
});
