import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData, MessageChannel } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const paths = isMainThread ? process.argv.slice(2) : workerData.paths;
const S = await import(pathToFileURL(join(isMainThread ? paths[0] : paths[1], 'dist/shared.js')));
const report = x => console.log(JSON.stringify(x));
function check(data, readOnly) {
  assert.equal(data.sorted.get('0000'), 0); assert.equal(data.sorted.get('4095'), 4095); assert.equal(data.sorted.size, 4096);
  assert.deepEqual([...data.sortedSet.values()], [1, '1', 'z']); assert.equal(data.nested.get('sorted').get('1024'), 1024);
  assert.deepEqual(data.sorted.toWorkerData(), data.again.toWorkerData()); assert.equal(data.earlier.get('0000'), 0); assert.equal(data.earlier.has('4095'), false);
  if (readOnly) { assert.throws(() => data.sorted.set('blocked', 1), /read-only/); assert.throws(() => data.sortedSet.add('blocked'), /read-only/); }
}
if (!isMainThread) {
  let old;
  parentPort.on('message', async message => {
    try {
      if (message.phase === 'initial') {
        old = await S.initWorker(message.payload); check(old, true); const fresh = S.compact(old.sorted); assert.equal(fresh.set('writable', 7).get('writable'), 7); assert.equal(old.sorted.has('writable'), false);
        parentPort.postMessage({ phase: 'initial', writableCompaction: true });
      } else {
        const next = await S.initWorker(message.payload); check(old, true); assert.equal(next.sorted.get('later'), 99); assert.equal(next.grow.get('large').length, 200000); parentPort.postMessage({ phase: 'growth', retainedRoots: true });
      }
    } catch (e) { parentPort.postMessage({ error: e.stack }); }
  });
} else {
  const [producer, reader, copyText] = paths, copy = copyText === 'copy';
  let sorted = new S.SharedSortedMap('number'), earlier;
  for (let i = 0; i < 4096; i++) { sorted = sorted.set(String(i).padStart(4, '0'), i); if (i === 5) earlier = sorted; }
  const sortedSet = new S.SharedSortedSet().add(1).add('1').add('z'), nested = new S.SharedMap('SharedSortedMap<number>').set('sorted', sorted), grow = new S.SharedMap('string');
  const group = S.compactMany({ sorted, sortedSet, nested, again: sorted, earlier, grow }); check(group, false);
  const worker = new Worker(new URL(import.meta.url), { workerData: { paths } });
  const exchange = message => new Promise((resolve, reject) => { const onMessage = x => { clean(); x.error ? reject(new Error(x.error)) : resolve(x); }, onError = e => { clean(); reject(e); }, timer = setTimeout(() => { clean(); reject(new Error('Worker response safety timeout')); }, 20000); function clean() { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); } worker.once('message', onMessage); worker.once('error', onError); worker.postMessage(message); });
  try {
    const initial = S.getWorkerData(group, { copy }), first = await exchange({ phase: 'initial', payload: initial });
    const next = { ...group, sorted: group.sorted.set('later', 99), grow: group.grow.set('large', 'x'.repeat(200000)) };
    const second = await exchange({ phase: 'growth', payload: S.getWorkerData(next, { copy }) });
    report({ producer, reader, mode: copyText, first, second, format: initial.version });
  } finally { await worker.terminate(); }
  // The official portable worker entry runs session publication for this producer.
  const W = await import(pathToFileURL(join(producer, 'dist/worker.js'))), { port1, port2 } = new MessageChannel();
  const state = W.createSharedState({ sorted: group.sorted }, { copy, channel: 'sorted-compaction-proof' }); let receiver;
  try {
    const receiving = W.connectSharedSession({ endpoint: port2, channel: 'sorted-compaction-proof' }); await state.connect(port1); receiver = await receiving; const retained = receiver.current.sorted;
    const waitNext = () => new Promise((resolve, reject) => { const timer = setTimeout(() => { off(); reject(new Error('Session response safety timeout')); }, 20000); const off = receiver.subscribe(() => { clearTimeout(timer); off(); resolve(); }); });
    let pending = waitNext(); state.value = S.compactMany(state.current); await pending; assert.deepEqual([...receiver.current.sorted.entries()], [...group.sorted.entries()]);
    pending = waitNext(); state.update('sorted', m => m.set('session', 77)); await pending; assert.equal(receiver.current.sorted.get('session'), 77); assert.equal(retained.has('session'), false); report({ mode: copyText, sessionPublication: 'pass' });
  } finally { receiver?.dispose(); state.dispose(); port1.close(); port2.close(); }
}
