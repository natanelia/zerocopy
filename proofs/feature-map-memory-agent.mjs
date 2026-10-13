/** One real data-owner or reader isolate. The controller never holds the full dataset. */
import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { EDIT_COUNT, READ_COUNT, RPC_TIMEOUT_MS } from './feature-map-memory-model.mjs';

const { kind, role, runtime, entries } = workerData;
const base = pathToFileURL(runtime + '/');
const core = await import(new URL('assets/feature-core.mjs', base));
const { createStorage } = await import(new URL('assets/feature-storage.mjs', base));
const storage = await createStorage(kind);
assert.equal(core.EDIT_COUNT, EDIT_COUNT);
assert.equal(core.READ_COUNT, READ_COUNT);
let snapshot, retained, revision = 0, retainedRevision = null, ids, lastAnswer;
let initialPublications = 0, editPublications = 0, clonedEntryPairs = 0;
const readers = [];

function readerRPC(port, index) {
  let next = 0;
  const pending = new Map();
  const rejectAll = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  port.on('message', message => {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
  });
  port.on('messageerror', rejectAll);
  port.on('close', () => rejectAll(new Error(`Reader ${index} channel closed`)));
  return { request(type, body = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: reader-${index} ${type}`)); }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage({ id, type, ...body }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  } };
}

async function publish(initial, changes) {
  if (!readers.length) return;
  const body = initial || kind === 'shared'
    ? { payload: storage.payload(snapshot), revision }
    : { changes, revision };
  if (!initial && kind !== 'shared') assert.equal(changes.length, EDIT_COUNT, 'Sparse edits must not clone the full map');
  await Promise.all(readers.map(peer => peer.request(initial ? 'init' : 'edit', body)));
  if (initial) initialPublications += readers.length;
  else editPublications += readers.length;
  if (kind !== 'shared') clonedEntryPairs += readers.length * (initial ? entries : changes.length);
}

async function run(message) {
  if (message.type === 'connect-owner') {
    assert.equal(role, 'owner');
    assert.equal(readers.length, 0);
    readers.push(...message.ports.map(readerRPC));
    return true;
  }
  if (message.type === 'connect-reader') {
    assert.notEqual(role, 'owner');
    message.port.on('message', data => handle(message.port, data));
    return true;
  }
  if (message.type === 'ping') return true;
  if (message.type === 'load') {
    assert.equal(role, 'owner');
    assert.equal(snapshot, undefined);
    snapshot = storage.build(core.entriesFor(entries));
    assert.equal(snapshot.size, entries);
    ids = core.queryIds(entries);
    await publish(true);
    return { count: snapshot.size, revision };
  }
  if (message.type === 'init') {
    assert.notEqual(role, 'owner');
    assert.equal(snapshot, undefined);
    assert.equal(message.revision, 0);
    snapshot = await storage.attach(message.payload);
    ids = core.queryIds(entries);
    assert.equal(snapshot.size, entries);
    return { count: snapshot.size, revision };
  }
  if (message.type === 'edit') {
    assert.ok(snapshot, 'Load before editing');
    if (role === 'owner') {
      const changes = core.editsFor(entries, revision + 1);
      assert.equal(changes.length, EDIT_COUNT);
      assert.equal(new Set(changes.map(([id]) => id)).size, EDIT_COUNT, 'An edit must replace 100 distinct existing IDs');
      snapshot = storage.update(snapshot, changes, retained);
      revision++;
      await publish(false, changes);
    } else {
      assert.equal(message.revision, revision + 1, 'Reader update revision skipped');
      if (kind === 'shared') snapshot = await storage.attach(message.payload);
      else {
        assert.equal(message.payload, undefined, 'Non-shared sparse edit cannot contain a full snapshot');
        assert.equal(message.changes.length, EDIT_COUNT);
        snapshot = storage.update(snapshot, message.changes, retained);
      }
      revision = message.revision;
    }
    assert.equal(snapshot.size, entries, 'Replacement changed map cardinality');
    return { count: snapshot.size, revision };
  }
  if (message.type === 'retain') {
    assert.equal(typeof message.enabled, 'boolean');
    if (message.enabled) {
      assert.equal(revision, 0, 'Only the initial revision is retained');
      retained = snapshot; retainedRevision = revision;
    } else { retained = undefined; retainedRevision = null; }
    if (role === 'owner') await Promise.all(readers.map(peer => peer.request('retain', { enabled: message.enabled })));
    return true;
  }
  if (message.type === 'query') {
    const value = message.retained ? retained : snapshot;
    const selectedRevision = message.retained ? retainedRevision : revision;
    assert.ok(value, 'Requested snapshot is missing');
    if (role === 'owner' && readers.length) {
      const answers = await Promise.all(readers.map((peer, index) => peer.request('query', { retained: message.retained, task: index % 2 ? 'validate' : 'lookup' })));
      lastAnswer = { revision: selectedRevision, answers };
    } else {
      const task = message.task || 'both';
      const answer = core.calculate(value, ids, task);
      lastAnswer = { role, revision: selectedRevision, task, answer };
      if (role === 'owner') lastAnswer = { revision: selectedRevision, answers: [lastAnswer] };
    }
    return lastAnswer;
  }
  if (message.type === 'sample') {
    assert.equal(typeof global.gc, 'function', 'GC must be enabled in every isolate');
    for (let i = 0; i < 4; i++) { await new Promise(setImmediate); global.gc(); }
    return { role, usage: process.memoryUsage(), arenas: storage.arenas(snapshot, retained), count: snapshot?.size ?? 0, revision,
      retainedRevision, transport: { initialPublications, editPublications, clonedEntryPairs } };
  }
  throw new Error(`Unknown memory proof operation: ${message.type}`);
}

let busy = false;
async function handle(port, message) {
  if (busy) { port.postMessage({ id: message.id, error: 'Concurrent memory proof operation' }); return; }
  busy = true;
  try { port.postMessage({ id: message.id, value: await run(message) }); }
  catch (error) { port.postMessage({ id: message.id, error: error.stack ?? String(error) }); }
  finally { busy = false; }
}
parentPort.on('message', message => handle(parentPort, message));
parentPort.postMessage({ ready: true, role });
