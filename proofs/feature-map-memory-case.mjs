/** One fresh OS process with a controller, one owner, and zero, two or four readers. */
import assert from 'node:assert/strict';
import { Worker, MessageChannel } from 'node:worker_threads';
import { validateCase, compareMemory, STREAM_EDITS, RPC_TIMEOUT_MS } from './feature-map-memory-model.mjs';

const config = validateCase(JSON.parse(process.argv[2]));
assert.equal(typeof global.gc, 'function', 'Start this process with --expose-gc');
const peers = [];
function spawn(role) {
  const worker = new Worker(new URL('./feature-map-memory-agent.mjs', import.meta.url), { workerData: { ...config, role } });
  let readyResolve, readyReject, next = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error(`Timeout: ${role} startup`)), RPC_TIMEOUT_MS);
  function rejectAll(error) {
    clearTimeout(readyTimer); readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  worker.on('error', rejectAll);
  worker.on('messageerror', rejectAll);
  worker.on('exit', code => rejectAll(new Error(`Worker ${role} exited (${code})`)));
  worker.on('message', message => {
    if (message.ready) {
      clearTimeout(readyTimer);
      if (message.role !== role) readyReject(new Error('Worker identity mismatch'));
      else readyResolve();
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
  });
  const peer = { worker, role, ready, request(type, body = {}, transferList = []) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${role} ${type}`)); }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, type, ...body }, transferList); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  } };
  peers.push(peer);
  return peer;
}

async function sample() {
  const threads = [];
  // Publication and computation are quiescent before each GC barrier.
  for (const peer of peers) threads.push(await peer.request('sample'));
  for (let i = 0; i < 4; i++) { await new Promise(setImmediate); global.gc(); }
  threads.push({ role: 'controller', usage: process.memoryUsage(), arenas: [] });
  return { threads, rssBytes: process.memoryUsage.rss(), processHighWaterRSSBytes: process.resourceUsage().maxRSS * 1024 };
}
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
try {
  output({ type: 'config', kind: config.kind, readers: config.readers, entries: config.entries, pid: process.pid });
  const owner = spawn('owner'), readers = Array.from({ length: config.readers }, (_, index) => spawn(`reader-${index}`));
  await Promise.all(peers.map(peer => peer.ready));
  const channels = readers.map(() => new MessageChannel());
  await Promise.all(readers.map((peer, index) => peer.request('connect-reader', { port: channels[index].port1 }, [channels[index].port1])));
  await owner.request('connect-owner', { ports: channels.map(channel => channel.port2) }, channels.map(channel => channel.port2));
  await Promise.all(peers.map(peer => peer.request('ping')));
  const baseline = await sample();
  output({ type: 'baseline', ...baseline });
  async function stage(name) {
    const reading = await sample(), memory = compareMemory(baseline.threads, reading.threads);
    output({ type: 'stage', name, ...reading, memory });
  }
  async function verify(retained = false, phase = 'validation') { output({ type: 'answer', retained, phase, value: await owner.request('query', { retained }) }); }
  await owner.request('load'); await stage('loaded');
  await verify(false, 'cold'); await verify(false, 'warm'); await stage('queried');
  await owner.request('retain', { enabled: true });
  await owner.request('edit'); await verify(); await verify(true); await stage('edited-retained');
  await owner.request('retain', { enabled: false }); await verify(); await stage('released');
  for (let index = 0; index < STREAM_EDITS; index++) await owner.request('edit');
  await verify(); await stage('streamed');
  await Promise.all(peers.map(peer => peer.worker.terminate())); peers.length = 0;
  output({ type: 'stopped', ...(await sample()) });
} finally { await Promise.all(peers.map(peer => peer.worker.terminate())); }
