import { expect, test } from 'vitest';
import { SharedList } from './shared-list';
import { arenaOf } from './arena';
import { getWorkerData, initWorker } from './shared';

for (const size of [0, 1, 2, 31, 32, 33, 63, 64, 65, 1024, 32768]) {
  test('number toArray keeps immutable values at size ' + size, () => {
    const samples = [NaN, -0, Infinity, -Infinity, Number.MIN_VALUE, 0.125, 1e300];
    const values = Array.from({ length: size }, (_, i) => samples[i % samples.length]);
    const list = new SharedList('number').pushMany(values);
    const arena = arenaOf(list), bytes = arena.copy(), state = arena.state();
    expect(list.toArray()).toEqual(values);
    expect(list.toArray()).toEqual(values);
    expect(arena.copy()).toEqual(bytes);
    expect(arena.state()).toEqual(state);
    if (size) {
      const changed = list.set(size - 1, 42.5);
      expect(changed.toArray()[size - 1]).toBe(42.5);
      expect(list.toArray()).toEqual(values);
    }
  });

  test('boolean toArray keeps immutable values at size ' + size, () => {
    const values = Array.from({ length: size }, (_, i) => i % 3 === 0);
    const list = new SharedList('boolean').pushMany(values);
    const arena = arenaOf(list), bytes = arena.copy();
    expect(list.toArray()).toEqual(values);
    expect(arena.copy()).toEqual(bytes);
    if (size) {
      const changed = list.set(size - 1, !values[size - 1]);
      expect(changed.toArray()[size - 1]).toBe(!values[size - 1]);
      expect(list.toArray()).toEqual(values);
    }
  });
}

test('nonprimitive fallback and read-only attachments remain correct', async () => {
  const strings = new SharedList('string').pushMany(['', 'x', '🙂', 'long '.repeat(32)]);
  const numbers = new SharedList('number').pushMany([NaN, -0, Infinity]);
  const flags = new SharedList('boolean').pushMany([true, false]);
  const wire = getWorkerData({ strings, numbers, flags }, { copy: true });
  const replica = await initWorker(wire);
  expect(replica.strings.toArray()).toEqual(strings.toArray());
  expect(replica.numbers.toArray()).toEqual(numbers.toArray());
  expect(replica.flags.toArray()).toEqual(flags.toArray());
  expect(() => replica.numbers.push(4)).toThrow();
});
