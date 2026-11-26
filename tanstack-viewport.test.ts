import { BTreeIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { expect, it } from 'vitest';
import { buildSpatialIndex, querySpatialIndex } from './spatial.ts';
import { sharedCollectionConfig, viewportCollectionConfig } from './tanstack-db-collection.ts';

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
