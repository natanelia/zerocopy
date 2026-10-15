import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CASES, ORDERS, capFor, nextCount, quality, makePrimary, validateSnapshot, validateExport, expectedBatch, makePublicationCase, subscriberSink, acknowledgementState } from './latency.mjs';

// Synthetic immutable maps and sessions only: no library import, elapsed timer,
// worker, process launch, fixture attachment or benchmark entry is exercised.
function syntheticAPI() {
  let arena, serial = 0;
  const events = [];
  class FakeMap {
    constructor(type, owner = arena, root = 0, value) {
      assert.equal(type, 'number'); assert(owner);
      Object.assign(this, { arena: owner, root, value, size: root ? 1 : 0 }); Object.freeze(this);
    }
    set(key, value) {
      assert.equal(key, 'value'); this.arena.used += 16;
      return new FakeMap('number', this.arena, ++this.arena.root, value);
    }
    get(key) { assert.equal(key, 'value'); return this.value; }
    toWorkerData() { return Object.freeze({ root: this.root, valueType: 'number', size: this.size }); }
  }
  return {
    events, SharedMap: FakeMap,
    configureMemory(options) { assert.deepEqual(options, { maximumBytes: 131072 }); events.push('configure'); },
    resetMap() { events.push('reset'); arena = { id: `arena-${++serial}`, root: 0, used: 65536, memory: { buffer: new SharedArrayBuffer(131072) } }; },
    getWorkerData(record, options) {
      events.push('export'); assert.deepEqual(options, { copy: false });
      const structures = Object.create(null), arenas = new Map();
      for (const [name, map] of Object.entries(record)) {
        const a = map.arena;
        if (!arenas.has(a.id)) arenas.set(a.id, Object.freeze({ id: a.id, used: a.used, memory: a.memory }));
        structures[name] = Object.freeze({ type: 'SharedMap', arena: a.id, data: map.toWorkerData() });
      }
      return Object.freeze({ __shared: true, version: 4, arenas: Object.freeze([...arenas.values()]), structures: Object.freeze(structures) });
    },
  };
}
function syntheticSession(input) {
  const single = typeof input.toWorkerData === 'function';
  const copy = value => single ? value : Object.freeze(Object.assign(Object.create(null), value));
  return {
    version: 0, closed: false, snapshot: copy(input), calls: [], flushCalls: 0, listener: null,
    getSnapshot() { return this.snapshot; },
    publish(next) {
      this.calls.push(next);
      const same = single ? this.snapshot === next : Object.keys(next).length === Object.keys(this.snapshot).length
        && Object.keys(next).every(name => this.snapshot[name] === next[name]);
      if (!same) { this.version++; this.snapshot = copy(next); this.listener?.(this.snapshot, this.version); }
      return this.version;
    },
    flush() { this.flushCalls++; return this.version; },
    dispose() { this.closed = true; },
  };
}
function simulate(fixture, count) {
  let latest, checksum = 0;
  for (let i = 0; i < count; i++) { latest = fixture.operation(); checksum += latest + 1; }
  return fixture.validate(latest, checksum, count);
}
function oneName() {
  const api = syntheticAPI(); api.configureMemory({ maximumBytes: 131072 }); api.resetMap();
  const first = new api.SharedMap('number').set('value', 23), second = first.set('value', 24);
  return [Object.freeze({ root: first }), Object.freeze({ root: second })];
}

