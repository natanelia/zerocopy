import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, resetSharedList, attachToMemory } from './shared-list';
import { fromFloat64 } from './numeric';

const bits = [0x3ff4000000000000n, 0x8000000000000000n, 0x7ff8000000000001n, 0xfff8000000000002n];
const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const resize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resize')?.value;
const resizable = (bytes: number) => new (ArrayBuffer as any)(bytes, { maxByteLength: bytes * 2 });
function fixture(buffer: ArrayBufferLike = new ArrayBuffer(bits.length * 8), offset = 0) {
  const input = new Float64Array(buffer, offset, bits.length), view = new DataView(buffer);
  bits.forEach((value, i) => view.setBigUint64(offset + i * 8, value, little));
  return input;
}
function rawBits(list: SharedList<'number'>): bigint[] {
  const a = arenaOf(list), view = a.dv, start = list.size ? (list.size - 1) & ~31 : 0;
  return Array.from({ length: list.size }, (_, index) => {
    const leaf = index >= start ? list.tail : a.wasm.vecLeaf(list.root, list.depth, index) >>> 0;
    return view.getBigUint64(leaf + (index & 31) * 8, true);
  });
}
function patternedInput(size: number, rotation: number) {
  const input = new Float64Array(size), view = new DataView(input.buffer);
  const patterns = [...bits, 0x7ff0000000000001n, 0x0000000000000001n, 0xc025000000000000n];
  const expected = Array.from({ length: size }, (_, i) => patterns[(i + rotation) % patterns.length]);
  expected.forEach((value, i) => view.setBigUint64(i * 8, value, little));
  return { input, expected };
}

beforeEach(() => resetSharedList());
afterEach(() => resetSharedList());

