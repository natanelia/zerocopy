import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ATTEMPT_PARAMETER, prepareIsolation } from '../assets/isolation.mjs';

const route = 'https://example.test/zerocopy/previews/pr-10/test/compare/';
const workerURL = new URL('isolation-sw.js', route);
const tick = () => new Promise(resolve => setImmediate(resolve));
class Events extends EventTarget {
  listeners = new Map();
  addEventListener(name, listener) { super.addEventListener(name, listener); if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); }
  removeEventListener(name, listener) { super.removeEventListener(name, listener); this.listeners.get(name)?.delete(listener); }
  emit(name) { this.dispatchEvent(new Event(name)); }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
class Worker extends Events {
  state = 'installing'; scriptURL = workerURL.href;
  messages = [];
  postMessage(data) { this.messages.push(data); }
  change(state) { this.state = state; this.emit('statechange'); }
}
function setup(href = route + '?query=timeout&count=1000#results') {
  const worker = new Worker(), registration = new Events(), container = new Events();
  const calls = [], navigations = [], timers = new Set();
  Object.assign(registration, { scope: route, installing: worker, waiting: null, active: null });
  Object.assign(container, { controller: null, register: async (...args) => { calls.push(args); return registration; } });
  const environment = {
    isSecureContext: true, crossOriginIsolated: false, SharedArrayBuffer, WebAssembly,
    navigator: { serviceWorker: container },
    location: { href, replace: value => { environment.location.href = value; navigations.push(value); } },
    history: { state: { app: 'unchanged' }, replaceState: (state, _, value) => { assert.deepEqual(state, { app: 'unchanged' }); environment.location.href = value; } },
    setTimeout: (callback, delay) => { const id = setTimeout(callback, delay); timers.add(id); return id; },
    clearTimeout: id => { clearTimeout(id); timers.delete(id); },
  };
  // Setup must not depend on cookies or mutable browser storage.
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(environment, name, { get() { throw new Error('Storage blocked'); } });
  const run = options => prepareIsolation({ environment, workerURL, timeoutMs: 100, ...options });
  function claim() { worker.state = 'activated'; registration.installing = null; registration.active = worker; container.controller = worker; container.emit('controllerchange'); }
  function clean() { assert.equal(container.listenerCount, 0); assert.equal(registration.listenerCount, 0); assert.equal(worker.listenerCount, 0); assert.equal(timers.size, 0); }
  return { environment, worker, registration, container, calls, navigations, run, claim, clean };
}