test('fixed seven rows, six orders and operation caps', () => {
  assert.deepEqual(CASES, ['P', 'L1', 'E0', 'E1', 'W24', 'U1', 'F']);
  assert.deepEqual(ORDERS, ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB']);
  assert.equal(new Set(ORDERS).size, 6);
  for (const id of CASES) assert.equal(capFor(id), id === 'F' ? 2 ** 24 : 2 ** 20);
});
test('calibration retains fixed arithmetic and quality thresholds', () => {
  assert.equal(nextCount(256, 15e6, 2 ** 20), 512);
  assert.equal(nextCount(256, 90e6, 2 ** 20), 85);
  assert.equal(nextCount(256, 1, 4096), 4096);
  assert.equal(nextCount(1, 100e6, 4096), 1);
  assert.throws(() => nextCount(256, 0, 4096));
  const batches = Array.from({ length: 9 }, () => ({ count: 1000, elapsedNs: 30e6 }));
  assert.equal(quality(batches).nsPerOp, 30000); assert(quality(batches).resolved);
  const short = batches.map((b, i) => ({ ...b, elapsedNs: i === 0 ? 9e6 : 30e6 }));
  assert(quality(short).reasons.includes('batch below 10 ms'));
  const drift = batches.map((b, i) => ({ ...b, elapsedNs: i >= 6 ? 40e6 : 30e6 }));
  assert(quality(drift).reasons.includes('batch drift outside 0.85–1.15'));
  const variable = batches.map((b, i) => ({ ...b, elapsedNs: i % 2 ? 15e6 : 60e6 }));
  assert(quality(variable).reasons.includes('batch CV above 25%'));
  assert.equal(short.length, 9);
});
test('version/parity/checksum expectations remain exact at fixed caps', () => {
  assert.deepEqual(expectedBatch(true, 0, 3), { version: 3, revision: 1, checksum: 9 });
  assert.deepEqual(expectedBatch(true, 3, 1), { version: 4, revision: 0, checksum: 5 });
  const n = 2 ** 20, v = 31 * n, expected = expectedBatch(true, v, n);
  assert.equal(expected.version, 32 * n);
  assert.equal(BigInt(expected.checksum), BigInt(n) * BigInt(v + 1) + BigInt(n) * BigInt(n + 1) / 2n);
  assert.deepEqual(expectedBatch(false, 0, 2 ** 24), { version: 0, revision: 0, checksum: 2 ** 24 });
  assert.throws(() => expectedBatch(false, 1, 1));
  assert.throws(() => expectedBatch(true, 0, 0));
  assert.throws(() => expectedBatch(true, Number.MAX_SAFE_INTEGER, 1));
});
test('record snapshots accept copied records but require order and map identity', () => {
  const [input, next] = oneName(), copied = syntheticSession(input).getSnapshot();
  assert.notEqual(copied, input); validateSnapshot(copied, input, false);
  assert.throws(() => validateSnapshot(input, input, false));
  assert.throws(() => validateSnapshot(copied, next, false));
  const record = Object.freeze({ first: input.root, second: next.root });
  const wrongOrder = Object.freeze(Object.assign(Object.create(null), { second: next.root, first: input.root }));
  assert.throws(() => validateSnapshot(wrongOrder, record, false));
  validateSnapshot(input.root, input.root, true);
  assert.throws(() => validateSnapshot(next.root, input.root, true));
});
test('alternation crosses odd batch boundaries without repeated revisions', () => {
  const inputs = oneName(), session = syntheticSession(inputs[0]);
  const fixture = makePublicationCase(session, inputs, { changed: true });
  assert.deepEqual(simulate(fixture, 3), { expectedVersion: 3, expectedRevision: 1 });
  assert.deepEqual(simulate(fixture, 1), { expectedVersion: 4, expectedRevision: 0 });
  assert.deepEqual(simulate(fixture, 3), { expectedVersion: 7, expectedRevision: 1 });
  assert.deepEqual(session.calls, [inputs[1], inputs[0], inputs[1], inputs[0], inputs[1], inputs[0], inputs[1]]);
});
test('primary continuation starts after the first publication', () => {
  const records = oneName(), inputs = records.map(record => record.root);
  const session = syntheticSession(inputs[0]); assert.equal(session.publish(inputs[1]), 1);
  const fixture = makePublicationCase(session, inputs, { changed: true, single: true, initialVersion: 1 });
  assert.deepEqual(simulate(fixture, 3), { expectedVersion: 4, expectedRevision: 0 });
  assert.deepEqual(simulate(fixture, 1), { expectedVersion: 5, expectedRevision: 1 });
  assert.deepEqual(session.calls, [inputs[1], inputs[0], inputs[1], inputs[0], inputs[1]]);
});
test('unchanged direct-single publish and flush preserve zero version', () => {
  const input = oneName()[0].root;
  for (const flush of [false, true]) {
    const session = syntheticSession(input), initial = session.getSnapshot();
    const fixture = makePublicationCase(session, [input], { single: true, flush });
    assert.deepEqual(simulate(fixture, 5), { expectedVersion: 0, expectedRevision: 0 });
    assert.equal(session.getSnapshot(), initial);
    assert.equal(session.calls.length, flush ? 0 : 5); assert.equal(session.flushCalls, flush ? 5 : 0);
  }
});
test('local subscriber counters validate each changed publication', () => {
  const inputs = oneName().map(record => record.root), session = syntheticSession(inputs[0]);
  const owner = subscriberSink(); session.listener = owner.listener;
  const fixture = makePublicationCase(session, inputs, { single: true, changed: true, owner });
  simulate(fixture, 3); simulate(fixture, 2);
  assert.equal(owner.count, 5); assert.equal(owner.checksum, 20);
  assert.equal(owner.snapshot, inputs[1]); assert.equal(owner.version, 5);
  owner.checksum++; assert.throws(() => simulate(fixture, 1));
});
test('publication validator rejects wrong checksum, missing version and wrong output', () => {
  for (const failure of ['checksum', 'version', 'snapshot']) {
    const inputs = oneName(), session = syntheticSession(inputs[0]);
    const fixture = makePublicationCase(session, inputs, { changed: true });
    const latest = fixture.operation();
    if (failure === 'version') session.version = 0;
    if (failure === 'snapshot') session.snapshot = syntheticSession(inputs[0]).getSnapshot();
    assert.throws(() => fixture.validate(latest, failure === 'checksum' ? 1 : 2, 1));
  }
});
test('primary setup fixes one arena, immutable roots and stable option handler', () => {
  for (const copy of [false, true]) {
    const api = syntheticAPI(), primary = makePrimary(api, copy);
    assert.deepEqual(api.events, ['configure', 'reset']);
    assert.equal(primary.maps.length, 24); assert.equal(new Set(primary.maps.map(map => map.arena)).size, 1);
    assert.equal(primary.next.arena, primary.maps[23].arena);
    assert.equal(primary.maps[23].get('value'), 23); assert.equal(primary.next.get('value'), 24);
    assert(Object.isFrozen(primary.R0) && Object.isFrozen(primary.R1));
    assert.deepEqual(Object.keys(primary.R0), Array.from({ length: 24 }, (_, i) => `m${i}`));
    for (let i = 0; i < 23; i++) assert.equal(primary.R0[`m${i}`], primary.R1[`m${i}`]);
    assert.equal(primary.R1.m23, primary.next);
    const first = primary.options('P'), peer = primary.options('E0');
    assert.deepEqual(first, { copy, delivery: 'latest', timeoutMs: 10000, channel: 'empty-recipient-P', onError: primary.onError });
    assert.equal(peer.onError, first.onError); primary.check();
    const failure = new Error('synthetic callback'); first.onError(failure); first.onError(new Error('later'));
    assert.throws(primary.check, error => error === failure);
  }
});
const ack = (sequence, fields = {}) => ({ protocol: 'zerocopy/session', version: 1, kind: 'ack', channel: 'channel', owner: 'owner', reader: 'reader', sequence, ...fields });
function initializedBarrier() {
  const state = acknowledgementState('channel'); state.arm(0);
  assert.deepEqual(state.accept(ack(0)), { fromVersion: -1, finalVersion: 0, ackCount: 1, ackChecksum: 1, bound: true });
  return state;
}
test('acknowledgement state binds identities and drains first/final versions', () => {
  const state = initializedBarrier(); assert.equal(state.last, 0);
  assert.equal(state.accept({ kind: 'ready' }), null); assert.equal(state.accept(ack(0, { channel: 'other' })), null);
  state.arm(3); assert.equal(state.accept(ack(1)), null);
  assert.deepEqual(state.accept(ack(3)), { fromVersion: 0, finalVersion: 3, ackCount: 2, ackChecksum: 6, bound: true });
  state.arm(4);
  assert.deepEqual(state.accept(ack(4)), { fromVersion: 3, finalVersion: 4, ackCount: 1, ackChecksum: 5, bound: true });
  assert.equal(state.last, 4);
});
test('acknowledgement validator rejects unbound, reordered or mismatched records', () => {
  assert.throws(() => acknowledgementState('channel').accept(ack(0)));
  for (const fields of [{ protocol: 'other' }, { version: 2 }, { owner: '' }, { reader: '' }, { sequence: 1 }]) {
    const state = acknowledgementState('channel'); state.arm(0); assert.throws(() => state.accept(ack(0, fields)));
  }
  for (const fields of [{ owner: 'different' }, { reader: 'different' }, { sequence: 2 }]) {
    const state = initializedBarrier(); state.arm(3); assert.throws(() => state.accept(ack(1, fields)));
  }
  const state = initializedBarrier(); state.arm(3); assert.throws(() => state.arm(4));
  state.accept(ack(1)); assert.throws(() => state.accept(ack(2)));
});
test('export validation rejects reordered arenas and copied transport fields', () => {
  const api = syntheticAPI(); api.configureMemory({ maximumBytes: 131072 }); api.resetMap();
  const first = new api.SharedMap('number').set('value', 0); api.resetMap();
  const second = new api.SharedMap('number').set('value', 1), record = { first, second };
  const data = api.getWorkerData(record, { copy: false });
  const ids = { first: first.arena.id, second: second.arena.id };
  validateExport(data, record, data.arenas, ids);
  assert.throws(() => validateExport(Object.freeze({ ...data, arenas: Object.freeze([...data.arenas].reverse()) }), record, data.arenas, ids));
  const arenas = Object.freeze([Object.freeze({ ...data.arenas[0], copy: new Uint8Array(1) }), data.arenas[1]]);
  assert.throws(() => validateExport(Object.freeze({ ...data, arenas }), record, data.arenas, ids));
  assert.throws(() => validateExport(data, record, data.arenas, { ...ids, first: 'wrong' }));
});

test('workflow context and ordinary execution settings are static', () => {
  const source = readFileSync(new URL('../../.github/workflows/empty-recipient.yml', import.meta.url), 'utf8');
  assert(!/^ {4}env:/m.test(source), 'No job-level environment context');
  for (const line of source.split('\n').filter(line => line.includes('${{ runner.temp }}'))) {
    assert(/^ {10,}/.test(line), 'runner.temp must occur in step env or step action input');
  }
  assert(source.includes("node-version: '22.16.0'"));
  assert(source.includes("bun-version: '1.4.2'"));
  assert(source.includes('permissions:\n  contents: read\n'));
  assert(source.includes('actions/checkout@v4') && source.includes('actions/setup-node@v4') && source.includes('oven-sh/setup-bun@v2') && source.includes('actions/upload-artifact@v4'));
  assert(!source.includes('pull_request_target'));
  assert(source.includes('npm ci --prefix proofs/empty-recipient/dependencies --no-audit --no-fund'));
  assert(!source.includes('bun install'));
});
