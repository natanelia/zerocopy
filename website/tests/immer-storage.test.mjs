import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { immerVersion } from '../_site/compare/vendor/version.mjs';
import { fromColumns, attachColumns, appendImmer, immerView } from '../_site/compare/assets/immer-storage.mjs';
import { FIELDS, MAX_EVENTS, generateColumns, rowAt } from '../assets/explorer-core.mjs';

test('pinned upstream Immer builds frozen columns without freezing the native input', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
  assert.equal(immerVersion, pkg.devDependencies.immer);
  const input = generateColumns(0, 33), snapshot = fromColumns(input);
  assert.deepEqual(snapshot, input); assert.ok(Object.isFrozen(snapshot));
  for (const field of FIELDS) {
    assert.ok(Object.isFrozen(snapshot[field])); assert.notEqual(snapshot[field], input[field]);
    assert.equal(Object.isFrozen(input[field]), false);
  }
  input.latency[0] = -123;
  assert.notEqual(immerView(snapshot).get('latency', 0), -123);
  assert.throws(() => { snapshot.latency[0] = -1; }, TypeError);
});
test('produce appends preserve retained roots and clone replicas can resume live', () => {
  const input = generateColumns(0, 1024), saved = fromColumns(input), delta = generateColumns(1024, 33);
  const next = appendImmer(saved, delta);
  assert.equal(immerView(saved).length, 1024); assert.equal(immerView(next).length, 1057);
  assert.deepEqual(saved, input);
  for (const field of FIELDS) {
    assert.notEqual(saved[field], next[field]); assert.ok(Object.isFrozen(next[field]));
  }
  const wire = structuredClone(saved);
  assert.equal(Object.isFrozen(wire.time), false);
  const replica = attachColumns(wire);
  assert.equal(replica, wire, 'Attachment must not make a needless full copy');
  assert.ok(Object.isFrozen(replica.time));
  assert.deepEqual(appendImmer(replica, structuredClone(delta)), next);
  assert.deepEqual(rowAt(immerView(replica), 1023), rowAt(immerView(saved), 1023));
  assert.equal(appendImmer(saved, generateColumns(0, 0)), saved);
});
test('Immer rejects malformed columns, mutable snapshots, and capacity overflow', () => {
  const input = generateColumns(0, 1), saved = fromColumns(input);
  assert.throws(() => fromColumns({ ...input, latency: [] }));
  assert.throws(() => attachColumns({ ...input, time: [] }));
  assert.throws(() => immerView(input), /frozen Immer/);
  assert.throws(() => appendImmer(saved, { ...input, message: [] }));
  assert.deepEqual(saved, input);
  const full = attachColumns(Object.fromEntries(FIELDS.map(field => [field, new Array(MAX_EVENTS)])));
  assert.throws(() => appendImmer(full, input), /capacity/);
});
