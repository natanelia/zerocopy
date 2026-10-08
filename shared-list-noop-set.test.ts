import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, SharedMap, compact, compactMany, getWorkerData, initWorker } from './shared';
import { createSharedState } from './worker';
import { serializeZerocopyState, deserializeZerocopyState } from './redux-checkpoint';

const positions = (size: number) => [...new Set([0, 31, 32, 1023, 1024, size - 1].filter(i => i < size))];
const payload = (a: Arena) => a.buf.slice(HEAP_START, a.used);
function samePayload(a: Arena, before: Uint8Array) {
  assert.deepEqual(a.buf.slice(HEAP_START, HEAP_START + before.length), before);
}
function address(list: SharedList<any>, index: number): number {
  const start = (list.size - 1) & ~31;
  return (index >= start ? list.tail : arenaOf(list).wasm.vecLeaf(list.root, list.depth, index) >>> 0) + (index & 31) * 8;
}
function bits(list: SharedList<any>, index: number): bigint {
  return arenaOf(list).dv.getBigUint64(address(list, index), true);
}
function fromBits(value: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, value, true); return view.getFloat64(0, true);
}
// Test-only WASM adapter: (i32, i32, i32, i64) -> imported set(i32, i32, i32,
// f64.reinterpret_i64). Passing raw bits directly between WASM functions avoids
// engines such as Bun canonicalizing a NaN when it becomes a JavaScript Number.
// (module (import "env" "set" (func $set (param i32 i32 i32 f64) (result i32)))
//   (func (export "set") (param i32 i32 i32 i64) (result i32)
//     local.get 0 local.get 1 local.get 2 local.get 3 f64.reinterpret_i64 call $set))
const bitArgumentModule = new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 17, 2, 96, 4, 127, 127, 127, 124, 1, 127, 96, 4, 127, 127, 127, 126, 1, 127,
  2, 11, 1, 3, 101, 110, 118, 3, 115, 101, 116, 0, 0,
  3, 2, 1, 1, 7, 7, 1, 3, 115, 101, 116, 0, 1,
  10, 15, 1, 13, 0, 32, 0, 32, 1, 32, 2, 32, 3, 191, 16, 0, 11,
]));
function changedBytes(list: SharedList<any>, index: number): number {
  const start = (list.size - 1) & ~31;
  return index >= start ? (list.size - start) * 8 : 256 + list.depth * 128;
}
const isTree = (list: SharedList<any>, index: number) => index < ((list.size - 1) & ~31);
function sameDescriptor(next: SharedList<any>, source: SharedList<any>, index: number) {
  if (isTree(source, index)) assert.deepEqual(next.toWorkerData(), source.toWorkerData());
  else {
    assert.notDeepEqual(next.toWorkerData(), source.toWorkerData());
    assert.equal(next.root, source.root);
    assert.notEqual(next.tail, source.tail);
  }
}

