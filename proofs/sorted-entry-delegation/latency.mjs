import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CASES = ['P', 'N32', 'N1', 'N0', 'O256', 'K4097', 'V4097', 'C256', 'F4097'];
export const ORDERS = ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB'];
export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
export const sd = xs => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
export function capFor(id) { assert(CASES.includes(id)); return 2 ** 20; }
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

const OFFSET = 2166136261;
const MULTIPLIER = 16777619;
const reverseKeys = (a, b) => a < b ? 1 : a > b ? -1 : 0;
export function expectedEntries(size, object = false, reverse = false) {
  const entries = Array.from({ length: size }, (_, i) => Object.freeze({
    key: `k${String(i).padStart(4, '0')}`,
    value: object ? Object.freeze({ score: 3 * i + 1, label: `v${i}`, flags: Object.freeze([i & 1, i % 3]) }) : 3 * i + 1,
  }));
  if (reverse) entries.reverse();
  return Object.freeze(entries);
}
export function makeMap(api, size, object = false, reverse = false) {
  api.resetSortedMap();
  const ascending = expectedEntries(size, object);
  let map = new api.SharedSortedMap(object ? 'object' : 'number', reverse ? reverseKeys : undefined);
  for (let i = size - 1; i >= 0; i--) map = map.set(ascending[i].key, ascending[i].value);
  const expected = reverse ? Object.freeze([...ascending].reverse()) : ascending;
  return Object.freeze({ map, expected, object });
}
export function makePrimary(api) {
  api.configureMemory({ maximumBytes: 16777216 });
  return makeMap(api, 4097);
}
export function expectedOperation(expected, kind, object) {
  let checksum = OFFSET;
  for (const row of expected) {
    const token = kind === 'keys' ? row.key.charCodeAt(4) : kind === 'values' ? row.value : (object ? row.value.score : row.value) + row.key.charCodeAt(4);
    checksum = Math.imul(checksum ^ token, MULTIPLIER) >>> 0;
  }
  return Object.freeze({ itemCount: expected.length, checksum });
}
export function validateOperation(fixture, kind) {
  const { map, expected, object } = fixture;
  assert(Object.isFrozen(map)); assert.equal(map.size, expected.length);
  assert(Object.isFrozen(expected) && expected.every(row => Object.isFrozen(row)));
  let index = 0;
  const checkValue = (actual, wanted) => {
    assert.deepEqual(actual, wanted);
    if (object) assert(Object.isFrozen(actual) && Object.isFrozen(actual.flags));
  };
  if (kind === 'forEach') {
    assert.equal(map.forEach((value, key) => {
      assert(index < expected.length);
      assert.equal(key, expected[index].key); checkValue(value, expected[index].value); index++;
    }), undefined);
  } else {
    const iterator = map[kind]();
    for (const value of iterator) {
      assert(index < expected.length);
      const wanted = expected[index++];
      if (kind === 'keys') assert.equal(value, wanted.key);
      else if (kind === 'values') checkValue(value, wanted.value);
      else {
        assert(Array.isArray(value)); assert.equal(value.length, 2);
        assert.equal(value[0], wanted.key); checkValue(value[1], wanted.value);
      }
    }
    assert.deepEqual(iterator.next(), { value: undefined, done: true });
  }
  assert.equal(index, expected.length);
  return true;
}
export function makeCase(fixture, kind = 'entries') {
  const { map, expected, object } = fixture;
  let q = 0, h = OFFSET;
  // State and callback are allocated once during setup; each call returns one scalar.
  const callback = (value, key) => { h = Math.imul(h ^ (value + key.charCodeAt(4)), MULTIPLIER) >>> 0; q++; };
  let operation;
  if (kind === 'keys') operation = () => {
    q = 0; h = OFFSET;
    for (const key of map.keys()) { h = Math.imul(h ^ key.charCodeAt(4), MULTIPLIER) >>> 0; q++; }
    return h;
  };
  else if (kind === 'values') operation = () => {
    q = 0; h = OFFSET;
    for (const value of map.values()) { h = Math.imul(h ^ value, MULTIPLIER) >>> 0; q++; }
    return h;
  };
  else if (kind === 'forEach') operation = () => { q = 0; h = OFFSET; map.forEach(callback); return h; };
  else if (object) operation = () => {
    q = 0; h = OFFSET;
    for (const [key, value] of map.entries()) { h = Math.imul(h ^ (value.score + key.charCodeAt(4)), MULTIPLIER) >>> 0; q++; }
    return h;
  };
  else operation = () => {
    q = 0; h = OFFSET;
    for (const [key, value] of map.entries()) { h = Math.imul(h ^ (value + key.charCodeAt(4)), MULTIPLIER) >>> 0; q++; }
    return h;
  };
  return Object.freeze({ operation, itemCount: () => q, expected: expectedOperation(expected, kind, object), validate: () => validateOperation(fixture, kind) });
}
export function fixtureSet(api, primary, primaryCase) {
  const small = makeMap(api, 32), singleton = makeMap(api, 1), empty = makeMap(api, 0);
  const objects = makeMap(api, 256, true), comparator = makeMap(api, 256, false, true);
  const cases = Object.freeze({
    P: primaryCase, N32: makeCase(small), N1: makeCase(singleton), N0: makeCase(empty), O256: makeCase(objects),
    K4097: makeCase(primary, 'keys'), V4097: makeCase(primary, 'values'), C256: makeCase(comparator), F4097: makeCase(primary, 'forEach'),
  });
  for (const id of CASES) cases[id].validate();
  const registry = Object.freeze({ primary, small, singleton, empty, objects, comparator });
  return Object.freeze({ cases, registry, summary: Object.freeze({
    arenaCount: 6, memoryMaximumBytesPerArena: 16777216, totalConfiguredArenaMaximumBytes: 100663296,
    cases: Object.fromEntries(CASES.map(id => [id, cases[id].expected])),
  }) });
}
export function expectedBatch(expected, count) {
  assert(Number.isSafeInteger(count) && count > 0 && count <= 2 ** 20);
  const itemCount = expected.itemCount * count;
  assert(Number.isSafeInteger(itemCount));
  return { itemCount, checksum: (expected.checksum * count) >>> 0 };
}
export function batch(fixture, id, count) {
  assert(Number.isSafeInteger(count) && count > 0 && count <= capFor(id));
  let itemCount = 0, checksum = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    checksum = (checksum + fixture.operation()) >>> 0;
    itemCount += fixture.itemCount();
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const expected = expectedBatch(fixture.expected, count);
  assert.equal(itemCount, expected.itemCount); assert.equal(checksum, expected.checksum);
  fixture.validate();
  return { count, elapsedNs, itemCount, checksum, validated: true };
}
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
async function child(entry, mode, countsPath) {
  assert(['calibrate', 'measure'].includes(mode));
  const entryPath = realpathSync(entry);
  assert.equal(basename(entryPath), process.versions.bun ? 'shared.ts' : 'shared.js');
  const api = await import(pathToFileURL(entryPath));
  const primary = makePrimary(api);
  emit({ event: 'ready', unixMs: Date.now() });
  const primaryCase = makeCase(primary);
  const firstStart = process.hrtime.bigint();
  const firstChecksum = primaryCase.operation();
  const firstDrainNs = Number(process.hrtime.bigint() - firstStart);
  const firstItemCount = primaryCase.itemCount();
  assert.equal(firstItemCount, primaryCase.expected.itemCount); assert.equal(firstChecksum, primaryCase.expected.checksum);
  // Exact public traversal starts after the first drain clock, before other setup.
  primaryCase.validate();
  const firstDrain = { elapsedNs: firstDrainNs, itemCount: firstItemCount, checksum: firstChecksum, validated: true };
  const fixtures = fixtureSet(api, primary, primaryCase);
  emit({ event: 'fixtures', firstDrainNs, firstDrain, ...fixtures.summary, validated: true });
  const cases = {}, counts = mode === 'measure' ? JSON.parse(readFileSync(countsPath, 'utf8')) : null;
  for (const id of CASES) {
    const fixture = fixtures.cases[id], cap = capFor(id);
    if (mode === 'calibrate') {
      let count = 256, accepted = false;
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
  emit({ event: 'result', mode, firstDrainNs, firstDrain, fixtures: fixtures.summary, cases });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'child') await child(...args);
  else throw new Error('Expected child');
}
