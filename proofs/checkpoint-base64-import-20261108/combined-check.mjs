import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against a build containing both the heap-compaction and byte-decoder
// changes. This checks their interaction; it collects no timing measurements.
const root = resolve(process.argv[2] ?? '.');
const S = await import(pathToFileURL(join(root, 'dist/shared.js')));
const R = await import(pathToFileURL(join(root, 'dist/redux.js')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

let queue = new S.SharedPriorityQueue('object');
for (let i = 0; i < 2049; i++) queue = queue.enqueue({ id: i, label: `road/${i}/街道🙂`, point: [i / 4, -i / 8] }, (i * 53) % 257);
const fork = queue.enqueue({ id: -1, label: 'fork', point: [-1, -1] }, -1);
const values = Array.from({ length: 65 }, (_, i) => `${i}:` + '街道🙂\0'.repeat(1024));
const list = new S.SharedList('string').pushMany(values);
const owners = { queue, fork, list };
const expected = { queue: [...queue.entries()], fork: [...fork.entries()], list: values };
const before = S.getWorkerData(owners, { copy: false }).arenas.map(arena => ({
  id: arena.id, used: arena.used, memory: arena.memory,
  hash: hash(new Uint8Array(arena.memory.buffer, 0, arena.used)),
}));
const state = { ...owners, again: queue, ui: { selected: -0, label: 'retained', missing: undefined } };
const packet = R.encodeZerocopyState(state), text = JSON.stringify(packet);
const verify = restored => {
  assert.equal(restored.queue, restored.again);
  assert.deepEqual([...restored.queue.entries()], expected.queue);
  assert.deepEqual([...restored.fork.entries()], expected.fork);
  assert.deepEqual(restored.list.toArray(), expected.list);
  assert.deepEqual(restored.ui, state.ui);
  for (const value of [restored, restored.queue, restored.fork, restored.list, restored.ui]) assert.ok(Object.isFrozen(value));
};

let restoredCount = 0, attachments = 0;
for (const restored of [R.decodeZerocopyState(packet), R.deserializeZerocopyState(text)]) {
  verify(restored); restoredCount++;
  const copied = S.compactMany({ queue: restored.queue, fork: restored.fork, list: restored.list, again: restored.queue });
  assert.equal(copied.queue, copied.again);
  assert.deepEqual([...copied.queue.entries()], expected.queue);
  assert.deepEqual([...copied.fork.entries()], expected.fork);
  assert.deepEqual(copied.list.toArray(), values);
  const updated = restored.queue.enqueue({ id: -2, label: 'new'.repeat(300000), point: [0, 0] }, -2);
  assert.equal(updated.peek().id, -2);
  verify(restored);
  for (const copy of [false, true]) {
    const reader = await S.initWorker(S.getWorkerData(copied, { copy }));
    assert.deepEqual([...reader.queue.entries()], expected.queue);
    assert.deepEqual([...reader.fork.entries()], expected.fork);
    assert.deepEqual(reader.list.toArray(), values);
    assert.throws(() => reader.queue.enqueue({ id: -3 }, -3), /read-only/);
    attachments++;
  }
  const again = R.decodeZerocopyState(R.encodeZerocopyState(restored));
  verify(again); restoredCount++;
}
assert.equal(JSON.stringify(packet), text);
for (const arena of S.getWorkerData(owners, { copy: false }).arenas) {
  const original = before.find(value => value.id === arena.id);
  assert.ok(original); assert.equal(arena.memory, original.memory); assert.equal(arena.used, original.used);
  assert.equal(hash(new Uint8Array(arena.memory.buffer, 0, arena.used)), original.hash);
}
assert.deepEqual([...queue.entries()], expected.queue);
assert.deepEqual([...fork.entries()], expected.fork);
assert.deepEqual(list.toArray(), values);
console.log(JSON.stringify({ passed: true, runtime: process.versions, restoredCount, attachments,
  heapNodes: queue.size, forksAndAliases: true, writableImports: true, retainedSnapshots: true,
  sourceBytesUnchanged: true, checkpointBytes: packet.arenas.reduce((sum, arena) => sum + arena.used, 0) }));
