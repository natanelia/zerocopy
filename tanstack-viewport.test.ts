import { BTreeIndex, createCollection, createLiveQueryCollection, eq, not } from '@tanstack/db';
import { expect, it } from 'vitest';
import { buildSpatialIndex, querySpatialIndex, querySpatialJoin, type SpatialPair } from './spatial.ts';
import { sharedCollectionConfig, spatialJoinCollectionConfig, viewportCollectionConfig } from './tanstack-db-collection.ts';

it('publishes pair deltas and follows metadata on both sides of a live spatial join', async () => {
  const box = [0, 0, 1, 1] as const, far = [5, 5, 6, 6] as const;
  const left = buildSpatialIndex([{ id: 1, bounds: box }, { id: 12, bounds: far }]);
  const right = buildSpatialIndex([{ id: 23, bounds: box }, { id: 3, bounds: far }]);
  const config = spatialJoinCollectionConfig({ id: 'boundary-road-overlaps' });
  await config.utils.setPairs(querySpatialJoin(left, right));
  const pairs = createCollection(config);
  pairs.createIndex(row => row.leftId, { indexType: BTreeIndex });
  pairs.createIndex(row => row.rightId, { indexType: BTreeIndex });
  const layer = (id: string, handles: number[]) => createCollection(sharedCollectionConfig({
    id, initialData: handles.map(handle => ({ id: String(handle), handle, direction: 'north' })),
  }));
  const boundaries = layer('boundaries', [1, 12]), roads = layer('roads', [3, 23]);
  boundaries.createIndex(row => row.handle, { indexType: BTreeIndex });
  roads.createIndex(row => row.handle, { indexType: BTreeIndex });
  const invalid = createLiveQueryCollection(q => q.from({ p: pairs })
    .innerJoin({ b: boundaries }, ({ p, b }) => eq(p.leftId, b.handle))
    .innerJoin({ r: roads }, ({ p, r }) => eq(p.rightId, r.handle))
    .where(({ b, r }) => not(eq(b.direction, r.direction)))
    .select(({ p }) => ({ id: p.id })));
  const batches: string[][] = [];
  const sub = pairs.subscribeChanges(events => batches.push(events.map(e => e.type + ':' + e.key)), { includeInitialState: true });
  try {
    await invalid.preload();
    expect([...pairs.keys()].sort()).toEqual(['12:3', '1:23']);
    expect(batches.flat().sort()).toEqual(['insert:12:3', 'insert:1:23']);
    batches.length = 0;
    await pairs.utils.setPairs([[12, 3], [1, 23], [1, 23]]);
    expect(batches).toEqual([]);
    expect(invalid.size).toBe(0);
    await roads.update('23', row => { row.direction = 'south'; }).when('settled');
    expect([...invalid.values()].map(row => row.id)).toEqual(['1:23']);
    await boundaries.update('1', row => { row.direction = 'south'; }).when('settled');
    expect(invalid.size).toBe(0);
    const late = Promise.withResolvers<readonly SpatialPair[]>();
    const obsolete = pairs.utils.setPairs(late.promise);
    const version = pairs.utils.getVersion();
    expect(await pairs.utils.applyPairChanges({ added: [[1, 3], [1, 3], [12, 3]], removed: [[1, 23]] }, version)).toBe(true);
    expect(pairs.utils.getVersion()).toBe(version + 1);
    late.resolve([[1, 23]]);
    expect(await obsolete).toBe(false);
    expect([...invalid.values()].map(row => row.id)).toEqual(['1:3']);
    expect(batches).toEqual([['delete:1:23', 'insert:1:3']]);
    await expect(pairs.utils.setPairs([[1, 0xffffffff], [-1, 3]])).rejects.toThrow(RangeError);
    expect([...pairs.keys()].sort()).toEqual(['12:3', '1:3']);
    await pairs.reload();
    expect(pairs.get('1:3')).toMatchObject({ id: '1:3', leftId: 1, rightId: 3 });
  } finally {
    sub.unsubscribe();
    await invalid.cleanup(); await pairs.cleanup(); await boundaries.cleanup(); await roads.cleanup();
  }
});

it('applies worker deltas only to their confirmed version, including while a previous commit is in flight', async () => {
  const config = spatialJoinCollectionConfig({ id: 'pair-receipts' });
  const { setPairs, getVersion, applyPairChanges } = config.utils;
  const entered = Promise.withResolvers<void>(), first = Promise.withResolvers<void>();
  const writes: string[] = [];
  let commits = 0;
  const close = config.sync.sync({
    collection: { keys: () => [] }, begin() {}, markReady() {},
    write(msg) { writes.push(msg.type + ':' + msg.value!.id); },
    commit() {
      commits++;
      if (commits === 1) { entered.resolve(); return first.promise; }
      if (commits === 2) return Promise.reject(new Error('Commit failed'));
    },
  });
  try {
    const seed = setPairs([[1, 2]]);
    await entered.promise;
    const add = { added: [[3, 4]], removed: [] } as const;
    const stale = applyPairChanges(add, getVersion());
    first.resolve();
    expect(await seed).toBe(true);
    expect(await stale).toBe(false);
    expect(writes).toEqual(['insert:1:2']);
    await expect(applyPairChanges(add, 1)).rejects.toThrow('Commit failed');
    expect(getVersion()).toBe(1);
    const worker = Promise.withResolvers<typeof add>();
    const pending = applyPairChanges(worker.promise, 1);
    expect(await applyPairChanges(Promise.reject(new Error('stale')), 0)).toBe(false);
    worker.resolve(add);
    expect(await pending).toBe(true);
    await expect(applyPairChanges({ added: [[3, 4]], removed: [[3, 4]] }, 2)).rejects.toThrow(/both/);
    const late = Promise.withResolvers<typeof add>();
    const replaced = applyPairChanges(late.promise, 2);
    expect(await setPairs([[1, 2], [3, 4]])).toBe(true);
    late.reject(new Error('superseded'));
    expect(await replaced).toBe(false);
    expect(getVersion()).toBe(3);
    expect(writes).toEqual(['insert:1:2', 'insert:3:4', 'insert:3:4']);
    const removed: [number, number][] = [[3, 4]];
    const captured = applyPairChanges({ added: [], removed }, 3);
    removed[0][0] = 7;
    expect(await captured).toBe(true);
    expect(writes.at(-1)).toBe('delete:3:4');
  } finally { close(); }
});

