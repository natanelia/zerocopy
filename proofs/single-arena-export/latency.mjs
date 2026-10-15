import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CASES = ['S', 'A', 'E', 'D2', 'D24', 'RC', 'RO', 'T', 'R'];
export const ORDERS = ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB'];
export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
export const sd = xs => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
export function capFor(id, copiedBytes) {
  if (id === 'R') return 2 ** 24;
  if (id === 'T') return Math.min(4096, Math.floor(512 * 1024 ** 2 / copiedBytes));
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

export function makeMap(api, i) {
  api.resetMap();
  let map = new api.SharedMap('number');
  for (let j = 0; j < 32; j++) map = map.set(`k${j}`, i * 32 + j);
  return map;
}
function checkMap(map, i) {
  assert.equal(map.size, 32);
  for (let j = 0; j < 32; j++) assert.equal(map.get(`k${j}`), i * 32 + j);
}
export function validateExport(value, record, expected, copy, structureIds = Object.fromEntries(Object.keys(record).map(name => [name, expected[0]?.id]))) {
  assert.equal(value.__shared, true); assert.equal(value.version, 4);
  assert(Object.isFrozen(value) && Object.isFrozen(value.arenas) && Object.isFrozen(value.structures));
  assert.deepEqual(Object.keys(value.structures), Object.keys(record));
  assert.deepEqual(value.arenas.map(a => a.id), expected.map(a => a.id));
  for (const [name, map] of Object.entries(record)) {
    const d = value.structures[name];
    assert(Object.isFrozen(d) && Object.isFrozen(d.data));
    assert.equal(d.type, 'SharedMap');
    assert.deepEqual(d.data, map.toWorkerData());
    assert.equal(d.arena, structureIds[name]);
  }
  for (let i = 0; i < expected.length; i++) {
    const actual = value.arenas[i], wanted = expected[i];
    assert(Object.isFrozen(actual)); assert.equal(actual.used, wanted.used);
    assert.equal(typeof actual.id, 'string');
    assert(Number.isSafeInteger(actual.used) && actual.used >= 65536 && actual.used <= wanted.memory.buffer.byteLength);
    assert.deepEqual(Object.keys(actual), ['id', 'used', copy ? 'copy' : 'memory']);
    if (copy) {
      assert(actual.copy instanceof Uint8Array); assert.equal(actual.copy.length, wanted.used);
      assert.deepEqual(actual.copy, new Uint8Array(wanted.memory.buffer, 0, wanted.used));
    } else { assert.equal(actual.memory, wanted.memory); assert(actual.memory.buffer instanceof SharedArrayBuffer); }
  }
}
async function fixtureSet(api, singleton, first) {
  checkMap(singleton.root, 0);
  const shared = { copy: false }, copied = { copy: true };
  const own = map => api.getWorkerData({ root: map }, shared).arenas[0];
  const source = own(singleton.root);
  validateExport(first, singleton, [source], false);
  const d2 = { m0: makeMap(api, 0), m1: makeMap(api, 1) };
  const many = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`m${i}`, makeMap(api, i)]));
  const twoArenas = Object.values(d2).map(own), manyArenas = Object.values(many).map(own);
  const ids = new Map([[singleton.root, source.id], ...Object.values(d2).map((m, i) => [m, twoArenas[i].id]), ...Object.values(many).map((m, i) => [m, manyArenas[i].id])]);
  const structureIds = record => Object.fromEntries(Object.entries(record).map(([name, map]) => [name, ids.get(map)]));
  assert.equal(new Set([...twoArenas, ...manyArenas, source].map(a => a.id)).size, 27);
  Object.values(d2).forEach(checkMap); Object.values(many).forEach(checkMap);
  const payload = api.getWorkerData(many, shared);
  validateExport(payload, many, manyArenas, false, structureIds(many));
  const closed = await api.initWorker(payload);
  const open = await api.initWorker(api.getWorkerData(many, shared));
  for (const readers of [closed, open]) for (const [name, map] of Object.entries(readers)) ids.set(map, payload.structures[name].arena);
  for (const snapshot of Object.values(open)) void Reflect.get(snapshot, 'arena').dependencies;
  Object.values(closed).forEach(checkMap); Object.values(open).forEach(checkMap);
  const reverse = [manyArenas[0], ...manyArenas.slice(1).reverse()];
  const definitions = {
    S: [singleton, [source]], A: [{ root: singleton.root, alias: singleton.root }, [source]], E: [{}, []],
    D2: [d2, twoArenas], D24: [many, manyArenas], RC: [{ root: closed.m0 }, reverse], RO: [{ root: open.m0 }, reverse], T: [singleton, [source]],
  };
  const result = {};
  for (const [id, [record, arenas]] of Object.entries(definitions)) {
    const options = id === 'T' ? copied : shared;
    const operation = () => api.getWorkerData(record, options);
    const validate = value => validateExport(value, record, arenas, id === 'T', structureIds(record));
    validate(operation());
    result[id] = { operation, validate, expectedChecksum: arenas.length };
  }
  result.R = { operation: () => singleton.root.get('k15'), validate: value => assert.equal(value, 15), expectedChecksum: 15 };
  return { cases: result, copiedBytes: source.used, summary: { keysPerMap: 32, memoryMaximumBytes: 131072, singletonUsed: source.used, arenaCounts: Object.fromEntries(CASES.map(id => [id, id === 'R' ? null : definitions[id][1].length])) } };
}
export function batch(fixture, id, count) {
  let latest, checksum = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    latest = fixture.operation();
    checksum += id === 'R' ? latest : latest.arenas.length;
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  assert.equal(checksum, fixture.expectedChecksum * count);
  fixture.validate(latest);
  return { count, elapsedNs, checksum, validated: true };
}
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
async function child(entry, mode, countsPath) {
  assert(['calibrate', 'measure'].includes(mode));
  const api = await import(pathToFileURL(entry));
  api.configureMemory({ maximumBytes: 131072 });
  const singleton = { root: makeMap(api, 0) }, firstOptions = { copy: false };
  emit({ event: 'ready', unixMs: Date.now() });
  const firstStart = process.hrtime.bigint();
  const first = api.getWorkerData(singleton, firstOptions);
  const firstExportNs = Number(process.hrtime.bigint() - firstStart);
  // Full validation occurs after the first observation, outside every timer.
  assert.equal(first.arenas.length, 1);
  validateExport(first, singleton, first.arenas, false);
  const fixtures = await fixtureSet(api, singleton, first);
  emit({ event: 'fixtures', firstExportNs, ...fixtures.summary, validated: true });
  const cases = {}, counts = mode === 'measure' ? JSON.parse(readFileSync(countsPath, 'utf8')) : null;
  for (const id of CASES) {
    const fixture = fixtures.cases[id], cap = capFor(id, fixtures.copiedBytes);
    assert(cap > 0);
    if (mode === 'calibrate') {
      let count = Math.min(id === 'T' ? 64 : 256, cap), accepted = false;
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
  emit({ event: 'result', mode, firstExportNs, fixtures: fixtures.summary, cases });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'child') await child(...args);
  else throw new Error('Expected child');
}
