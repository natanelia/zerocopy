import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, makeFixture, expectedPlain } from './fixtures.mjs';
import { exact } from './study-core.mjs';

test('cache fixtures cross one admission limit at a time', () => {
  for (const kind of ['map', 'list']) {
    for (const side of ['below', 'above']) {
      const entries = CASES.find(item => item.id === `${kind}-entries-${side}`), a = makeFixture(entries);
      assert.equal(entries.size < 2048, side === 'below'); assert.ok(a.serializedBytes < 2097152);
      const bytes = CASES.find(item => item.id === `${kind}-bytes-${side}`), b = makeFixture(bytes);
      assert.ok(bytes.size < 2048); assert.equal(b.serializedBytes < 2097152, side === 'below');
    }
  }
});
test('Unicode key oracle preserves NFC/NFD distinction and replaces lone surrogates only', () => {
  const definition = CASES.find(item => item.id === 'map-unicode'), fixture = makeFixture(definition);
  const actual = expectedPlain(fixture, definition, false, ['café/0', 'cafe\u0301/0', 'cafe\u0301/12', 'café/12', 'surrogate/\ud800/1', 'surrogate/\ufffd/1']);
  assert.equal(actual[0].index, 0); assert.equal(actual[1], undefined);
  assert.equal(actual[2].index, 12); assert.equal(actual[3], undefined);
  assert.equal(actual[4], actual[5]); assert.equal(actual[4].index, 1);
});
test('exact result checker distinguishes negative zero, undefined, shape and reserved keys', () => {
  assert.throws(() => exact(-0, 0)); assert.throws(() => exact([undefined], [null]));
  assert.throws(() => exact([], Array(2))); assert.throws(() => exact({ a: 1 }, { b: 1 }));
  const reserved = JSON.parse('{"__proto__":{"safe":true},"constructor":"record"}');
  exact(reserved, JSON.parse(JSON.stringify(reserved)));
  assert.throws(() => exact(reserved, { constructor: 'record' }));
});
