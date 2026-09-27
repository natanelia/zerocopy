import assert from 'node:assert/strict';
import test from 'node:test';
import { Peer } from '../assets/explorer-peer.mjs';

// These units check resource ownership. Real WebKit/Chromium tests exercise
// module loading, shared memory and browser security policies separately.
async function environment(page, check) {
  const saved = new Map(['Worker', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const blobs = [], revoked = [], workers = [];
  class WorkerStub {
    constructor(url, options) { this.url = url; this.options = options; this.stops = 0; workers.push(this); }
    postMessage() {}
    terminate() { this.stops++; }
  }
  globalThis.Worker = WorkerStub;
  if (page) globalThis.document = {}; else delete globalThis.document;
  URL.createObjectURL = blob => { blobs.push(blob); return `blob:test-${blobs.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  try { await check({ blobs, revoked, workers }); }
  finally {
    URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('page-created peers use ordinary module worker URLs', async () => {
  await environment(true, async ({ blobs, revoked, workers }) => {
    const url = new URL('https://example.test/demo/assets/reader.mjs');
    const peer = new Peer(url);
    assert.equal(workers[0].url, url);
    assert.deepEqual(blobs, []);
    peer.close(); peer.close();
    assert.equal(workers[0].stops, 1);
    assert.deepEqual(revoked, []);
  });
});

test('nested peers use an absolute import and release its module URL once', async () => {
  await environment(false, async ({ blobs, revoked, workers }) => {
    const url = new URL('https://example.test/demo/assets/reader.mjs');
    const peer = new Peer(url);
    assert.equal(workers[0].url, 'blob:test-1');
    assert.deepEqual(workers[0].options, { type: 'module' });
    assert.equal(await blobs[0].text(), `import ${JSON.stringify(url.href)};`);
    const pending = peer.request('ping');
    const rejection = assert.rejects(pending, /Worker connection closed/);
    peer.close(); peer.close(); await rejection;
    assert.deepEqual(revoked, ['blob:test-1']);
    assert.equal(workers[0].stops, 1);
    assert.equal(peer.pending.size, 0);
  });
});

test('worker constructor failure releases the unstarted module URL', async () => {
  await environment(false, async ({ revoked }) => {
    globalThis.Worker = class { constructor() { throw new Error('constructor failed'); } };
    assert.throws(() => new Peer(new URL('https://example.test/reader.mjs')), /constructor failed/);
    assert.deepEqual(revoked, ['blob:test-1']);
  });
});

test('script loading errors close peers and identify the failed module', async () => {
  await environment(false, async ({ revoked, workers }) => {
    const fatal = [];
    const peer = new Peer(new URL('https://example.test/reader.mjs'), () => {}, error => fatal.push(error));
    const pending = peer.request('ping');
    const rejection = assert.rejects(pending, /reader\.mjs/);
    workers[0].onerror({}); await rejection;
    assert.equal(fatal.length, 1);
    assert.equal(peer.closed, true);
    assert.deepEqual(revoked, ['blob:test-1']);
    assert.equal(peer.pending.size, 0);
  });
});
