/** Pure proposed preflight: no library import, clock, or benchmark execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CASES, SPECS, EXPECTED, makeCorpus, oracle, referenceMatch } from './corpus.mjs';
const entries = makeCorpus(), encoder = new TextEncoder(), decoder = new TextDecoder();
assert.deepEqual(SPECS.slice(0, 8).map(s => encoder.encode(s.term).length), [1, 4, 5, 8, 9, 13, 16, 16]);
assert.deepEqual(SPECS.slice(8, 10).map(s => encoder.encode(s.term).length), [24, 40]);
for (const [j, entry] of entries.entries()) {
  assert.equal(entry.values.length, j < 8 ? 4096 : 16);
  assert.equal(new Set(entry.values).size, entry.values.length);
  for (const [i, value] of entry.values.entries()) {
    assert.ok(encoder.encode(value).length >= 64);
    assert.equal(decoder.decode(encoder.encode(value)), value);
    assert.equal(referenceMatch(entry, value), i % 2 === 0, entry.id + ':' + i);
    if (j < 8 && !entry.caseSensitive) assert.ok([...value].every(c => c.charCodeAt(0) < 128));
  }
}
for (const id of CASES) assert.deepEqual(oracle(id, entries), EXPECTED[id]);
console.log(JSON.stringify({ kind: 'short-query-corpus', status: 'passed',
  corpusSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  entries: entries.length, rows: entries.reduce((n, e) => n + e.values.length, 0), expected: EXPECTED }));
