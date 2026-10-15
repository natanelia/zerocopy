import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedSortedMap, resetSortedMap } from './shared';

beforeEach(() => resetSortedMap());
afterEach(() => vi.restoreAllMocks());

function sample() {
  return new SharedSortedMap('number').set('b', 2).set('a', 1).set('c', 3);
}

function watchReads(arena: Arena, failure?: 'key' | 'value', error?: Error) {
  const key = arena.leafKey, value = arena.leafValue, trace: string[] = [];
  let keys = 0, values = 0;
  vi.spyOn(arena, 'leafKey').mockImplementation(function (leaf) {
    trace.push('key');
    if (++keys === 2 && failure === 'key') throw error;
    return key.call(this, leaf);
  });
  vi.spyOn(arena, 'leafValue').mockImplementation(function (type, leaf, prefix) {
    trace.push('value');
    if (++values === 2 && failure === 'value') throw error;
    return value.call(this, type, leaf, prefix);
  });
  return trace;
}

// Keep genuine radix traversal and observe only its public iterator protocol.
function watchClose(arena: Arena, closeError?: Error) {
  const original = arena.radixLeaves, returns: unknown[][] = [], throws: unknown[] = [];
  let first = true;
  vi.spyOn(arena, 'radixLeaves').mockImplementation(function (root) {
    const inner = original.call(this, root);
    // Recursive journal iterators keep their ordinary implementation.
    if (!first) return inner;
    first = false;
    return {
      next() { return inner.next(); },
      return(...args: unknown[]) {
        returns.push(args);
        inner.return(undefined);
        if (closeError) throw closeError;
        return { value: undefined, done: true };
      },
      throw(error: unknown) { throws.push(error); return inner.throw(error); },
      [Symbol.iterator]() { return this; },
    } as Generator<number>;
  });
  return { returns, throws };
}

test.each([0, 3])('entries keeps generator shape and stays lazy before first next (size=%s)', size => {
  const map = size ? sample() : new SharedSortedMap('number'), arena = arenaOf(map);
  let arenaReads = 0;
  class Observed extends SharedSortedMap<'number'> {
    protected get arena(): Arena { arenaReads++; return super.arena; }
  }
  const observed = new Observed('number', undefined, map.root, map.size, arena);
  const view = vi.spyOn(arena, 'dv', 'get'), reads = watchReads(arena);
  const method = observed.entries, iterator = observed.entries();
  assert.equal(Object.getPrototypeOf(method), Object.getPrototypeOf(function* () {}));
  assert.equal(method.name, 'entries');
  assert.equal(method.length, 0);
  assert.equal(Object.getPrototypeOf(iterator), method.prototype);
  assert.equal(iterator[Symbol.iterator](), iterator);
  const descriptor = Object.getOwnPropertyDescriptor(SharedSortedMap.prototype, 'entries')!;
  assert.deepEqual([descriptor.enumerable, descriptor.configurable, descriptor.writable], [false, true, true]);
  const closed = observed.entries();
  assert.deepEqual(closed.return('closed'), { value: 'closed', done: true });
  const stopped = observed.entries(), error = new Error('never started');
  assert.throws(() => stopped.throw(error), caught => caught === error);
  assert.equal(arenaReads, 0);
  assert.equal(view.mock.calls.length, 0);
  assert.deepEqual(reads, []);
  arena.memory.grow(1);
  resetSortedMap();
  assert.deepEqual(iterator.next('ignored'), size ? { value: ['a', 1], done: false } : { value: undefined, done: true });
  assert.equal(arenaReads, 1);
  assert.deepEqual(reads, size ? ['key', 'value'] : []);
  if (!size) assert.equal(view.mock.calls.length, 0);
  iterator.return(undefined);
  assert.deepEqual(closed.next(), { value: undefined, done: true });
  assert.deepEqual(stopped.next(), { value: undefined, done: true });
});

test('entries decodes exactly one key then value per next and ignores next arguments', () => {
  const map = sample(), trace = watchReads(arenaOf(map)), iterator = map.entries();
  for (const [index, entry] of [['a', 1], ['b', 2], ['c', 3]].entries()) {
    assert.deepEqual(iterator.next(Symbol('unused')), { value: entry, done: false });
    assert.deepEqual(trace, Array.from({ length: index + 1 }, () => ['key', 'value']).flat());
  }
  assert.deepEqual(iterator.next('unused'), { value: undefined, done: true });
  assert.equal(trace.length, 6);
});

test.each(['key', 'value'] as const)('entries propagates a %s decode error and closes traversal', failure => {
  const map = sample(), arena = arenaOf(map), error = new Error(`${failure} failed`);
  const trace = watchReads(arena, failure, error), close = watchClose(arena), iterator = map.entries();
  assert.deepEqual(iterator.next(), { value: ['a', 1], done: false });
  assert.throws(() => iterator.next(), caught => caught === error);
  assert.deepEqual(trace, failure === 'key' ? ['key', 'value', 'key'] : ['key', 'value', 'key', 'value']);
  assert.deepEqual(close.returns, [[]]);
  assert.deepEqual(close.throws, []);
  assert.deepEqual(iterator.next(), { value: undefined, done: true });
});