test('server isolation is ready without registration or navigation', async () => {
  const s = setup(); s.environment.crossOriginIsolated = true;
  assert.equal(await s.run(), 'ready'); assert.equal(s.calls.length, 0); assert.equal(s.navigations.length, 0); s.clean();
});
test('a first visit waits for an active registration, then navigates once without needing a claim', async () => {
  const s = setup(); const pending = s.run(); await tick();
  assert.equal(s.calls.length, 1); assert.equal(s.navigations.length, 0);
  assert.equal(s.calls[0][0].href, workerURL.href);
  assert.deepEqual(s.calls[0][1], { scope: route, updateViaCache: 'none' });
  s.registration.installing = null; s.registration.active = s.worker; s.worker.change('activated');
  assert.equal(await pending, 'reloading');
  assert.equal(s.container.controller, null, 'No claim is required for the next navigation');
  const target = new URL(s.navigations[0]);
  assert.equal(target.searchParams.get(ATTEMPT_PARAMETER), '1');
  assert.equal(target.searchParams.get('query'), 'timeout'); assert.equal(target.searchParams.get('count'), '1000'); assert.equal(target.hash, '#results');
  s.container.emit('controllerchange'); assert.equal(s.navigations.length, 1); s.clean();
});
test('success removes only the attempt marker; return visits do not reload', async () => {
  const s = setup(); const pending = s.run(); await tick(); s.claim(); await pending;
  s.environment.crossOriginIsolated = true;
  assert.equal(await s.run(), 'ready'); assert.equal(await s.run(), 'ready');
  assert.equal(s.environment.location.href, route + '?query=timeout&count=1000#results');
  assert.equal(s.calls.length, 1); assert.equal(s.navigations.length, 1); s.clean();
});
test('failed isolation after a reload stops automatically, even without browser storage', async () => {
  const s = setup(); const pending = s.run(); await tick(); s.claim(); await pending;
  await assert.rejects(s.run(), /Automatic reloads have stopped/);
  await assert.rejects(s.run(), /Automatic reloads have stopped/);
  assert.equal(s.calls.length, 1); assert.equal(s.navigations.length, 1); s.clean();
});
test('an explicit retry can navigate again, even with a fragment and an existing marker', async () => {
  const s = setup(route + `?query=timeout&${ATTEMPT_PARAMETER}=1#results`); s.claim();
  assert.equal(await s.run({ retry: true }), 'reloading');
  assert.equal(new URL(s.navigations[0]).searchParams.get(ATTEMPT_PARAMETER), '2');
  assert.equal(new URL(s.navigations[0]).hash, '#results');
  await assert.rejects(s.run(), /Automatic reloads have stopped/); assert.equal(s.navigations.length, 1); s.clean();
});
test('history access failure does not disable already available shared memory', async () => {
  const s = setup(route + `?${ATTEMPT_PARAMETER}=1`); s.environment.crossOriginIsolated = true;
  s.environment.history.replaceState = () => { throw new Error('History blocked'); };
  assert.equal(await s.run(), 'ready'); assert.equal(s.calls.length, 0); s.clean();
});
test('unsupported and insecure contexts do not register or navigate', async () => {
  for (const change of [env => { env.isSecureContext = false; }, env => { env.WebAssembly = undefined; }, env => { env.navigator.serviceWorker = undefined; }, env => { env.crossOriginIsolated = true; env.SharedArrayBuffer = undefined; }]) {
    const s = setup(); change(s.environment); await assert.rejects(s.run()); assert.equal(s.calls.length, 0); assert.equal(s.navigations.length, 0); s.clean();
  }
});
test('activation can precede registration resolution in another tab', async () => {
  const s = setup(); let release; s.container.register = () => new Promise(resolve => { release = resolve; });
  const pending = s.run(); await tick(); s.claim(); assert.equal(await pending, 'reloading');
  release(s.registration); await tick(); s.clean(); assert.equal(s.navigations.length, 1);
});
test('a controller still activating is not enough; wait for its activated state', async () => {
  const s = setup(); const pending = s.run(); await tick();
  s.worker.state = 'activating'; s.container.controller = s.worker; s.container.emit('controllerchange');
  assert.equal(s.navigations.length, 0); s.worker.change('activated'); assert.equal(await pending, 'reloading'); s.clean();
});
test('an already active worker allows one navigation into its scope', async () => {
  const s = setup(); s.registration.installing = null; s.registration.active = s.worker; s.worker.state = 'activated';
  assert.equal(await s.run(), 'reloading'); assert.equal(s.navigations.length, 1); assert.equal(s.container.controller, null); s.clean();
});
test('registration failure, including synchronous rejection, cleans up without a navigation', async () => {
  for (const register of [() => { throw new Error('Policy blocked'); }, () => Promise.reject(new Error('Policy blocked'))]) {
    const s = setup(); s.container.register = register; await assert.rejects(s.run(), /Policy blocked/); s.clean(); assert.equal(s.navigations.length, 0);
  }
});
test('a failed installation is reported and all event listeners are removed', async () => {
  const s = setup(); const pending = s.run(); await tick(); s.worker.change('redundant');
  await assert.rejects(pending, /could not install/); assert.equal(s.navigations.length, 0); s.clean();
});
test('a redundant installation can be replaced by a live successor', async () => {
  const s = setup(); const pending = s.run(); await tick();
  const successor = new Worker(); s.registration.installing = successor; s.registration.emit('updatefound'); s.worker.change('redundant');
  successor.state = 'activated'; s.container.controller = successor; s.container.emit('controllerchange');
  assert.equal(await pending, 'reloading'); assert.equal(successor.listenerCount, 0); s.clean();
});
test('a blocked registration has a deadline; late completion cannot reload', async () => {
  const s = setup(); let release; s.container.register = () => new Promise(resolve => { release = resolve; });
  await assert.rejects(s.run({ timeoutMs: 15 }), /timed out/); s.clean();
  release(s.registration); s.claim(); await tick(); assert.equal(s.navigations.length, 0); s.clean();
});
test('a worker stuck activating times out without navigation', async () => {
  const s = setup(); s.registration.installing = null; s.registration.active = s.worker; s.worker.state = 'activating';
  await assert.rejects(s.run({ timeoutMs: 15 }), /timed out/); s.clean(); assert.equal(s.navigations.length, 0);
});
test('unrelated controller changes do not trigger a reload or unregister other workers', async () => {
  const s = setup(); const other = new Worker(); other.scriptURL = new URL('../unrelated.js', route).href; other.state = 'activated';
  s.container.controller = other; s.registration.unregister = () => { throw new Error('Must not unregister'); };
  const pending = s.run(); await tick(); s.container.emit('controllerchange'); assert.equal(s.navigations.length, 0);
  s.claim(); assert.equal(await pending, 'reloading'); assert.equal(other.listenerCount, 0); s.clean();
});
test('scope validation rejects a different origin or a different preview path', async () => {
  for (const url of ['https://elsewhere.test/isolation-sw.js', new URL('../explorer/isolation-sw.js', route).href]) {
    const s = setup(); await assert.rejects(s.run({ workerURL: url }), /origin and path/); assert.equal(s.calls.length, 0); assert.equal(s.navigations.length, 0); s.clean();
  }
});
test('changes to queries during setup survive; a route change cancels the reload', async () => {
  const s = setup(); const pending = s.run(); await tick(); s.environment.location.href = route + '?query=retry#timeline'; s.claim(); await pending;
  assert.equal(new URL(s.navigations[0]).searchParams.get('query'), 'retry'); assert.equal(new URL(s.navigations[0]).hash, '#timeline'); s.clean();
  const changed = setup(); const cancelled = changed.run(); await tick(); changed.environment.location.href = new URL('../docs/', route).href; changed.claim();
  await assert.rejects(cancelled, /page changed/); assert.equal(changed.navigations.length, 0); changed.clean();
});

