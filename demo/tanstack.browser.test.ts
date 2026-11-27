import { createCollection, createTransaction, whenSyncAccepted } from '@tanstack/db';
import { expect, it } from 'vitest';
import { SharedList, getWorkerData } from '../dist/shared.js';
import { createSharedSession } from '../dist/worker.js';
import { applySpatialEdits, buildSpatialIndex, prepareSpatialQuery } from '../dist/spatial.js';
import type { SpatialViewportDelta } from '../spatial.ts';
import { sharedCollectionConfig, spatialJoinCollectionConfig, viewportCollectionConfig, withConfirmedSharedCache } from '../dist/tanstack-db-collection.js';

function openRowWorker(source) {
  const session = createSharedSession({ source }, { copy: false });
  const worker = new Worker(new URL('./tanstack-session-worker.ts', import.meta.url), { type: 'module' });
  const { port1, port2 } = new MessageChannel();
  const request = (message, transfer = []) => new Promise((resolve, reject) => {
    worker.onerror = reject;
    worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
    worker.postMessage(message, transfer);
  });
  async function connect() {
    const ready = request({ port: port2 }, [port2]);
    await session.connect(port1);
    expect(await ready).toEqual({ revision: 0 });
  }
  return { connect, request, session, close() { session.dispose(); port1.close(); worker.terminate(); } };
}

it('automatically publishes confirmed rows to a worker that skips intermediate revisions', async () => {
  const first = { id: 'north', revision: 0, label: 'confirmed' };
  const options = sharedCollectionConfig({ id: 'session-lanes', initialData: [first] });
  const lanes = createCollection(options);
  await lanes.preload();
  const { session, request, connect, close } = openRowWorker(options);
  try {
    await connect();
    const preview = createTransaction({ autoCommit: false, mutationFn: async () => {} });
    preview.mutate(() => lanes.update('north', lane => { lane.label = 'optimistic'; }));
    expect(lanes.get('north')?.label).toBe('optimistic');
    expect(session.version).toBe(0);
    await lanes.update('north', lane => { lane.revision++; }).when('settled');
    await lanes.insert({ ...first, id: 'temporary' }).when('settled');
    await lanes.delete('temporary').when('settled');
    const nextRevision = options.getSnapshot().get('north')!.revision + 1;
    await lanes.update('north', lane => { lane.revision = nextRevision; }).when('settled');
    preview.rollback();
    expect(session.version).toBe(4);
    expect(options.getSnapshot().get('north')).toEqual({ ...first, revision: 2 });
    expect(await request({ version: session.version })).toEqual({
      version: 4, latest: true, sameMemory: true, original: first,
      changes: [{ type: 'update', key: 'north', before: first, after: { ...first, revision: 2 } }],
    });
  } finally {
    close(); await lanes.cleanup();
  }
});

