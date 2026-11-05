import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedMap, SharedList, compactMany, getWorkerData } from '../../dist/shared.js';
import { createSharedState, connectSharedSession } from '../../dist/worker.js';

const names = Array.from({ length: 128 }, (_, i) => `collection-${i}`);
const expectedKeys = ['2', '10', ...names, '__proto__', 'constructor'];

function waitFor(worker, version) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing version ${version}`)), 15000);
    const onMessage = value => {
      if (value.proof === 'error') finish(new Error(value.message));
      else if (value.proof === 'snapshot' && value.version === version) finish(undefined, value);
    };
    const onError = error => finish(error);
    const finish = (error, value) => {
      clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    worker.on('message', onMessage); worker.on('error', onError);
  });
}

if (!isMainThread) {
  const copy = workerData.copy;
  const reader = await connectSharedSession({ endpoint: parentPort, channel: 'record-capture-proof' });
  const original = reader.current;
  let previous = original;
  const report = (value, version) => {
    try {
      assert.ok(Object.isFrozen(value)); assert.equal(Object.getPrototypeOf(value), null);
      assert.deepEqual(Object.keys(value), expectedKeys);
      for (let i = 0; i < names.length; i++) {
        const collection = value[names[i]];
        assert.ok(Object.isFrozen(collection));
        if (i % 2) assert.deepEqual(collection.toArray(), [i, -i]);
        else {
          assert.equal(collection.get('value'), i === 0 && version ? -1 : i);
          if (i === 0 && version) assert.equal(collection.get('added-19999'), 19999);
        }
        if (version === 1 && i > 0) assert.strictEqual(collection, previous[names[i]]);
        assert.equal(i % 2 ? original[names[i]].get(0) : original[names[i]].get('value'), i);
      }
      assert.equal(value.__proto__.get('value'), 0);
      assert.equal(value.constructor.get('value'), 0);
      assert.equal(value['2'].get('value'), 0);
      assert.equal(value['10'].get('value'), 0);
      assert.throws(() => value[names[0]].set('forbidden', 1), /read-only/);
      previous = value;
      parentPort.postMessage({ proof: 'snapshot', version, copy, names: Object.keys(value).length });
    } catch (error) { parentPort.postMessage({ proof: 'error', message: error.stack }); }
  };
  reader.subscribe(report);
  report(reader.current, reader.version);
} else {
  for (const copy of [false, true]) {
    const input = Object.create(null);
    for (let i = 0; i < names.length; i++) input[names[i]] = i % 2
      ? new SharedList('number').pushMany([i, -i]) : new SharedMap('number').set('value', i);
    input.__proto__ = input[names[0]];
    input.constructor = input[names[0]];
    input['2'] = input[names[0]];
    input['10'] = input[names[0]];
    let getters = 0;
    Object.defineProperty(input, 'hidden', { get() { getters++; throw new Error('hidden getter ran'); } });
    Object.defineProperty(input, Symbol('hidden'), { get() { getters++; throw new Error('hidden symbol getter ran'); } });
    const state = createSharedState(input, { copy, channel: 'record-capture-proof' });
    const worker = new Worker(new URL(import.meta.url), { workerData: { copy } });
    const old = state.current;
    try {
      const initial = waitFor(worker, 0);
      await state.connect(worker); assert.equal((await initial).names, 132);
      const memory = getWorkerData({ map: old[names[0]] }, { copy: false }).arenas[0].memory;
      const beforeBytes = memory.buffer.byteLength;
      const changed = old[names[0]].setMany(Array.from({ length: 20000 }, (_, i) => [`added-${i}`, i])).set('value', -1);
      assert.ok(memory.buffer.byteLength > beforeBytes);
      const received = waitFor(worker, 1);
      assert.equal(state.publish({ ...old, [names[0]]: changed }), 1);
      assert.equal((await received).copy, copy);
      assert.equal(state.publish({ ...state.current }), 1);
      const invalid = { ...state.current };
      Object.defineProperty(invalid, 'bad', { enumerable: true, get() { getters++; throw new Error('bad getter ran'); } });
      assert.throws(() => state.publish(invalid), /getters or setters/);
      assert.equal(state.version, 1); assert.equal(getters, 0);
      const moved = waitFor(worker, 2);
      assert.equal(state.publish(compactMany(state.current)), 2);
      await moved;
      assert.equal(old[names[0]].get('value'), 0);
      assert.equal(old[names[0]].get('added-19999'), undefined);
    } finally { state.dispose(); await worker.terminate(); }
  }
  console.log('Worker record capture proof passed: 132 names, special keys, shared/copy transports, unchanged identities, retained values, growth, validation failures and compaction.');
}
