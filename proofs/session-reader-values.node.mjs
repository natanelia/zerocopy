import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedMap, SharedList, compactMany, getWorkerData, resetMap, resetSharedList } from '../dist/shared.js';
import { createSharedState, connectSharedSession } from '../dist/worker.js';

if (!isMainThread) {
  const reader = await connectSharedSession({ endpoint: parentPort, channel: 'decoded-values' });
  const original = reader.current, first = original.map.get('stable');
  const report = (value, version) => {
    const stable = value.map.get('stable');
    parentPort.postMessage({
      proof: 'decoded-values', version,
      same: stable === first,
      stable, changed: value.map.get('changed'),
      tail: value.strings.get(value.strings.size - 1),
      oldChanged: original.map.get('changed'),
      oldString: original.strings.get(1),
      frozen: Object.isFrozen(stable) && Object.isFrozen(stable.nested),
    });
    if (version === 2) {
      reader.dispose();
      assert.deepEqual(original.map.get('stable'), first);
      parentPort.postMessage({ proof: 'retained-after-close', copy: workerData.copy });
    }
  };
  report(reader.current, reader.version);
  reader.subscribe(report);
} else {
  function response(worker, version, proof = 'decoded-values') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Missing decoded-values version ${version}`)), 10000);
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Worker exited before ${proof} ${version}: ${code}`));
      const onMessage = value => {
        if (value.proof === proof && value.version === version) finish(undefined, value);
      };
      function finish(error, value) {
        clearTimeout(timer); worker.off('error', onError); worker.off('exit', onExit); worker.off('message', onMessage);
        error ? reject(error) : resolve(value);
      }
      worker.on('error', onError); worker.on('exit', onExit); worker.on('message', onMessage);
    });
  }

  for (const copy of [false, true]) test(`real session decode reuse, copy=${copy}`, async () => {
    resetMap(); resetSharedList();
    const state = createSharedState({
      map: new SharedMap('object').set('stable', { nested: [1, false, null] }).set('changed', { n: 0 }),
      strings: new SharedList('string').pushMany(['', 'Å🙂'.repeat(40)]),
    }, { copy, channel: 'decoded-values' });
    const worker = new Worker(new URL(import.meta.url), { workerData: { copy } });
    try {
      const first = response(worker, 0);
      await state.connect(worker);
      const initial = await first;
      assert.equal(initial.same, true); assert.equal(initial.frozen, true);
      const memory = getWorkerData({ strings: state.current.strings }, { copy: false }).arenas[0].memory;
      const capacity = memory.buffer.byteLength;
      const next = response(worker, 1);
      state.update(value => ({
        map: value.map.set('changed', { n: 1 }),
        strings: value.strings.push('x'.repeat(300000)),
      }));
      const updated = await next;
      assert.equal(updated.same, !copy);
      assert.deepEqual(updated.changed, { n: 1 });
      assert.deepEqual(updated.oldChanged, { n: 0 });
      assert.equal(updated.oldString, 'Å🙂'.repeat(40));
      assert.equal(updated.tail.length, 300000);
      assert.ok(memory.buffer.byteLength > capacity);
      assert.equal(updated.frozen, true);
      const compacted = response(worker, 2);
      const closed = response(worker, undefined, 'retained-after-close');
      state.value = compactMany(state.current);
      const result = await compacted;
      assert.equal(result.same, false);
      assert.deepEqual(result.stable, initial.stable);
      assert.deepEqual(result.oldChanged, { n: 0 });
      assert.equal(result.frozen, true);
      assert.equal((await closed).copy, copy);
    } finally { state.dispose(); await worker.terminate(); }
  });
}
