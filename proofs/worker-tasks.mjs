import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import { SharedMap } from '../dist/shared.js';
import { createSharedState, defineTasks, connect, spawn, pool, serve } from '../dist/worker.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let tries = 0; tries < 200; tries++) {
    if (predicate()) return;
    await sleep(1);
  }
  assert.fail('Expected condition was not reached');
}
function model(value = 1) {
  return createSharedState({ map: new SharedMap('number').set('lane', value) });
}
const tasks = defineTasks()({
  get({ state }, key) { return state.map.get(key); },
});

// Fault injection is limited to transport events. These are real WASM-backed
// collections and the production session decoder, not stand-in data structures.
class Port {
  handlers = new Map();
  sent = [];
  hook;
  peer;
  terminated = 0;
  postMessage(data) {
    data = this.hook?.(data) ?? data;
    this.sent.push(data);
    queueMicrotask(() => this.peer.emit('message', { data }));
  }
  addEventListener(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); }
  emit(name, event) { for (const fn of [...(this.handlers.get(name) ?? [])]) fn(event); }
  start() {}
  terminate() { this.terminated++; }
  get count() { return [...this.handlers.values()].reduce((sum, values) => sum + values.size, 0); }
}
function pair() {
  const a = new Port(), b = new Port();
  a.peer = b; b.peer = a;
  return { a, b };
}
async function fixture(t, handlers = tasks) {
  const state = model(), ports = pair();
  const stop = await serve(handlers, { endpoint: ports.b });
  const executor = await connect(ports.a, { state, memory: 'share' });
  t.after(() => { executor.dispose(); stop(); state.dispose(); });
  return { ...ports, state, executor, stop };
}
async function pooled(t, handlers = tasks, options = {}) {
  const state = model(), ports = Array.from({ length: 3 }, pair);
  const stops = await Promise.all(ports.map(p => serve(handlers, { endpoint: p.b })));
  const executor = await pool(ports.map(p => p.a), { state, memory: 'share', ...options });
  t.after(() => { executor.dispose(); stops.forEach(stop => stop()); state.dispose(); });
  return { state, ports, executor };
}

// This was the failing CI test before this revision.
test('immediate task reads include a pending source update', { timeout: 2000 }, async t => {
  const { state, executor } = await fixture(t);
  state.update('map', map => map.set('lane', 42));
  assert.equal(await executor.run.get('lane'), 42);
});

test('reader closure settles a task waiting for a future revision', { timeout: 2000 }, async t => {
  const { a, executor } = await fixture(t);
  a.hook = data => data.protocol === 'zerocopy/tasks' && data.kind === 'call' ? { ...data, revision: 999 } : data;
  const pending = executor.run.get('lane');
  const rejected = assert.rejects(pending, /reader closed/);
  await sleep(5);
  const snapshot = a.sent.find(data => data.protocol === 'zerocopy/session' && data.kind === 'snapshot');
  assert.ok(snapshot, 'Initial snapshot must have completed its handshake');
  a.postMessage({ ...snapshot, kind: 'close' });
  await rejected;
});

