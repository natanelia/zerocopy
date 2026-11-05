import assert from 'node:assert/strict';

export const CASES = Object.freeze([
  { name: 'empty', size: 0, op: 'array', role: 'empty control' },
  { name: 'single', size: 1, op: 'array', role: 'small input control' },
  { name: 'warm-ascii', size: 256, op: 'array', role: 'cached-value target' },
  { name: 'warm-unicode', size: 256, unicode: true, op: 'array', role: 'discarded Unicode key target' },
  { name: 'warm-cache-boundary', size: 2048, op: 'array', role: 'decode-cache boundary' },
  { name: 'warm-cache-overflow', size: 4096, op: 'array', role: 'decode-cache overflow control' },
  { name: 'fresh-ascii', size: 256, fresh: true, op: 'array', role: 'cold reader decoding' },
  { name: 'fresh-unicode-nested', size: 256, fresh: true, unicode: true, nested: true, op: 'array', role: 'cold nested-object decoding' },
  { name: 'fresh-array-then-entries', size: 256, fresh: true, unicode: true, op: 'both', role: 'complete downstream key-work control' },
  { name: 'entries-control', size: 256, unicode: true, op: 'entries', role: 'unchanged operation control' },
]);

export function makeRows(spec) {
  return Array.from({ length: spec.size }, (_, rank) => {
    const id = spec.unicode ? `row-${rank.toString(36).padStart(5, '0')}-${'道路🌏'.repeat(16)}` : `row-${rank.toString(36).padStart(5, '0')}`;
    const value = { id, rank, active: rank % 3 === 0, title: `value ${rank} café` };
    if (spec.nested) value.details = { group: `group-${rank % 7}`, tags: [`tag-${rank % 11}`, '日本語'], coordinates: [[rank + .25, -rank], [rank + .5, rank % 17]] };
    return value;
  });
}

export function oracle(rows, keys) {
  // Native JSON defines the stored value, independently of shared decoding.
  const byKey = new Map(rows.map(row => [row.id, JSON.parse(JSON.stringify(row))]));
  assert.equal(new Set(keys).size, rows.length);
  return keys.map(key => { assert.ok(byKey.has(key)); return byKey.get(key); });
}

export function checkRow(actual, expected, nested) {
  if (actual === null || typeof actual !== 'object' || actual.id !== expected.id || actual.rank !== expected.rank
    || actual.active !== expected.active || actual.title !== expected.title) throw new Error('Materialized row does not match the native oracle');
  if (nested) {
    const a = actual.details, e = expected.details;
    if (!a || a.group !== e.group || !Array.isArray(a.tags) || a.tags.length !== 2 || a.tags[0] !== e.tags[0] || a.tags[1] !== e.tags[1]
      || !Array.isArray(a.coordinates) || a.coordinates.length !== 2) throw new Error('Nested data does not match the native oracle');
    for (let i = 0; i < 2; i++) if (!Array.isArray(a.coordinates[i]) || a.coordinates[i].length !== 2
      || !Object.is(a.coordinates[i][0], e.coordinates[i][0]) || !Object.is(a.coordinates[i][1], e.coordinates[i][1])) throw new Error('Coordinates do not match the native oracle');
  }
  return actual.rank;
}

export function verify(result, expected, keys, spec) {
  let sum = 0, checkedRows = 0;
  if (spec.op !== 'entries') {
    const values = spec.op === 'both' ? result.values : result;
    assert.ok(Array.isArray(values)); assert.equal(values.length, expected.length);
    for (let i = 0; i < values.length; i++) { sum += checkRow(values[i], expected[i], spec.nested); checkedRows++; }
  }
  if (spec.op !== 'array') {
    const entries = spec.op === 'both' ? result.entries : result;
    assert.ok(Array.isArray(entries)); assert.equal(entries.length, expected.length);
    for (let i = 0; i < entries.length; i++) {
      if (!Array.isArray(entries[i]) || entries[i].length !== 2 || entries[i][0] !== keys[i]) throw new Error('Entry order/key mismatch');
      sum += checkRow(entries[i][1], expected[i], spec.nested); checkedRows++;
    }
  }
  return { sum, checkedRows };
}