describe('fromFloat64 independent contract', () => {
  it('rejects wrong brands and Proxy wrappers without consulting their properties', () => {
    const a = arenaOf(new SharedList('number')), used = a.used;
    let traps = 0;
    const fail = () => { traps++; throw new Error('Input property hook must not run'); };
    const spoof = Object.create(Float64Array.prototype);
    Object.defineProperties(spoof, { length: { get: fail }, buffer: { get: fail },
      [Symbol.toStringTag]: { get: fail }, [Symbol.iterator]: { get: fail } });
    const proxy = new Proxy(new Float64Array([1, 2]), {
      get: fail, getPrototypeOf: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail,
    });
    for (const input of [undefined, null, [], {}, new Float32Array(2), new Uint8Array(8),
      new BigInt64Array(2), new DataView(new ArrayBuffer(8)), spoof, proxy]) {
      assert.throws(() => fromFloat64(input as Float64Array), TypeError);
    }
    assert.equal(traps, 0); assert.equal(a.used, used);
  });

  it('accepts cross-realm views and subclasses while ignoring input metadata, iterator and species hooks', () => {
    const foreign = runInNewContext('new Float64Array([1.25, -0, NaN, Infinity])') as Float64Array;
    const copied = fromFloat64(foreign);
    assert.deepEqual(copied.toArray(), [1.25, -0, NaN, Infinity]);
    let calls = 0;
    const fail = () => { calls++; throw new Error('Subclass hook must not run'); };
    class Subclass extends Float64Array { static get [Symbol.species](): Float64ArrayConstructor { return fail() as never; } }
    for (const buffer of [new ArrayBuffer(48), new SharedArrayBuffer(48)]) {
      const input = new Subclass(buffer, 8, 4), view = new DataView(buffer);
      bits.forEach((value, i) => view.setBigUint64(8 + i * 8, value, little));
      Object.defineProperties(input, {
        length: { get: fail }, buffer: { get: fail }, byteLength: { get: fail }, byteOffset: { get: fail },
        constructor: { get: fail }, [Symbol.iterator]: { get: fail }, [Symbol.toStringTag]: { get: fail },
      });
      assert.deepEqual(rawBits(fromFloat64(input)), bits);
    }
    assert.equal(calls, 0);
  });

  it('distinguishes valid empty views from detached views, including detached empty views', () => {
    const empty = fromFloat64(new Float64Array(0));
    assert.equal(empty.size, 0); assert.equal(empty.root, 0); assert.equal(empty.tail, 0);
    assert.ok(Object.isFrozen(empty));
    for (const count of [0, 4]) {
      const buffer = new ArrayBuffer(count * 8), input = new Float64Array(buffer);
      structuredClone(buffer, { transfer: [buffer] });
      assert.throws(() => fromFloat64(input), TypeError);
    }
  });

  it.skipIf(!resize)('rejects fixed and tracking out-of-bounds RAB views but accepts an in-bounds empty endpoint', () => {
    const buffer = resizable(64);
    const fixed = new Float64Array(buffer, 16, 4), tracking = new Float64Array(buffer, 16);
    resize.call(buffer, 8);
    assert.throws(() => fromFloat64(fixed), TypeError);
    assert.throws(() => fromFloat64(tracking), TypeError);
    assert.equal(fromFloat64(new Float64Array(buffer, 8, 0)).size, 0);
  });

  it.skipIf(!resize)('captures RAB bytes before an allocator hook shrinks its source', () => {
    const buffer = resizable(64), input = fixture(buffer, 8);
    const a = arenaOf(new SharedList('number')), alloc = a.alloc;
    Object.defineProperty(a, 'alloc', { value(bytes: number) {
      resize.call(buffer, 0);
      return alloc.call(this, bytes);
    } });
    const result = fromFloat64(input);
    assert.deepEqual(rawBits(result), bits);
    assert.equal(input.length, 0);
  });

  it('captures shared and same-arena aliases before custom hooks can replace their values', () => {
    const a = arenaOf(new SharedList('number')), input = fixture(new SharedArrayBuffer(48), 8), alloc = a.alloc;
    Object.defineProperty(a, 'alloc', { configurable: true, value(bytes: number) {
      input.fill(99);
      return alloc.call(this, bytes);
    } });
    const copied = fromFloat64(input);
    assert.deepEqual(rawBits(copied), bits);
    delete (a as any).alloc;
    const alias = new Float64Array(a.memory.buffer, copied.tail, copied.size);
    const independent = fromFloat64(alias);
    alias.fill(0);
    assert.deepEqual(rawBits(independent), bits);
  });

  it('snapshots ordinary input before reentrant allocator, view, readOnly and memory accessors', () => {
    for (const hook of ['alloc', 'dv', 'readOnly', 'memory', 'memory.buffer']) {
      resetSharedList();
      const held = new SharedList('number').pushMany([10, 20, 30]);
      const a = arenaOf(held), memory = a.memory, input = fixture();
      const end = a.used, before = a.buf.slice(HEAP_START, end);
      const alloc = a.alloc, view = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
      const memoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer')!.get!;
      let calls = 0;
      const reenter = () => {
        if (calls++ === 0) {
          structuredClone(input.buffer, { transfer: [input.buffer] });
          if (hook === 'alloc') resetSharedList();
        }
      };
      if (hook === 'alloc') Object.defineProperty(a, 'alloc', { value(bytes: number) { reenter(); return alloc.call(this, bytes); } });
      if (hook === 'dv') Object.defineProperty(a, 'dv', { get() { reenter(); return view.call(this); } });
      if (hook === 'readOnly') Object.defineProperty(a, 'readOnly', { get() { reenter(); return false; } });
      if (hook === 'memory') Object.defineProperty(a, 'memory', { get() { reenter(); return memory; } });
      if (hook === 'memory.buffer') Object.defineProperty(memory, 'buffer', { get() { reenter(); return memoryBuffer.call(memory); } });
      const result = fromFloat64(input);
      assert.ok(calls > 0, hook); assert.equal(arenaOf(result), a, hook);
      assert.deepEqual(rawBits(result), bits, hook);
      assert.deepEqual(held.toArray(), [10, 20, 30], hook);
      assert.deepEqual(a.buf.slice(HEAP_START, end), before, hook);
    }
  });

  it('honors custom native-kernel dispatch without invoking a numeric codec', () => {
    const a = arenaOf(new SharedList('number')), native = a.wasm;
    const values = Float64Array.from({ length: 65 }, (_, i) => i + 0.25), expected = Array.from(values);
    let allocCalls = 0, linkCalls = 0;
    Object.defineProperty(a, 'wasm', { value: { ...native,
      alloc(bytes: number) { allocCalls++; values.fill(-99); return native.alloc(bytes); },
      vecLink(...args: number[]) { linkCalls++; return native.vecLink(...args); },
    } });
    const codecError = new Error('Explicit numeric codec hook');
    Object.defineProperty(a, 'encodeRange', { value() { throw codecError; } });
    const result = fromFloat64(values);
    assert.equal(allocCalls, 1); assert.equal(linkCalls, 1);
    assert.deepEqual(result.toArray(), expected);
    assert.throws(() => new SharedList('number').pushMany([7]), error => error === codecError);
  });

  it('permits an empty result on a read-only default arena and rejects nonempty writes', () => {
    const held = new SharedList('number').pushMany([10, 20, 30]), a = arenaOf(held), used = a.used;
    const before = a.buf.slice(HEAP_START, used);
    attachToMemory(a.memory, { heapEnd: used });
    const empty = fromFloat64(new Float64Array(0));
    assert.equal(empty.size, 0); assert.equal(arenaOf(empty).readOnly, true);
    assert.throws(() => fromFloat64(new Float64Array([1])), /read-only/);
    assert.equal(arenaOf(empty).used, used);
    assert.deepEqual(a.buf.slice(HEAP_START, used), before);
    assert.deepEqual(held.toArray(), [10, 20, 30]);
  });

  it.each(['allocator', 'view setter'] as const)('keeps outer and nested input bits separate through a reentrant %s and memory growth', hook => {
    const held = new SharedList('number').pushMany([10, -0, 30]), a = arenaOf(held);
    const end = a.used, published = a.buf.slice(HEAP_START, end), capacity = a.memory.buffer.byteLength;
    const outer = patternedInput(hook === 'allocator' ? 1057 : 65, 0);
    const large = patternedInput(32769, 2), small = patternedInput(17, 4);
    let entered = false, largeResult: SharedList<'number'> | undefined, smallResult: SharedList<'number'> | undefined;
    const reenter = () => {
      if (entered) return;
      entered = true;
      outer.input.fill(91);
      largeResult = fromFloat64(large.input);
      large.input.fill(92);
      // A second nested call must also leave the still-active outer input intact.
      smallResult = fromFloat64(small.input);
      small.input.fill(93);
      assert.ok(a.memory.buffer.byteLength > capacity, 'Nested import grows the owner');
    };
    const alloc = a.alloc, getter = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
    if (hook === 'allocator') {
      Object.defineProperty(a, 'alloc', { configurable: true, value(bytes: number) {
        reenter(); return alloc.call(this, bytes);
      } });
    } else {
      Object.defineProperty(a, 'dv', { configurable: true, get() {
        // The returned view keeps its write hooks even if the getter removes
        // itself before the caller classifies the current arena protocol.
        delete (a as any).dv;
        const target = new DataView(getter.call(this).buffer);
        Object.defineProperty(target, 'setUint32', { value(offset: number, value: number, endian?: boolean) {
          reenter(); DataView.prototype.setUint32.call(this, offset, value, endian);
        } });
        return target;
      } });
    }
    let result: SharedList<'number'>;
    try { result = fromFloat64(outer.input); }
    finally { delete (a as any)[hook === 'allocator' ? 'alloc' : 'dv']; }
    assert.ok(entered); assert.ok(largeResult); assert.ok(smallResult);
    for (const [list, wanted] of [[result!, outer.expected], [largeResult!, large.expected], [smallResult!, small.expected]] as const) {
      assert.equal(arenaOf(list), a); assert.ok(Object.isFrozen(list));
      assert.deepEqual(rawBits(list), wanted);
      assert.equal(list.toArray().length, wanted.length);
    }
    assert.deepEqual(held.toArray(), [10, -0, 30]);
    assert.deepEqual(a.buf.slice(HEAP_START, end), published);
  });

  it.each(['allocator', 'view setter'] as const)('preserves published bits and recovers after a failing %s', hook => {
    const oldInput = patternedInput(65, 1), held = fromFloat64(oldInput.input), a = arenaOf(held);
    const end = a.used, published = a.buf.slice(HEAP_START, end);
    const failed = patternedInput(1057, 3), failure = new Error(`Expected ${hook} failure`);
    const getter = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
    let writes = 0;
    if (hook === 'allocator') {
      Object.defineProperty(a, 'alloc', { configurable: true, value() {
        failed.input.fill(99); throw failure;
      } });
    } else {
      Object.defineProperty(a, 'dv', { configurable: true, get() {
        const target = new DataView(getter.call(this).buffer);
        Object.defineProperty(target, 'setUint32', { value(offset: number, value: number, endian?: boolean) {
          if (++writes === 3) { failed.input.fill(99); throw failure; }
          DataView.prototype.setUint32.call(this, offset, value, endian);
        } });
        return target;
      } });
    }
    try { assert.throws(() => fromFloat64(failed.input), error => error === failure); }
    finally { delete (a as any)[hook === 'allocator' ? 'alloc' : 'dv']; }
    if (hook === 'view setter') assert.equal(writes, 3, 'Failure follows a partial unpublished write');
    const recovered: { list: SharedList<'number'>; expected: bigint[] }[] = [];
    for (const [size, rotation] of [[33, 4], [262144, 5], [1057, 6]]) {
      const next = patternedInput(size, rotation), list = fromFloat64(next.input);
      next.input.fill(-99);
      recovered.push({ list, expected: next.expected });
    }
    for (const { list, expected } of recovered) assert.deepEqual(rawBits(list), expected);
    assert.deepEqual(rawBits(held), oldInput.expected);
    assert.deepEqual(a.buf.slice(HEAP_START, end), published);
  });

  it('keeps ordinary pushMany getter order and factory reentry from object serialization', () => {
    const base = new SharedList('number').pushMany([10, 20]), input = [1, 2];
    let calls = 0, side: SharedList<'number'> | undefined;
    Object.defineProperty(input, 0, { get() {
      if (++calls === 1) side = base.push(99);
      return calls === 1 ? 1 : 7;
    } });
    Object.defineProperty(input, Symbol.iterator, { get() { throw new Error('Indexed append must not iterate'); } });
    const next = base.pushMany(input);
    assert.equal(calls, 2);
    assert.deepEqual(next.toArray(), [10, 20, 7, 2]);
    assert.deepEqual(side!.toArray(), [10, 20, 99]);
    assert.deepEqual(base.toArray(), [10, 20]);
    assert.equal(base.pushMany([]), base);
    assert.throws(() => base.pushMany([undefined as never]), /Expected a number/);
    let typed: SharedList<'number'> | undefined, serializations = 0;
    const objects = new SharedList('object').pushMany([{ toJSON() {
      serializations++; typed = fromFloat64(new Float64Array([1, -0, NaN]));
      return { id: 1 };
    } }]);
    assert.equal(serializations, 1); assert.deepEqual(objects.toArray(), [{ id: 1 }]);
    assert.deepEqual(typed!.toArray(), [1, -0, NaN]);
  });
});
