import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CASES, ORDERS, capFor, nextCount, quality, expectedEntries, expectedOperation, expectedBatch, validateOperation, makeCase, makePrimary, fixtureSet, batch } from './latency.mjs';

test('fixed nine cases, six orders and uniform operation cap', () => {
  assert.deepEqual(CASES, ['P', 'N32', 'N1', 'N0', 'O256', 'K4097', 'V4097', 'C256', 'F4097']);
  assert.deepEqual(ORDERS, ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB']);
  assert.equal(new Set(ORDERS).size, 6);
  for (const id of CASES) assert.equal(capFor(id), 2 ** 20);
  assert.throws(() => capFor('other'));
});
test('calibration arithmetic clips and rounds without tuning', () => {
  assert.equal(nextCount(256, 15e6, 2 ** 20), 512);
  assert.equal(nextCount(256, 90e6, 2 ** 20), 85);
  assert.equal(nextCount(256, 1, 2 ** 20), 2 ** 20);
  assert.equal(nextCount(1, 100e6, 2 ** 20), 1);
  assert.throws(() => nextCount(256, 0, 2 ** 20));
});
test('quality retains every batch and applies fixed limits', () => {
  const batches = Array.from({ length: 9 }, () => ({ count: 1000, elapsedNs: 30e6 }));
  assert.equal(quality(batches).nsPerOp, 30000);
  assert.equal(quality(batches).resolved, true);
  const short = batches.map((b, i) => ({ ...b, elapsedNs: i === 0 ? 9e6 : 30e6 }));
  assert(quality(short).reasons.includes('batch below 10 ms'));
  const drift = batches.map((b, i) => ({ ...b, elapsedNs: i >= 6 ? 40e6 : 30e6 }));
  assert(quality(drift).reasons.includes('batch drift outside 0.85–1.15'));
  const variable = batches.map((b, i) => ({ ...b, elapsedNs: i % 2 ? 15e6 : 60e6 }));
  assert(quality(variable).reasons.includes('batch CV above 25%'));
  assert(quality(batches.map(b => ({ ...b, elapsedNs: 0 }))).reasons.includes('invalid duration'));
  assert.equal(short.length, 9);
});

function fakeFixture(expected, object = false, entries = expected) {
  const events = [];
  const map = Object.freeze({ size: expected.length,
    *entries() { events.push('entries'); for (const row of entries) yield [row.key, row.value]; events.push('entries-done'); },
    *keys() { events.push('keys'); for (const row of entries) yield row.key; events.push('keys-done'); },
    *values() { events.push('values'); for (const row of entries) yield row.value; events.push('values-done'); },
    forEach(callback) { events.push('forEach'); for (const row of entries) callback(row.value, row.key); events.push('forEach-done'); },
  });
  return { fixture: Object.freeze({ map, expected, object }), events };
}
test('expected sequence and scalar checksum follow the frozen specification', () => {
  const rows = expectedEntries(2);
  assert.deepEqual(rows, [{ key: 'k0000', value: 1 }, { key: 'k0001', value: 4 }]);
  const first = Math.imul(2166136261 ^ (1 + 48), 16777619) >>> 0;
  const second = Math.imul(first ^ (4 + 49), 16777619) >>> 0;
  assert.deepEqual(expectedOperation(rows, 'entries', false), { itemCount: 2, checksum: second });
  assert.deepEqual(expectedEntries(2, false, true), [...rows].reverse());
  const objects = expectedEntries(2, true);
  assert.deepEqual(objects[1].value, { score: 4, label: 'v1', flags: [1, 1] });
  assert(Object.isFrozen(objects) && Object.isFrozen(objects[1]) && Object.isFrozen(objects[1].value) && Object.isFrozen(objects[1].value.flags));
  assert.deepEqual(expectedBatch({ itemCount: 4097, checksum: 4294967295 }, 2 ** 20), { itemCount: 4296015872, checksum: 4293918720 });
  assert.throws(() => expectedBatch({ itemCount: 1, checksum: 1 }, 2 ** 20 + 1));
});
test('every operation resets scalar state and drains its public method completely', () => {
  for (const kind of ['entries', 'keys', 'values', 'forEach']) {
    const { fixture, events } = fakeFixture(expectedEntries(3));
    const consumer = makeCase(fixture, kind);
    assert.deepEqual(events, []);
    for (let i = 0; i < 2; i++) {
      const checksum = consumer.operation();
      assert.equal(typeof checksum, 'number'); assert.equal(checksum, consumer.expected.checksum);
      assert.equal(consumer.itemCount(), 3);
    }
    assert.deepEqual(events, [kind, kind + '-done', kind, kind + '-done']);
    assert.equal(consumer.validate(), true);
  }
  const empty = fakeFixture(expectedEntries(0));
  const consumer = makeCase(empty.fixture);
  assert.equal(consumer.operation(), 2166136261); assert.equal(consumer.itemCount(), 0);
  assert.deepEqual(empty.events, ['entries', 'entries-done']);
});
test('exact validation rejects checksum-colliding keys, order and object corruption', () => {
  const expected = expectedEntries(2);
  const badKey = [{ key: 'x0000', value: 1 }, expected[1]];
  assert.equal(expectedOperation(badKey, 'entries', false).checksum, expectedOperation(expected, 'entries', false).checksum);
  assert.throws(() => validateOperation(fakeFixture(expected, false, badKey).fixture, 'entries'));
  assert.throws(() => validateOperation(fakeFixture(expected, false, [...expected].reverse()).fixture, 'entries'));
  assert.throws(() => validateOperation(fakeFixture(expected, false, expected.slice(1)).fixture, 'values'));
  const objects = expectedEntries(1, true);
  const badObject = [{ key: objects[0].key, value: Object.freeze({ ...objects[0].value, label: 'wrong' }) }];
  assert.throws(() => validateOperation(fakeFixture(objects, true, badObject).fixture, 'entries'));
  const mutableObject = [{ key: objects[0].key, value: { ...objects[0].value, flags: [...objects[0].value.flags] } }];
  assert.throws(() => validateOperation(fakeFixture(objects, true, mutableObject).fixture, 'entries'));
});
test('batch stores scalar results and validates after the clock', t => {
  const trace = [], ticks = [100n, 1000n];
  t.mock.method(process.hrtime, 'bigint', () => { trace.push('clock'); return ticks.shift(); });
  const fixture = { expected: { itemCount: 2, checksum: 3 }, operation: () => { trace.push('operation'); return 3; },
    itemCount: () => { trace.push('count'); return 2; }, validate: () => { trace.push('validate'); } };
  assert.deepEqual(batch(fixture, 'P', 2), { count: 2, elapsedNs: 900, itemCount: 4, checksum: 6, validated: true });
  assert.deepEqual(trace, ['clock', 'operation', 'count', 'operation', 'count', 'clock', 'validate']);
});
test('setup makes six bounded arenas and never traverses P before the first drain', () => {
  const arenas = [], values = new WeakMap(); let current;
  const api = {
    configureMemory(options) { assert.deepEqual(options, { maximumBytes: 16777216 }); },
    resetSortedMap() { current = { inserted: [], traversals: 0 }; arenas.push(current); },
    SharedSortedMap: class {
      constructor(type, comparator) { values.set(this, { arena: current, rows: new Map(), comparator }); Object.freeze(this); }
      set(key, value) { const state = values.get(this); state.arena.inserted.push(key); state.rows.set(key, value); return this; }
      get size() { return values.get(this).rows.size; }
      *entries() { const state = values.get(this); state.arena.traversals++; for (const key of [...state.rows.keys()].sort(state.comparator)) yield [key, state.rows.get(key)]; }
      *keys() { for (const [key] of this.entries()) yield key; }
      *values() { for (const [, value] of this.entries()) yield value; }
      forEach(callback) { for (const [key, value] of this.entries()) callback(value, key); }
    },
  };
  const primary = makePrimary(api), consumer = makeCase(primary);
  assert.equal(arenas.length, 1); assert.equal(arenas[0].traversals, 0);
  assert.equal(arenas[0].inserted[0], 'k4096'); assert.equal(arenas[0].inserted.at(-1), 'k0000');
  assert.equal(consumer.operation(), consumer.expected.checksum); assert.equal(arenas[0].traversals, 1);
  consumer.validate();
  const fixtures = fixtureSet(api, primary, consumer);
  assert.deepEqual(arenas.map(arena => arena.inserted.length), [4097, 32, 1, 0, 256, 256]);
  assert(Object.isFrozen(fixtures.registry) && Object.isFrozen(fixtures.cases));
  assert.deepEqual(Object.keys(fixtures.cases), CASES);
  for (const id of CASES) {
    assert.equal(fixtures.cases[id].operation(), fixtures.cases[id].expected.checksum);
    assert.equal(fixtures.cases[id].itemCount(), fixtures.cases[id].expected.itemCount);
    fixtures.cases[id].validate();
  }
});
test('workflow context and ordinary execution settings are static', () => {
  const source = readFileSync(new URL('../../.github/workflows/sorted-entry-delegation.yml', import.meta.url), 'utf8');
  assert(!/^ {4}env:/m.test(source), 'No job-level environment context');
  for (const line of source.split('\n').filter(line => line.includes('${{ runner.temp }}'))) assert(/^ {10,}/.test(line));
  assert(source.includes("node-version: '22.16.0'")); assert(source.includes("bun-version: '1.4.2'"));
  assert(source.includes('permissions:\n  contents: read\n'));
  assert(source.includes('actions/checkout@v4') && source.includes('actions/setup-node@v4') && source.includes('oven-sh/setup-bun@v2') && source.includes('actions/upload-artifact@v4'));
  assert(!source.includes('pull_request_target'));
  assert(source.includes('npm ci --prefix proofs/sorted-entry-delegation/dependencies --no-audit --no-fund'));
  assert(!source.includes('bun install'));
});
