import test from 'node:test';
import assert from 'node:assert/strict';
import { Peer } from '../assets/catalog-peer.mjs';

test('catalog bootstrap ownership preserves worker errors and navigation cleanup', async t => {
  const previous = Object.fromEntries(['Worker', 'window', 'document'].map(key => [key, globalThis[key]]));
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  const blobs = [], revoked = [], owned = [];
  class WorkerStub {
    constructor(url) { this.url = String(url); this.terminations = 0; }
    postMessage() {}
    terminate() { this.terminations++; }
  }
  globalThis.Worker = WorkerStub; globalThis.document = {}; globalThis.window = new EventTarget();
  URL.createObjectURL = blob => { blobs.push(blob); return `blob:catalog-test-${blobs.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  const source = new URL('https://example.invalid/compare/assets/feature-owner.mjs');
  const open = () => { const peer = new Peer(source); owned.push(peer); return peer; };
  try {
    await t.test('document owner imports the original absolute URL and releases once', async () => {
      const peer = open(), bootstrap = peer.worker.url;
      assert.match(bootstrap, /^blob:/);
      assert.equal(await blobs.at(-1).text(), `import ${JSON.stringify(source.href)};`);
      peer.close(); peer.close();
      assert.equal(peer.worker.terminations, 1);
      assert.equal(revoked.filter(url => url === bootstrap).length, 1);
    });
    await t.test('construction failure revokes the unused bootstrap', () => {
      globalThis.Worker = class { constructor() { throw new Error('constructor failed'); } };
      assert.throws(() => open(), /constructor failed/);
      assert.equal(revoked.at(-1), `blob:catalog-test-${blobs.length}`);
      globalThis.Worker = WorkerStub;
    });
    await t.test('active load errors reject work, propagate and revoke', async () => {
      const peer = open(), bootstrap = peer.worker.url;
      const rejected = assert.rejects(peer.request('prepare'), /Feature worker could not load/);
      const event = new Event('error'); peer.worker.onerror(event); await rejected;
      assert.equal(event.defaultPrevented, false);
      assert.equal(peer.closed, true); assert.equal(peer.pending.size, 0);
      assert.equal(peer.worker.terminations, 1);
      assert.equal(revoked.filter(url => url === bootstrap).length, 1);
    });
    await t.test('navigation synchronously releases every owner without a leave prompt', async () => {
      const peers = [open(), open()];
      const rejected = peers.map(peer => assert.rejects(peer.request('load'), /Worker connection is closed/));
      const event = new Event('beforeunload', { cancelable: true });
      assert.equal(window.dispatchEvent(event), true); assert.equal(event.defaultPrevented, false);
      for (const peer of peers) {
        assert.equal(peer.closed, true); assert.equal(peer.pending.size, 0);
        assert.equal(peer.worker.terminations, 1);
        assert.equal(revoked.filter(url => url === peer.worker.url).length, 1);
      }
      await Promise.all(rejected);
    });
    await t.test('nested readers keep one existing bootstrap and release it', async () => {
      delete globalThis.document; delete globalThis.window;
      const before = blobs.length, peer = open(), bootstrap = peer.worker.url;
      assert.equal(blobs.length, before + 1);
      assert.equal(await blobs.at(-1).text(), `import ${JSON.stringify(source.href)};`);
      peer.close(); assert.equal(revoked.filter(url => url === bootstrap).length, 1);
    });
  } finally {
    for (const peer of owned) peer.close();
    URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
