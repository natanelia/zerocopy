import test from 'node:test';
import assert from 'node:assert/strict';
import { Peer } from '../assets/feature-peer.mjs';

test('feature peers release at navigation without hiding live worker errors', async t => {
  const previous = Object.fromEntries(['Worker', 'window', 'document'].map(key => [key, globalThis[key]]));
  globalThis.Worker = class {
    terminations = 0;
    postMessage() {}
    terminate() { this.terminations++; }
  };
  globalThis.document = {};
  globalThis.window = new class extends EventTarget {
    listeners = new Set();
    addEventListener(type, listener, options) {
      if (type === 'beforeunload') this.listeners.add(listener);
      super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      if (type === 'beforeunload') this.listeners.delete(listener);
      super.removeEventListener(type, listener, options);
    }
  }();
  const owned = new Set();
  const owner = () => { const peer = new Peer(new URL('https://example.invalid/feature-owner.mjs')); owned.add(peer); return peer; };
  try {
    await t.test('navigation closes pending work synchronously without cancelling navigation', async () => {
      const peer = owner();
      const rejected = assert.rejects(peer.request('prepare'), /Worker connection is closed/);
      assert.equal(window.listeners.size, 1);
      const event = new Event('beforeunload', { cancelable: true });
      assert.equal(window.dispatchEvent(event), true);
      assert.equal(event.defaultPrevented, false);
      assert.equal(peer.closed, true);
      assert.equal(peer.pending.size, 0);
      assert.equal(peer.worker.terminations, 1);
      assert.equal(window.listeners.size, 0);
      await rejected;
      peer.close();
      window.dispatchEvent(new Event('beforeunload'));
      assert.equal(peer.worker.terminations, 1);
      await assert.rejects(peer.request('load'), /Worker connection is closed/);
    });
    await t.test('a live non-cancelable load failure still rejects and propagates', async () => {
      const peer = owner();
      const rejected = assert.rejects(peer.request('prepare'), /Feature worker could not load/);
      const event = new Event('error');
      peer.worker.onerror(event);
      await rejected;
      assert.equal(event.defaultPrevented, false);
      assert.equal(peer.closed, true);
      assert.equal(peer.pending.size, 0);
      assert.equal(peer.worker.terminations, 1);
      assert.equal(window.listeners.size, 0);
    });
    await t.test('normal release removes the listener and leaves other peers owned', () => {
      const first = owner(), second = owner();
      assert.equal(window.listeners.size, 2);
      first.close();
      assert.equal(window.listeners.size, 1);
      assert.equal(second.closed, false);
      window.dispatchEvent(new Event('beforeunload'));
      assert.equal(second.closed, true);
      assert.equal(window.listeners.size, 0);
      assert.equal(first.worker.terminations, 1);
      assert.equal(second.worker.terminations, 1);
    });
  } finally {
    for (const peer of owned) peer.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
