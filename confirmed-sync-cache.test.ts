import { createCollection, type SyncConfig } from '@tanstack/db';
import { expect, it, vi } from 'vitest';
import { withConfirmedSharedCache } from './tanstack-db-collection.ts';

type Lane = { id: string; revision?: number; style?: { color: string }; obsolete?: string };
type Params = Parameters<SyncConfig<Lane, string>['sync']>[0];
const north: Lane = { id: 'north', revision: 0, style: { color: 'blue' }, obsolete: 'drop' };

it('mirrors whole visible upstream batches, aborts, truncation and replacement snapshots', async () => {
  let source!: Params;
  const provider: SyncConfig<Lane, string> = { sync(params) { source = params; params.markReady(); } };
  const mirror = withConfirmedSharedCache(provider);
  const lanes = createCollection({ id: 'remote', getKey: lane => 'lane-' + lane.id, sync: mirror.sync });
  const updates = vi.fn();
  const unsubscribe = mirror.subscribe(updates);
  try {
    await lanes.preload();
    const empty = mirror.getSnapshot();
    source.begin();
    source.write({ type: 'insert', value: north });
    source.write({ type: 'insert', value: { id: 'south' } });
    expect(mirror.getSnapshot()).toBe(empty);
    expect(updates).not.toHaveBeenCalled();
    await source.commit();
    const initial = mirror.getSnapshot();
    expect([...initial.entries()].sort()).toEqual([...lanes.base.entries()].sort());
    expect(updates).toHaveBeenCalledTimes(1);

    source.begin();
    source.write({ type: 'delete', key: 'lane-south' });
    source.write({ type: 'update', value: { id: 'north', revision: 9 } });
    await expect(source.commit(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(mirror.getSnapshot()).toBe(initial);
    expect(updates).toHaveBeenCalledTimes(1);

    source.begin();
    source.write({ type: 'update', value: { id: 'north', revision: 2 } });
    source.write({ type: 'update', value: { id: 'north', obsolete: undefined } });
    await source.commit();
    expect(mirror.getSnapshot().get('lane-north')).toEqual({ id: 'north', revision: 2, style: north.style });
    source.begin({ snapshot: true });
    source.write({ type: 'insert', value: { id: 'west' } });
    await source.commit();
    expect([...mirror.getSnapshot().entries()]).toEqual([...lanes.base.entries()]);
    source.begin();
    source.write({ type: 'update', value: { id: 'west', revision: 42 } });
    source.truncate({ markReady: false });
    source.write({ type: 'insert', value: north });
    await source.commit();
    expect([...mirror.getSnapshot().entries()]).toEqual([...lanes.base.entries()]);
    expect(initial.size).toBe(2);
    expect(initial.get('lane-north')).toEqual(north);
    expect(updates).toHaveBeenCalledTimes(4);
  } finally { unsubscribe(); await lanes.cleanup(); }
});

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('preserves receipts and publishes later partial edits in order after an earlier rejection', async () => {
  let source!: Params;
  const provider: SyncConfig<Lane, string> = { sync(params) { source = params; } };
  const mirror = withConfirmedSharedCache(provider);
  const one = deferred(), two = deferred(), three = deferred();
  const commit = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(one.promise)
    .mockReturnValueOnce(two.promise).mockReturnValueOnce(three.promise);
  const downstream = { collection: { getKeyFromItem: (row: Lane) => row.id }, begin() {}, write() {}, commit } as unknown as Params;
  mirror.sync.sync(downstream);
  source.begin(); source.write({ type: 'insert', value: north }); source.commit();
  const initial = mirror.getSnapshot();
  const received: number[] = [];
  mirror.subscribe(() => received.push(mirror.getSnapshot().get('north')!.revision!));
  source.begin();
  source.write({ type: 'delete', key: 'north' });
  expect(source.commit()).toBe(one.promise);
  source.begin();
  const patch = { id: 'north', revision: 2 };
  source.write({ type: 'update', value: patch });
  patch.revision = 99;
  expect(source.commit()).toBe(two.promise);
  source.begin();
  source.write({ type: 'update', value: { id: 'north', revision: 3 } });
  expect(source.commit()).toBe(three.promise);
  three.resolve(); two.resolve(); await Promise.all([two.promise, three.promise]);
  expect(mirror.getSnapshot()).toBe(initial);
  one.reject(new Error('Lost durable write')); await expect(one.promise).rejects.toThrow();
  expect(received).toEqual([2, 3]);
  expect(mirror.getSnapshot().get('north')).toEqual({ ...north, revision: 3 });
});

it('discards rejected writes and retired receipts while retaining provider hooks and cleanup', async () => {
  let source!: Params;
  const loadSubset = vi.fn(), cleanup = vi.fn(async () => {});
  const provider: SyncConfig<Lane, string> = {
    rowUpdateMode: 'full', getSyncMetadata: () => ({ stream: 1 }),
    sync(params) { source = params; return { loadSubset, cleanup }; },
  };
  const mirror = withConfirmedSharedCache(provider);
  const waiting = deferred();
  const downstream = {
    collection: { getKeyFromItem: (row: Lane) => row.id }, begin() {},
    write(message) { if (message.value?.id === 'invalid') throw new Error('rejected row'); },
    commit: vi.fn().mockImplementationOnce(() => { throw new Error('retry commit'); })
      .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(waiting.promise).mockReturnValue(true),
  } as unknown as Params;
  const run = mirror.sync.sync(downstream) as { cleanup: () => Promise<void>; loadSubset: unknown };
  expect(run.loadSubset).toBe(loadSubset);
  expect(mirror.sync.getSyncMetadata?.()).toEqual({ stream: 1 });
  source.begin();
  expect(() => source.write({ type: 'insert', value: { id: 'invalid' } })).toThrow('rejected row');
  expect(() => source.write({ type: 'insert', value: { id: 'bad', revision: 2n } as never })).toThrow();
  expect(() => source.write({ type: 'insert', value: { id: '\ud800' } })).toThrow(/Unicode/);
  source.write({ type: 'insert', value: north });
  expect(() => source.commit()).toThrow('retry commit');
  expect(mirror.getSnapshot().size).toBe(0);
  source.commit();
  source.begin(); source.write({ type: 'update', value: { id: 'north', revision: 4 } }); source.commit();
  expect([...mirror.getSnapshot().values()]).toEqual([{ id: 'north', revision: 4 }]);
  const old = source;
  old.begin(); old.write({ type: 'delete', key: 'north' }); old.commit();
  await run.cleanup(); expect(cleanup).toHaveBeenCalledOnce();
  mirror.sync.sync(downstream);
  source.begin(); source.write({ type: 'insert', value: { id: 'south' } }); source.commit();
  const current = mirror.getSnapshot();
  old.begin(); old.write({ type: 'delete', key: 'south' }); waiting.resolve(); await waiting.promise;
  expect(mirror.getSnapshot()).toBe(current);
  expect(current.size).toBe(2);
});
