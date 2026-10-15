import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CASES = ['W24-changed', 'W24-unchanged', 'D24-changed', 'Single-changed', 'Single-unchanged', 'Record1-changed', 'Record1-unchanged', 'Empty-unchanged', 'Flush'];
export const ORDERS = ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB'];
export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
export const sd = xs => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
export function capFor(id) {
  if (id === 'Flush') return 2 ** 24;
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

export function makePrimary(api) {
  api.configureMemory({ maximumBytes: 131072 });
  api.resetMap();
  const maps = Array.from({ length: 24 }, (_, i) => new api.SharedMap('number').set('value', i));
  const next = maps[23].set('value', 24);
  const R0 = Object.freeze(Object.fromEntries(maps.map((map, i) => [`m${i}`, map])));
  const R1 = Object.freeze({ ...R0, m23: next });
  return { maps, next, R0, R1, options: { copy: false } };
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
export function makePublicationCase(session, inputs, { single = false, changed = false, flush = false } = {}) {
  assert.equal(inputs.length, changed ? 2 : 1); assert(!(flush && changed));
  assert.equal(session.version, 0); assert.equal(session.closed, false);
  const initial = session.getSnapshot();
  validateSnapshot(initial, inputs[0], single);
  const records = inputs.map(input => single ? [input] : Object.values(input));
  const maps = [...new Set(records.flat())].map(map => ({ map, data: map.toWorkerData(), value: map.get('value') }));
  const keys = inputs.map(input => single ? null : Object.keys(input));
  let expectedVersion = 0, revision = 0;
  const operation = flush ? () => session.flush() : changed
    ? () => session.publish(inputs[revision ^= 1])
    : () => session.publish(inputs[0]);
  return {
    operation,
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
          assert.deepEqual(Object.keys(inputs[i]), keys[i]);
          assert.deepEqual(Object.values(inputs[i]), records[i]);
        }
      }
      for (const { map, data, value } of maps) {
        checkMap(map, value); assert.deepEqual(map.toWorkerData(), data);
      }
      expectedVersion = expected.version;
      return { expectedVersion, expectedRevision: expected.revision };
    },
  };
}
export function fixtureSet(api, worker, primary, firstSession) {
  const { maps, next, R0, R1, options } = primary;
  const sessions = [firstSession];
  try {
    assert.equal(firstSession.version, 0); assert.equal(firstSession.closed, false);
    validateSnapshot(firstSession.getSnapshot(), R0, false);
    maps.forEach(checkMap); checkMap(next, 24);
    assert.notEqual(maps[23].root, next.root);
    const distinct = Array.from({ length: 24 }, (_, i) => {
      api.resetMap(); return new api.SharedMap('number').set('value', i);
    });
    const distinctNext = distinct[23].set('value', 24);
    distinct.forEach(checkMap); checkMap(distinctNext, 24);
    assert.notEqual(distinct[23].root, distinctNext.root);
    const D0 = Object.freeze(Object.fromEntries(distinct.map((map, i) => [`m${i}`, map])));
    const D1 = Object.freeze({ ...D0, m23: distinctNext });
    const Q0 = Object.freeze({ root: maps[23] }), Q1 = Object.freeze({ root: next }), E = Object.freeze({});
    const ids = new Map();
    const own = map => {
      const record = { root: map }, data = api.getWorkerData(record, options);
      assert.equal(data.arenas.length, 1);
      const arena = data.arenas[0];
      validateExport(data, record, [arena], { root: arena.id });
      ids.set(map, arena.id); return arena;
    };
    const sharedArenas = [...maps, next].map(own), manyArenas = distinct.map(own), nextArena = own(distinctNext);
    const sameArena = (a, b) => { assert.equal(a.id, b.id); assert.equal(a.memory, b.memory); assert.equal(a.used, b.used); };
    sharedArenas.forEach(arena => sameArena(arena, sharedArenas[0]));
    sameArena(nextArena, manyArenas[23]);
    assert.equal(new Set([sharedArenas[0], ...manyArenas].map(a => a.id)).size, 25);
    const structureIds = record => Object.fromEntries(Object.entries(record).map(([name, map]) => [name, ids.get(map)]));
    for (const [record, arenas] of [[R0, [sharedArenas[0]]], [R1, [sharedArenas[0]]], [D0, manyArenas], [D1, manyArenas], [Q0, [sharedArenas[0]]], [Q1, [sharedArenas[0]]], [E, []]]) {
      validateExport(api.getWorkerData(record, options), record, arenas, structureIds(record));
    }
    const definitions = {
      'W24-changed': { inputs: [R0, R1], changed: true },
      'W24-unchanged': { inputs: [R0] },
      'D24-changed': { inputs: [D0, D1], changed: true },
      'Single-changed': { inputs: [maps[23], next], single: true, changed: true },
      'Single-unchanged': { inputs: [maps[23]], single: true },
      'Record1-changed': { inputs: [Q0, Q1], changed: true },
      'Record1-unchanged': { inputs: [Q0] },
      'Empty-unchanged': { inputs: [E] },
      Flush: { inputs: [R0], flush: true },
    };
    const cases = {};
    for (const id of CASES) {
      const definition = definitions[id];
      const session = id === 'W24-changed' ? firstSession : worker.createSharedSession(definition.inputs[0], options);
      if (session !== firstSession) sessions.push(session);
      cases[id] = makePublicationCase(session, definition.inputs, definition);
    }
    return { cases, dispose: () => sessions.forEach(session => session.dispose()), summary: {
      namesPerWideRecord: 24, entriesPerMap: 1, memoryMaximumBytes: 131072,
      arenaCounts: Object.fromEntries(CASES.map(id => [id, id === 'D24-changed' ? 24 : id === 'Empty-unchanged' ? 0 : 1])),
    } };
  } catch (error) { sessions.forEach(session => session.dispose()); throw error; }
}
export function batch(fixture, id, count) {
  assert(Number.isSafeInteger(count) && count > 0 && count <= capFor(id));
  let latest, checksum = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    latest = fixture.operation();
    checksum += latest + 1;
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const expected = fixture.validate(latest, checksum, count);
  return { count, elapsedNs, checksum, ...expected, validated: true };
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
  const primary = makePrimary(api);
  emit({ event: 'ready', unixMs: Date.now() });
  const firstStart = mode === 'measure' ? process.hrtime.bigint() : null;
  const first = worker.createSharedSession(primary.R0, primary.options);
  const firstConstructorNs = firstStart === null ? null : Number(process.hrtime.bigint() - firstStart);
  // First-session validation and every direct export happen after this timer.
  const fixtures = fixtureSet(api, worker, primary, first);
  try {
    emit({ event: 'fixtures', firstConstructorNs, ...fixtures.summary, validated: true });
    const cases = {}, counts = mode === 'measure' ? JSON.parse(readFileSync(countsPath, 'utf8')) : null;
    for (const id of CASES) {
      const fixture = fixtures.cases[id], cap = capFor(id);
      assert(cap > 0);
      if (mode === 'calibrate') {
        let count = Math.min(256, cap), accepted = false;
        const trials = [];
        for (let trial = 0; trial < 4; trial++) {
          const warmups = [], pilots = [];
          for (let i = 0; i < 5; i++) { const b = batch(fixture, id, count); warmups.push(b); emit({ event: 'batch', mode, id, trial, phase: 'warmup', index: i, ...b }); }
          for (let i = 0; i < 3; i++) { const b = batch(fixture, id, count); pilots.push(b); emit({ event: 'batch', mode, id, trial, phase: 'pilot', index: i, ...b }); }
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
          const b = batch(fixture, id, count); (i < 5 ? warmups : measured).push(b);
          emit({ event: 'batch', mode, id, phase: i < 5 ? 'warmup' : 'measured', index: i < 5 ? i : i - 5, ...b });
        }
        cases[id] = { count, cap, warmups, measured, quality: quality(measured) };
      }
    }
    emit({ event: 'result', mode, firstConstructorNs, fixtures: fixtures.summary, cases });
  } finally { fixtures.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'child') await child(...args);
  else throw new Error('Expected child');
}
