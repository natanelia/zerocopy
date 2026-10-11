import test from 'node:test';
import assert from 'node:assert/strict';
import { entriesFor, editsFor, queryIds, calculate, feature, featureId } from '../assets/feature-core.mjs';
import { reference, verifyAnswer } from '../assets/feature-reference.mjs';
test('deterministic sparse lookups and validation include missing IDs and Unicode values', () => {
  for (const count of [1000, 10000, 100000]) {
    const map = new Map(entriesFor(count)), ids = queryIds(count);
    assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
    const answer = calculate(map, ids); verifyAnswer(answer, reference(count, 0, ids));
    assert.equal(answer.lookup.missing, 90); assert.match(map.get('road/000000').name, /道路/);
    assert.equal(answer.lookup.rows.length, 12); assert.equal(answer.validation.issues[0].id, 'road/000000');
  }
});
test('sparse replacements preserve the original objects and change every requested field fingerprint', () => {
  const count = 1000, initial = new Map(entriesFor(count)), current = new Map(initial), ids = queryIds(count);
  for (const [id, value] of editsFor(count, 1)) current.set(id, value);
  verifyAnswer(calculate(initial, ids), reference(count, 0, ids)); verifyAnswer(calculate(current, ids), reference(count, 1, ids));
  assert.equal(initial.get('road/000000').attributes.lanes, 0); assert.equal(current.get('road/000000').attributes.lanes, 2);
  assert.throws(() => { current.get('road/000000').attributes.lanes = 99; }, TypeError);
  const laterId = ids[501], wrong = structuredClone(current.get(laterId)); wrong.name = 'Incorrect name outside visible page'; current.set(laterId, wrong);
  assert.throws(() => verifyAnswer(calculate(current, ids), reference(count, 1, ids)), /reference/);
});
test('oracle rejects missing tasks and supports absent selected IDs', () => {
  const map = new Map(entriesFor(1000)), ids = queryIds(1000, 'road/099999'), expected = reference(1000, 0, ids);
  assert.equal(expected.lookup.missing, 91);
  verifyAnswer(calculate(map, ids, 'lookup'), expected, 'lookup');
  assert.throws(() => verifyAnswer(calculate(map, ids, 'lookup'), expected), /coverage/);
  assert.throws(() => feature(-1)); assert.throws(() => featureId(100000)); assert.throws(() => editsFor(1000, 13));
  for (const count of [7919, 1001, 15838]) {
    assert.throws(() => entriesFor(count)); assert.throws(() => queryIds(count)); assert.throws(() => editsFor(count, 1));
  }
});
