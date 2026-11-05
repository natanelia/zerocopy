import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, getWorkerData, initWorker, json } from './shared';

describe('immutable vector block copies', () => {
  it('copies every tail width exactly without changing a published snapshot', () => {
    const values = [-0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE];
    for (let length = 1; length <= 32; length++) {
      const input = Array.from({ length }, (_, i) => values[i % values.length]);
      const owner = new Arena(), base = new SharedList('number', 0, 0, 0, owner).pushMany(input);
      const published = owner.buf.slice(HEAP_START, owner.used), end = owner.used;
      for (let index = 0; index < length; index++) {
        const before = owner.used, fork = base.set(index, index + 0.25), expected = input.slice();
        expected[index] = index + 0.25;
        expect(owner.used - before).toBe(length * 8);
        assert.deepEqual(fork.toArray(), expected);
        assert.deepEqual(base.toArray(), input);
        assert.deepEqual(owner.buf.slice(HEAP_START, end), published);
      }
    }
  });

  it('keeps branches and sibling leaves across tree depth transitions and memory growth', () => {
    for (const length of [33, 64, 1025, 1057, 32769, 32801]) {
      const input = Array.from({ length }, (_, i) => i + 0.5);
      const owner = new Arena(), base = new SharedList('number', 0, 0, 0, owner).pushMany(input);
      const end = owner.used, published = owner.buf.slice(HEAP_START, end);
      owner.memory.grow(1);
      for (const index of new Set([0, 31, 32, 1023, length - 2, length - 1].filter(i => i < length))) {
        const before = owner.used, fork = base.set(index, -index - 0.5), expected = input.slice();
        expected[index] = -index - 0.5;
        const tailStart = (length - 1) & ~31;
        expect(owner.used - before).toBe(index >= tailStart ? (length - tailStart) * 8 : 256 + base.depth * 128);
        assert.deepEqual(fork.toArray(), expected);
        assert.deepEqual(base.toArray(), input);
        assert.deepEqual(owner.buf.slice(HEAP_START, end), published);
      }
    }
  });

  it('copies encoded references and gives attached readers the same fork', async () => {
    const input = Array.from({ length: 97 }, (_, id) => ({ id, text: `item-${id}-🌱` }));
    const base = new SharedList(json<{ id: number; text: string }>(), 0, 0, 0, new Arena()).pushMany(input);
    const fork = base.set(31, { id: -31, text: 'tree' }).set(96, { id: -96, text: 'tail' });
    const expected = input.slice();
    expected[31] = { id: -31, text: 'tree' }; expected[96] = { id: -96, text: 'tail' };
    for (const copy of [false, true]) {
      const attached = await initWorker(getWorkerData({ base, fork }, { copy }));
      expect(attached.base.toArray()).toEqual(input);
      expect(attached.fork.toArray()).toEqual(expected);
      expect(() => attached.fork.set(1, input[0])).toThrow();
    }
    expect(arenaOf(base)).toBe(arenaOf(fork));
  });
});