test('cancellation removes a future-revision wait without starting the task', { timeout: 2000 }, async t => {
  let calls = 0;
  const { a, executor } = await fixture(t, defineTasks()({ get() { calls++; return 1; } }));
  a.hook = data => data.kind === 'call' ? { ...data, revision: 999 } : data;
  const controller = new AbortController();
  const pending = executor.run.get('lane', { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel/);
  await sleep(5);
  controller.abort(new Error('cancel'));
  await rejected;
  await pending.settled;
  assert.equal(calls, 0);
});

test('server disposal rejects pending calls and closes the client', { timeout: 2000 }, async t => {
  const { a, stop, executor } = await fixture(t);
  a.hook = data => data.kind === 'call' ? { ...data, revision: 999 } : data;
  const pending = executor.run.get('lane');
  const rejected = assert.rejects(pending, /server closed/);
  await sleep(5);
  stop();
  await rejected;
  assert.equal(executor.closed, true);
});

test('large maps use bounded feeders even with no pending queue', { timeout: 10000 }, async t => {
  const { executor } = await pooled(t, tasks, { maxPending: 0 });
  const input = Array.from({ length: 2000 }, () => 'lane');
  assert.deepEqual(await executor.map.get(input), input.map(() => 1));
});

test('large maps preserve ordering with a one-entry queue', { timeout: 10000 }, async t => {
  const { executor, state } = await pooled(t, tasks, { maxPending: 1 });
  state.update('map', map => map.set('second', 2));
  const input = Array.from({ length: 300 }, (_, index) => index % 2 ? 'lane' : 'second');
  assert.deepEqual(await executor.map.get(input, { chunkSize: 2 }), input.map(key => key === 'lane' ? 1 : 2));
});

for (const memory of ['share', 'copy']) {
  test(`overlapping pool batches capture independent roots at invocation (${memory})`, { timeout: 5000 }, async t => {
    const ports = [pair(), pair()], gate = deferred();
    // This source deliberately reuses the outer record and has no change notifications.
    const roots = { map: new SharedMap('number').set('lane', 1) };
    const source = { getSnapshot: () => roots, subscribe: () => () => {} };
    const stops = await Promise.all(ports.map(p => serve({
      async check({ state }, wait) {
        if (wait) await gate.promise;
        return state.map.get('lane');
      },
    }, { endpoint: p.b })));
    const workers = await pool(ports.map(p => p.a), { state: source, memory, maxPending: 4 });
    t.after(() => { gate.resolve(); workers.dispose(); stops.forEach(stop => stop()); });
    const jobs = [true, true, false, false, false, false];
    const first = workers.map.check(jobs, { snapshot: 'batch' });
    roots.map = roots.map.set('lane', 2);
    const second = workers.map.check(jobs, { snapshot: 'batch' });
    const live = workers.run.check(false);
    roots.map = roots.map.set('lane', 3);
    gate.resolve();
    assert.deepEqual(await first, jobs.map(() => 1));
    assert.deepEqual(await second, jobs.map(() => 2));
    assert.equal(await live, 3);
    assert.deepEqual(await workers.map.check(jobs, { snapshot: 'task' }), jobs.map(() => 3));
    assert.ok(ports.every(p => p.a.sent.filter(m => m.kind === 'hello').length === 1));
  });
}

test('an edit during a pinned batch resumes live publication once per worker', { timeout: 5000 }, async t => {
  const gate = deferred();
  let started = 0;
  const { executor, state, ports } = await pooled(t, { async read({ state }) {
    started++;
    await gate.promise;
    return state.map.get('lane');
  } });
  t.after(() => gate.resolve());
  const batch = executor.map.read(Array(60).fill(null), { snapshot: 'batch' });
  await until(() => started === 3);
  state.update('map', map => map.set('lane', 2));
  state.update('map', map => map.set('lane', 3));
  state.flush();
  const frames = p => p.a.sent.filter(m => m.kind === 'snapshot');
  assert.ok(ports.every(p => frames(p).length === 1));
  gate.resolve();
  assert.deepEqual(await batch, Array(60).fill(1));
  await until(() => ports.every(p => frames(p).length === 2));
  assert.ok(ports.every(p => frames(p)[1].data.arenas.every(arena => !arena.memory && !arena.copy)));
  assert.equal(await executor.run.read(), 3);
});

test('an aborted batch releases its snapshot after the active handler settles', { timeout: 3000 }, async t => {
  const gate = deferred(), entered = deferred();
  const state = model(), p = pair();
  const stop = await serve({ async check({ state }, wait) {
    if (wait) { entered.resolve(); await gate.promise; }
    return state.map.get('lane');
  } }, { endpoint: p.b });
  const workers = await pool([p.a], { state, memory: 'share' });
  t.after(() => { gate.resolve(); workers.dispose(); stop(); state.dispose(); });
  const abort = new AbortController();
  const batch = workers.map.check([true, false], { snapshot: 'batch', signal: abort.signal });
  await entered.promise;
  abort.abort(new Error('viewport cancelled'));
  await assert.rejects(batch, /viewport cancelled/);
  state.update('map', map => map.set('lane', 5));
  state.flush();
  const live = workers.run.check(false);
  assert.equal(p.a.sent.filter(m => m.kind === 'snapshot').length, 1);
  gate.resolve();
  assert.equal(await live, 5);
  assert.deepEqual(await workers.map.check([false], { snapshot: 'batch' }), [5]);
});

test('the next queued job uses the worker that actually became idle', { timeout: 3000 }, async t => {
  const state = model(), ports = [pair(), pair()];
  const gates = [deferred(), deferred()];
  const running = [0, 0], peak = [0, 0], seen = [];
  const stops = await Promise.all(ports.map((p, worker) => serve(defineTasks()({
    async work(_context, input) {
      running[worker]++; peak[worker] = Math.max(peak[worker], running[worker]);
      seen.push([worker, input]);
      if (input < 2) await gates[input].promise;
      running[worker]--;
      return input;
    },
  }), { endpoint: p.b })));
  const executor = await pool(ports.map(p => p.a), { state, memory: 'share' });
  t.after(() => { gates.forEach(gate => gate.resolve()); executor.dispose(); stops.forEach(stop => stop()); state.dispose(); });
  const first = executor.run.work(0), second = executor.run.work(1), third = executor.run.work(2);
  await until(() => seen.length === 2);
  gates[1].resolve();
  assert.equal(await third, 2);
  assert.deepEqual(seen[2], [1, 2]);
  assert.deepEqual(peak, [1, 1]);
  gates[0].resolve();
  await Promise.all([first, second]);
});

test('cancelled work keeps its pool slot until the handler really settles', { timeout: 3000 }, async t => {
  const state = model(), p = pair(), gate = deferred();
  let started = 0;
  const stop = await serve(defineTasks()({
    async work(_context, input) { started++; if (input === 1) await gate.promise; return input; },
  }), { endpoint: p.b });
  const executor = await pool([p.a], { state, memory: 'share' });
  t.after(() => { gate.resolve(); executor.dispose(); stop(); state.dispose(); });
  const abort = new AbortController();
  const first = executor.run.work(1, { signal: abort.signal });
  const rejected = assert.rejects(first, /cancel/);
  await until(() => started === 1);
  abort.abort(new Error('cancel'));
  await rejected;
  const next = executor.run.work(2);
  await sleep(10);
  assert.equal(started, 1, 'Cancellation must not make a busy worker idle');
  gate.resolve();
  assert.equal(await next, 2);
});

test('failed call sends release bookkeeping and leave the client usable', { timeout: 2000 }, async t => {
  const { a, executor } = await fixture(t);
  a.hook = data => { if (data.kind === 'call') throw new Error('clone failed'); return data; };
  const pending = executor.run.get('lane');
  await assert.rejects(pending, /clone failed/);
  await pending.settled;
  a.hook = undefined;
  assert.equal(await executor.run.get('lane'), 1);
});

test('failed cancellation still rejects and cleans up the connection', { timeout: 2000 }, async t => {
  const { a, executor } = await fixture(t);
  a.hook = data => {
    if (data.kind === 'cancel') throw new Error('cancel send failed');
    return data.kind === 'call' ? { ...data, revision: 999 } : data;
  };
  const abort = new AbortController();
  const pending = executor.run.get('lane', { signal: abort.signal });
  const rejected = assert.rejects(pending, /cancel/);
  await sleep(5);
  abort.abort(new Error('cancel'));
  await rejected;
  await pending.settled;
  assert.equal(executor.closed, true);
  assert.equal(a.count, 0);
});

test('borrowed connection startup failures remove protocol listeners', { timeout: 2000 }, async t => {
  const p = pair(), state = model();
  t.after(() => state.dispose());
  await assert.rejects(connect(p.a, { state, timeoutMs: 20 }), /timed out/);
  assert.equal(p.a.count, 0);
  assert.equal(p.a.terminated, 0);
});

test('pool factory failure cleans up every resource created so far', { timeout: 2000 }, async t => {
  const state = model(), resources = [];
  t.after(() => state.dispose());
  await assert.rejects(pool(() => {
    if (resources.length === 2) throw new Error('factory failed');
    const resource = pair().a; resources.push(resource); return resource;
  }, { state, size: 3 }), /factory failed/);
  assert.deepEqual(resources.map(resource => resource.terminated), [1, 1]);
});

test('spawn constructor failure releases its owned resource once', { timeout: 2000 }, async () => {
  const resource = pair().a;
  await assert.rejects(spawn(() => resource, { state: { bad: 3 } }), /Unsupported/);
  assert.equal(resource.terminated, 1);
  assert.equal(resource.count, 0);
});

test('pool validates queue limits before creating workers', { timeout: 2000 }, async t => {
  const state = model(); let created = 0;
  t.after(() => state.dispose());
  for (const maxPending of [-1, NaN, Infinity, 1.5]) {
    await assert.rejects(pool(() => { created++; return pair().a; }, { state, maxPending }), /maxPending/);
  }
  assert.equal(created, 0);
});

test('empty maps still validate chunk size and disposal', { timeout: 2000 }, async t => {
  const { executor } = await pooled(t);
  await assert.rejects(executor.map.get([], { chunkSize: 0 }), /chunkSize/);
  await assert.rejects(executor.map.get([], { snapshot: 'invalid' }), /snapshot/);
  assert.deepEqual(await executor.map.get([], { snapshot: 'batch' }), []);
  assert.deepEqual(await executor.map.get([]), []);
  executor.dispose();
  await assert.rejects(executor.map.get([]), /closed/);
});

test('inherited task properties are never callable', { timeout: 2000 }, async t => {
  const { executor } = await fixture(t);
  await assert.rejects(executor.run.toString(), /Unknown task/);
});

test('real MessagePorts share snapshots and report uncloneable results', { timeout: 3000 }, async t => {
  const state = model(), channel = new MessageChannel();
  const stop = await serve(defineTasks()({
    ...tasks,
    uncloneable() { return () => {}; },
  }), { endpoint: channel.port2 });
  const executor = await connect(channel.port1, { state, memory: 'share' });
  t.after(() => { executor.dispose(); stop(); state.dispose(); channel.port1.close(); channel.port2.close(); });
  state.update('map', map => map.set('lane', 71));
  assert.equal(await executor.run.get('lane'), 71);
  await assert.rejects(executor.run.uncloneable(), /clone/i);
  assert.equal(await executor.run.get('lane'), 71);
});

test('real Node workers execute pool calls over shared WASM memory', { timeout: 10000 }, async t => {
  const state = model();
  const entry = new URL('../dist/worker.js', import.meta.url).href;
  const factory = () => new Worker(`
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(entry)}).then(({serve,defineTasks}) => serve(defineTasks()({
      get({state},key) { return state.map.get(key); }
    }), {endpoint:parentPort})).catch(error => { throw error; });
  `, { eval: true });
  const executor = await pool(factory, { state, size: 2, memory: 'share', maxPending: 0 });
  t.after(() => { executor.dispose(); state.dispose(); });
  state.update('map', map => map.set('lane', 91));
  assert.deepEqual(await executor.map.get(Array(200).fill('lane')), Array(200).fill(91));
});

test('eight workers validate one confirmed TanStack snapshot across an optimistic edit', { timeout: 15000 }, async t => {
  const { createCollection, createTransaction } = await import('@tanstack/db');
  const { sharedCollectionConfig } = await import('zerocopy/tanstack');
  const source = sharedCollectionConfig({ id: 'pool-lanes', initialData: [{ id: 'lane', revision: 1 }] });
  const lanes = createCollection(source);
  await lanes.preload();
  t.after(() => lanes.cleanup());
  const entry = new URL('../dist/worker.js', import.meta.url).href;
  const workers = await pool(() => new Worker(`
    const { parentPort, threadId } = require('node:worker_threads');
    import(${JSON.stringify(entry)}).then(({ serve }) => serve({
      check({ state }, gate) {
        if (Atomics.wait(new Int32Array(gate), 0, 0, 10000) === 'timed-out') throw new Error('Validation gate timed out');
        return [threadId, state.get('lane').revision];
      }
    }, { endpoint: parentPort }));
  `, { eval: true }), { state: source, size: 8, memory: 'share' });
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
  t.after(() => { release(); workers.dispose(); });
  const tx = createTransaction({ autoCommit: false, mutationFn: ({ transaction }) => source.utils.acceptMutations(transaction) });
  tx.mutate(() => lanes.update('lane', lane => { lane.revision = 2; }));
  assert.equal(lanes.get('lane').revision, 2);
  assert.equal(source.getSnapshot().get('lane').revision, 1);
  const checks = workers.map.check(Array(256).fill(gate.buffer), { snapshot: 'batch' });
  await tx.commit();
  assert.equal(source.getSnapshot().get('lane').revision, 2);
  release();
  const results = await checks;
  assert.equal(new Set(results.map(([worker]) => worker)).size, 8);
  assert.deepEqual(results.map(([, revision]) => revision), Array(256).fill(1));
  assert.equal((await workers.run.check(gate.buffer))[1], 2);
});
