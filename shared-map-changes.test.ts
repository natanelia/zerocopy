import { expect, it, vi } from 'vitest';
import { Arena, arenaOf } from './arena';
import collisions from './proofs/bulk-input-collisions.json';
import { SharedList, SharedMap, getWorkerData, initWorker, json, list } from './shared';

it('returns net changes between forks, even when a key is rewritten or reinserted', () => {
  const base = new SharedMap('string').setMany([['a', 'first'], ['界', 'old'], ['', 'empty']]);
  const previous = base.set('gone', 'old branch');
  const next = base.delete('a').set('a', 'first').set('界', 'new')
    .set('temporary', 'hidden').delete('temporary').set('added', 'new branch');
  const changes = [...next.changesSince(previous)].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  expect(changes).toEqual([
    { type: 'insert', key: 'added', before: undefined, after: 'new branch' },
    { type: 'delete', key: 'gone', before: 'old branch', after: undefined },
    { type: 'update', key: '界', before: 'old', after: 'new' },
  ]);
  expect([...next.changesSince(next)]).toEqual([]);
  expect([...next.changesSince(new SharedMap('string'))].length).toBe(next.size);
  expect([...new SharedMap('string').changesSince(next)].every(v => v.type === 'delete')).toBe(true);
  expect(() => [...next.changesSince(new SharedMap('number') as never)]).toThrow(/same value type/);
});

it('prunes shared branches and only decodes values that the iterator yields', () => {
  const type = json<{ version: number }>();
  const before = new SharedMap(type).setMany(Array.from({ length: 4096 }, (_, i) => [String(i), { version: 0 }]));
  const after = before.set('64', { version: 4 }).set('2048', { version: 8 }).set('72', { version: 0 });
  const arena = arenaOf(after), start = arena.used;
  const decode = vi.spyOn(arena, 'leafValue'), key = vi.spyOn(arena, 'leafKey');
  try {
    const changes = after.changesSince(before);
    expect(decode).not.toHaveBeenCalled();
    expect(changes.next().value).toMatchObject({ type: 'update', before: { version: 0 } });
    expect(decode).toHaveBeenCalledTimes(2);
    // Pausing an iterator must also survive growth by the owner.
    arena.memory.grow(1);
    expect([...changes]).toHaveLength(1);
    expect(decode).toHaveBeenCalledTimes(4);
    expect(key.mock.calls.length).toBeLessThan(40);
    expect(arena.used).toBe(start);
  } finally { key.mockRestore(); decode.mockRestore(); }
});

it('compares stored JSON, primitive values and nested snapshot handles', () => {
  const initial = new SharedMap('object').set('row', { a: 1, b: 2 });
  expect([...initial.set('row', { a: 1, b: 2 }).changesSince(initial)]).toEqual([]);
  expect([...initial.set('row', { b: 2, a: 1 }).changesSince(initial)]).toHaveLength(1);
  const numbers = new SharedMap('number').setMany([['nan', NaN], ['zero', -0]]);
  const changes = [...numbers.setMany([['nan', NaN], ['zero', 0]]).changesSince(numbers)];
  expect(changes).toEqual([{ type: 'update', key: 'zero', before: -0, after: 0 }]);
  const flags = new SharedMap('boolean').set('flag', false);
  expect([...flags.set('flag', true).changesSince(flags)]).toEqual([{ type: 'update', key: 'flag', before: false, after: true }]);
  const child = new SharedList('number').push(1), children = new SharedMap(list('number')).set('path', child);
  expect([...children.set('path', child).changesSince(children)]).toEqual([]);
  const [edit] = children.set('path', child.push(2)).changesSince(children);
  expect(edit.before?.toArray()).toEqual([1]);
  expect(edit.after?.toArray()).toEqual([1, 2]);
});

it('compares independent arenas even when both root addresses match', async () => {
  const previous = new SharedMap('string', 0, 0, new Arena()).set('same', 'old');
  const next = new SharedMap('string', 0, 0, new Arena({ id: arenaOf(previous).id })).set('same', 'new');
  expect(previous.root).toBe(next.root);
  const result = [{ type: 'update', key: 'same', before: 'old', after: 'new' }];
  expect([...next.changesSince(previous)]).toEqual(result);
  const updated = previous.set('same', 'new');
  for (const copy of [true, false]) {
    const group = await initWorker(getWorkerData({ previous, updated }, { copy }));
    expect([...group.updated.changesSince(group.previous)]).toEqual(result);
  }
  const oldCopy = await initWorker(getWorkerData({ previous }, { copy: true }));
  const newCopy = await initWorker(getWorkerData({ updated }, { copy: true }));
  expect([...newCopy.updated.changesSince(oldCopy.previous)]).toEqual(result);
  expect([...oldCopy.previous.changesSince(previous)]).toEqual([]);
});

it('matches a native Map across retained revisions, hash collisions and tree shape changes', () => {
  const keys = [...collisions.keys, '', '工作', '\uFEFFlane', ...Array.from({ length: 96 }, (_, i) => String(i))];
  let map = new SharedMap('number'), model = new Map<string, number>(), seed = 99;
  const samples = [{ map, model }];
  function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
  for (let i = 0; i < 360; i++) {
    if (i % 9 === 0) model = new Map(model);
    const key = i < collisions.keys.length ? keys[i] : keys[random() % keys.length];
    if (i % 4 === 3) { map = map.delete(key); model.delete(key); }
    else { const n = random() % 19; map = map.set(key, n); model.set(key, n); }
    if (i % 9 === 8) samples.push({ map, model });
  }
  for (const { map: previous, model: earlier } of samples) {
    const { map: next, model: later } = samples[random() % samples.length];
    const expected = [...new Set([...earlier.keys(), ...later.keys()])]
      .filter(key => earlier.get(key) !== later.get(key)).sort()
      .map(key => ({ key, before: earlier.get(key), after: later.get(key),
        type: !later.has(key) ? 'delete' : earlier.has(key) ? 'update' : 'insert' }));
    const actual = [...next.changesSince(previous)].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    expect(actual).toEqual(expected);
  }
});
