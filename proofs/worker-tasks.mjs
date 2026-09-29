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
