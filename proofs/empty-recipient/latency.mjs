import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';

export const CASES = ['P', 'L1', 'E0', 'E1', 'W24', 'U1', 'F'];
export const ORDERS = ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB'];
export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
export const sd = xs => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
export function capFor(id) {
  if (id === 'F') return 2 ** 24;
  return 2 ** 20;
}
export function nextCount(count, elapsedNs, cap) {
  assert(Number.isFinite(elapsedNs) && elapsedNs > 0);
  return Math.max(1, Math.min(cap, Math.round(count * 30e6 / elapsedNs)));
}
export function quality(batches) {
  assert.equal(batches.length, 9);
  const xs = batches.map(b => b.elapsedNs / b.count);
  const cv = sd(xs) / mean(xs), drift = mean(xs.slice(-3)) / mean(xs.slice(0, 3));
  const reasons = [];
  if (xs.some(x => !Number.isFinite(x) || x <= 0)) reasons.push('invalid duration');
  if (batches.some(b => b.elapsedNs < 10e6)) reasons.push('batch below 10 ms');
  if (cv > .25) reasons.push('batch CV above 25%');
  if (drift < .85 || drift > 1.15) reasons.push('batch drift outside 0.85–1.15');
  return { nsPerOp: mean(xs), cv, drift, reasons, resolved: reasons.length === 0 };
}

function checkMap(map, value) {
  assert(Object.isFrozen(map)); assert.equal(map.size, 1);
  assert.equal(map.get('value'), value);
  const data = map.toWorkerData();
  assert(Object.isFrozen(data));
  assert(Number.isSafeInteger(data.root) && data.root > 0);
  assert.equal(data.size, 1); assert.equal(data.valueType, 'number');
}
export function validateSnapshot(snapshot, input, single) {
  assert(Object.isFrozen(snapshot));
  if (single) assert.equal(snapshot, input);
  else {
    assert.equal(Object.getPrototypeOf(snapshot), null);
    assert.deepEqual(Object.keys(snapshot), Object.keys(input));
    for (const name of Object.keys(input)) assert.equal(snapshot[name], input[name]);
  }
}
export function validateExport(value, record, arenas, structureIds) {
  assert.equal(value.__shared, true); assert.equal(value.version, 4);
  assert(Object.isFrozen(value) && Object.isFrozen(value.arenas) && Object.isFrozen(value.structures));
  assert.equal(Object.getPrototypeOf(value.structures), null);
  assert.deepEqual(Object.keys(value.structures), Object.keys(record));
  assert.deepEqual(value.arenas.map(a => a.id), arenas.map(a => a.id));
  for (const [name, map] of Object.entries(record)) {
    const descriptor = value.structures[name];
    assert(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.data));
    assert.equal(descriptor.type, 'SharedMap');
    assert.equal(descriptor.arena, structureIds[name]);
    assert.deepEqual(descriptor.data, map.toWorkerData());
  }
  for (let i = 0; i < arenas.length; i++) {
    const actual = value.arenas[i], expected = arenas[i];
    assert(Object.isFrozen(actual));
    assert.deepEqual(Object.keys(actual), ['id', 'used', 'memory']);
    assert.equal(typeof actual.id, 'string');
    assert.equal(actual.used, expected.used); assert.equal(actual.memory, expected.memory);
    assert(actual.memory.buffer instanceof SharedArrayBuffer);
    assert(Number.isSafeInteger(actual.used) && actual.used >= 65536 && actual.used <= actual.memory.buffer.byteLength);
  }
}
export function expectedBatch(changed, version, count) {
  assert(Number.isSafeInteger(version) && version >= 0);
  assert(Number.isSafeInteger(count) && count > 0);
  if (!changed) { assert.equal(version, 0); return { version: 0, revision: 0, checksum: count }; }
  const result = { version: version + count, revision: (version + count) % 2, checksum: count * (version + 1) + count * (count + 1) / 2 };
  assert(Number.isSafeInteger(result.version) && Number.isSafeInteger(result.checksum));
  return result;
}