test.each(['factory', 'next'] as const)('entries preserves a radix %s failure without closing an unentered loop', failure => {
  const map = sample(), arena = arenaOf(map), trace = watchReads(arena), closed: unknown[] = [];
  const error = new Error(`${failure} failed`);
  vi.spyOn(arena, 'radixLeaves').mockImplementation(() => {
    if (failure === 'factory') throw error;
    return {
      next() { throw error; },
      return() { closed.push('closed'); return { value: undefined, done: true }; },
      [Symbol.iterator]() { return this; },
    } as Generator<number>;
  });
  const iterator = map.entries();
  assert.throws(() => iterator.next(), caught => caught === error);
  assert.deepEqual(trace, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(iterator.next(), { value: undefined, done: true });
});

test.each(['return', 'throw', 'break', 'callback'] as const)('entries closes without further decoding after %s', completion => {
  const map = sample(), arena = arenaOf(map), trace = watchReads(arena), close = watchClose(arena);
  const error = new Error('consumer stopped');
  if (completion === 'callback') {
    assert.throws(() => map.forEach(() => { throw error; }), caught => caught === error);
  } else {
    const iterator = map.entries();
    if (completion === 'break') {
      for (const entry of iterator) { assert.deepEqual(entry, ['a', 1]); break; }
    } else {
      assert.deepEqual(iterator.next(), { value: ['a', 1], done: false });
      if (completion === 'return') assert.deepEqual(iterator.return('closed'), { value: 'closed', done: true });
      else assert.throws(() => iterator.throw(error), caught => caught === error);
    }
    assert.deepEqual(iterator.next(), { value: undefined, done: true });
  }
  assert.deepEqual(trace, ['key', 'value']);
  assert.deepEqual(close.returns, [[]]);
  assert.deepEqual(close.throws, []);
});

test.each(['return', 'throw'] as const)('entries preserves cleanup-error precedence for %s', completion => {
  const map = sample(), arena = arenaOf(map), trace = watchReads(arena);
  const cleanupError = new Error('close failed'), consumerError = new Error('consumer failed');
  const close = watchClose(arena, cleanupError), iterator = map.entries();
  assert.deepEqual(iterator.next(), { value: ['a', 1], done: false });
  if (completion === 'return') assert.throws(() => iterator.return('closed'), caught => caught === cleanupError);
  else assert.throws(() => iterator.throw(consumerError), caught => caught === consumerError);
  assert.deepEqual(close.returns, [[]]);
  assert.deepEqual(close.throws, []);
  assert.deepEqual(trace, ['key', 'value']);
  assert.deepEqual(iterator.next(), { value: undefined, done: true });
});

test('comparator entries fully decode before sorting and propagate its error before a yield', () => {
  const error = new Error('comparison failed');
  let trace: string[];
  const map = new SharedSortedMap('number', function () {
    assert.equal(this, map);
    trace.push('compare');
    throw error;
  }).set('b', 2).set('a', 1).set('c', 3);
  trace = watchReads(arenaOf(map));
  const iterator = map.entries();
  assert.deepEqual(trace, []);
  assert.throws(() => iterator.next(), caught => caught === error);
  assert.deepEqual(trace, ['key', 'value', 'key', 'value', 'key', 'value', 'compare']);
  assert.deepEqual(iterator.next(), { value: undefined, done: true });
});

test('public entries overrides preserve forEach, comparator values and super delegation', () => {
  const map = sample(), arena = arenaOf(map), expected = [['a', 1], ['b', 2], ['c', 3]];
  class Replaced extends SharedSortedMap<'number'> {
    *entries(): Generator<[string, number]> { yield ['public override', 99]; }
  }
  let calls = 0;
  class Delegated extends SharedSortedMap<'number'> {
    *entries(): Generator<[string, number]> { calls++; yield* super.entries(); }
  }
  const replaced = new Replaced('number', undefined, map.root, map.size, arena);
  const delegated = new Delegated('number', undefined, map.root, map.size, arena);
  const first: unknown[] = [], second: unknown[] = [];
  replaced.forEach((value, key) => first.push([key, value]));
  delegated.forEach((value, key) => second.push([key, value]));
  assert.deepEqual(first, [['public override', 99]]);
  assert.deepEqual(second, expected);
  assert.equal(calls, 1);
  const custom = new Replaced('number', (a, b) => b.localeCompare(a), map.root, map.size, arena);
  assert.deepEqual([...custom.values()], [99]);
  const sorted = new Delegated('number', (a, b) => b.localeCompare(a), map.root, map.size, arena);
  assert.deepEqual([...sorted.values()], [3, 2, 1]);
  assert.equal(calls, 2);
});
