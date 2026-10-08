import assert from 'node:assert/strict';
import { MessageChannel, Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const directory = isMainThread ? process.argv[2] : workerData.directory;
const variant = isMainThread ? process.argv[3] : workerData.variant;
const probe = globalThis.__streamProof = {
  allocations: 0, queues: [],
  allocate(value) { this.allocations++; return value; },
  register(read) { this.queues.push(read); },
};
const { SharedMap, resetMap } = await import(pathToFileURL(`${directory}/shared.mjs`).href);
const { createSharedSession, connectSharedSession } = await import(pathToFileURL(`${directory}/worker.mjs`).href);
const latestQueue = () => probe.queues.at(-1);
const count = () => probe.allocations;
const rejected = async (promise, reason) => {
  await assert.rejects(promise, error => reason instanceof Error ? error === reason : reason.test(error.message));
};

async function checkReader(reader, produce) {
  const trace = [], allocation = {};
  const publish = async amount => {
    const target = reader.version + amount;
    const arrived = new Promise(resolve => {
      const unsubscribe = reader.subscribe((_value, version) => {
        if (version === target) { unsubscribe(); resolve(); }
      });
    });
    produce(amount);
    await arrived;
    assert.equal(reader.version, target);
    trace.push(['version', target, reader.current.get('x')]);
  };
  const checkValue = async (stream, expected = reader.current) => {
    const value = await stream.next();
    assert.equal(value.done, false); assert.equal(value.value, expected);
  };

  assert.equal(reader.version, 0);
  const initial = reader.current, first = reader.snapshots();
  await checkValue(first, initial); assert.equal(latestQueue()().length, 0);
  await first.return();

  const start = count(), paused = reader.snapshots(), queue = latestQueue();
  assert.equal(count() - start, 1);
  let accepted = 0;
  const unsubscribe = reader.subscribe(() => accepted++);
  await publish(10000); unsubscribe();
  assert.equal(accepted, 10000, 'Every publication must reach the paused stream');
  allocation.paused10000 = count() - start;
  assert.equal(allocation.paused10000, variant === 'baseline' ? 10001 : 1);
  assert.deepEqual(queue(), [reader.current]);
  const current = reader.current;
  await checkValue(paused); assert.deepEqual(queue(), []);
  assert.equal(initial.get('x'), 0); assert.equal(current.get('x'), 0);
  const beforeReturn = count(); await paused.return(); assert.deepEqual(queue(), []);
  allocation.return = count() - beforeReturn;
  assert.equal(allocation.return, variant === 'baseline' ? 1 : 0);

  // A pending consumer bypasses the queue, and a second next() must still reject.
  const waiting = reader.snapshots({ emitCurrent: false }), waitingQueue = latestQueue();
  const waitingStart = count();
  for (let index = 0; index < 8; index++) {
    let settled = false;
    const next = waiting.next().then(value => { settled = true; return value; });
    await Promise.resolve(); assert.equal(settled, false);
    await rejected(waiting.next(), /sequentially/);
    await publish(1);
    assert.equal((await next).value, reader.current); assert.deepEqual(waitingQueue(), []);
  }
  allocation.waiting8 = count() - waitingStart;
  assert.equal(allocation.waiting8, 0); await waiting.return();

  const defaultStream = reader.snapshots(), explicit = reader.snapshots({ strategy: 'latest', emitCurrent: false });
  const all = reader.snapshots({ strategy: 'all', capacity: 4 }), allQueue = latestQueue();
  const old = reader.current;
  await publish(3);
  await checkValue(defaultStream); await checkValue(explicit);
  assert.equal(allQueue().length, 4);
  assert.equal((await all.next()).value, old);
  for (const value of [1, 0, 1]) assert.equal((await all.next()).value.get('x'), value);
  assert.deepEqual(allQueue(), []);
  await defaultStream.return();
  const independent = explicit.next(); await publish(1); assert.equal((await independent).value, reader.current);
  await explicit.return(); await all.return();

  const overflow = reader.snapshots({ strategy: 'all', capacity: 1 }), overflowQueue = latestQueue();
  const survivor = reader.snapshots();
  await publish(1); await rejected(overflow.next(), /overflow/);
  assert.deepEqual(overflowQueue(), []); await checkValue(survivor); await survivor.return();
  assert.equal(reader.closed, false);

  for (const emitCurrent of [false, true]) {
    for (const ending of ['return', 'abort', 'throw']) {
      const controller = new AbortController(), reason = new Error(`${ending} reason`);
      const stream = reader.snapshots({ emitCurrent, signal: controller.signal }), readQueue = latestQueue();
      const next = emitCurrent ? undefined : stream.next();
      const checkedNext = next && (ending === 'return' ? next.then(value => assert.equal(value.done, true)) : rejected(next, reason));
      if (ending === 'return') assert.equal((await stream.return()).done, true);
      if (ending === 'abort') controller.abort(reason);
      if (ending === 'throw') await rejected(stream.throw(reason), reason);
      await checkedNext; assert.deepEqual(readQueue(), []);
      if (ending === 'return') assert.equal((await stream.next()).done, true);
      else await rejected(stream.next(), reason);
      assert.equal(reader.closed, false);
      trace.push([ending, emitCurrent]);
    }
  }
  const controller = new AbortController(), reason = new Error('already aborted'); controller.abort(reason);
  const aborted = reader.snapshots({ signal: controller.signal }), abortedQueue = latestQueue();
  await rejected(aborted.next(), reason); assert.deepEqual(abortedQueue(), []);
  const nonzero = reader.snapshots(); assert.equal((await nonzero.next()).value, reader.current); await nonzero.return();
  const queued = reader.snapshots(), queuedReader = latestQueue();
  const pending = reader.snapshots({ emitCurrent: false }), pendingReader = latestQueue(), next = pending.next();
  reader.dispose(); reader.dispose();
  assert.equal((await next).done, true); assert.equal((await queued.next()).done, true);
  assert.deepEqual(queuedReader(), []); assert.deepEqual(pendingReader(), []);
  assert.throws(() => reader.snapshots(), /closed/);
  trace.push(['closed', reader.closed]);
  // All current queue objects are empty after consumption/termination. This is
  // deterministic reference-release evidence, not a GC or reachability claim.
  for (const read of probe.queues) assert.deepEqual(read(), []);
  probe.queues.length = 0;
  return { trace, allocation };
}

function owner(copy) {
  resetMap();
  const even = new SharedMap('number').set('x', 0), odd = even.set('x', 1);
  const state = createSharedSession(even, { copy, delivery: 'all', maxPending: 10001, timeoutMs: 30000 });
  return { state, produce(amount) {
    for (let index = 0; index < amount; index++) state.publish(state.version % 2 === 0 ? odd : even);
  } };
}

if (!isMainThread) {
  const reader = await connectSharedSession({ endpoint: parentPort, timeoutMs: 30000 });
  try {
    const result = await checkReader(reader, amount => parentPort.postMessage({ produce: amount }));
    parentPort.postMessage({ result });
  } catch (error) { parentPort.postMessage({ error: error.stack }); }
} else {
  const traces = {}, allocations = {};
  for (const copy of [false, true]) {
    const { port1, port2 } = new MessageChannel(), local = owner(copy);
    try {
      const receiving = connectSharedSession({ endpoint: port2 });
      await local.state.connect(port1);
      const result = await checkReader(await receiving, local.produce);
      traces[`messageChannel/copy=${copy}`] = result.trace;
      allocations[`messageChannel/copy=${copy}`] = result.allocation;
    } finally { local.state.dispose(); port1.close(); port2.close(); }

    const remote = owner(copy);
    const worker = new Worker(new URL(import.meta.url), { workerData: { directory, variant } });
    try {
      const result = new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', message => {
          if (message.produce) remote.produce(message.produce);
          if (message.result) resolve(message.result);
          if (message.error) reject(new Error(message.error));
        });
        worker.on('exit', code => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
      });
      await remote.state.connect(worker);
      const checked = await result;
      traces[`worker/copy=${copy}`] = checked.trace;
      allocations[`worker/copy=${copy}`] = checked.allocation;
    } finally { remote.state.dispose(); await worker.terminate(); }
  }
  console.log(JSON.stringify({ runtime: process.version, traces, allocations }));
}
