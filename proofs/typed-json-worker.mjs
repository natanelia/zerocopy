import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedMap, SharedList, json, list, getWorkerData, initWorker, compact, resetMap, resetSharedList } from '../dist/shared.js';

const lane = { id: 'lane-1', speedLimit: 50, centerline: [[103.85, 1.29]] };

function checkOld(state) {
  assert.deepEqual(state.lanes.get('lane-1'), lane);
  const values = state.tiles.get('tile-1');
  assert.equal(values.size, 1);
  assert.deepEqual(values.get(0), lane);
  assert(Object.isFrozen(values.get(0).centerline[0]));
  assert.throws(() => { values.get(0).centerline[0][0] = 0; }, TypeError);
  assert.throws(() => values.push(lane), /read-only/);
}

if (!isMainThread) {
  let previous;
  parentPort.on('message', async ({ stage, data }) => {
    try {
      const state = await initWorker(data);
      if (stage === 'old') {
        previous = state;
        checkOld(previous);
        if (!workerData.copy) {
          // Test-only scratch below the data heap. No published node is changed.
          const arena = data.arenas.find(a => a.id === data.structures.lanes.arena);
          Atomics.store(new Int32Array(arena.memory.buffer, 64000, 1), 0, 73);
        }
      } else {
        checkOld(previous);
        assert.equal(state.lanes.get('lane-1').speedLimit, 70);
        assert.equal(state.lanes.get('large').label.length, 200000);
        assert.equal(state.tiles.get('tile-1').size, 2);
        assert.throws(() => state.lanes.set('lane-1', lane), /read-only/);
        const owned = compact(state.lanes).set('lane-1', lane);
        assert.deepEqual(owned.get('lane-1'), lane);
        assert.equal(state.lanes.get('lane-1').speedLimit, 70);
      }
      parentPort.postMessage({ stage, ok: true });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  for (const copy of [false, true]) {
    const value = json();
    const lanes = new SharedMap(value).set('lane-1', lane);
    const lines = new SharedList(value).push(lane);
    const tiles = new SharedMap(list(value)).set('tile-1', lines);
    const worker = new Worker(new URL(import.meta.url), { workerData: { copy } });
    const timer = setTimeout(() => { console.error('Typed JSON worker test timed out'); process.exit(1); }, 30000);
    async function exchange(stage, data) {
      const reply = once(worker, 'message');
      worker.postMessage({ stage, data });
      const [result] = await reply;
      if (result.error) throw new Error(result.error);
      assert.deepEqual(result, { stage, ok: true });
    }
    try {
      const initial = getWorkerData({ lanes, tiles }, { copy });
      await exchange('old', initial);
      if (!copy) {
        const arena = initial.arenas.find(a => a.id === initial.structures.lanes.arena);
        assert.equal(Atomics.load(new Int32Array(arena.memory.buffer, 64000, 1), 0), 73);
      }
      const next = lanes.set('lane-1', { ...lane, speedLimit: 70 })
        .set('large', { ...lane, label: '🙂'.repeat(100000) });
      const nextTiles = tiles.set('tile-1', lines.push({ ...lane, id: 'lane-2' }));
      resetMap(); resetSharedList();
      await exchange('new', getWorkerData({ lanes: next, tiles: nextTiles }, { copy }));
      assert.deepEqual(lanes.get('lane-1'), lane);
      assert.equal(tiles.get('tile-1').size, 1);
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }
  console.log('Typed JSON worker tests passed: shared memory, copy transport, nested values, retained snapshots, memory growth, and compaction.');
}