it('keeps deferred upstream edits out of the worker until the real sync receipt becomes visible', async () => {
  const first = { id: 'north', revision: 0, label: 'confirmed' };
  let feed;
  const mirror = withConfirmedSharedCache({ sync(params) {
    feed = params;
    feed.begin(); feed.write({ type: 'insert', value: first }); feed.commit(); feed.markReady();
  } });
  const lanes = createCollection({ id: 'remote-lanes', getKey: row => row.id, sync: mirror.sync });
  await lanes.preload();
  const { session, request, connect, close } = openRowWorker(mirror);
  let release;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await connect();
    feed.begin(); feed.write({ type: 'delete', key: 'north' });
    await expect(feed.commit(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    const preview = createTransaction({ autoCommit: false, mutationFn: () => gate });
    preview.mutate(() => lanes.update('north', lane => { lane.label = 'preview'; }));
    const persisting = preview.commit();
    const after = { ...first, revision: 2 };
    feed.begin(); feed.write({ type: 'update', value: after });
    const receipt = feed.commit();
    expect(receipt).toBeInstanceOf(Promise);
    await whenSyncAccepted(receipt);
    expect(mirror.getSnapshot().get('north')).toEqual(first);
    expect(session.version).toBe(0);
    release(); await persisting; await receipt;
    expect(session.version).toBe(1);
    expect(await request({ version: session.version })).toMatchObject({
      version: 1, latest: true, original: first,
      changes: [{ type: 'update', key: 'north', before: first, after }],
    });
    feed.begin({ snapshot: true }); await feed.commit();
    expect(await request({ version: session.version })).toMatchObject({
      version: 2, changes: [{ type: 'delete', key: 'north', before: first, after: undefined }],
    });
  } finally { release(); close(); await lanes.cleanup(); }
});

it('attaches confirmed rows and geometry from the same edit in a browser worker', async () => {
  const firstRow = { id: 'lane', handle: 7, bounds: [0, 0, 2, 3], revision: 0, style: { color: 'black', width: 2 } };
  const options = sharedCollectionConfig({ id: 'lanes', initialData: [firstRow] });
  const lanes = createCollection(options);
  const overlaps = createCollection(spatialJoinCollectionConfig({ id: 'lane-road-overlaps' }));
  const visible = createCollection(viewportCollectionConfig({ id: 'narrow-lanes' }));
  const reader = new Worker(new URL('./tanstack-worker.ts', import.meta.url), { type: 'module' });
  const initial = new SharedList('number').pushMany([0, 0, 2, 3]);
  const base = buildSpatialIndex([{ id: 7, bounds: [0, 0, 2, 3] }]);
  const roadIndex = buildSpatialIndex([{ id: 23, bounds: [0, 2.5, 0, 2.75] }]);
  const initialChanges = applySpatialEdits(undefined, 0, []);
  type WorkerRead = { narrowPairs: [number, number][] };
  type Delta = { added: [number, number][]; removed: [number, number][] };
  const read = (geometry, changes = initialChanges) => new Promise<{ first: WorkerRead; current: WorkerRead; delta: Delta; viewportDelta: SpatialViewportDelta }>((resolve, reject) => {
    reader.onerror = reject;
    reader.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
    const rows = options.getSnapshot();
    const prepared = prepareSpatialQuery(base, changes, rows.get('lane')!.revision);
    reader.postMessage({ base, prepared, roadIndex, roots: getWorkerData({ rows, geometry, changes }, { copy: false }) });
  });
  try {
    await lanes.preload();
    const before = { row: firstRow, bounds: [0, 0, 2, 3], candidates: [], rebuiltCandidates: [],
      preparedCandidates: [], narrowCandidates: [7], intersectsNarrow: false, narrowPairs: [] };
    const empty = { added: [], removed: [] };
    const seed = await read(initial);
    expect(seed).toEqual({ first: before, current: before, delta: empty, viewportDelta: empty });
    await overlaps.utils.setPairs(seed.current.narrowPairs);
    await visible.utils.setVisibleIds([]);
    const version = overlaps.utils.getVersion();
    const visibleVersion = visible.utils.getVersion();

    const geometry = initial.set(0, -12);
    const edits = applySpatialEdits(initialChanges, 1, [{ id: 7, bounds: [-12, 0, 2, 3] }]);
    const color = createTransaction({ autoCommit: false, mutationFn: async () => {} });
    color.mutate(() => lanes.update('lane', lane => { lane.style.color = 'red'; }));
    const tx = createTransaction({ autoCommit: false,
      mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction) });
    tx.mutate(() => lanes.update('lane', lane => { lane.revision = 1; lane.bounds[0] = -12; lane.style.width = 6; }));
    expect(lanes.get('lane')?.revision).toBe(1);
    expect(await read(initial)).toEqual({ first: before, current: before, delta: empty, viewportDelta: empty });
    await tx.commit();
    const after = { row: { ...firstRow, bounds: [-12, 0, 2, 3], revision: 1, style: { color: 'black', width: 6 } }, bounds: [-12, 0, 2, 3], candidates: [7], rebuiltCandidates: [7],
      preparedCandidates: [7], narrowCandidates: [7], intersectsNarrow: true, narrowPairs: [[7, 23]] };
    const reply = read(geometry, edits);
    const published = overlaps.utils.applyPairChanges(reply.then(({ delta }) => delta), version);
    const visibleUpdate = visible.utils.applyVisibleChanges(reply.then(({ viewportDelta }) => viewportDelta), visibleVersion);
    expect(await reply).toEqual({ first: before, current: after, delta: { added: [[7, 23]], removed: [] },
      viewportDelta: { added: [7], removed: [] } });
    color.rollback();
    expect(lanes.get('lane')?.style).toEqual(after.row.style);
    expect(await published).toBe(true);
    expect(await visibleUpdate).toBe(true);
    expect([...visible.keys()]).toEqual([7]);
    expect(overlaps.get('7:23')).toMatchObject({ leftId: 7, rightId: 23 });
  } finally {
    reader.terminate();
    await visible.cleanup();
    await overlaps.cleanup();
    await lanes.cleanup();
  }
});
