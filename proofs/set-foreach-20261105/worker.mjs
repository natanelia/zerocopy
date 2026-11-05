import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const directory = isMainThread ? resolve(process.argv[2]) : workerData.directory;
const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
function collect(record) {
  const output = {};
  for (const [name, set] of Object.entries(record)) {
    const values = [];
    assert.equal(set.forEach(function (value) {
      assert.equal(this, undefined); assert.equal(arguments.length, 1); values.push(value);
    }), undefined);
    output[name] = values;
  }
  return output;
}
function invariant(record) {
  const packet = S.getWorkerData(record);
  return { used: packet.arenas.map(a => a.used),
    bytes: packet.arenas.map(a => new Uint8Array(a.memory.buffer, 65536, a.used - 65536).slice()) };
}

if (!isMainThread) {
  const old = await S.initWorker(workerData.packet), before = invariant(old);
  const iterators = Object.fromEntries(Object.entries(old).map(([name, value]) => [name, value.values()]));
  const first = Object.fromEntries(Object.entries(iterators).map(([name, value]) => [name, value.next().value]));
  parentPort.postMessage({ stage: 'attached', values: collect(old) });
  const [nextPacket] = await once(parentPort, 'message');
  const next = await S.initWorker(nextPacket);
  const continued = Object.fromEntries(Object.entries(iterators).map(([name, iterator]) => [name, [first[name], ...iterator]]));
  const oldValues = collect(old), nextValues = collect(next);
  assert.deepEqual(invariant(old), before);
  parentPort.postMessage({ stage: 'grown', oldValues, nextValues, continued });
  parentPort.close();
} else {
  const rows = [];
  for (const copy of [false, true]) {
    S.resetMap(); S.resetOrderedSet(); S.resetSortedSet();
    const original = { set: new S.SharedSet(), ordered: new S.SharedOrderedSet(), sorted: new S.SharedSortedSet() };
    for (const name of Object.keys(original)) for (let i = 0; i < 128; i++) original[name] = original[name].add(i % 2 ? `value-${i}` : i);
    const expectedOld = Object.fromEntries(Object.entries(original).map(([name, value]) => [name, [...value.values()]]));
    const packet = S.getWorkerData(original, { copy });
    const worker = new Worker(new URL(import.meta.url), { workerData: { directory, packet } });
    const exit = once(worker, 'exit');
    const [attached] = await once(worker, 'message');
    assert.equal(attached.stage, 'attached'); assert.deepEqual(attached.values, expectedOld);
    const buffers = S.getWorkerData(original).arenas.map(a => a.memory.buffer);
    const changed = Object.fromEntries(Object.entries(original).map(([name, value]) => [name, value.add(`${name}:${'x'.repeat(262144)}`).delete(0)]));
    const grown = S.getWorkerData(changed);
    assert.ok(grown.arenas.every((a, i) => a.memory.buffer.byteLength > buffers[i].byteLength), 'grow all writer arenas');
    const expectedNext = Object.fromEntries(Object.entries(changed).map(([name, value]) => [name, [...value.values()]]));
    const response = once(worker, 'message');
    worker.postMessage(S.getWorkerData(changed, { copy }));
    const [result] = await response;
    assert.equal(result.stage, 'grown'); assert.deepEqual(result.oldValues, expectedOld);
    assert.deepEqual(result.continued, expectedOld); assert.deepEqual(result.nextValues, expectedNext);
    const [code] = await exit; assert.equal(code, 0);
    rows.push({ copy, sets: 3, oldSize: 128, nextSize: 128, oldSnapshotsAndPausedIteratorsRetained: true, actualGrowth: true });
  }
  console.log(JSON.stringify({ runtime: process.versions, passed: rows }, null, 2));
}
