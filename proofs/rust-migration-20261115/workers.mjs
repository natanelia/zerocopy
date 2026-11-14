// Real Node worker correctness proof, with no reader-side shared-memory writes.
// Run after build:wasm and build:browser:
// node proofs/rust-migration-20261115/workers.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { setImmediate as immediate } from 'node:timers/promises';
import * as S from '../../dist/shared.js';

const coreBytes = isMainThread ? readFileSync(new URL('../../persistent-core.wasm', import.meta.url)) : undefined;
const INITIAL_READERS = 8;
const LATE_READERS = 4;
const FIRST_ROUNDS = 40;
const FINAL_ROUNDS = 20;

function equalBytes(actual, expected, label) {
  assert.deepEqual(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength), label);
}
function image(memory, start = 0, end = memory.buffer.byteLength) {
  return new Uint8Array(memory.buffer, start, end - start).slice();
}
function row(revision, padding = '') {
  return { revision, category: 'books', available: true, missing: null, text: '保持🙂',
    nested: { count: 17, '道路': 'shared bytes', note: 'quote" and newline\n' },
    items: [3, null, { active: true, code: 'A17' }], padding };
}

if (!isMainThread) {
  // If an application path starts using JS Atomics to mutate shared memory,
  // fail immediately. Wasm writes are independently caught by byte canaries.
  let atomicWrites = 0;
  for (const name of ['add', 'and', 'compareExchange', 'exchange', 'or', 'store', 'sub', 'xor']) {
    Object.defineProperty(Atomics, name, { configurable: true, value() { atomicWrites++; throw new Error(`Reader called Atomics.${name}`); } });
  }
  let running = false, reading, cycles = 0, attached, view, nested, items, item, listView, matches;
  let readyInfo;

  function readRetained(iteration) {
    assert.equal(view.get('revision'), 7);
    assert.equal(view.equals('category', 'books'), true);
    assert.equal(view.equals('text', '保持🙂'), true);
    assert.equal(view.has('absent'), false);
    assert.equal(view.get('missing'), null);
    assert.equal(nested.get('count'), 17);
    assert.equal(nested.equals('道路', 'shared bytes'), true);
    assert.equal(nested.equals('note', 'quote" and newline\n'), true);
    assert.equal(items.at(0), 3);
    assert.equal(items.at(1), null);
    assert.equal(item.get('active'), true);
    assert.equal(item.equals('code', 'A17'), true);
    assert.equal(listView.get('revision'), 7);
    assert.equal(attached.numbers.get('key-31'), 31);
    assert.equal(attached.numbers.get('key-' + (iteration % 256)), iteration % 256);
    assert.equal(attached.list.get(iteration % 2049), iteration % 2049);
    assert.equal(matches(iteration % 96), iteration % 3 !== 1);
  }

  async function prepare() {
    const { payload, coreModule, phase } = workerData;
    const before = payload.arenas.map(source => image(source.memory, phase === 'canary' ? 0 : 65536, phase === 'canary' ? source.memory.buffer.byteLength : source.used));
    // Two direct instances over the same memory must have independent globals.
    const memory = payload.arenas[0].memory;
    const first = new WebAssembly.Instance(coreModule, { env: { memory } }).exports;
    const second = new WebAssembly.Instance(coreModule, { env: { memory } }).exports;
    assert.equal(first.getHeapEnd(), 65536);
    assert.equal(second.getHeapEnd(), 65536);
    first.setHeapEnd(payload.arenas[0].used);
    second.setHeapEnd(65544);
    assert.equal(first.getHeapEnd(), payload.arenas[0].used);
    assert.equal(second.getHeapEnd(), 65544);
    attached = await S.initWorker(payload);
    const attachedState = S.getWorkerData(attached, { copy: false });
    for (const source of payload.arenas) assert.equal(attachedState.arenas.find(arena => arena.id === source.id).used, source.used);

    let freezeCalls = 0;
    const originalFreeze = Object.freeze;
    let materialized, independent;
    Object.freeze = function (...args) { freezeCalls++; return Reflect.apply(originalFreeze, Object, args); };
    try {
      view = attached.docs.getView('document');
      nested = view.get('nested');
      items = view.get('items');
      item = items.at(2);
      listView = attached.jsonRows.getView(0);
      matches = attached.words.compileTextSearch('route', { caseSensitive: false });
      materialized = view.toObject();
      independent = view.toObject();
      readRetained(0);
    } finally { Object.freeze = originalFreeze; }
    assert.equal(freezeCalls, 0, 'selected byte reads and default materialization do not freeze');
    assert.equal(Object.isFrozen(view), false);
    assert.equal(Object.isFrozen(nested), false);
    assert.equal(Object.isFrozen(materialized), false);
    assert.equal(Object.isFrozen(materialized.nested), false);
    assert.notEqual(materialized, independent);
    assert.notEqual(materialized.nested, independent.nested);
    assert.notEqual(materialized.items, independent.items);
    materialized.nested.count = 900;
    materialized.items.push('local-only');
    assert.equal(nested.get('count'), 17);
    assert.equal(independent.nested.count, 17);
    assert.equal(independent.items.length, 3);
    const frozen = view.toObject({ freeze: true });
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.nested), true);
    assert.equal(Object.isFrozen(frozen.items), true);
    assert.throws(() => attached.docs.set('no-writer', row(99)), /read-only/i);
    assert.throws(() => attached.list.push(99), /read-only/i);
    for (let i = 0; i < 300; i++) readRetained(i);
    for (let i = 0; i < payload.arenas.length; i++) {
      const source = payload.arenas[i], start = phase === 'canary' ? 0 : 65536;
      equalBytes(new Uint8Array(source.memory.buffer, start, before[i].length), before[i], `reader ${workerData.index}: attachment/queries preserve ${phase} bytes`);
    }
    readyInfo = { index: workerData.index, phase, privateHeapGlobals: true, freezeCalls, atomicWrites, canaryArenas: payload.arenas.length };
    parentPort.postMessage({ type: 'ready', result: readyInfo });
  }

  async function loop() {
    while (running) {
      for (let i = 0; i < 64; i++) readRetained(cycles++);
      await immediate();
    }
  }
  parentPort.on('message', async message => {
    try {
      if (message.type === 'start') {
        assert.equal(running, false);
        running = true;
        reading = loop();
        reading.catch(error => parentPort.postMessage({ type: 'fatal', error: error.stack }));
        parentPort.postMessage({ id: message.id, result: { reading: true } });
      } else if (message.type === 'finish') {
        running = false;
        await reading;
        assert(cycles > 0);
        const before = message.payload.arenas.map(source => image(source.memory));
        for (let i = 0; i < 500; i++) readRetained(i);
        assert.deepEqual(view.toObject(), row(7));
        assert.deepEqual(nested.toObject(), row(7).nested);
        const fresh = await S.initWorker(message.payload);
        assert.equal(fresh.docs.getView('document').get('revision'), message.revision);
        assert.equal(fresh.docs.getView('document').get('nested').get('count'), 17);
        assert.equal(fresh.numbers.get('key-31'), message.number);
        assert.equal(fresh.list.get(0), message.listFirst);
        assert.equal(fresh.list.get(fresh.list.size - 1), fresh.list.size - 1);
        const oldState = S.getWorkerData(attached, { copy: false });
        for (const source of workerData.payload.arenas) assert.equal(oldState.arenas.find(arena => arena.id === source.id).used, source.used, 'reader frontier remains its attached snapshot frontier');
        for (let i = 0; i < message.payload.arenas.length; i++) equalBytes(new Uint8Array(message.payload.arenas[i].memory.buffer), before[i], 're-attachment and queries do not write any arena byte');
        assert.equal(atomicWrites, 0);
        parentPort.postMessage({ id: message.id, result: { ...readyInfo, cycles, retainedViewsAfterGrowth: true, repeatAttachment: true, atomicWrites } });
      }
    } catch (error) { parentPort.postMessage({ id: message.id, type: 'fatal', error: error.stack }); }
  });
  prepare().catch(error => parentPort.postMessage({ type: 'fatal', error: error.stack }));
} else {
  class Reader {
    constructor(index, phase, payload, coreModule) {
      this.nextId = 0;
      this.pending = new Map();
      this.worker = new Worker(new URL(import.meta.url), { workerData: { index, phase, payload, coreModule } });
      this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
      this.worker.on('message', message => {
        if (message.error) { this.fail(new Error(message.error)); return; }
        if (message.type === 'ready') { this.resolveReady(message.result); return; }
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); pending.resolve(message.result); }
      });
      this.worker.on('error', error => this.fail(error));
      this.worker.on('exit', code => { if (!this.stopping && code !== 0) this.fail(new Error(`Reader exited with ${code}`)); });
    }
    fail(error) {
      this.error = error; this.rejectReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    }
    request(type, extra = {}) {
      if (this.error) return Promise.reject(this.error);
      const id = ++this.nextId;
      return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, type, ...extra }); });
    }
    async terminate() { this.stopping = true; await this.worker.terminate(); }
  }

  S.configureMemory({ maximumBytes: 64 * 1024 * 1024 });
  let docs = new S.SharedMap(S.json()).set('document', row(7));
  let numbers = new S.SharedMap('number').setMany(Array.from({ length: 256 }, (_, i) => ['key-' + i, i]));
  let list = new S.SharedList('number').pushMany(Array.from({ length: 2049 }, (_, i) => i));
  let jsonRows = new S.SharedList(S.json()).pushMany([row(7), { second: true }]);
  const words = new S.SharedList('string').pushMany(Array.from({ length: 96 }, (_, i) => ['route alpha', 'not here', 'é ROUTE'][i % 3]));
  const oldItems = { docs, numbers, list, jsonRows, words };
  const oldPayload = S.getWorkerData(oldItems, { copy: false });
  assert(oldPayload.arenas.every(source => source.memory && !source.copy));
  const records = oldPayload.arenas.map((source, arena) => {
    const scratch = image(source.memory, 0, 65536);
    const published = image(source.memory, 65536, source.used);
    const canary = Uint8Array.from({ length: 65536 }, (_, i) => (i * 73 + arena * 41 + 19) & 255);
    new Uint8Array(source.memory.buffer, 0, 65536).set(canary);
    return { ...source, scratch, published, canary, fullCanary: image(source.memory), initialBytes: source.memory.buffer.byteLength };
  });
  const coreModule = new WebAssembly.Module(coreBytes);
  const readers = [];
  const timer = setTimeout(() => { console.error('Rust shared-worker proof timed out'); process.exit(1); }, 60000);
  try {
    for (let i = 0; i < INITIAL_READERS; i++) readers.push(new Reader(i, 'canary', oldPayload, coreModule));
    const initial = await Promise.all(readers.map(reader => reader.ready));
    for (const record of records) equalBytes(new Uint8Array(record.memory.buffer), record.fullCanary, 'all initial reader attachments preserve every byte, including the entire scratch page');
    const ownerBefore = S.getWorkerData(oldItems, { copy: false });
    for (const record of records) assert.equal(ownerBefore.arenas.find(source => source.id === record.id).used, record.used, 'readers cannot replace writer heap globals');
    // Restore writer directory/scratch exactly before the owning writer resumes.
    for (const record of records) new Uint8Array(record.memory.buffer, 0, 65536).set(record.scratch);
    await Promise.all(readers.map(reader => reader.request('start')));
    const lateStarts = [];
    let revision = 7, number = 31, listFirst = 0;
    function appendRound(round) {
      docs = docs.set('growth-' + round, row(1000 + round, '🚗'.repeat(4096)));
      revision = 1000 + round;
      docs = docs.set('document', row(revision));
      numbers = numbers.setMany(Array.from({ length: 64 }, (_, i) => ['append-' + (round * 64 + i), round * 64 + i]));
      number = 10000 + round; numbers = numbers.set('key-31', number);
      const start = list.size;
      list = list.pushMany(Array.from({ length: 256 }, (_, i) => start + i));
      listFirst = 500 + round; list = list.set(0, listFirst);
      jsonRows = jsonRows.push(row(revision, 'x'.repeat(8192)));
    }
    for (let round = 0; round < FIRST_ROUNDS; round++) {
      appendRound(round);
      if ([4, 8, 12, 16].includes(round)) {
        const reader = new Reader(readers.length, 'concurrent', oldPayload, coreModule);
        readers.push(reader);
        lateStarts.push(reader.ready.then(() => reader.request('start')));
      }
      await immediate();
    }
    await Promise.all(lateStarts);
    // All late readers have attached to old data; continue writing/growing with
    // all twelve reader loops actively running, without a shared control word.
    for (let round = FIRST_ROUNDS; round < FIRST_ROUNDS + FINAL_ROUNDS; round++) { appendRound(round); await immediate(); }
    const payload = S.getWorkerData({ docs, numbers, list, jsonRows, words }, { copy: false });
    const finalImages = payload.arenas.map(source => image(source.memory));
    const results = await Promise.all(readers.map(reader => reader.request('finish', { payload, revision, number, listFirst })));
    for (let i = 0; i < payload.arenas.length; i++) equalBytes(new Uint8Array(payload.arenas[i].memory.buffer), finalImages[i], 'finished writer arena unchanged by all final attachments and reads');
    for (const record of records) {
      equalBytes(new Uint8Array(record.memory.buffer, 65536, record.published.length), record.published, 'writer retains old published prefix during concurrent append');
      assert(record.memory.buffer.byteLength > record.initialBytes, 'each shared arena must grow during the proof');
    }
    const ownerAfter = S.getWorkerData({ docs, numbers, list, jsonRows, words }, { copy: false });
    for (const source of payload.arenas) assert.equal(ownerAfter.arenas.find(arena => arena.id === source.id).used, source.used, 'final readers leave writer heap frontier unchanged');
    assert.equal(readers.length, INITIAL_READERS + LATE_READERS);
    assert(results.every(result => result.cycles > 0 && result.atomicWrites === 0));
    console.log(JSON.stringify({
      ok: true,
      node: process.version,
      coreSha256: createHash('sha256').update(coreBytes).digest('hex'),
      readers: readers.length,
      initialCanaryReaders: initial.length,
      readersAttachedDuringWriterSession: LATE_READERS,
      writerRounds: FIRST_ROUNDS + FINAL_ROUNDS,
      queryCyclesDuringWriterSession: results.reduce((sum, result) => sum + result.cycles, 0),
      arenas: records.map(record => ({ initialBytes: record.initialBytes, finalBytes: record.memory.buffer.byteLength, retainedPublishedBytes: record.published.length })),
      fullScratchCanaryBytesPerArena: 65536,
      perInstanceHeapGlobalsIsolated: true,
      attachmentAndQueriesWriteNoArenaBytes: true,
      readerAtomicWrites: 0,
      viewFreezeCalls: 0,
      explicitMaterializationsAreFreshAndIndependent: true,
      explicitFreezeStillAvailable: true,
      retainedJsonViewsSurviveGrowth: true,
      repeatedAttachmentPreservesOlderSnapshots: true,
    }, null, 2));
  } finally {
    clearTimeout(timer);
    await Promise.all(readers.map(reader => reader.terminate()));
  }
}
