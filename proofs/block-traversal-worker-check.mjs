import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
const module = new URL(process.argv[2] ?? '../dist/shared.js', import.meta.url).href;
const api = await import(module), rows = [];
for (const name of ['SharedLinkedList', 'SharedDoublyLinkedList']) for (const copy of [false, true]) {
  for (const reverse of name === 'SharedDoublyLinkedList' ? [false, true] : [false]) {
    let item = api.compact(new api[name]('number'));
    const special = [-0, NaN, Infinity, -Infinity, Number.MIN_VALUE, 0.25];
    const expected = Array.from({ length: 129 }, (_, i) => special[i % special.length]);
    for (const value of expected) item = item.append(value);
    const fork = item.prepend(-999);
    let nested = api.compact(new api[name](`${name}<number>`));
    for (let i = 0; i < 65; i++) nested = nested.append(i % 2 ? item : fork);
    const nestedExpected = Array.from({ length: 65 }, (_, i) => i % 2 ? expected : [-999, ...expected]);
    const data = api.getWorkerData({ item, fork, nested }, { copy });
    const memories = api.getWorkerData({ item, nested }, { copy: false }).arenas.map(arena => arena.memory);
    const before = memories.map(memory => memory.buffer.byteLength), gate = new SharedArrayBuffer(4), control = new Int32Array(gate);
    const worker = new Worker(new URL('./block-traversal-worker.mjs', import.meta.url));
    try {
      const result = await new Promise((resolve, reject) => {
        let paused = false;
        const timeout = setTimeout(() => reject(new Error('Block worker proof timed out')), 40000);
        worker.on('error', error => { clearTimeout(timeout); reject(error); });
        worker.on('exit', code => { if (code) { clearTimeout(timeout); reject(new Error(`Worker exit ${code}`)); } });
        worker.on('message', message => {
          try {
            if (message.type === 'paused') {
              assert.equal(paused, false); paused = true;
              for (let i = 0; i < memories.length; i++) { memories[i].grow(2); assert.ok(memories[i].buffer.byteLength > before[i]); }
              assert.deepEqual(item.append(777).toArray(), [...expected, 777]);
              Atomics.store(control, 0, 1); Atomics.notify(control, 0);
            } else {
              clearTimeout(timeout); assert.ok(paused);
              if (message.type === 'error') throw new Error(message.error);
              assert.equal(message.type, 'done'); resolve(message);
            }
          } catch (error) { clearTimeout(timeout); reject(error); }
        });
        worker.postMessage({ module, data, gate, reverse });
      });
      assert.equal(result.writeRejected, true);
      assert.deepEqual(result.values, reverse ? expected.slice().reverse() : expected);
      const indices = expected.map((_, i) => i);
      assert.deepEqual(result.indices, reverse ? indices.reverse() : indices);
      for (const key of ['array', 'compacted']) assert.deepEqual(result[key], expected);
      for (const key of ['fork', 'compactedFork']) assert.deepEqual(result[key], [-999, ...expected]);
      for (const key of ['nested', 'compactedNested']) assert.deepEqual(result[key], nestedExpected);
      rows.push({ name, copy, reverse, pausedInsideBlocks: true, grownArenas: memories.length });
    } finally { Atomics.store(control, 0, 1); Atomics.notify(control, 0); await worker.terminate(); }
  }
}
console.log(JSON.stringify({ module, checks: rows }, null, 2));
