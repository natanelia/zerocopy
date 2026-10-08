import assert from 'node:assert/strict';
import { parentPort } from 'node:worker_threads';
let api, items, pending, snapshot;
parentPort.on('message', async message => {
  try {
    if (message.type === 'attach') {
      api = await import(message.module);
      items = await api.initWorker(message.data);
      pending = Object.fromEntries(Object.entries(items).filter(([name]) => !['nested', 'list', 'set', 'sortedSet'].includes(name)).map(([name, item]) => [name, { iterators: [item.entries(), item.entries()], output: [[], []] }]));
      snapshot = api.getWorkerData(items, { copy: false }).arenas.map(a => ({ memory: a.memory, used: a.used, bytes: new Uint8Array(a.memory.buffer).slice(65536, a.used) }));
      parentPort.postMessage({ type: 'created' });
    } else if (message.type === 'first') {
      for (const p of Object.values(pending)) p.iterators.forEach((iterator, i) => { const next = iterator.next(); if (!next.done) p.output[i].push(next.value); });
      parentPort.postMessage({ type: 'paused' });
    } else if (message.type === 'resume') {
      const result = {};
      for (const [name, { iterators, output }] of Object.entries(pending)) {
        let active = true;
        while (active) {
          active = false;
          iterators.forEach((iterator, i) => { const next = iterator.next(); if (!next.done) { active = true; output[i].push(next.value); } });
        }
        assert.deepEqual(output[0], output[1]);
        const item = items[name], visited = [];
        item.forEach((value, key) => { for (const _ of item.entries()) break; visited.push([key, value]); });
        const abandoned = item.entries(); abandoned.next(); assert.equal(abandoned.return().done, true);
        const thrown = item.entries(); thrown.next(); const error = new Error('stop');
        assert.throws(() => thrown.throw(error), e => e === error); assert.equal(thrown.next().done, true);
        assert.throws(() => item.set('forbidden', 1), /read-only/);
        result[name] = { entries: output[0], keys: [...item.keys()], values: [...item.values()], visited };
      }
      result.nested = [...items.nested.get('child').entries()];
      result.list = items.list.get('child').toArray();
      result.set = [...items.set.values()]; result.sortedSet = [...items.sortedSet.values()];
      const after = api.getWorkerData(items, { copy: false }).arenas;
      assert.deepEqual(after.map(a => a.used), snapshot.map(a => a.used), 'no shared allocator changes in reader');
      for (const a of snapshot) assert.deepEqual(new Uint8Array(a.memory.buffer, 65536, a.bytes.length), a.bytes, 'reader source bytes unchanged');
      parentPort.postMessage({ type: 'done', result, allocatedSharedBytes: 0, verifiedArenas: snapshot.length });
    } else throw new Error('Unknown worker message');
  } catch (error) { parentPort.postMessage({ type: 'error', error: String(error.stack ?? error) }); }
});
