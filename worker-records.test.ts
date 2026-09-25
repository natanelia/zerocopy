import { beforeEach, expect, test } from 'vitest';
import { SharedMap, SharedList, json, list, getWorkerData, initWorker, resetMap, resetSharedList } from './shared';
import { arenaOf, type Arena } from './arena';

beforeEach(() => { resetMap(); resetSharedList(); });

test.each([false, true])('worker metadata keeps plain string keys, copy=%s', async copy => {
  const value = json<{ id: string }>();
  const lanes = new SharedList(value).push({ id: 'one' });
  const tiles = new SharedMap(list(value)).set('tile', lanes);
  const source = Object.assign(Object.create(null), { lanes, tiles });
  source.__proto__ = tiles;
  source.constructor = lanes;
  const payload = getWorkerData(source, { copy });
  expect(Object.hasOwn(payload.structures, '__proto__')).toBe(true);
  expect(Object.isFrozen(payload.structures.lanes.data)).toBe(true);
  const restored = await initWorker(payload);
  expect(Object.getPrototypeOf(restored)).toBeNull();
  expect(restored.tiles.get('tile')?.get(0)).toEqual({ id: 'one' });
  expect(restored.__proto__.get('tile')?.get(0)).toEqual({ id: 'one' });
  expect(restored.constructor.get(0)).toEqual({ id: 'one' });
});

test('rejects symbol names rather than silently losing a typed collection', () => {
  const lanes = new SharedMap('number');
  expect(() => getWorkerData({ [Symbol('lanes')]: lanes } as never)).toThrow(/names must be strings/);
});

test('collects deep arena graphs iteratively and deduplicates cycles', () => {
  const lanes = new SharedMap('number').set('n', 1), root = arenaOf(lanes);
  // Only metadata traversal is under test. Reuse one memory rather than
  // allocating thousands of WASM instances just to form a deep graph.
  let last = root;
  const count = 12000;
  for (let index = 0; index < count; index++) {
    const next = {
      id: `traversal-fixture-${index}`, used: root.used, memory: root.memory,
      dependencies: new Map<string, Arena>(),
    } as Arena;
    last.dependencies.set(next.id, next);
    last = next;
  }
  last.dependencies.set(root.id, root);
  const payload = getWorkerData({ lanes, same: lanes }, { copy: false });
  expect(payload.arenas).toHaveLength(count + 1);
  expect(new Set(payload.arenas.map(arena => arena.id)).size).toBe(count + 1);
  expect(payload.structures.lanes).toEqual(payload.structures.same);
  expect(lanes.get('n')).toBe(1);
});
