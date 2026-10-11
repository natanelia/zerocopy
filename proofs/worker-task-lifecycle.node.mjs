import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { MessageChannel, Worker } from 'node:worker_threads';
import test from 'node:test';
import { SharedMap } from '../dist/shared.js';
import { connect, createSharedState, defineTasks, pool, serve } from '../dist/worker.js';

// These are ordering/lifecycle assertions. No elapsed-time threshold decides
// success. A runner-level watchdog is only a safety cap for a broken handshake.
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function observe(promise) {
  const outcome = { status: 'pending' };
  const done = promise.then(
    value => Object.assign(outcome, { status: 'fulfilled', value }),
    error => Object.assign(outcome, { status: 'rejected', error }),
  );
  return { outcome, done };
}
const eventNames = ['message', 'messageerror', 'error', 'close', 'exit'];
function listeners(port) {
  return new Map(eventNames.map(name => [name, getEventListeners(port, name)]));
}
function assertListenersRestored(port, baseline) {
  for (const name of eventNames) {
    const actual = getEventListeners(port, name);
    const expected = baseline.get(name);
    assert.equal(actual.length, expected.length, `${name}: library listeners remain installed`);
    for (const listener of expected) {
      assert.ok(actual.includes(listener), `${name}: caller-owned listener was removed`);
    }
  }
}
function stateWith(value = 7) {
  return createSharedState({ map: new SharedMap('number').set('value', value) });
}
async function setupHeldTask(options = {}) {
  const { port1, port2 } = new MessageChannel();
  const state = stateWith();
  const entered = deferred(), release = deferred(), finished = deferred();
  const errors = [];
  // Real application listeners must survive library shutdown, even though the
  // port itself has closed. Capture their identities, not global listener totals.
  const appMessage = () => {};
  const appMessageError = () => {};
  port2.addEventListener('message', appMessage);
  port2.addEventListener('messageerror', appMessageError);
  const baseline = listeners(port2);
  const tasks = defineTasks()({
    async held(context) {
      entered.resolve(context);
      try { await release.promise; return context.state.map.get('value'); }
      finally { finished.resolve(); }
    },
  });
  let stop, executor, active, context;
  const cleanup = async () => {
    // Always release the explicit gate, including after a failed assertion.
    // A retained handler is evidence of cooperative cancellation, not a GC claim.
    release.resolve();
    executor?.dispose();
    stop?.();
    state.dispose();
    port1.close();
    port2.close();
    if (context) await finished.promise;
    if (active) await active.done;
    port2.removeEventListener('message', appMessage);
    port2.removeEventListener('messageerror', appMessageError);
  };
  try {
    stop = await serve(tasks, {
      endpoint: endpointView(port2, options.endpointStyle),
      onError(error) { errors.push(error); options.onError?.(error); },
    });
    executor = await connect(endpointView(port1, options.endpointStyle), { state, onError: error => errors.push(error) });
    active = observe(executor.run.held());
    context = await entered.promise;
    return { port1, port2, state, baseline, executor, active, context, errors, stop, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
async function closePair(port1, port2) {
  const closed = Promise.all([once(port1, 'close'), once(port2, 'close')]);
  port1.close();
  await closed;
}

test('abrupt native port closure aborts an active task before explicit disposal', async () => {
  const task = await setupHeldTask();
  try {
    task.state.update('map', map => map.set('value', 9));
    await closePair(task.port1, task.port2);
    assert.equal(task.context.signal.aborted, true,
      'the server must abort active work when its native MessagePort closes');
    assert.ok(task.context.signal.reason instanceof Error);
    assert.match(task.context.signal.reason.message, /closed/i);
    // An already-running handler may retain and read its original snapshot until
    // it cooperates. Shutdown must not invalidate that immutable snapshot.
    assert.equal(task.context.state.map.get('value'), 7);
    assert.equal(task.executor.closed, true);
    const result = await task.active.done;
    assert.equal(result.status, 'rejected');
    assert.match(result.error.message, /closed/i);
  } finally { await task.cleanup(); }
});

test('abrupt native port closure removes library listeners and preserves application listeners', async () => {
  const task = await setupHeldTask();
  try {
    await closePair(task.port1, task.port2);
    assertListenersRestored(task.port2, task.baseline);
  } finally { await task.cleanup(); }
});

test('a reported transport error aborts active work with the original Error', async () => {
  const task = await setupHeldTask();
  try {
    const error = new Error('injected native-port message deserialization failure');
    // Message delivery and handshakes use a real MessageChannel. Only this
    // difficult-to-produce deserialization failure is injected at the endpoint.
    const event = new Event('messageerror');
    Object.defineProperty(event, 'error', { value: error });
    task.port2.dispatchEvent(event);
    assert.equal(task.context.signal.aborted, true,
      'transport error reporting must follow active-task cancellation');
    assert.equal(task.context.signal.reason, error, 'cleanup must preserve the original Error identity');
    assert.ok(task.errors.includes(error));
    // Reader disposal is attached to its already-resolved initialization promise.
    await cancellationCheckpoint();
    assertListenersRestored(task.port2, task.baseline);
  } finally { await task.cleanup(); }
});

test('a shared-reader failure aborts its active task before reporting the failure', async () => {
  let task;
  const reported = deferred();
  task = await setupHeldTask({
    onError(error) {
      reported.resolve({ error, aborted: task.context.signal.aborted, reason: task.context.signal.reason });
    },
  });
  try {
    // The reader announces its channel on the wire. Discover it without reading
    // private maps or predicting a generated client/session identifier.
    const readerChannel = deferred();
    const capture = data => {
      if (data?.protocol === 'zerocopy/session' && data.kind === 'snapshot') {
        readerChannel.resolve(data.channel);
      }
    };
    task.port2.on('message', capture);
    try {
      task.state.update('map', map => map.set('value', 11));
      const channel = await readerChannel.promise;
      task.port1.postMessage({ protocol: 'zerocopy/session', version: -1, channel, kind: 'offer' });
      const failure = await reported.promise;
      assert.match(failure.error.message, /Unsupported session protocol version/);
      assert.equal(failure.aborted, true,
        'a failed reader must cancel its task before application onError runs');
      assert.equal(failure.reason, failure.error, 'the reader failure must remain the cancellation reason');
    } finally { task.port2.off('message', capture); }
  } finally { await task.cleanup(); }
});

async function setupBusyPool(maxPending = 1, options = {}) {
  const { port1, port2 } = new MessageChannel();
  const state = stateWith();
  const entered = deferred(), release = deferred(), finished = deferred();
  const started = [];
  const tasks = defineTasks()({
    async work(context, input) {
      const { state } = context;
      started.push(input);
      if (input === 'busy') {
        entered.resolve(context);
        try { await release.promise; }
        finally { finished.resolve(); }
      }
      return `${input}:${state.map.get('value')}`;
    },
  });
  let stop, workers, active;
  let handlerEntered = false;
  const results = [];
  const cleanup = async () => {
    release.resolve();
    workers?.dispose();
    stop?.();
    state.dispose();
    port1.close();
    port2.close();
    if (handlerEntered) await finished.promise;
    await Promise.all(results.map(result => result.done));
  };
  try {
    stop = await serve(tasks, { endpoint: port2 });
    workers = await pool([port1], { state, maxPending });
    active = observe(workers.run.work('busy', { signal: options.signal }));
    results.push(active);
    const context = await entered.promise;
    handlerEntered = true;
    return { port1, port2, workers, started, context, release, active, results, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// The marker follows the rejection callback in the microtask queue when an
// AbortSignal cancels a queued call synchronously. It does not wait for a timer,
// worker availability, remote message delivery, or an arbitrary retry count.
const cancellationCheckpoint = () => new Promise(resolve => queueMicrotask(resolve));

test('an aborted queued pool call rejects before the busy handler is released', async () => {
  const busy = await setupBusyPool();
  try {
    const controller = new AbortController();
    const error = new Error('cancel the queued call');
    const queued = observe(busy.workers.run.work('cancelled', { signal: controller.signal }));
    busy.results.push(queued);
    controller.abort(error);
    await cancellationCheckpoint();
    assert.equal(queued.outcome.status, 'rejected',
      'queued cancellation must not wait for an unrelated active handler');
    assert.equal(queued.outcome.error, error);
    assert.deepEqual(busy.started, ['busy']);
    assert.equal(busy.active.outcome.status, 'pending');
  } finally { await busy.cleanup(); }
});

test('an already-aborted call never occupies a busy pool queue', async () => {
  const busy = await setupBusyPool();
  try {
    const controller = new AbortController();
    const error = new Error('cancel before scheduling');
    controller.abort(error);
    const queued = observe(busy.workers.run.work('cancelled', { signal: controller.signal }));
    busy.results.push(queued);
    await cancellationCheckpoint();
    assert.equal(queued.outcome.status, 'rejected');
    assert.equal(queued.outcome.error, error);
    assert.deepEqual(busy.started, ['busy']);
  } finally { await busy.cleanup(); }
});

test('aborting a queued pool call returns its queue slot without reusing the busy worker', async () => {
  const busy = await setupBusyPool();
  try {
    const controller = new AbortController();
    const cancelled = observe(busy.workers.run.work('cancelled', { signal: controller.signal }));
    busy.results.push(cancelled);
    controller.abort(new Error('free this queue slot'));
    await cancellationCheckpoint();
    const next = observe(busy.workers.run.work('next'));
    busy.results.push(next);
    await cancellationCheckpoint();
    assert.equal(next.outcome.status, 'pending', 'an aborted queue entry must not cause queue overflow');
    assert.deepEqual(busy.started, ['busy'], 'the still-running handler must retain its worker slot');
    busy.release.resolve();
    assert.equal((await busy.active.done).value, 'busy:7');
    assert.equal((await next.done).value, 'next:7');
    assert.equal((await cancelled.done).status, 'rejected');
    assert.deepEqual(busy.started, ['busy', 'next']);
  } finally { await busy.cleanup(); }
});

// Narrow views exercise each documented listener API while retaining native
// MessageChannel delivery. They intentionally expose no ownership methods.
function endpointView(port, style) {
  if (!style) return port;
  const endpoint = { postMessage: port.postMessage.bind(port), start: port.start.bind(port) };
  const methods = style === 'browser' ? ['addEventListener', 'removeEventListener'] : ['on', 'off'];
  for (const method of methods) endpoint[method] = port[method].bind(port);
  return endpoint;
}
let barriers = 0;
async function portBarrier(port1, port2) {
  const id = ++barriers, acknowledged = deferred();
  const receive = data => {
    if (data?.lifecycleBarrier === id) port2.postMessage({ lifecycleAck: id });
  };
  const reply = data => {
    if (data?.lifecycleAck === id) acknowledged.resolve();
  };
  port2.on('message', receive);
  port1.on('message', reply);
  try {
    port1.postMessage({ lifecycleBarrier: id });
    await acknowledged.promise;
  } finally {
    port2.off('message', receive);
    port1.off('message', reply);
  }
}

for (const endpointStyle of ['browser', 'node']) {
  test(`${endpointStyle}-style endpoints dispose active tasks without closing borrowed ports`, async () => {
    const task = await setupHeldTask({ endpointStyle });
    try {
      task.stop();
      task.stop();
      assert.equal(task.context.signal.aborted, true);
      assert.match(task.context.signal.reason.message, /Task server closed/);
      assertListenersRestored(task.port2, task.baseline);
      const result = await task.active.done;
      assert.equal(result.status, 'rejected');
      assert.match(result.error.message, /Task server closed/);
      assert.equal(task.executor.closed, true);
      // Both callers still own an operational MessageChannel after disposal.
      await portBarrier(task.port1, task.port2);
    } finally { await task.cleanup(); }
  });
}

test('on/off-only endpoints observe native close and release task listeners', async () => {
  const task = await setupHeldTask({ endpointStyle: 'node' });
  try {
    await closePair(task.port1, task.port2);
    assert.equal(task.context.signal.aborted, true);
    assertListenersRestored(task.port2, task.baseline);
    assert.equal((await task.active.done).status, 'rejected');
  } finally { await task.cleanup(); }
});

test('throwing application error callbacks cannot prevent transport cleanup', async () => {
  const callbackError = new Error('application onError threw');
  const logged = [], originalConsoleError = console.error;
  console.error = (...values) => logged.push(values);
  let task;
  try {
    task = await setupHeldTask({ onError() { throw callbackError; } });
    const original = new Error('transport failed first');
    const event = new Event('messageerror');
    Object.defineProperty(event, 'error', { value: original });
    assert.doesNotThrow(() => task.port2.dispatchEvent(event));
    assert.equal(task.context.signal.reason, original);
    assertListenersRestored(task.port2, task.baseline);
    assert.equal(task.errors.filter(error => error === original).length, 1);
    assert.equal(logged.length, 1);
    assert.ok(logged[0].includes(callbackError));
    await portBarrier(task.port1, task.port2);
    assert.equal((await task.active.done).status, 'rejected');
  } finally {
    if (task) await task.cleanup();
    console.error = originalConsoleError;
  }
});

async function halfOpenServer() {
  const { port1, port2 } = new MessageChannel();
  const baseline = listeners(port2), ready = deferred(), reported = deferred();
  const stop = await serve(defineTasks()({ read({ state }) { return state.map.get('value'); } }), {
    endpoint: port2, onError: error => reported.resolve(error),
  });
  const serving = listeners(port2);
  const receive = data => {
    if (data?.protocol === 'zerocopy/tasks' && data.client === 'half-open' && data.kind === 'ready') ready.resolve();
  };
  port1.on('message', receive);
  port1.postMessage({ protocol: 'zerocopy/tasks', version: 1, channel: 'default', client: 'half-open', kind: 'hello' });
  await ready.promise;
  port1.off('message', receive);
  return {
    port1, port2, baseline, serving, reported, stop,
    cleanup() { stop(); port1.close(); port2.close(); },
  };
}

test('server disposal immediately removes an initializing reader without waiting for its timeout', async () => {
  const server = await halfOpenServer();
  try {
    assert.ok(getEventListeners(server.port2, 'message').length > server.serving.get('message').length);
    server.stop();
    assertListenersRestored(server.port2, server.baseline);
    await portBarrier(server.port1, server.port2);
  } finally { server.cleanup(); }
});

test('native closure immediately removes an initializing reader and server listeners', async () => {
  const server = await halfOpenServer();
  try {
    await closePair(server.port1, server.port2);
    assertListenersRestored(server.port2, server.baseline);
  } finally { server.cleanup(); }
});

test('reader initialization failure preserves the server for a later client', async () => {
  const server = await halfOpenServer();
  const state = stateWith(23);
  let executor;
  try {
    server.port1.postMessage({
      protocol: 'zerocopy/session', version: -1, channel: 'tasks:default:half-open', kind: 'offer',
    });
    const error = await server.reported.promise;
    assert.match(error.message, /Unsupported session protocol version/);
    assertListenersRestored(server.port2, server.serving);
    executor = await connect(server.port1, { state });
    assert.equal(await executor.run.read(), 23);
  } finally {
    executor?.dispose();
    state.dispose();
    server.cleanup();
  }
});

test('a failed reader cancels only its client while another client remains usable', async () => {
  const { port1, port2 } = new MessageChannel();
  const states = [stateWith(31), stateWith(47)];
  const entered = [deferred(), deferred()], release = deferred();
  const channels = new Map(), reported = deferred(), results = [];
  const clients = [];
  const capture = data => {
    if (data?.protocol === 'zerocopy/tasks' && data.kind === 'call') channels.set(data.input, `tasks:default:${data.client}`);
  };
  port2.on('message', capture);
  const stop = await serve(defineTasks()({
    async held(context, index) { entered[index].resolve(context); await release.promise; return context.state.map.get('value'); },
    read({ state }) { return state.map.get('value'); },
  }), { endpoint: port2, onError: error => reported.resolve(error) });
  try {
    for (let index = 0; index < states.length; index++) {
      clients.push(await connect(port1, { state: states[index], onError() {} }));
      results.push(observe(clients[index].run.held(index)));
    }
    const contexts = await Promise.all(entered.map(gate => gate.promise));
    port1.postMessage({ protocol: 'zerocopy/session', version: -1, channel: channels.get(0), kind: 'offer' });
    const error = await reported.promise;
    assert.equal(contexts[0].signal.reason, error);
    assert.equal(contexts[1].signal.aborted, false);
    assert.equal((await results[0].done).status, 'rejected');
    assert.equal(clients[0].closed, true);
    assert.equal(clients[1].closed, false);
    assert.equal(await clients[1].run.read(), 47);
    release.resolve();
    assert.equal((await results[1].done).value, 47);
  } finally {
    release.resolve();
    clients.forEach(client => client.dispose());
    stop();
    states.forEach(state => state.dispose());
    port2.off('message', capture);
    port1.close(); port2.close();
    await Promise.all(results.map(result => result.done));
  }
});

test('active cancellation keeps its pool slot until the handler exits', async () => {
  const controller = new AbortController();
  const busy = await setupBusyPool(1, { signal: controller.signal });
  try {
    const error = new Error('cancel the active handler cooperatively');
    controller.abort(error);
    assert.equal((await busy.active.done).error, error);
    const next = observe(busy.workers.run.work('next'));
    busy.results.push(next);
    await portBarrier(busy.port1, busy.port2);
    assert.equal(busy.context.signal.aborted, true);
    assert.deepEqual(busy.started, ['busy']);
    assert.equal(next.outcome.status, 'pending');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    busy.release.resolve();
    assert.equal((await next.done).value, 'next:7');
    assert.deepEqual(busy.started, ['busy', 'next']);
  } finally { await busy.cleanup(); }
});

test('queued cancellation preserves FIFO and removes signal listeners after cancellation or completion', async () => {
  const busy = await setupBusyPool(3);
  try {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const appAbort = () => {};
    controllers[1].signal.addEventListener('abort', appAbort);
    const queued = controllers.map((controller, index) => observe(busy.workers.run.work(`queued-${index}`, { signal: controller.signal })));
    busy.results.push(...queued);
    const error = new Error('cancel the middle queue item');
    controllers[1].abort(error);
    await cancellationCheckpoint();
    assert.equal(queued[1].outcome.error, error);
    assert.deepEqual(getEventListeners(controllers[1].signal, 'abort'), [appAbort]);
    const tail = observe(busy.workers.run.work('tail'));
    busy.results.push(tail);
    await portBarrier(busy.port1, busy.port2);
    assert.deepEqual(busy.started, ['busy']);
    busy.release.resolve();
    await Promise.all(busy.results.map(result => result.done));
    assert.deepEqual(busy.started, ['busy', 'queued-0', 'queued-2', 'tail']);
    assert.equal(tail.outcome.value, 'tail:7');
    assert.equal(getEventListeners(controllers[0].signal, 'abort').length, 0);
    assert.equal(getEventListeners(controllers[2].signal, 'abort').length, 0);
    controllers[1].signal.removeEventListener('abort', appAbort);
  } finally { await busy.cleanup(); }
});

test('pool disposal rejects queued calls and removes every queued signal listener', async () => {
  const busy = await setupBusyPool(2);
  try {
    const controllers = [new AbortController(), new AbortController()];
    const queued = controllers.map((controller, index) => observe(busy.workers.run.work(index, { signal: controller.signal })));
    busy.results.push(...queued);
    assert.deepEqual(controllers.map(controller => getEventListeners(controller.signal, 'abort').length), [1, 1]);
    busy.workers.dispose();
    busy.workers.dispose();
    assert.deepEqual(controllers.map(controller => getEventListeners(controller.signal, 'abort').length), [0, 0]);
    await Promise.all(queued.map(result => result.done));
    for (const result of queued) {
      assert.equal(result.outcome.status, 'rejected');
      assert.match(result.outcome.error.message, /Worker pool is closed/);
    }
    await portBarrier(busy.port1, busy.port2);
    assert.equal(busy.context.signal.aborted, true);
    assert.deepEqual(busy.started, ['busy']);
  } finally { await busy.cleanup(); }
});

test('pool map cancellation removes its queued feeder while another call is active', async () => {
  const busy = await setupBusyPool(1);
  try {
    const controller = new AbortController(), error = new Error('cancel queued map feeder');
    const mapped = observe(busy.workers.map.work(['first', 'second'], { signal: controller.signal }));
    busy.results.push(mapped);
    controller.abort(error);
    await portBarrier(busy.port1, busy.port2);
    assert.equal(mapped.outcome.status, 'rejected');
    assert.equal(mapped.outcome.error, error);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(busy.started, ['busy']);
  } finally { await busy.cleanup(); }
});

test('an actual Node Worker exit rejects active calls and closes the borrowed executor', async () => {
  const state = stateWith(), entered = deferred();
  const entry = new URL('../dist/worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(entry)}).then(({ serve, defineTasks }) => serve(defineTasks()({
      async held() {
        parentPort.postMessage({ lifecycleWorker: 'entered' });
        await new Promise(() => {});
      }
    }), { endpoint: parentPort })).catch(error => { throw error; });
  `, { eval: true });
  const receive = data => { if (data?.lifecycleWorker === 'entered') entered.resolve(); };
  worker.on('message', receive);
  let executor, active;
  const controller = new AbortController();
  try {
    executor = await connect(worker, { state, onError() {} });
    active = observe(executor.run.held(undefined, { signal: controller.signal }));
    await entered.promise;
    await worker.terminate();
    assert.equal(executor.closed, true);
    const result = await active.done;
    assert.equal(result.status, 'rejected');
    assert.match(result.error.message, /closed/i);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    executor?.dispose();
    state.dispose();
    worker.off('message', receive);
    await worker.terminate();
    if (active) await active.done;
  }
});