test('a throwing service-worker getter rejects without navigation or leaked resources', async () => {
  const s = setup();
  Object.defineProperty(s.environment.navigator, 'serviceWorker', { get() { throw new Error('Service workers blocked by policy'); } });
  await assert.rejects(s.run(), /blocked by policy/);
  assert.equal(s.calls.length, 0); assert.equal(s.navigations.length, 0); s.clean();
});


test('reuse an exact active installation from another tab without registering or claiming', async () => {
  const s = setup(); s.worker.state = 'activated'; s.registration.installing = null; s.registration.active = s.worker;
  s.container.getRegistration = async scope => { assert.equal(scope, route); return s.registration; };
  assert.equal(await s.run(), 'reloading');
  assert.equal(s.calls.length, 0); assert.equal(s.navigations.length, 1);
  assert.equal(s.container.controller, null); assert.deepEqual(s.worker.messages, []);
  s.container.emit('controllerchange'); s.registration.emit('updatefound');
  assert.equal(s.navigations.length, 1); s.clean();
});
test('a rejected registration job can use a matching installation completed by another tab', async () => {
  const s = setup(); let reads = 0;
  s.container.getRegistration = async () => ++reads === 1 ? undefined : s.registration;
  s.container.register = async () => {
    s.worker.state = 'activated'; s.registration.installing = null; s.registration.active = s.worker;
    throw new Error('Concurrent registration rejected');
  };
  assert.equal(await s.run(), 'reloading');
  assert.equal(reads, 2); assert.equal(s.worker.messages.length, 0); assert.equal(s.navigations.length, 1);
  assert.equal(s.container.controller, null); s.clean();
});
test('a matching installation in progress is reused until activation', async () => {
  const s = setup(); s.container.getRegistration = async () => s.registration;
  const pending = s.run(); await tick(); assert.equal(s.calls.length, 0); assert.equal(s.worker.messages.length, 0);
  s.registration.installing = null; s.registration.active = s.worker; s.worker.change('activated');
  assert.equal(await pending, 'reloading');
  assert.equal(s.worker.messages.length, 0); assert.equal(s.navigations.length, 1); s.clean();
});
test('another script or broader registration must not hide the original registration error', async () => {
  for (const mismatch of ['script', 'scope', 'redundant']) {
    const s = setup(); s.container.getRegistration = async () => s.registration;
    if (mismatch === 'script') s.worker.scriptURL = new URL('unrelated.js', route).href;
    if (mismatch === 'scope') s.registration.scope = new URL('../', route).href;
    if (mismatch === 'redundant') s.worker.state = 'redundant';
    s.container.register = () => { throw new Error('Original registration error'); };
    await assert.rejects(s.run(), /Original registration error/);
    assert.equal(s.worker.messages.length, 0); assert.equal(s.navigations.length, 0); s.clean();
  }
});
test('failed registration lookup preserves the registration error', async () => {
  const s = setup(); s.container.getRegistration = () => Promise.reject(new Error('Lookup blocked'));
  s.container.register = () => Promise.reject(new Error('Registration blocked'));
  await assert.rejects(s.run(), /Registration blocked/); s.clean(); assert.equal(s.navigations.length, 0);
});
test('a late registration lookup after the deadline must neither register nor claim nor navigate', async () => {
  const s = setup(); let release;
  s.container.getRegistration = () => new Promise(resolve => { release = resolve; });
  await assert.rejects(s.run({ timeoutMs: 15 }), /timed out/); s.clean();
  s.worker.state = 'activated'; s.registration.active = s.worker; s.registration.installing = null;
  release(s.registration); await tick();
  assert.equal(s.calls.length, 0); assert.equal(s.worker.messages.length, 0); assert.equal(s.navigations.length, 0); s.clean();
});
test('a late recovery lookup after registration failure must not claim or navigate', async () => {
  const s = setup(); let release, reads = 0;
  s.container.getRegistration = () => ++reads === 1 ? Promise.resolve(undefined) : new Promise(resolve => { release = resolve; });
  s.container.register = () => Promise.reject(new Error('Concurrent registration rejected'));
  await assert.rejects(s.run({ timeoutMs: 15 }), /timed out/); s.clean();
  release(s.registration); s.claim(); await tick();
  assert.equal(s.worker.messages.length, 0); assert.equal(s.navigations.length, 0); s.clean();
});
test('an active registration alone does not enable shared memory after the navigation', async () => {
  const s = setup(); s.worker.state = 'activated'; s.registration.installing = null; s.registration.active = s.worker;
  s.container.getRegistration = async () => s.registration;
  assert.equal(await s.run(), 'reloading');
  assert.equal(s.environment.crossOriginIsolated, false);
  await assert.rejects(s.run(), /Automatic reloads have stopped/);
  assert.equal(s.calls.length, 0); assert.equal(s.navigations.length, 1); s.clean();
});

function workerHarness() {
  const handlers = new Map(); let claims = 0;
  const self = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => { claims++; } },
  };
  runInNewContext(readFileSync(new URL('../assets/isolation-sw.js', import.meta.url), 'utf8'), { self, URL });
  async function activate() {
    const work = []; handlers.get('activate')({ waitUntil: value => work.push(value) });
    await Promise.all(work);
  }
  return { self, activate, handlers, claims: () => claims };
}
test('the setup worker attempts immediate control on activation without a message protocol', async () => {
  const h = workerHarness(); await h.activate();
  assert.equal(h.claims(), 1); assert.equal(h.handlers.has('message'), false);
});
test('a denied claim does not block activation; navigation can still use the active registration', async () => {
  const h = workerHarness(); h.self.clients.claim = () => Promise.reject(new Error('Browser denied claim'));
  await h.activate();
});
