import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';

const flags = (count: number) => Array.from({ length: count }, (_, i) => i % 3 === 0 || i % 7 === 2);
const saved = (arena: Arena, end = arena.used) => arena.buf.slice(HEAP_START, end);

describe('large boolean List appends', () => {
  for (const count of [255, 256, 1024, 32767, 32768, 32769, 262144]) {
    it(`retains complete values and forks when appending ${count} flags`, () => {
      const arena = new Arena(), prefix = flags(65), input = flags(count);
      const source = new SharedList('boolean', 0, 0, 0, arena).pushMany(prefix);
      const end = arena.used, bytes = saved(arena), next = source.pushMany(input);
      const fork = source.pushMany(input.map(value => !value));
      assert.deepEqual(next.toArray(), [...prefix, ...input]);
      assert.deepEqual(fork.toArray(), [...prefix, ...input.map(value => !value)]);
      assert.deepEqual(source.toArray(), prefix);
      assert.deepEqual(saved(arena, end), bytes);
      assert.equal(next.size, prefix.length + input.length);
      assert.ok(Object.isFrozen(next));
    });
  }

  it('joins empty, partial, full and tree-backed prefixes without changing old tails', () => {
    for (const size of [0, 1, 31, 32, 33, 64, 65, 1056]) {
      const arena = new Arena(), prefix = flags(size), input = flags(32768);
      const source = new SharedList('boolean', 0, 0, 0, arena).pushMany(prefix);
      const end = arena.used, bytes = saved(arena), next = source.pushMany(input);
      assert.deepEqual(next.toArray(), [...prefix, ...input]);
      assert.deepEqual(source.toArray(), prefix);
      assert.deepEqual(saved(arena, end), bytes);
      assert.deepEqual(next.pop().push(false).toArray(), [...prefix, ...input.slice(0, -1), false]);
    }
  });

  it('completes getters before arena allocation, including reentrant writes and growth', () => {
    const arena = new Arena(), prefix = flags(65), input = flags(32768), expected = [...input];
    const source = new SharedList('boolean', 0, 0, 0, arena).pushMany(prefix);
    const end = arena.used, bytes = saved(arena), oldBuffer = arena.memory.buffer;
    const events: number[] = [];
    let side: SharedList<'boolean'> | undefined;
    for (const index of [0, 127, 511, 32767]) {
      Object.defineProperty(input, index, { configurable: true, get() {
        events.push(index);
        if (index === 0) assert.equal(arena.used, end);
        if (index === 511) {
          side = source.pushMany(flags(300));
          arena.memory.grow(2);
        }
        return expected[index];
      } });
    }
    const next = source.pushMany(input);
    assert.deepEqual(events, [0, 127, 511, 32767]);
    assert.ok(arena.memory.buffer.byteLength > oldBuffer.byteLength);
    assert.deepEqual(next.toArray(), [...prefix, ...expected]);
    assert.deepEqual(side!.toArray(), [...prefix, ...flags(300)]);
    assert.deepEqual(source.toArray(), prefix);
    assert.deepEqual(saved(arena, end), bytes);
  });

  it('preserves custom encoders, maps and Array species', () => {
    {
      const arena = new Arena(), original = arena.encode, input = flags(32768);
      let calls = 0;
      arena.encode = function(type, value) { calls++; return original.call(this, type, !value); };
      const result = new SharedList('boolean', 0, 0, 0, arena).pushMany(input);
      assert.equal(calls, input.length);
      assert.deepEqual(result.toArray(), input.map(value => !value));
    }
    {
      const input = flags(32768), expected = input.map(value => !value);
      let calls = 0;
      Object.defineProperty(input, 'map', { value(fn: (value: boolean) => number) {
        calls++;
        return Array.prototype.map.call(this, (value: boolean) => fn(!value));
      } });
      const result = new SharedList('boolean', 0, 0, 0, new Arena()).pushMany(input);
      assert.equal(calls, 1); assert.deepEqual(result.toArray(), expected);
    }
    {
      const input = flags(32768), expected = [...input];
      let constructed = 0;
      class ResultArray extends Array { constructor(length: number) { super(length); constructed++; } }
      Object.defineProperty(input, 'constructor', { value: { [Symbol.species]: ResultArray } });
      const result = new SharedList('boolean', 0, 0, 0, new Arena()).pushMany(input);
      assert.equal(constructed, 1); assert.deepEqual(result.toArray(), expected);
    }
  });

  it('observes encoders installed by input getters without rereading inputs', () => {
    const arena = new Arena(), input = Array(32768).fill(false);
    let reads = 0, calls = 0;
    Object.defineProperty(input, 0, { get() {
      reads++;
      arena.encode = function(type, value) {
        assert.equal(this, arena); assert.equal(type, 'boolean'); calls++;
        return value ? 0 : 1;
      };
      return false;
    } });
    const result = new SharedList('boolean', 0, 0, 0, arena).pushMany(input);
    assert.equal(reads, 1); assert.equal(calls, input.length);
    assert.deepEqual(result.toArray(), Array(32768).fill(true));
  });

  it('retains arbitrary custom numeric encodings and later encoder changes', () => {
    const arena = new Arena(), original = arena.encode, prefix = flags(65), input = flags(32768);
    const source = new SharedList('boolean', 0, 0, 0, arena).pushMany(prefix);
    const end = arena.used, bytes = saved(arena), expectedRaw = input.map(value => value ? 1 : 0);
    const custom = [2, NaN, -7, -0, Infinity, -Infinity];
    const reads: number[] = [], calls: boolean[] = [];
    for (let i = 127; i < 513; i++) expectedRaw[i] = custom[(i - 127) % custom.length];
    for (const index of [127, 513]) {
      const value = input[index];
      Object.defineProperty(input, index, { get() {
        reads.push(index);
        if (index === 127) arena.encode = function(type, value) {
          assert.equal(this, arena); assert.equal(type, 'boolean');
          const raw = custom[calls.length % custom.length]; calls.push(value); return raw;
        };
        else arena.encode = original;
        return value;
      } });
    }
    const result = source.pushMany(input), allRaw = [...prefix.map(value => value ? 1 : 0), ...expectedRaw];
    const rawAt = (index: number) => {
      const leaf = index >>> 5 === (result.size - 1) >>> 5
        ? result.tail : arena.wasm.vecLeaf(result.root, result.depth, index) >>> 0;
      return arena.dv.getFloat64(leaf + (index & 31) * 8, true);
    };
    assert.deepEqual(reads, [127, 513]); assert.equal(calls.length, 386);
    assert.deepEqual(result.toArray(), allRaw.map(value => value !== 0));
    for (let i = 0; i < allRaw.length; i++) assert.ok(Object.is(rawAt(i), allRaw[i]), `raw value at ${i}`);
    assert.deepEqual(source.toArray(), prefix); assert.deepEqual(saved(arena, end), bytes);
  });

  it('finishes custom encoding before rejecting a nonnumeric raw result', () => {
    const arena = new Arena(), source = new SharedList('boolean', 0, 0, 0, arena).pushMany(flags(65));
    const end = arena.used, bytes = saved(arena), input = flags(32768);
    let calls = 0;
    Object.defineProperty(input, 0, { get() {
      arena.encode = (() => { calls++; return calls === 1 ? 'invalid' : 1; }) as any;
      return false;
    } });
    assert.throws(() => source.pushMany(input), { name: 'TypeError', message: 'Expected a number' });
    assert.equal(calls, input.length);
    assert.deepEqual(source.toArray(), flags(65)); assert.deepEqual(saved(arena, end), bytes);
  });

  it('rejects invalid flags, holes and throwing getters while retaining published snapshots', () => {
    const arena = new Arena(), prefix = flags(65);
    const source = new SharedList('boolean', 0, 0, 0, arena).pushMany(prefix);
    const end = arena.used, bytes = saved(arena);
    for (const index of [0, 255, 32767]) {
      const invalid: any[] = flags(32768); invalid[index] = 1;
      assert.throws(() => source.pushMany(invalid), { name: 'TypeError', message: 'Expected a boolean' });
      const sparse = flags(32768); delete sparse[index];
      assert.throws(() => source.pushMany(sparse), { name: 'TypeError', message: 'Expected a number' });
    }
    const failure = new Error('input getter failed'), input = flags(32768);
    let side: SharedList<'boolean'> | undefined;
    Object.defineProperty(input, 511, { get() { side = source.push(true); throw failure; } });
    assert.throws(() => source.pushMany(input), error => error === failure);
    assert.deepEqual(side!.toArray(), [...prefix, true]);
    assert.deepEqual(source.toArray(), prefix);
    assert.deepEqual(saved(arena, end), bytes);
    assert.deepEqual(source.pushMany(flags(32768)).toArray(), [...prefix, ...flags(32768)]);
  });

  it('aligns the new range after a Map leaves a four-byte allocation frontier', () => {
    const arena = new Arena(), source = new SharedList('boolean', 0, 0, 0, arena).pushMany(flags(65));
    const map = new SharedMap('number', 0, 0, arena).set('abc', 9);
    assert.equal(arena.used % 8, 4);
    const end = arena.used, bytes = saved(arena), next = source.pushMany(flags(32768));
    assert.deepEqual(next.toArray(), [...flags(65), ...flags(32768)]);
    assert.equal(map.get('abc'), 9);
    assert.deepEqual(saved(arena, end), bytes);
  });

  it('can recover with a smaller append after a real allocation failure', () => {
    const arena = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }) });
    const source = new SharedList('boolean', 0, 0, 0, arena).pushMany(flags(65));
    const end = arena.used, bytes = saved(arena), input = flags(32768);
    let finalRead = false;
    Object.defineProperty(input, input.length - 1, { get() { finalRead = true; return true; } });
    assert.throws(() => source.pushMany(input), WebAssembly.RuntimeError);
    assert.equal(finalRead, true); assert.equal(arena.used, end);
    const recovered = source.pushMany(flags(256));
    assert.deepEqual(recovered.toArray(), [...flags(65), ...flags(256)]);
    assert.deepEqual(source.toArray(), flags(65));
    assert.deepEqual(saved(arena, end), bytes);
  });

  for (const copy of [false, true]) it(`retains shared and copied read-only views (copy=${copy})`, async () => {
    const source = new SharedList('boolean', 0, 0, 0, new Arena()).pushMany(flags(65));
    const next = source.pushMany(flags(32768)), attached = await initWorker(getWorkerData({ source, next }, { copy }));
    assert.deepEqual(attached.source.toArray(), flags(65));
    assert.deepEqual(attached.next.toArray(), [...flags(65), ...flags(32768)]);
    const arena = arenaOf(attached.next), used = arena.used, bytes = saved(arena);
    let called = false;
    const input = flags(32768); Object.defineProperty(input, 0, { get() { called = true; return false; } });
    assert.throws(() => attached.next.pushMany(input), /read-only/);
    assert.equal(called, false); assert.equal(arena.used, used); assert.deepEqual(saved(arena), bytes);
  });
});
