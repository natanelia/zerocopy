/** WebKit may leave an activated worker in a stale registration wrapper slot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIsolation } from '../assets/isolation.mjs';

function setup(slot, state, unrelated = false) {
  const scope = 'https://example.test/previews/pr-13/test/compare/';
  const workerURL = new URL('isolation-sw.js', scope);
  const worker = Object.assign(new EventTarget(), { state, scriptURL: unrelated ? new URL('other.js', scope).href : workerURL.href });
  const registration = Object.assign(new EventTarget(), { scope, active: null, waiting: null, installing: null, [slot]: worker });
  const container = Object.assign(new EventTarget(), {
    controller: null,
    register: async () => registration,
    getRegistration: async () => registration,
  });
  const navigations = [], timers = new Set();
  const environment = {
    isSecureContext: true, crossOriginIsolated: false, WebAssembly, SharedArrayBuffer,
    navigator: { serviceWorker: container },
    location: { href: scope, replace(url) { this.href = url; navigations.push(url); } },
    setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  };
  return {
    worker, environment, navigations, timers,
    run: () => prepareIsolation({ environment, workerURL, timeoutMs: 30 }),
  };
}

for (const slot of ['installing', 'waiting']) {
  test(`an activated worker in a stale ${slot} slot permits only one setup navigation`, async () => {
    const s = setup(slot, 'installing');
    const pending = s.run();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.navigations.length, 0);
    s.worker.state = 'activated'; s.worker.dispatchEvent(new Event('statechange'));
    assert.equal(await pending, 'reloading');
    assert.equal(s.navigations.length, 1);
    assert.equal(s.environment.crossOriginIsolated, false, 'Navigation does not prove isolation');
    await assert.rejects(s.run(), /Automatic reloads have stopped/);
    assert.equal(s.navigations.length, 1); assert.equal(s.timers.size, 0);
  });

  test(`a stale ${slot} slot rejects an activating worker and an unrelated activated script`, async () => {
    for (const unrelated of [false, true]) {
      const s = setup(slot, unrelated ? 'activated' : 'activating', unrelated);
      await assert.rejects(s.run(), unrelated ? /unexpected demo registration/ : /timed out/);
      assert.equal(s.navigations.length, 0); assert.equal(s.timers.size, 0);
    }
  });
}
