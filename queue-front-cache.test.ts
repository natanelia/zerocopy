import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, HEAP_START, arenaOf } from './arena';
import { SharedQueue, SharedList, getWorkerData, initWorker } from './shared';

function queue<T extends string>(type: T, values: readonly any[], a = new Arena()): SharedQueue<T> {
  let result = new SharedQueue(type, 0, 0, 0, undefined, a);
  for (const value of values) result = result.enqueue(value);
  return result;
}
function drain(item: SharedQueue<any>): any[] {
  const values = [];
  while (item.size) { values.push(item.peek()); item = item.dequeue(); }
  assert.equal(item.peek(), undefined); assert.equal(item.dequeue(), item);
  return values;
}

describe('queue committed front cache', () => {
  it('preserves complete FIFO order across tail/tree/depth boundaries and binary64 values', () => {
    const special = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, .25];
    for (const size of [0, 1, 31, 32, 33, 63, 64, 65, 1025, 1057, 32769]) {
      const a = new Arena(), expected = Array.from({ length: size }, (_, i) => special[i % special.length]);
      const item = queue('number', expected, a), data = item.toWorkerData();
      const end = a.used, bytes = a.buf.slice(HEAP_START, end);
      assert.deepEqual(drain(item), expected); assert.deepEqual(drain(item), expected);
      assert.deepEqual(item.toWorkerData(), data); assert.equal(a.used, end);
      assert.deepEqual(a.buf.slice(HEAP_START, end), bytes);
    }
  });

  it('reuses each complete leaf across new dequeue handles without allocating shared bytes', () => {
    const a = new Arena(), item = queue('number', Array.from({ length: 1057 }, (_, i) => i + .25), a);
    const original = a.wasm, calls = { leaf: 0, get: 0 };
    (a as any).wasm = { ...original,
      vecLeaf(...args: any[]) { calls.leaf++; return original.vecLeaf(...args); },
      vecGet(...args: any[]) { calls.get++; return original.vecGet(...args); },
    };
    try {
      const used = a.used;
      assert.deepEqual(drain(item), Array.from({ length: 1057 }, (_, i) => i + .25));
      // 33 committed leaves and one value in the final tail.
      assert.deepEqual(calls, { leaf: 33, get: 0 }); assert.equal(a.used, used);
    } finally { (a as any).wasm = original; }
  });

  it('keeps roots distinct when queues, retained forks and append paths interleave', () => {
    const a = new Arena(), firstValues = Array.from({ length: 2057 }, (_, i) => i + .25);
    const secondValues = Array.from({ length: 97 }, (_, i) => -i - .5);
    const first = queue('number', firstValues, a), second = queue('number', secondValues, a);
    assert.equal(first.peek(), firstValues[0]);
    const fork = first.enqueue(9999), popped = first.dequeue();
    let x = first, y = second;
    for (let i = 0; i < secondValues.length; i++) {
      assert.equal(x.peek(), firstValues[i]); assert.equal(y.peek(), secondValues[i]);
      assert.equal(fork.peek(), firstValues[0]); assert.equal(popped.peek(), firstValues[1]);
      x = x.dequeue(); y = y.dequeue();
    }
    assert.deepEqual(drain(first), firstValues); assert.deepEqual(drain(second), secondValues);
    assert.deepEqual(drain(fork), [...firstValues, 9999]);
    // The cached committed front remains valid while the final tail changes.
    let changed = first;
    for (let i = 0; i < 40; i++) { changed = changed.enqueue(3000 + i); assert.equal(changed.peek(), firstValues[0]); }
    assert.deepEqual(drain(changed), [...firstValues, ...Array.from({ length: 40 }, (_, i) => 3000 + i)]);
  });

  it('preserves cold and warm shared/copy reads through owner growth, including generic values', async () => {
    const childArena = new Arena(), child = new SharedList('number', 0, 0, 0, childArena).pushMany([1, 2, 3]);
    for (const type of ['number', 'boolean', 'string', 'object', 'SharedList<number>']) {
      const expected = Array.from({ length: 65 }, (_, i) => type === 'number' ? i + .25
        : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `界🙂-${i}`
          : type === 'object' ? { id: i, nested: [i, { active: i % 3 === 0 }] } : [1, 2, 3, i]);
      const input = type === 'SharedList<number>' ? expected.map((_, i) => child.push(i)) : expected;
      const a = new Arena(), item = queue(type, input, a);
      for (const copy of [false, true]) for (const warm of [false, true]) {
        const { item: reader } = await initWorker(getWorkerData({ item }, { copy }));
        const owner = arenaOf(reader), end = owner.used, bytes = owner.buf.slice(HEAP_START, end);
        if (warm) reader.peek();
        a.memory.grow(1); item.enqueue(input[0]);
        const values = drain(reader);
        assert.deepEqual(type === 'SharedList<number>' ? values.map(value => value.toArray()) : values, expected);
        if (type === 'object') for (const value of values) {
          assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.nested)); assert.ok(Object.isFrozen(value.nested[1]));
        }
        assert.throws(() => reader.enqueue(input[0]), /read-only/);
        if (type === 'SharedList<number>') assert.throws(() => values[0].push(4), /read-only/);
        assert.equal(owner.used, end); assert.deepEqual(owner.buf.slice(HEAP_START, end), bytes);
      }
    }
  });

  it('keeps decoder calls, receiver and exceptions when decoding overwrites the cache and grows memory', () => {
    const a = new Arena(), expected = Array.from({ length: 97 }, (_, i) => i + .25);
    const item = queue('number', expected, a), other = queue('number', [-1, ...expected], a);
    const decode = a.decode, stopped = new Error('decode stopped');
    let inside = false, calls = 0, grown = false;
    a.decode = function (type, raw) {
      assert.equal(this, a);
      if (!inside) {
        calls++; inside = true;
        assert.equal(other.peek(), -1); inside = false;
        if (!grown) { a.memory.grow(1); grown = true; }
        if (calls === 4) throw stopped;
      }
      return decode.call(this, type, raw);
    };
    try {
      assert.equal(item.peek(), expected[0]); assert.equal(item.peek(), expected[0]);
      assert.equal(item.dequeue().peek(), expected[1]);
      assert.throws(() => item.peek(), error => error === stopped);
      assert.equal(calls, 4);
    } finally { a.decode = decode; }
    assert.deepEqual(drain(item), expected); assert.deepEqual(drain(other), [-1, ...expected]);
  });
});
