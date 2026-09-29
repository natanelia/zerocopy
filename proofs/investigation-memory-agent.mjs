/** A proof-only data owner or reader. Uses the website's real storage/query code. */
import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { decorateColumns } from './investigation-memory-model.mjs';
const { kind, role, runtime, fixture } = workerData;
const base = pathToFileURL(runtime + '/');
const core = await import(new URL('assets/explorer-core.mjs', base));
const sharedAPI = kind === 'shared' ? await import(new URL('library/shared.js', base)) : undefined;
const storage = kind === 'shared' ? await import(new URL('assets/explorer-storage.mjs', base))
  : kind === 'immutable' ? await import(new URL('assets/immutable-storage.mjs', base)) : undefined;
let snapshot, frozen, count = 0, frozenCount = 0, lastAnswer;
const readers = [];
const columnsFor = (start, size) => decorateColumns(core.generateColumns(start, size), start, fixture);
const makeView = (value = snapshot, length = count) => {
  const view = kind === 'immutable' ? storage.immutableView(value) : kind === 'shared' ? core.sharedView(value) : core.nativeView(value);
  view.length = length; return view;
};
function readerRPC(port) {
  let next = 0; const pending = new Map();
  port.on('message', message => { const item = pending.get(message.id); if (!item) return; pending.delete(message.id); message.error ? item.reject(new Error(message.error)) : item.resolve(message.value); });
  return { port, request(type, body = {}) { return new Promise((resolve,reject) => { const id = ++next; pending.set(id,{resolve,reject}); port.postMessage({ id, type, ...body }); }); } };
}
function arenas() {
  if (kind !== 'shared' || !snapshot) return [];
  const seen = new Map(), queue = [snapshot, frozen].filter(Boolean).flatMap(s => Object.values(s).map(value => value.arena));
  while (queue.length) {
    const arena = queue.pop();
    assert.ok(arena?.memory instanceof WebAssembly.Memory);
    assert.ok(arena.memory.buffer instanceof SharedArrayBuffer);
    if (seen.has(arena.id)) continue;
    seen.set(arena.id, { id: arena.id, capacityBytes: arena.memory.buffer.byteLength, usedBytes: arena.used, readOnly: arena.readOnly });
    queue.push(...arena.dependencies.values());
  }
  return [...seen.values()];
}
async function calculate(value, length, task) {
  const view = makeView(value, length), query = { term: 'request' }, answer = {};
  if (task !== 'summary') answer.search = await core.search(view, query);
  if (task !== 'search') answer.summary = await core.summarizeEvents(view, query);
  if (answer.search && role === 'owner') answer.rows = answer.search.indices.map(index => core.rowAt(view,index));
  return answer;
}
async function publish(type, delta) {
  const body = kind === 'shared' ? { payload: storage.sharedPayload(snapshot), count }
    : { columns: kind === 'immutable' ? storage.transportColumns(snapshot, type === 'append' ? count - delta.time.length : 0) : (type === 'append' ? delta : snapshot), count };
  await Promise.all(readers.map(peer => peer.request(type, body)));
}
async function run(message) {
  if (message.type === 'connect-owner') { readers.push(...message.ports.map(readerRPC)); return true; }
  if (message.type === 'connect-reader') { message.port.on('message', data => handle(message.port, data)); return true; }
  if (message.type === 'ping') return true;
  if (message.type === 'load') {
    assert.equal(role,'owner');
    if (kind === 'shared') {
      snapshot = storage.emptyShared();
      for (let start = 0; start < message.count; start += 2000) snapshot = storage.appendShared(snapshot, columnsFor(start, Math.min(2000,message.count-start)));
    } else {
      const columns = columnsFor(0, message.count);
      snapshot = kind === 'immutable' ? storage.fromColumns(columns) : columns;
    }
    count = message.count; await publish('init'); return count;
  }
  if (message.type === 'init' || message.type === 'append') {
    if (role === 'owner') {
      const delta = columnsFor(count, message.count);
      if (kind === 'shared') snapshot = storage.appendShared(snapshot, delta);
      else if (kind === 'immutable') snapshot = storage.appendImmutable(snapshot, delta);
      else core.appendNative(snapshot, delta);
      count += message.count; await publish('append',delta);
    } else {
      if (kind === 'shared') snapshot = await sharedAPI.initWorker(message.payload);
      else if (kind === 'immutable') snapshot = message.type === 'init' ? storage.fromColumns(message.columns) : storage.appendImmutable(snapshot, message.columns);
      else if (message.type === 'init') snapshot = message.columns; else core.appendNative(snapshot,message.columns);
      count = message.count;
    }
    return count;
  }
  if (message.type === 'retain') {
    frozen = message.enabled ? snapshot : undefined; frozenCount = message.enabled ? count : 0;
    if (role === 'owner') await Promise.all(readers.map(peer => peer.request('retain', { enabled: message.enabled })));
    return true;
  }
  if (message.type === 'query') {
    const value = message.frozen ? frozen : snapshot, length = message.frozen ? frozenCount : count;
    assert.ok(value, 'Snapshot is missing');
    if (role === 'owner' && readers.length) {
      const answers = await Promise.all(readers.map((peer, index) => peer.request('query', { frozen: message.frozen, task: readers.length === 1 ? 'both' : index % 2 ? 'summary' : 'search' })));
      // Match the browser design: the owner materializes the visible row page.
      const view = makeView(value, length);
      for (const answer of answers) if (answer.search) answer.rows = answer.search.indices.map(index => core.rowAt(view,index));
      lastAnswer = { readers: answers, count: length }; return lastAnswer;
    }
    lastAnswer = await calculate(value, length, message.task || 'both'); return lastAnswer;
  }
  if (message.type === 'sample') {
    assert.equal(typeof global.gc, 'function', 'GC must be enabled in every worker');
    for (let i=0;i<4;i++) { await new Promise(setImmediate); global.gc(); }
    const usage = process.memoryUsage();
    return { role, usage, arenas: arenas(), count, frozenCount };
  }
  throw new Error(`Unknown memory proof operation: ${message.type}`);
}
let busy = false;
async function handle(port, message) {
  if (busy) { port.postMessage({ id: message.id, error: 'Concurrent memory proof operation' }); return; }
  busy = true;
  try { port.postMessage({ id: message.id, value: await run(message) }); }
  catch (error) { port.postMessage({ id: message.id, error: error.stack }); }
  finally { busy = false; }
}
parentPort.on('message', message => handle(parentPort,message));
parentPort.postMessage({ ready: true });
