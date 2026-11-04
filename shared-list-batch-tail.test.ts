import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';

const bytes = (arena: Arena, end = arena.used) => arena.buf.slice(HEAP_START, end);

describe('SharedList bulk append at the allocation frontier', () => {
  for (const type of ['number', 'boolean'] as const) {
    it(`keeps ${type} snapshots and forks across tail and tree boundaries`, () => {
      for (const size of [0, 1, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025]) {
        for (const count of [1, 2, 31, 32, 33]) {
          const a = new Arena();
          const source = Array.from({ length: size }, (_, i) => type === 'number' ? i + .25 : i % 3 === 0);
          const suffix = Array.from({ length: count }, (_, i) => type === 'number' ? -i - .5 : i % 2 === 0);
          let base = new SharedList(type, 0, 0, 0, a);
          for (const value of source) base = base.push(value as never);
          base.get(size - 1); // Retain the original read view before growth.
          const before = bytes(a), end = a.used;
          const next = base.pushMany(suffix as never[]);
          const fork = base.pushMany([type === 'number' ? 900 : false] as never[]);
          assert.deepEqual(base.toArray(), source);
          assert.deepEqual(next.toArray(), [...source, ...suffix]);
          assert.deepEqual(fork.toArray(), [...source, type === 'number' ? 900 : false]);
          assert.deepEqual(bytes(a, end), before);
        }
      }
    });

    it(`reserves only new ${type} bytes when a short tail is contiguous`, () => {
      const a = new Arena(), initial = type === 'number' ? [1, 2, 3, 4, 5] : [true, false, true, false, true];
      const suffix = type === 'number' ? [6, 7] : [false, true];
      const base = new SharedList(type, 0, 0, 0, a).pushMany(initial as never[]), end = a.used;
      const next = base.pushMany(suffix as never[]);
      assert.equal(a.used - end, 16);
      assert.deepEqual(base.toArray(), initial);
      assert.deepEqual(next.toArray(), [...initial, ...suffix]);
      const retained = next.pop().pop(), fork = retained.pushMany(suffix as never[]);
      assert.deepEqual(fork.toArray(), [...initial, ...suffix]);
      assert.deepEqual(next.toArray(), [...initial, ...suffix]);
    });
  }

  it('preserves numeric bits, input access order and reserved writes during reentry', () => {
    const a = new Arena(), initial = [-0, NaN, Infinity, -Infinity, Number.MIN_VALUE];
    const base = new SharedList('number', 0, 0, 0, a).pushMany(initial), before = bytes(a), end = a.used;
    let calls = 0, side: SharedList<'number'> | undefined;
    const input = [0, 2];
    Object.defineProperty(input, 0, { get() {
      if (++calls === 1) {
        side = base.pushMany([77, 88]);
        a.alloc(a.memory.buffer.byteLength * 2);
      }
      return calls === 1 ? 1 : 42;
    } });
    const next = base.pushMany(input);
    assert.equal(calls, 2, 'Numeric validation and writing retain their original two reads');
    assert.deepEqual(next.toArray(), [...initial, 42, 2]);
    assert.deepEqual(side!.toArray(), [...initial, 77, 88]);
    assert.deepEqual(base.toArray(), initial);
    assert.deepEqual(bytes(a, end), before);
  });

  it('checks the frontier after a reentrant input length getter', () => {
    const a = new Arena(), base = new SharedList('number', 0, 0, 0, a).pushMany([1, 2, 3]);
    let lengths = 0, side: SharedList<'number'> | undefined;
    const input = new Proxy([4, 5], { get(target, property, receiver) {
      if (property === 'length' && ++lengths === 3) side = base.pushMany([90, 91]);
      return Reflect.get(target, property, receiver);
    } });
    const next = base.pushMany(input);
    assert.deepEqual(next.toArray(), [1, 2, 3, 4, 5]);
    assert.deepEqual(side!.toArray(), [1, 2, 3, 90, 91]);
    assert.deepEqual(base.toArray(), [1, 2, 3]);
  });

  it('keeps serialized objects, nested snapshots and intervening allocations independent', () => {
    const a = new Arena(), base = new SharedList('object', 0, 0, 0, a).pushMany([{ id: 1 }]);
    let side: SharedList<'object'> | undefined;
    const next = base.pushMany([{ toJSON() {
      side = base.pushMany([{ side: true }]);
      a.alloc(a.memory.buffer.byteLength * 2);
      return { id: 2 };
    } }] as never[]);
    assert.deepEqual(next.toArray(), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(side!.toArray(), [{ id: 1 }, { side: true }]);
    const strings = new SharedList('string', 0, 0, 0, new Arena()).pushMany(['same']);
    assert.deepEqual(strings.pushMany(['same', 'same']).toArray(), ['same', 'same', 'same']);
    assert.deepEqual(strings.toArray(), ['same']);
    const child = new SharedMap('number', 0, 0, new Arena()).set('id', 1);
    const nested = new SharedList('SharedMap<number>', 0, 0, 0, new Arena()).pushMany([child]);
    assert.deepEqual(nested.pushMany([child.set('id', 2)]).toArray().map(value => value.get('id')), [1, 2]);
    assert.equal(nested.get(0)!.get('id'), 1);
  });

  it('keeps reentrant length coercion on the original copy path', () => {
    for (const primitive of [2, '2']) {
      const a = new Arena(), base = new SharedList('number', 0, 0, 0, a).pushMany([1, 2, 3]);
      let lengths = 0, coercions = 0, side: SharedList<'number'> | undefined;
      const input = new Proxy([4, 5], { get(target, property, receiver) {
        if (property === 'length' && ++lengths === 3) return { valueOf() {
          coercions++;
          side = base.pushMany([90, 91]);
          return primitive;
        } };
        return Reflect.get(target, property, receiver);
      } });
      const end = a.used, next = base.pushMany(input);
      assert.equal(coercions, 1);
      assert.deepEqual(next.toArray(), [1, 2, 3, 4, 5]);
      assert.deepEqual(side!.toArray(), [1, 2, 3, 90, 91]);
      assert.deepEqual(base.toArray(), [1, 2, 3]);
      // Preserve the original length + count order for a string coercion too.
      assert.equal(a.used - end, 16 + (primitive === 2 ? 5 : 32) * 8);
    }
  });

  it('keeps published bytes after validation errors, exhaustion and recovery', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 3, shared: true });
    const a = new Arena({ memory }), base = new SharedList('number', 0, 0, 0, a).pushMany([1, 2, 3]);
    const before = bytes(a), end = a.used;
    assert.throws(() => base.pushMany([4, 'bad'] as never[]), /Expected a number/);
    assert.deepEqual(base.pushMany([5, 6]).toArray(), [1, 2, 3, 5, 6]);
    assert.throws(() => base.pushMany(Array(20000).fill(7)), WebAssembly.RuntimeError);
    assert.deepEqual(base.pushMany([8]).toArray(), [1, 2, 3, 8]);
    assert.deepEqual(base.toArray(), [1, 2, 3]);
    assert.deepEqual(bytes(a, end), before);
  });

  it('rejects invalid allocation sizes before any u32 conversion or write', () => {
    for (const count of [-4, .1, 2 ** 32, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
      const a = new Arena(), base = new SharedList('number', 0, 0, 0, a).pushMany([1, 2, 3]);
      const before = bytes(a), end = a.used;
      let lengths = 0;
      const input = new Proxy([4, 5], { get(target, property, receiver) {
        if (property === 'length' && ++lengths === 3) return count;
        return Reflect.get(target, property, receiver);
      } });
      assert.throws(() => base.pushMany(input), { name: 'RangeError', message: 'Allocation exceeds the arena limit' });
      assert.equal(a.used, end);
      assert.deepEqual(base.toArray(), [1, 2, 3]);
      assert.deepEqual(bytes(a, end), before);
    }
  });

  it('keeps fractional third lengths on the original byte-count path', () => {
    const a = new Arena(), base = new SharedList('number', 0, 0, 0, a).pushMany([1, 2, 3]);
    const end = a.used;
    let lengths = 0;
    const input = new Proxy([4, 5], { get(target, property, receiver) {
      if (property === 'length' && ++lengths === 3) return 1.5;
      return Reflect.get(target, property, receiver);
    } });
    const next = base.pushMany(input);
    assert.equal(a.used - end, 40, 'The original 36-byte request rounds up to 40; it must not truncate the count to one');
    assert.deepEqual(next.toArray(), [1, 2, 3, 4, 5]);
    assert.deepEqual(base.toArray(), [1, 2, 3]);
  });

  for (const copy of [false, true]) it(`preserves read-only readers while the owner grows (copy=${copy})`, async () => {
    const a = new Arena(), original = new SharedList('number', 0, 0, 0, a).pushMany([1, 2, 3]);
    const attached = (await initWorker(getWorkerData({ original }, { copy }))).original;
    const iterator = attached.values(); assert.equal(iterator.next().value, 1);
    original.pushMany(Array.from({ length: 20000 }, (_, i) => i));
    assert.deepEqual([...iterator], [2, 3]);
    assert.deepEqual(attached.toArray(), [1, 2, 3]);
    assert.throws(() => attached.pushMany([4]), /read-only/);
    assert.equal(attached.pushMany([]), attached);
  });
});
