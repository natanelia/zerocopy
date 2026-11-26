import { BTreeIndex, createCollection, createLiveQueryCollection, createTransaction, eq, localOnlyCollectionOptions } from '@tanstack/db';
import { createSharedSession } from '../../dist/worker.js';
import { SharedList, SharedMap, getWorkerData, list } from '../../dist/shared.js';
import { sharedCollectionConfig, viewportCollectionConfig } from '../../dist/tanstack-db-collection.js';
import { bboxXY } from '../../dist/geometry.js';
import { applySpatialEdits, pruneSpatialEdits } from '../../dist/spatial.js';
import { baseFor, viewportFor } from './spatial.mjs';
import { assertEqual, bounds, edit, lane, west } from './workload.mjs';
import { renderer } from './render.mjs';

function reader() {
  const worker = new Worker('/reader.js', { type: 'module' });
  const waiting = [];
  worker.onmessage = ({ data }) => {
    if (data.protocol === 'zerocopy/session') return;
    const { resolve, reject } = waiting.shift();
    if (data.error) reject(new Error(data.error)); else resolve(data);
  };
  worker.onerror = e => { for (const p of waiting.splice(0)) p.reject(new Error(e.message)); };
  return {
    worker,
    send(message) {
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        worker.postMessage(message);
      });
    },
    close() { worker.terminate(); },
  };
}

