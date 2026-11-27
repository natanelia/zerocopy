import { expect, it } from 'vitest';
import { SharedMap, SharedList, compact } from '../dist/shared.js';
import { createSharedSession, createSharedState, pool } from '../dist/worker.js';
import { applySpatialEdits, buildSpatialIndex } from '../dist/spatial.js';
import type { tasks as spatialTasks } from './spatial-pool-worker';
function result(worker: Worker, version: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing browser version ${version}`)), 10000);
    const onMessage = (event: MessageEvent) => { if (event.data.result && event.data.version === version) finish(undefined, event.data); };
    const onError = (event: ErrorEvent) => finish(new Error(event.message));
    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError);
      error ? reject(error) : resolve(value);
    };
    worker.addEventListener('message', onMessage); worker.addEventListener('error', onError);
  });
}
it('auto-publishes to an isolated browser module worker without resending known memory', async () => {
  expect(crossOriginIsolated).toBe(true);
  const worker = new Worker(new URL('./session-worker.ts', import.meta.url), { type: 'module' });
  const state = createSharedState({ map: new SharedMap('number').set('seed', 1) }, { channel: 'browser-proof', copy: false });
  try {
    const initial = result(worker, 0); await state.connect(worker);
    expect((await initial).memoryHandles).toBeGreaterThan(0);
    const next = result(worker, 1);
    state.update('map', map => map.setMany(Array.from({ length: 10000 }, (_, i) => [`n${i}`, i])));
    state.update('map', map => map.set('seed', 2));
    expect(await next).toMatchObject({ seed: 2, oldSeed: 1, last: 9999, memoryHandles: 0, readOnly: true, isolated: true });
    const moved = result(worker, 2); state.update('map', map => compact(map));
    expect(await moved).toMatchObject({ seed: 2, oldSeed: 1, last: 9999, memoryHandles: 1, readOnly: true });
  } finally { state.dispose(); worker.terminate(); }
}, 20000);

it('validates overlapping batches on a live worker pool while a lane moves', async () => {
  const west = [0, 0, 1, 1] as const, east = [9, 0, 10, 1] as const;
  const base = buildSpatialIndex([{ id: 7, bounds: west }]);
  const state = createSharedState({
    rows: new SharedMap('number').set('lane', 0),
    geometry: new SharedList('number').pushMany(west),
    changes: applySpatialEdits(undefined, 0, []),
  });
  const workers = await pool<typeof spatialTasks>(
    () => new Worker(new URL('./spatial-pool-worker.ts', import.meta.url), { type: 'module' }),
    { state, size: 2, memory: 'share' },
  );
  try {
    const jobs = Array.from({ length: 16 }, (_, i) => ({ base, viewport: i % 2 ? east : west }));
    const original = workers.map.validate(jobs, { snapshot: 'batch' });
    state.update(old => ({
      rows: old.rows.set('lane', 1),
      geometry: new SharedList('number').pushMany(east),
      changes: applySpatialEdits(old.changes, 1, [{ id: 7, bounds: east }]),
    }));
    const moved = workers.map.validate(jobs, { snapshot: 'batch' });
    const results = await Promise.all([original, moved]);
    for (const [revision, batch] of results.entries()) {
      const bounds = revision === 0 ? west : east;
      expect(batch).toEqual(jobs.map(job => ({ revision, bounds, visible: job.viewport === bounds ? [7] : [] })));
    }
    expect(await workers.run.validate({ base, viewport: east })).toEqual({ revision: 1, bounds: east, visible: [7] });
  } finally { workers.dispose(); state.dispose(); }
});

it('uses matching row, geometry and index roots for outstanding viewport jobs on two workers', async () => {
  const base = buildSpatialIndex([{ id: 7, bounds: [0, 0, 1, 1] }]);
  const session = createSharedSession({
    rows: new SharedMap('number').set('lane', 0),
    geometry: new SharedList('number').pushMany([0, 0, 1, 1]),
    changes: applySpatialEdits(undefined, 0, []),
  }, { copy: false });
  const jobs = [1, 2, 3].map(version => ({
    version, viewport: [version * 10, 0, version * 10 + 1, 1] as const,
  }));
  const peers = [0, 1].map(() => {
    const worker = new Worker(new URL('./spatial-publication-worker.ts', import.meta.url), { type: 'module' });
    const { port1, port2 } = new MessageChannel();
    const receive = () => new Promise<any>((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = reject;
    });
    const waiting = receive();
    worker.postMessage({ port: port2, jobs, base }, [port2]);
    return { worker, port1, waiting, receive };
  });
  try {
    await session.connect(peers.map(p => p.port1));
    for (const peer of peers) expect(await peer.waiting).toEqual({ waiting: true });
    const replies = Promise.all(peers.map(p => p.receive()));
    for (const { version, viewport } of jobs) {
      expect(session.publish({
        rows: session.current.rows.set('lane', version),
        geometry: new SharedList('number').pushMany(viewport),
        changes: applySpatialEdits(session.current.changes, version, [{ id: 7, bounds: viewport }]),
      })).toBe(version);
    }
    for (const reply of await replies) expect(reply.results).toEqual([
      { revision: 1, bounds: jobs[0].viewport, visible: [7] }, null,
      { revision: 3, bounds: jobs[2].viewport, visible: [7] },
    ]);
  } finally {
    session.dispose();
    for (const peer of peers) { peer.port1.close(); peer.worker.terminate(); }
  }
});