export function makePrimary(api, copy) {
  api.configureMemory({ maximumBytes: 131072 });
  api.resetMap();
  const maps = Array.from({ length: 24 }, (_, i) => new api.SharedMap('number').set('value', i));
  const next = maps[23].set('value', 24);
  const R0 = Object.freeze(Object.fromEntries(maps.map((map, i) => [`m${i}`, map])));
  const R1 = Object.freeze({ ...R0, m23: next });
  let failure;
  const onError = error => { failure ??= error; };
  return { maps, next, R0, R1, copy,
    options: id => ({ copy, delivery: 'latest', timeoutMs: 10000, channel: `empty-recipient-${id}`, onError }),
    check: () => { if (failure) throw failure; }, onError };
}
export function subscriberSink() {
  const sink = { count: 0, checksum: 0, snapshot: undefined, version: -1 };
  sink.listener = (snapshot, version) => {
    sink.count++; sink.checksum += version + 1; sink.snapshot = snapshot; sink.version = version;
  };
  return sink;
}
export function acknowledgementState(channel) {
  let owner, reader, last = -1, active;
  return {
    arm(target) {
      assert(!active); assert(Number.isSafeInteger(target) && target >= 0);
      assert(target > last);
      active = { fromVersion: last, finalVersion: target, ackCount: 0, ackChecksum: 0 };
    },
    accept(data) {
      if (data?.kind !== 'ack' || data.channel !== channel) return null;
      assert.equal(data.protocol, 'zerocopy/session'); assert.equal(data.version, 1);
      assert.equal(typeof data.owner, 'string'); assert(data.owner.length > 0);
      assert.equal(typeof data.reader, 'string'); assert(data.reader.length > 0);
      assert(active, 'Unexpected acknowledgement without an armed batch');
      if (owner === undefined) {
        assert.equal(last, -1); assert.equal(active.finalVersion, 0); assert.equal(data.sequence, 0);
        owner = data.owner; reader = data.reader;
      } else { assert.equal(data.owner, owner); assert.equal(data.reader, reader); }
      const expected = active.ackCount === 0 ? active.fromVersion + 1 : active.finalVersion;
      assert.equal(data.sequence, expected);
      assert(data.sequence > last && data.sequence <= active.finalVersion);
      last = data.sequence; active.ackCount++; active.ackChecksum += data.sequence + 1;
      if (last !== active.finalVersion) return null;
      assert.equal(active.ackCount, active.finalVersion === active.fromVersion + 1 ? 1 : 2);
      const complete = { ...active, bound: true }; active = undefined; return complete;
    },
    get last() { return last; },
  };
}
async function verifyPortOrder(owner, partner, marker) {
  assert.equal(typeof owner.addEventListener, 'function'); assert.equal(typeof owner.removeEventListener, 'function');
  let order = 0, resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(new Error('Native EventTarget order check timed out')), 10000);
  const first = event => {
    try { assert.equal(event.data, marker); assert.equal(order, 0); order = 1; }
    catch (error) { reject(error); }
  };
  const second = event => {
    try { assert.equal(event.data, marker); assert.equal(order, 1); order = 2; queueMicrotask(resolve); }
    catch (error) { reject(error); }
  };
  try {
    owner.addEventListener('message', first); owner.addEventListener('message', second);
    owner.start(); partner.postMessage(marker);
    await promise; assert.equal(order, 2);
  } finally {
    clearTimeout(timer); owner.removeEventListener('message', first); owner.removeEventListener('message', second);
  }
}
function nativeBarrier(port, channel, onError) {
  const state = acknowledgementState(channel);
  let pending, failure;
  const fail = error => {
    failure ??= error; onError(error);
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
  };
  const observer = event => {
    try {
      const complete = state.accept(event.data);
      if (complete) {
        assert(pending); const current = pending; pending = undefined; clearTimeout(current.timer);
        // Resolving here resumes the awaiting caller after this native event dispatch.
        current.resolve(complete);
      }
    } catch (error) { fail(error); }
  };
  port.addEventListener('message', observer);
  return {
    arm(target) {
      if (failure) throw failure;
      assert(!pending); state.arm(target);
      const promise = new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => fail(new Error('Final acknowledgement timed out')), 10000) };
      });
      promise.catch(() => {}); return promise;
    },
    get last() { return state.last; },
    dispose() {
      port.removeEventListener('message', observer);
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Acknowledgement wait disposed')); pending = undefined; }
    },
  };
}
async function connectPeer(worker, session, options, check, withSubscriber) {
  const { port1, port2 } = new MessageChannel();
  let barrier, reader, unsubscribe = () => {};
  try {
    await verifyPortOrder(port1, port2, `order:${options.channel}`);
    // The library registers its EventTarget listener synchronously in connect.
    const connecting = session.connect(port1);
    barrier = nativeBarrier(port1, options.channel, options.onError);
    const initialAck = barrier.arm(0);
    const receiving = worker.connectSharedSession({ ...options, endpoint: port2 });
    const initialized = await Promise.all([connecting, receiving, initialAck]);
    reader = initialized[1];
    assert.equal(barrier.last, 0); assert.equal(reader.version, 0); check();
    const sink = withSubscriber ? subscriberSink() : null;
    if (sink) unsubscribe = reader.subscribe(sink.listener);
    return {
      prepare(version, count) {
        check(); assert.equal(barrier.last, version); assert(!reader.closed && !session.closed);
        const before = sink ? { count: sink.count, checksum: sink.checksum } : null;
        return { promise: barrier.arm(version + count), before };
      },
      async finish(prepared, version, count, input) {
        const ack = await prepared.promise;
        check(); assert(!reader.closed && !session.closed);
        assert.equal(ack.finalVersion, version); assert.equal(barrier.last, version);
        assert.equal(reader.version, version);
        const snapshot = reader.getSnapshot(); checkMap(snapshot, input.get('value'));
        assert.deepEqual(snapshot.toWorkerData(), input.toWorkerData());
        const callbacks = count === 1 ? 1 : 2;
        const callbackChecksum = count === 1 ? version + 1 : (version - count + 2) + version + 1;
        assert.equal(ack.ackCount, callbacks); assert.equal(ack.ackChecksum, callbackChecksum);
        if (sink) {
          assert.equal(sink.count - prepared.before.count, callbacks);
          assert.equal(sink.checksum - prepared.before.checksum, callbackChecksum);
          assert.equal(sink.version, version); assert.equal(sink.snapshot, snapshot);
        }
        return { ...ack, readerVersion: reader.version, readerCallbacks: sink ? callbacks : 0, readerSubscribed: !!sink };
      },
      dispose() { unsubscribe(); barrier.dispose(); reader.dispose(); port1.close(); port2.close(); },
    };
  } catch (error) {
    unsubscribe(); barrier?.dispose(); reader?.dispose(); session.dispose(); port1.close(); port2.close(); throw error;
  }
}
export function makePublicationCase(session, inputs, { single = false, changed = false, flush = false, initialVersion = 0, owner = null, peer = null, check = () => {} } = {}) {
  assert.equal(inputs.length, changed ? 2 : 1); assert(!(flush && changed));
  assert.equal(session.version, initialVersion); assert.equal(session.closed, false);
  const initial = session.getSnapshot();
  validateSnapshot(initial, inputs[changed ? initialVersion % 2 : 0], single);
  const records = inputs.map(input => single ? [input] : Object.values(input));
  const maps = [...new Set(records.flat())].map(map => ({ map, data: map.toWorkerData(), value: map.get('value') }));
  const keys = inputs.map(input => single ? null : Object.keys(input));
  let expectedVersion = initialVersion, revision = initialVersion % 2;
  const operation = flush ? () => session.flush() : changed
    ? () => session.publish(inputs[revision ^= 1])
    : () => session.publish(inputs[0]);
  return {
    operation,
    prepare(count) { check(); return peer?.prepare(expectedVersion, count); },
    validate(latest, checksum, count) {
      const expected = expectedBatch(changed, expectedVersion, count);
      assert.equal(latest, expected.version); assert.equal(checksum, expected.checksum);
      assert.equal(session.version, expected.version); assert.equal(session.closed, false);
      assert.equal(revision, expected.revision);
      const current = session.getSnapshot();
      validateSnapshot(current, inputs[expected.revision], single);
      if (!changed) assert.equal(current, initial);
      for (let i = 0; i < inputs.length; i++) {
        assert(Object.isFrozen(inputs[i]));
        if (!single) {
          assert.deepEqual(Object.keys(inputs[i]), keys[i]); assert.deepEqual(Object.values(inputs[i]), records[i]);
        }
      }
      for (const { map, data, value } of maps) { checkMap(map, value); assert.deepEqual(map.toWorkerData(), data); }
      if (owner) {
        assert.equal(owner.count, expected.version);
        assert.equal(owner.checksum, expected.version * (expected.version + 3) / 2);
        assert.equal(owner.version, expected.version); assert.equal(owner.snapshot, current);
      }
      check(); expectedVersion = expected.version;
      return { expectedVersion, expectedRevision: expected.revision };
    },
    async finish(prepared, count) {
      const result = peer ? await peer.finish(prepared, expectedVersion, count, inputs[revision]) : null;
      check(); return result;
    },
  };
}
export async function fixtureSet(api, worker, primary, firstSession, firstVersion) {
  const { maps, next, R0, R1, options, check } = primary;
  const sessions = [firstSession], peers = [], subscriptions = [];
  const dispose = () => {
    subscriptions.forEach(unsubscribe => unsubscribe());
    sessions.forEach(session => session.dispose()); peers.forEach(peer => peer.dispose());
  };
  try {
    assert.equal(firstVersion, 1); assert.equal(firstSession.version, 1); assert.equal(firstSession.current, next);
    maps.forEach(checkMap); checkMap(next, 24); assert.notEqual(maps[23].root, next.root);
    const ids = new Map(), arenas = [...maps, next].map(map => {
      const record = { root: map }, data = api.getWorkerData(record, { copy: false });
      assert.equal(data.arenas.length, 1); const arena = data.arenas[0];
      validateExport(data, record, [arena], { root: arena.id }); ids.set(map, arena.id); return arena;
    });
    for (const arena of arenas) {
      assert.equal(arena.id, arenas[0].id); assert.equal(arena.memory, arenas[0].memory); assert.equal(arena.used, arenas[0].used);
    }
    for (const record of [R0, R1]) {
      const structureIds = Object.fromEntries(Object.entries(record).map(([name, map]) => [name, ids.get(map)]));
      validateExport(api.getWorkerData(record, { copy: false }), record, [arenas[0]], structureIds);
    }
    const definitions = {
      P: { inputs: [maps[23], next], single: true, changed: true, initialVersion: 1 },
      L1: { inputs: [maps[23], next], single: true, changed: true },
      E0: { inputs: [maps[23], next], single: true, changed: true },
      E1: { inputs: [maps[23], next], single: true, changed: true },
      W24: { inputs: [R0, R1], changed: true },
      U1: { inputs: [maps[23]], single: true },
      F: { inputs: [maps[23]], single: true, flush: true },
    };
    const cases = {};
    for (const id of CASES) {
      const definition = definitions[id], settings = options(id);
      const session = id === 'P' ? firstSession : worker.createSharedState(definition.inputs[0], settings);
      if (session !== firstSession) sessions.push(session);
      const owner = id === 'L1' || id === 'E1' ? subscriberSink() : null;
      if (owner) subscriptions.push(session.subscribe(owner.listener));
      const peer = id === 'E0' || id === 'E1' ? await connectPeer(worker, session, settings, check, id === 'E1') : null;
      if (peer) peers.push(peer);
      cases[id] = makePublicationCase(session, definition.inputs, { ...definition, owner, peer, check });
    }
    check();
    return { cases, dispose, summary: {
      namesPerWideRecord: 24, entriesPerMap: 1, arenaCount: 1, memoryMaximumBytes: 131072,
      copy: primary.copy, peerRows: ['E0', 'E1'], peerTransport: 'native MessageChannel in this process',
      observerAPI: 'EventTarget addEventListener after library listener', nativeRegistrationOrderValidated: true,
      timedScope: 'synchronous publication; peer batches are latest-mode burst submission; final ack/reader work outside timer',
      firstPublicationVersion: firstVersion,
    } };
  } catch (error) { dispose(); throw error; }
}
export async function batch(fixture, id, count) {
  assert(Number.isSafeInteger(count) && count > 0 && count <= capFor(id));
  const prepared = fixture.prepare(count);
  let latest, checksum = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) { latest = fixture.operation(); checksum += latest + 1; }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const expected = fixture.validate(latest, checksum, count);
  const peer = await fixture.finish(prepared, count);
  return { count, elapsedNs, checksum, ...expected, peer, validated: true };
}
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
async function child(sharedEntry, workerEntry, mode, countsPath) {
  assert(['calibrate', 'measure'].includes(mode));
  const sharedPath = realpathSync(sharedEntry), workerPath = realpathSync(workerEntry);
  const extension = process.versions.bun ? 'ts' : 'js';
  assert.equal(dirname(sharedPath), dirname(workerPath));
  assert.equal(basename(sharedPath), `shared.${extension}`); assert.equal(basename(workerPath), `worker.${extension}`);
  const api = await import(pathToFileURL(sharedPath));
  const worker = await import(pathToFileURL(workerPath));
  const primary = makePrimary(api, !!process.versions.bun);
  const first = worker.createSharedState(primary.maps[23], primary.options('P'));
  emit({ event: 'ready', unixMs: Date.now() });
  const firstStart = mode === 'measure' ? process.hrtime.bigint() : null;
  const firstVersion = first.publish(primary.next);
  const firstPublishNs = firstStart === null ? null : Number(process.hrtime.bigint() - firstStart);
  // The first public publication precedes fixture reads, exports and peer setup.
  const fixtures = await fixtureSet(api, worker, primary, first, firstVersion);
  try {
    emit({ event: 'fixtures', firstPublishNs, ...fixtures.summary, validated: true });
    const cases = {}, counts = mode === 'measure' ? JSON.parse(readFileSync(countsPath, 'utf8')) : null;
    for (const id of CASES) {
      const fixture = fixtures.cases[id], cap = capFor(id);
      if (mode === 'calibrate') {
        let count = Math.min(256, cap), accepted = false;
        const trials = [];
        for (let trial = 0; trial < 4; trial++) {
          const warmups = [], pilots = [];
          for (let i = 0; i < 5; i++) { const b = await batch(fixture, id, count); warmups.push(b); emit({ event: 'batch', mode, id, trial, phase: 'warmup', index: i, ...b }); }
          for (let i = 0; i < 3; i++) { const b = await batch(fixture, id, count); pilots.push(b); emit({ event: 'batch', mode, id, trial, phase: 'pilot', index: i, ...b }); }
          const pilotMedianNs = median(pilots.map(b => b.elapsedNs));
          accepted = pilotMedianNs >= 20e6 && pilotMedianNs <= 50e6;
          trials.push({ count, warmups, pilots, pilotMedianNs, accepted });
          if (accepted || trial === 3) break;
          count = nextCount(count, pilotMedianNs, cap);
        }
        cases[id] = { count, cap, accepted, trials };
      } else {
        const count = counts[id]; assert(Number.isSafeInteger(count) && count >= 1 && count <= cap);
        const warmups = [], measured = [];
        for (let i = 0; i < 14; i++) {
          const b = await batch(fixture, id, count); (i < 5 ? warmups : measured).push(b);
          emit({ event: 'batch', mode, id, phase: i < 5 ? 'warmup' : 'measured', index: i < 5 ? i : i - 5, ...b });
        }
        cases[id] = { count, cap, warmups, measured, quality: quality(measured) };
      }
    }
    emit({ event: 'result', mode, firstPublishNs, fixtures: fixtures.summary, cases });
  } finally { fixtures.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'child') await child(...args);
  else throw new Error('Expected child');
}