it('publishes only membership changes and keeps a real metadata join live', async () => {
  const index = buildSpatialIndex([1, 2, 3].map(handle => ({ id: handle, bounds: [handle, 0, handle, 0] })));
  const lanes = createCollection(sharedCollectionConfig({ id: 'joined-lanes', initialData:
    [1, 2, 3].map(handle => ({ id: 'lane-' + handle, handle, direction: 'north' })) }));
  lanes.createIndex(row => row.handle, { indexType: BTreeIndex });
  const visible = createCollection(viewportCollectionConfig({ id: 'joined-viewport' }));
  const joined = createLiveQueryCollection(q => q.from({ v: visible })
    .innerJoin({ lane: lanes }, ({ v, lane }) => eq(v.id, lane.handle))
    .select(({ lane }) => ({ id: lane.id, direction: lane.direction })));
  const listener = joined.subscribeChanges(() => {});
  const batches: string[][] = [];
  const membership = visible.subscribeChanges(batch => batches.push(batch.map(e => e.type + ':' + e.key)));
  try {
    await Promise.all([lanes.preload(), visible.preload(), joined.preload()]);
    const rows = () => [...joined.values()].map(v => [v.id, v.direction]).sort();
    expect(await visible.utils.setVisibleIds(querySpatialIndex(index, [1, 0, 2, 0]))).toBe(true);
    expect(rows()).toEqual([['lane-1', 'north'], ['lane-2', 'north']]);
    await visible.utils.setVisibleIds([2, 1, 2]);
    expect(batches).toEqual([['insert:1', 'insert:2']]);
    await visible.utils.setVisibleIds(querySpatialIndex(index, [2, 0, 3, 0]));
    expect(batches.at(-1)).toEqual(['delete:1', 'insert:3']);
    await lanes.update('lane-2', lane => { lane.direction = 'south'; }).when('settled');
    expect(rows()).toEqual([['lane-2', 'south'], ['lane-3', 'north']]);
    expect(batches).toHaveLength(2);
    await visible.utils.setVisibleIds([]);
    expect(rows()).toEqual([]);
  } finally {
    membership.unsubscribe(); listener.unsubscribe();
    await joined.cleanup(); await visible.cleanup(); await lanes.cleanup();
  }
});

it('supersedes pending worker searches in dispatch order and preserves the last successful viewport', async () => {
  const options = viewportCollectionConfig<string>({ id: 'async-viewport' });
  await options.utils.setVisibleIds(['seed']);
  const visible = createCollection(options);
  try {
    await visible.preload();
    expect([...visible.keys()]).toEqual(['seed']);
    const delayed = Promise.withResolvers<string[]>();
    const superseded = visible.utils.setVisibleIds(delayed.promise);
    const next = ['new'];
    const newer = visible.utils.setVisibleIds(next);
    next.length = 0;
    await expect(newer).resolves.toBe(true);
    delayed.resolve(['stale']);
    await expect(superseded).resolves.toBe(false);
    const failure = Promise.withResolvers<string[]>();
    const staleFailure = visible.utils.setVisibleIds(failure.promise);
    await expect(visible.utils.setVisibleIds(Promise.reject(new Error('Worker failed')))).rejects.toThrow('Worker failed');
    failure.reject(new Error('Old worker failed'));
    await expect(staleFailure).resolves.toBe(false);
    await expect(visible.utils.setVisibleIds([NaN as unknown as string])).rejects.toThrow();
    expect([...visible.keys()]).toEqual(['new']);
    const late = Promise.withResolvers<string[]>();
    const oldRun = visible.utils.setVisibleIds(late.promise);
    await visible.reload();
    late.resolve(['obsolete']);
    expect(await oldRun).toBe(false);
    await visible.cleanup();
    await visible.preload();
    expect([...visible.keys()]).toEqual(['new']);
  } finally { await visible.cleanup(); }
});

it('serializes started publications and retries from committed IDs after a failed receipt', async () => {
  const options = viewportCollectionConfig({ id: 'viewport-receipts' });
  const entered = Promise.withResolvers<void>(), first = Promise.withResolvers<void>();
  let commits = 0;
  const writes: string[] = [];
  const close = options.sync.sync({
    collection: { keys: () => [] }, begin() {}, markReady() {},
    write(msg) { writes.push(msg.type + ':' + msg.value!.id); },
    commit() {
      commits++;
      if (commits === 1) { entered.resolve(); return first.promise; }
      if (commits === 2) return Promise.reject(new Error('Commit failed'));
    },
  });
  try {
    const a = options.utils.setVisibleIds([1]);
    await entered.promise;
    const b = options.utils.setVisibleIds([2]);
    expect(commits).toBe(1);
    first.resolve();
    await expect(a).resolves.toBe(true);
    await expect(b).rejects.toThrow('Commit failed');
    await options.utils.setVisibleIds([3]);
    expect(writes).toEqual(['insert:1', 'delete:1', 'insert:2', 'delete:1', 'insert:3']);
  } finally { close(); }
});
