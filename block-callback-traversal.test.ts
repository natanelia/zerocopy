import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, HEAP_START, arenaOf } from './arena';
import { SharedLinkedList, SharedDoublyLinkedList, SharedMap, getWorkerData, initWorker } from './shared';

const variants = [
  ['linked forward', SharedLinkedList, false],
  ['doubly forward', SharedDoublyLinkedList, false],
  ['doubly reverse', SharedDoublyLinkedList, true],
] as const;
function make(C: any, type: string, values: readonly any[], arena = new Arena()): any {
  let item = new C(type, 0, 0, 0, arena);
  for (const value of values) item = item.append(value);
  return item;
}
function scan(item: any, reverse: boolean) {
  const values: any[] = [], indices: number[] = [];
  item[reverse ? 'forEachReverse' : 'forEach']((value: any, index: number) => { values.push(value); indices.push(index); });
  return { values, indices };
}
const order = <T>(values: readonly T[], reverse: boolean): T[] => reverse ? [...values].reverse() : [...values];

describe('block callback traversal', () => {
  for (const [name, C, reverse] of variants) {
    it(`${name}: preserves boundaries, edited blocks and retained roots`, () => {
      const special = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, .25];
      for (const size of [0, 1, 31, 32, 33, 65, 1025]) {
        const a = new Arena(), original = Array.from({ length: size }, (_, i) => special[i % special.length]);
        const retained = make(C, 'number', original, a), expected = [...original];
        let item = retained;
        if (size >= 65) for (let step = 0; step < 8; step++) {
          const index = 17 + step * 3, value = -1000 - step;
          item = item.insertAfter(index, value).removeFirst();
          expected.splice(index + 1, 0, value); expected.shift();
        }
        const end = a.used, before = a.buf.slice(HEAP_START, end);
        const actual = scan(item, reverse);
        assert.deepEqual(actual.values, order(expected, reverse));
        assert.deepEqual(actual.indices, order(Array.from({ length: size }, (_, i) => i), reverse));
        assert.deepEqual(retained.toArray(), original);
        assert.equal(a.used, end);
        assert.deepEqual(a.buf.slice(HEAP_START, end), before);
      }
    });

    it(`${name}: keeps independent continuations through callbacks and growth`, () => {
      const a = new Arena(), expected = Array.from({ length: 1057 }, (_, i) => i + .25);
      const item = make(C, 'number', expected, a), fork = item.prepend(-9);
      const generator = a.blocks(item.head), first = generator.next().value;
      const end = a.used, before = a.buf.slice(HEAP_START, end), buffer = a.memory.buffer;
      const stopped = new Error('inner callback stopped'), seen: number[] = [], indices: number[] = [];
      const pause = reverse ? item.size - item.tailSize - 1 : 1;
      let entered = false;
      item[reverse ? 'forEachReverse' : 'forEach']((value: number, index: number) => {
        if (index === pause) {
          entered = true;
          assert.throws(() => fork.forEach((_v: number, i: number) => { if (i === 34) throw stopped; }), error => error === stopped);
          assert.deepEqual(fork.toArray(), [-9, ...expected]);
          a.memory.grow(2);
          assert.deepEqual(item.append(9000).toArray(), [...expected, 9000]);
        }
        seen.push(value); indices.push(index);
      });
      assert.ok(entered); assert.notEqual(a.memory.buffer, buffer);
      assert.deepEqual(seen, order(expected, reverse));
      assert.deepEqual(indices, order(expected.map((_, i) => i), reverse));
      assert.deepEqual([first, ...generator], expected.slice(0, item.size - item.tailSize));
      assert.deepEqual(item.toArray(), expected);
      assert.deepEqual(a.buf.slice(HEAP_START, end), before);
    });

    it(`${name}: propagates callback failures and keeps empty callback behavior`, () => {
      const empty = make(C, 'number', []), method = reverse ? 'forEachReverse' : 'forEach';
      assert.equal(empty[method](undefined), undefined);
      const expected = Array.from({ length: 65 }, (_, i) => i + .25), item = make(C, 'number', expected);
      assert.throws(() => item[method](undefined), TypeError);
      const error = { reason: 'callback' }, visited: number[] = [];
      assert.throws(() => item[method]((value: number) => { visited.push(value); if (visited.length === 35) throw error; }), caught => caught === error);
      assert.deepEqual(visited, order(expected, reverse).slice(0, 35));
      assert.deepEqual(scan(item, reverse).values, order(expected, reverse));
    });

    it(`${name}: keeps generic values and shared/copy readers immutable`, async () => {
      const child = new SharedMap('number', 0, 0, new Arena()).set('id', 0);
      for (const type of ['boolean', 'string', 'object', 'SharedMap<number>']) {
        const expected = Array.from({ length: 65 }, (_, i) => type === 'boolean' ? i % 3 === 0
          : type === 'string' ? `界🙂-${i}` : type === 'object' ? { id: i, nested: [i, { text: `v-${i}` }] } : i);
        const input = type === 'SharedMap<number>' ? expected.map(id => child.set('id', id as number)) : expected;
        const original = make(C, type, input);
        for (const copy of [false, true]) {
          const { item } = await initWorker(getWorkerData({ item: original }, { copy }));
          const a = arenaOf(item), end = a.used, before = a.buf.slice(HEAP_START, end);
          const actual = scan(item, reverse);
          const decoded = type === 'SharedMap<number>' ? actual.values.map(value => value.get('id')) : actual.values;
          assert.deepEqual(decoded, order(expected, reverse));
          assert.deepEqual(actual.indices, order(expected.map((_, i) => i), reverse));
          if (type === 'object') for (const value of actual.values) {
            assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.nested)); assert.ok(Object.isFrozen(value.nested[1]));
          }
          assert.throws(() => item.append(input[0]), /read-only/);
          if (type === 'SharedMap<number>') assert.throws(() => actual.values[0].set('bad', 1), /read-only/);
          assert.equal(a.used, end); assert.deepEqual(a.buf.slice(HEAP_START, end), before);
        }
      }
    });
  }
});
