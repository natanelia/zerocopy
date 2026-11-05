import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as S from '../../dist/shared.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (!isMainThread) {
  const { map } = await S.initWorker(workerData);
  const keys = map.keys(), values = map.values(), entries = map.entries();
  const first = [keys.next().value, values.next().value, entries.next().value];
  parentPort.postMessage('paused-after-pending');
  await once(parentPort, 'message');
  const result = { keys: [first[0], ...keys], values: [first[1], ...values], entries: [first[2], ...entries] };
  assert.throws(() => map.set('forbidden', 'no'), /read-only/);
  parentPort.postMessage({ ...result, readOnly: true });
} else {
  const encoder = new TextEncoder();
  for (const copy of [false, true]) {
    S.resetSortedMap();
    let map = new S.SharedSortedMap('string'); const model = new Map(), prefix = 'shared/界🙂/'.repeat(8);
    const key = i => `${prefix}m-${String(i).padStart(6, '0')}`;
    const put = (key, value) => { map = map.set(key, value); model.set(key, value); };
    for (let i = 0; i < 31; i++) put(key(i), `\ufeffvalue-${i}-🙂`);
    for (const [k, value] of [[`${prefix}a-first`, 'first'], [`${prefix}a-second`, 'second'], [key(7), 'replacement'], [`${prefix}z-last`, 'last']]) put(k, value);
    const descriptor = map.toWorkerData(), source = S.getWorkerData({ map }, { copy: false }).arenas[0], before = source.memory.buffer;
    const view = new DataView(before);
    assert.equal(view.getUint32(descriptor.root, true), 0xffffffff); assert.equal(view.getUint32(descriptor.root + 12, true), 4);
    const beforeHash = digest(new Uint8Array(before, 65536, source.used - 65536));
    const expected = [...model].sort(([a], [b]) => Buffer.compare(encoder.encode(a), encoder.encode(b)));
    const worker = new Worker(new URL(import.meta.url), { workerData: S.getWorkerData({ map }, { copy }) });
    const timer = setTimeout(() => { console.error('Sorted journal worker proof timed out'); process.exit(1); }, 15000);
    try {
      assert.deepEqual(await once(worker, 'message'), ['paused-after-pending']);
      let writer = map;
      for (let i = 0; i < 64; i++) writer = writer.set(`growth-${i}`, 'grow界🙂'.repeat(1024));
      assert.notEqual(source.memory.buffer, before);
      assert.equal(writer.has('growth-0'), true); assert.equal(map.has('growth-0'), false);
      S.resetSortedMap(); new S.SharedSortedMap('number').set('new arena', 123);
      const reply = once(worker, 'message'); worker.postMessage('resume');
      const [result] = await reply;
      assert.deepEqual(result, { keys: expected.map(row => row[0]), values: expected.map(row => row[1]), entries: expected, readOnly: true });
      assert.equal(digest(new Uint8Array(source.memory.buffer, 65536, source.used - 65536)), beforeHash);
    } finally { clearTimeout(timer); await worker.terminate(); }
    console.log(`Sorted journal scans retained complete old outputs after a pending yield, writer growth and reset (${copy ? 'copy' : 'shared'}).`);
  }
}