describe('bit-identical tree updates reuse storage; tail writes retain baseline allocation', () => {
  for (const size of [1, 31, 32, 33, 64, 65, 1024, 1025, 1057, 32769, 32801]) {
    for (const type of ['number', 'boolean', 'string'] as const) {
      test(`${type}: exact no-op allocation and changed-write cost at ${size}`, () => {
        const a = new Arena();
        const values: any[] = Array.from({ length: size }, (_, i) => type === 'number' ? i : type === 'boolean' ? !!(i & 1) : `value-${i & 7}`);
        const source = new SharedList(type, 0, 0, 0, a).pushMany(values);
        const before = payload(a);
        for (const index of positions(size)) {
          const used = a.used;
          const next = source.set(index, values[index]);
          assert.notEqual(next, source, 'valid set keeps allocating a distinct public snapshot');
          sameDescriptor(next, source, index);
          assert.equal(Object.isFrozen(next), true);
          assert.equal(a.used - used, isTree(source, index) ? 0 : changedBytes(source, index));
          assert.deepEqual(next.get(index), source.get(index));
        }
        samePayload(a, before);
        for (const index of positions(size)) {
          const replacement: any = type === 'number' ? -index - 1 : type === 'boolean' ? !values[index] : `value-${(index + 1) & 7}`;
          // One-element string lists have not interned the replacement yet.
          if (type === 'string') a.encode(type, replacement);
          const mark = a.used, next = source.set(index, replacement);
          assert.equal(a.used - mark, changedBytes(source, index));
          assert.deepEqual(next.get(index), replacement);
          assert.deepEqual(source.get(index), values[index]);
          assert.equal(next.size, source.size);
          samePayload(a, before);
          const after = a.used;
          const repeated = next.set(index, replacement);
          assert.equal(a.used - after, isTree(next, index) ? 0 : changedBytes(next, index));
          sameDescriptor(repeated, next, index);
        }
        assert.deepEqual(source.toArray(), values);
      });
    }
  }

  for (const index of [0, 64]) test(`public special-number writes preserve the engine boundary at ${index}`, () => {
    const a = new Arena(), probe = new Arena();
    let list = new SharedList('number', 0, 0, 0, a).pushMany(Array(65).fill(0));
    const encodings = [0n, 0x8000000000000000n, 0x7ff8000000000001n, 0x7ff8000000000002n,
      0xfff8000000000001n, 0x7ff0000000000000n, 0xfff0000000000000n, 1n, 0x8000000000000001n];
    const retained: { list: SharedList<'number'>; bits: bigint }[] = [];
    for (const encoding of encodings) {
      const before = payload(a), mark = a.used, oldBits = bits(list, index), value = fromBits(encoding);
      // cons is an unchanged WASM f64 store, providing the same host Number boundary.
      const written = probe.wasm.cons(0, value) >>> 0, expectedBits = probe.dv.getBigUint64(written + 8, true);
      retained.push({ list, bits: oldBits });
      const next = list.set(index, value);
      assert.equal(bits(next, index), expectedBits);
      assert.equal(a.used - mark, isTree(list, index) && expectedBits === oldBits ? 0 : changedBytes(list, index));
      samePayload(a, before);
      const repeatedMark = a.used;
      list = next.set(index, value);
      assert.equal(a.used - repeatedMark, isTree(next, index) ? 0 : changedBytes(next, index));
      assert.equal(bits(list, index), expectedBits);
      assert.notEqual(list, next);
    }
    for (const old of retained) assert.equal(bits(old.list, index), old.bits);
  });

  for (const index of [0, 64]) test(`WASM raw-bit updates preserve all NaN and zero representations at ${index}`, () => {
    const a = new Arena();
    let list = new SharedList('number', 0, 0, 0, a).pushMany(Array(65).fill(0));
    const setBits = new WebAssembly.Instance(bitArgumentModule, { env: { set: index === 64 ? a.wasm.tailSet : a.wasm.vecSet } }).exports.set as
      (root: number, depthOrLength: number, index: number, bits: bigint) => number;
    const encodings = [0n, 0x8000000000000000n, 0x7ff8000000000001n, 0x7ff8000000000002n,
      0xfff8000000000001n, 0x7ff0000000000001n, 0xfff0000000000001n, 1n];
    for (const encoding of encodings) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const before = payload(a), mark = a.used, oldBits = bits(list, index);
        const pointer = index === 64 ? setBits(list.tail, 1, 0, encoding) >>> 0 : setBits(list.root, list.depth, index, encoding) >>> 0;
        const next = new SharedList('number', index === 64 ? list.root : pointer, list.depth, list.size, a, index === 64 ? pointer : list.tail);
        assert.equal(bits(next, index), encoding);
        assert.equal(a.used - mark, isTree(list, index) && encoding === oldBits ? 0 : changedBytes(list, index));
        if (encoding === oldBits) sameDescriptor(next, list, index);
        assert.equal(bits(list, index), oldBits);
        samePayload(a, before);
        list = next;
      }
    }
  });

  test('missing WASM vector nodes are still materialized, including zero values', () => {
    const a = new Arena();
    for (const depth of [0, 1, 2, 3]) for (const value of [0, -0, 19, NaN]) {
      const index = depth ? 32 ** depth : 0, mark = a.used;
      const root = a.wasm.vecSet(0, depth, index, value) >>> 0;
      assert.notEqual(root, 0);
      assert.equal(a.used - mark, 256 + depth * 128);
      assert.equal(Object.is(a.wasm.vecGet(root, depth, index), value), true);
      const after = a.used;
      assert.equal(a.wasm.vecSet(root, depth, index, value) >>> 0, root);
      assert.equal(a.used, after);
      // A missing sibling cannot be represented by an unchanged null child.
      if (depth) {
        const sibling = a.wasm.vecSet(root, depth, 0, 0) >>> 0;
        assert.notEqual(sibling, root);
        assert.notEqual(a.wasm.vecLeaf(sibling, depth, 0) >>> 0, 0);
        assert.equal(a.wasm.vecGet(root, depth, index), value);
      }
    }
  });

  test('frontier append, forks, pop and pushMany preserve a freshly copied identical tail', () => {
    const a = new Arena(), source = new SharedList('number', 0, 0, 0, a).pushMany([10, 20, 30]);
    const initial = a.used, same = source.set(1, 20), before = payload(a), mark = a.used;
    assert.equal(mark - initial, 24); sameDescriptor(same, source, 1);
    const left = same.push(40);
    assert.equal(a.used - mark, 8);
    const right = source.push(50), overwritten = same.set(1, 99), popped = same.pop().push(60);
    const bulk = same.pushMany(Array.from({ length: 64 }, (_, i) => i));
    assert.deepEqual(source.toArray(), [10, 20, 30]);
    assert.deepEqual(same.toArray(), [10, 20, 30]);
    assert.deepEqual(left.toArray(), [10, 20, 30, 40]);
    assert.deepEqual(right.toArray(), [10, 20, 30, 50]);
    assert.deepEqual(overwritten.toArray(), [10, 99, 30]);
    assert.deepEqual(popped.toArray(), [10, 20, 60]);
    assert.deepEqual(bulk.toArray(), [10, 20, 30, ...Array.from({ length: 64 }, (_, i) => i)]);
    samePayload(a, before);
  });

  for (const remaining of [128, 256, 384]) test(`changed tree growth with ${remaining} bytes free retains cached views`, () => {
    const a = new Arena(), source = new SharedList('number', 0, 0, 0, a).pushMany(Array.from({ length: 1057 }, (_, i) => i));
    assert.equal(source.get(0), 0); // Capture the old shared view.
    const before = payload(a), oldBuffer = a.memory.buffer;
    a.alloc(oldBuffer.byteLength - a.used - remaining);
    const next = source.set(1023, -1023);
    assert.ok(a.memory.buffer.byteLength > oldBuffer.byteLength);
    assert.equal(source.get(1023), 1023);
    assert.equal(next.get(1023), -1023);
    assert.equal(source.get(1056), 1056);
    samePayload(a, before);
    const mark = a.used;
    assert.equal(next.set(1023, -1023).root, next.root);
    assert.equal(a.used, mark);
    assert.deepEqual(compact(next).toArray(), next.toArray());
  });

  test('tree no-ops skip alignment padding; identical tails retain aligned allocation', () => {
    for (const index of [0, 64]) {
      const a = new Arena(), source = new SharedList('number', 0, 0, 0, a).pushMany(Array.from({ length: 65 }, (_, i) => i));
      const map = new SharedMap('number', 0, 0, a).set('a', 1);
      assert.equal(a.used % 8, 4);
      const before = payload(a), mark = a.used;
      const next = source.set(index, index);
      assert.equal(a.used - mark, isTree(source, index) ? 0 : changedBytes(source, index) + 4);
      sameDescriptor(next, source, index);
      const changedMark = a.used;
      const changed = next.set(index, -index - 1);
      assert.equal(a.used - changedMark, changedBytes(source, index) + (isTree(source, index) ? 4 : 0));
      assert.equal(changed.get(index), -index - 1);
      assert.equal(map.get('a'), 1);
      samePayload(a, before);
    }
  });

  test('full arenas allow identical tree writes and reject identical tail allocation', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }), a = new Arena({ memory });
    const source = new SharedList('number', 0, 0, 0, a).pushMany(Array.from({ length: 65 }, (_, i) => i));
    a.alloc(memory.buffer.byteLength - a.used);
    const before = payload(a), mark = a.used;
    for (const index of [0, 64]) {
      if (isTree(source, index)) {
        const same = source.set(index, index);
        assert.notEqual(same, source); assert.equal(Object.isFrozen(same), true);
        assert.deepEqual(same.toWorkerData(), source.toWorkerData());
      } else assert.throws(() => source.set(index, index), WebAssembly.RuntimeError);
      assert.equal(a.used, mark);
      assert.throws(() => source.set(index, -index - 1), WebAssembly.RuntimeError);
      assert.equal(a.used, mark);
      assert.equal(source.get(index), index);
    }
    samePayload(a, before);
  });

  test('valid indices still validate type; invalid indices keep exact no-op behavior', () => {
    for (const [type, value, invalid] of [['number', 1, '1'], ['boolean', true, 1], ['string', '1', 1]] as const) {
      const a = new Arena(), list = new SharedList(type, 0, 0, 0, a).push(value as never), mark = a.used;
      assert.throws(() => list.set(0, invalid as never), TypeError);
      assert.equal(a.used, mark);
      for (const index of [-1, 1, 0.5, NaN, Infinity, 2 ** 32, '0', undefined]) {
        assert.equal(list.set(index as number, invalid as never), list);
        assert.equal(a.used, mark);
      }
    }
  });

  for (const copy of [false, true]) test(`attached no-op updates remain read-only (${copy ? 'copy' : 'shared'})`, async () => {
    const list = new SharedList('number', 0, 0, 0, new Arena()).pushMany(Array.from({ length: 65 }, (_, i) => i));
    const { list: read } = await initWorker(getWorkerData({ list }, { copy }));
    const a = arenaOf(read), before = payload(a), mark = a.used;
    for (const index of [0, 64]) {
      assert.throws(() => read.set(index, index), /read-only/);
      assert.throws(() => read.set(index, 'wrong' as never), /read-only/);
    }
    assert.equal(read.set(-1, 1), read);
    assert.equal(a.used, mark); samePayload(a, before);
  });

  test('uninterned equal strings retain encoding behavior after the intern table fills', () => {
    const a = new Arena();
    const list = new SharedList('string', 0, 0, 0, a).pushMany(Array.from({ length: 2050 }, (_, i) => `unique-${i}`));
    for (const index of [0, 2048, 2049]) {
      const mark = a.used, oldRaw = bits(list, index), value = list.get(index)!;
      const next = list.set(index, value);
      assert.equal(next.get(index), value);
      if (index === 0) { assert.equal(a.used, mark); assert.equal(bits(next, index), oldRaw); }
      else { assert.ok(a.used - mark > changedBytes(list, index)); assert.notEqual(bits(next, index), oldRaw); }
    }
  });

  test('equal JSON and nested snapshots still encode new records', () => {
    const a = new Arena(), value = { x: [1, 2] }, list = new SharedList('object', 0, 0, 0, a).push(value);
    const mark = a.used, next = list.set(0, value);
    assert.ok(a.used - mark > 8);
    assert.notEqual(bits(next, 0), bits(list, 0));
    assert.deepEqual(next.get(0), value);
    assert.equal(Object.isFrozen((next.get(0) as any).x), true);
    const child = new SharedList('number', 0, 0, 0, new Arena()).push(7);
    const nested = new SharedList('SharedList<number>', 0, 0, 0, a).push(child);
    const after = a.used, changed = nested.set(0, child);
    assert.ok(a.used - after > 8);
    assert.notEqual(bits(changed, 0), bits(nested, 0));
    assert.deepEqual(changed.get(0)!.toArray(), [7]);
    assert.equal(a.dependencies.get(arenaOf(child).id), arenaOf(child));
  });

  test('reentrant serialization completes before deciding any storage reuse', () => {
    const a = new Arena(), numbers = new SharedList('number', 0, 0, 0, a).pushMany(Array.from({ length: 65 }, (_, i) => i));
    const object = new SharedList('object', 0, 0, 0, a).push({ n: 1 });
    let calls = 0, fork: SharedList<'number'>;
    const next = object.set(0, { toJSON() {
      calls++;
      assert.equal(numbers.set(0, 0).root, numbers.root);
      fork = numbers.set(32, -32);
      a.alloc(a.memory.buffer.byteLength);
      return { n: 2 };
    } });
    assert.equal(calls, 1);
    assert.equal(numbers.get(32), 32); assert.equal(fork!.get(32), -32);
    assert.deepEqual(object.get(0), { n: 1 }); assert.deepEqual(next.get(0), { n: 2 });
  });

  test('descriptor-based compaction and checkpoints coalesce storage-identical handles', () => {
    const source = new SharedList('number', 0, 0, 0, new Arena()).pushMany(Array.from({ length: 65 }, (_, i) => i));
    const same = source.set(0, 0), sameTail = source.set(64, 64);
    assert.notEqual(source, same);
    const group = compactMany({ source, same, sameTail });
    assert.equal(group.source, group.same);
    assert.notEqual(group.source, group.sameTail);
    assert.notEqual(group.source, source);
    const restored = deserializeZerocopyState<typeof group>(serializeZerocopyState({ source, same, sameTail }));
    assert.equal(restored.source, restored.same);
    assert.notEqual(restored.source, restored.sameTail);
    assert.deepEqual(restored.sameTail.toArray(), source.toArray());
    assert.deepEqual(restored.source.toArray(), source.toArray());
    assert.equal(restored.same.set(0, 99).get(0), 99);
    assert.equal(source.get(0), 0);
  });

  test('state suppresses identical trees and publishes identical tails and signed-zero changes', () => {
    const source = new SharedList('number', 0, 0, 0, new Arena()).pushMany(Array.from({ length: 65 }, (_, i) => i));
    const state = createSharedState(source, { publish: { strategy: 'immediate' } });
    const seen: number[] = [];
    const unsubscribe = state.subscribe((_snapshot, version) => { seen.push(version); });
    try {
      state.update(list => list.set(0, 0));
      assert.equal(state.current, source);
      assert.equal(state.version, 0); assert.deepEqual(seen, []);
      state.update(list => list.set(64, 64));
      assert.notEqual(state.current, source); assert.notEqual(state.current.tail, source.tail);
      assert.deepEqual(state.current.toArray(), source.toArray());
      assert.equal(state.version, 1); assert.deepEqual(seen, [1]);
      state.update(list => list.set(0, -0));
      assert.equal(state.version, 2); assert.deepEqual(seen, [1, 2]);
      assert.equal(Object.is(state.current.get(0), -0), true);
      const changed = state.current;
      state.update(list => list.set(0, -0));
      assert.equal(state.current, changed); assert.equal(state.version, 2);
      assert.equal(Object.is(source.get(0), 0), true);
    } finally { unsubscribe(); state.dispose(); }
  });

  test('random changed and no-op writes retain all sampled historical forks', () => {
    const a = new Arena();
    let list = new SharedList('number', 0, 0, 0, a).pushMany(Array.from({ length: 1057 }, (_, i) => i));
    let expected = list.toArray(), seed = 0x718abc32;
    const retained: { list: SharedList<'number'>; values: number[] }[] = [];
    for (let step = 0; step < 600; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const index = seed % list.size, value = step % 3 ? -step - 1 : expected[index], mark = a.used;
      if (!(step % 40)) retained.push({ list, values: expected.slice() });
      const changed = !Object.is(value, expected[index]);
      const next = list.set(index, value);
      assert.equal(a.used - mark, changed || !isTree(list, index) ? changedBytes(list, index) : 0);
      list = next; expected[index] = value;
    }
    assert.deepEqual(list.toArray(), expected);
    for (const old of retained) assert.deepEqual(old.list.toArray(), old.values);
  });
});