export async function replay({ mode, readers, count, vertices, steps, warmup, transport = 'session', rebuild = 'packed', graphicsMode = 'swiftshader', uploads = 'range' }) {
  if (!crossOriginIsolated) throw new Error('A cross-origin-isolated page is required');
  const shared = mode === 'shared';
  const view = await renderer(graphicsMode, uploads);
  const peers = Array.from({ length: readers }, reader);
  const initialData = [], expectedBounds = new Map(), editedPaths = new Map();
  const toPath = xy => shared ? new SharedList('number').pushMany(xy) : xy;
  let paths = shared ? new SharedMap(list('number')) : new Map();
  let changes = shared ? applySpatialEdits(undefined, 0, []) : new Map();
  for (let n = 0; n < count; n++) {
    const id = String(n), xy = lane(n, vertices), b = bounds(xy);
    paths = paths.set(id, toPath(xy));
    initialData.push({ id, revision: 0, geometryId: id, kind: 'lane', bounds: b });
    expectedBounds.set(id, b);
  }
  const local = (id, initialData = []) => localOnlyCollectionOptions({ id, initialData, getKey: row => row.id });
  const options = shared ? sharedCollectionConfig({ id: 'lanes', initialData }) : local('lanes', initialData);
  const lanes = createCollection(options);
  lanes.createIndex(row => row.id, { indexType: BTreeIndex });
  const visible = createCollection(viewportCollectionConfig({ id: 'viewport' }));
  const query = createLiveQueryCollection(q => q.from({ v: visible })
    .innerJoin({ lane: lanes }, ({ v, lane }) => eq(v.id, lane.id))
    .select(({ lane }) => ({ id: lane.id, revision: lane.revision })));
  const sub = query.subscribeChanges(() => {});
  let revision = 0, box = west, rebuilding;
  const samples = [];
  const nativeRows = shared ? undefined : new Map(initialData.map(row => [row.id, row]));
  const rows = () => shared ? options.getSnapshot() : nativeRows;
  const roots = () => ({ rows: rows(), paths, changes });
  const snapshot = () => getWorkerData(roots(), { copy: false });
  let session;
  try {
    await Promise.all([lanes.preload(), visible.preload(), query.preload()]);
    let base = baseFor(shared, rows(), revision);
    let message;
    if (shared && transport === 'session') {
      session = createSharedSession(roots(), { copy: false, channel: 'editor' });
      // The reader acknowledges session setup separately from application jobs.
      const ready = peers.map(p => p.send({ connect: true }));
      await session.connect(peers.map(p => p.worker));
      await Promise.all(ready);
      message = { sequence: session.version };
    } else message = shared ? { payload: snapshot() } : { initial: { rows: rows(), paths, changes } };
    await Promise.all(peers.map(p => p.send({ ...message, base, revision, box })));
    await peers[0].send({ hold: true, revision, request: -1, id: '5' });
    for (let step = -1; step < steps + warmup; step++) {
      const started = performance.now();
      const cmd = step < 0 ? { box: west } : edit(step, vertices);
      let newBase, patch, rebuiltChanges, rebuildMs;
      if (step >= 0 && step % 16 === 0) rebuilding = peers[0].send({ rebuild, revision });
      if (step >= 0 && step % 16 === 2) {
        ({ base: newBase, rebuildMs } = await rebuilding);
        // Edits newer than the worker's input revision survive the swap.
        if (shared) changes = pruneSpatialEdits(changes, newBase.revision);
        else for (const [id, change] of changes) if (change.revision <= newBase.revision) changes.delete(id);
        base = newBase;
        if (!shared) rebuiltChanges = new Map(changes);
      }
      if (cmd.box) box = cmd.box;
      else {
        const { id } = cmd;
        const old = paths.get(id);
        let next, xy;
        if (!cmd.remove) {
          if (cmd.path) { xy = cmd.path; next = toPath(xy); }
          else {
            xy = (editedPaths.get(id) ?? lane(Number(id), vertices)).slice();
            const axis = cmd.moveY === undefined ? 0 : 1;
            xy[axis] = cmd.moveX ?? cmd.moveY;
            next = shared ? old.set(axis, xy[axis]) : xy;
          }
        }
        const row = !cmd.remove && { id, geometryId: id, revision: revision + 1, kind: 'lane',
          bounds: shared ? bboxXY(next) : bounds(next) };
        const change = { revision: revision + 1, bounds: row ? row.bounds : null };
        const stagedPaths = shared ? (cmd.remove ? paths.delete(id) : paths.set(id, next)) : undefined;
        const stagedChanges = shared ? applySpatialEdits(changes, change.revision, [{ id: Number(id), bounds: change.bounds }]) : undefined;
        const wasPresent = lanes.has(id);
        const tx = createTransaction({ autoCommit: false, mutationFn: async ({ transaction }) => {
          if (cmd.reject) throw new Error('Rejected edit');
          await options.utils.acceptMutations(transaction);
        } });
        tx.mutate(() => {
          if (cmd.remove) lanes.delete(id);
          else if (wasPresent) lanes.update(id, draft => Object.assign(draft, row));
          else lanes.insert(row);
        });
        if (cmd.reject) {
          try { await tx.commit(); throw new Error('Accepted invalid edit'); }
          catch (error) { if (error.message !== 'Rejected edit') throw error; }
        } else {
          await tx.commit();
          revision++;
          if (shared) { changes = stagedChanges; paths = stagedPaths; }
          else changes.set(id, change);
          if (cmd.remove) {
            if (!shared) { paths.delete(id); nativeRows.delete(id); }
            expectedBounds.delete(id); editedPaths.delete(id);
          } else {
            if (!shared) { paths.set(id, next); nativeRows.set(id, row); }
            expectedBounds.set(id, bounds(xy)); editedPaths.set(id, xy);
          }
          patch = cmd.moveX !== undefined || cmd.moveY !== undefined
            ? { id, row, axis: cmd.moveY === undefined ? 0 : 1, coordinate: cmd.moveX ?? cmd.moveY, change }
            : { id, row, path: next, change };
        }
      }
      const ids = viewportFor(shared, base, changes, box);
      await visible.utils.setVisibleIds(ids);
      const liveRows = [...query.values()];
      const liveIds = liveRows.map(v => v.id).sort((a, b) => Number(a) - Number(b));
      const frame = { box, revision, request: step, base: newBase, rebuiltChanges,
        ...(session ? { sequence: patch || newBase ? session.publish(roots()) : session.version } :
          shared ? { payload: patch || newBase ? snapshot() : undefined } : { patch }) };
      const validation = Promise.all(peers.map(p => p.send(frame))).then(results => ({
        results, validationMs: performance.now() - started,
      }));
      const draw = await view.draw(liveIds, paths, box, patch, started);
      const frameMs = performance.now() - started;
      if (uploads === 'range') {
        if (draw.positionUploadBytes !== draw.packedBytes) throw new Error('Unexpected WebGL position upload size');
        if (cmd.moveY !== undefined && draw.packedBytes !== 16) throw new Error('A single vertex drag must pack exactly one XY pair');
        if (cmd.reject && draw.packedBytes !== 0) throw new Error('Rejected geometry reached the renderer');
      }
      const { results, validationMs } = await validation;
      const isCurrent = response => response.revision === revision && response.request === step;
      if (!results.every(isCurrent)) throw new Error('Validation used the wrong revision or viewport');
      if (step === 0) {
        // Complete a job begun before the vertex moved, after readers attached the edit.
        const old = await peers[0].send({ release: true });
        assertEqual([old.bounds, old.rowRevision], [bounds(lane(5, vertices)), 0], 'held validation');
        if (isCurrent(old)) throw new Error('Stale validation replaced the current result');
      }
      const expected = [...expectedBounds.entries()].filter(([, [x0, y0, x1, y1]]) =>
        Math.max(x0, box[0]) <= Math.min(x1, box[2]) && Math.max(y0, box[1]) <= Math.min(y1, box[3]))
        .map(([id]) => id).sort((a, b) => Number(a) - Number(b));
      assertEqual(liveIds, expected, 'TanStack live query vs full scan');
      for (const result of liveRows) assertEqual(result.revision, rows().get(result.id).revision, 'live row revision');
      for (const result of results) {
        assertEqual([result.visible, result.revision, result.generation], [expected, revision, base.revision], `worker result for ${mode} at command ${step}`);
      }
      if (step < 10) view.check(expected, id => editedPaths.get(id) ?? lane(Number(id), vertices), cmd.moveY);
      if (step >= warmup) samples.push({ step, revision, frameMs, validationMs, rebuildMs, ...draw });
    }
    return { samples, graphics: view.graphics };
  } finally {
    sub.unsubscribe();
    await Promise.all([query.cleanup(), visible.cleanup(), lanes.cleanup()]);
    session?.dispose();
    for (const peer of peers) peer.close();
    view.dispose();
  }
}
