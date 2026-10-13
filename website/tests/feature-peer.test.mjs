import test from 'node:test';
import assert from 'node:assert/strict';
import { Peer } from '../assets/feature-peer.mjs';

test('feature peers distinguish live worker failures from errors after closure', async t => {
  const priorWorker = globalThis.Worker;
  globalThis.Worker = class {
    terminations = 0;
    postMessage() {}
    terminate() { this.terminations++; }
  };
  const moduleError = () => Object.assign(new Event('error', { cancelable: true }), { message: 'Importing a module script failed.' });
  try {
    await t.test('a live failure rejects its request and keeps error propagation', async () => {
      const peer = new Peer(new URL('https://example.invalid/feature-owner.mjs'));
      const rejected = assert.rejects(peer.request('prepare'), /Importing a module script failed/);
      const event = moduleError();
      peer.worker.onerror(event);
      await rejected;
      assert.equal(event.defaultPrevented, false);
      assert.equal(peer.closed, true);
      assert.equal(peer.pending.size, 0);
      assert.equal(peer.worker.terminations, 1);
    });
    await t.test('a late error after explicit close is cancelled without reopening work', async () => {
      const peer = new Peer(new URL('https://example.invalid/feature-owner.mjs'));
      const rejected = assert.rejects(peer.request('prepare'), /Worker connection is closed/);
      peer.close();
      await rejected;
      const event = moduleError();
      peer.worker.onerror(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(peer.closed, true);
      assert.equal(peer.pending.size, 0);
      assert.equal(peer.worker.terminations, 1);
      await assert.rejects(peer.request('load'), /Worker connection is closed/);
    });
  } finally {
    if (priorWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = priorWorker;
  }
});
