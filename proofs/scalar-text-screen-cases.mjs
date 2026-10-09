/** Prospective structural public-API cases; no clocks and no tuned fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const rows = 1024, indexes = Array.from({ length: rows }, (_, i) => i);
function make(id, value, term, caseSensitive = true) {
  return { id, values: Array(rows).fill(value), indexes, term, options: { caseSensitive },
    distribution: 'repeated-interned', access: 'sequential-all-rows' };
}
export function makeCases() { return [
  make('tiny-early-hit', 'ok!', 'ok'),
  make('seven-start-dense-miss', 'a'.repeat(14), 'aaaaaaab'),
  make('eight-start-dense-miss', 'a'.repeat(15), 'aaaaaaab'),
  make('long-one-byte-miss', 'x'.repeat(1024), 'n'),
  make('long-zero-candidate-miss', 'x'.repeat(1024), 'needle'),
  make('long-singleton-per-chunk-miss', 'nxxxxxxx'.repeat(128), 'needle'),
  make('long-two-candidates-per-chunk-miss', 'nxnxxxxx'.repeat(128), 'needle'),
  make('dense-last-byte-miss-length8', 'a'.repeat(1024), 'aaaaaaab'),
  make('dense-last-byte-miss-length16', 'a'.repeat(1024), 'a'.repeat(15) + 'b'),
  make('dense-endpoint-passing-miss', 'a'.repeat(1024), 'abaa'),
  make('dense-early-hit', 'a'.repeat(1024), 'aaaa'),
  make('insensitive-unicode-tail-miss', 'a'.repeat(1021) + '中', 'aaaaaaab', false),
]; }
export function expected(item) {
  const term = item.options.caseSensitive ? item.term : item.term.toLowerCase();
  return item.indexes.map(index => (item.options.caseSensitive ? item.values[index] : item.values[index].toLowerCase()).includes(term));
}
export const expectedScore = item => expected(item).reduce((sum, hit, i) => sum + (hit ? item.indexes[i] + 1 : 0), 0);
export function build(api, item) { api.resetSharedList(); return new api.SharedList('string').pushMany(item.values); }
export function scan(list, item) {
  // A fresh predicate each operation prevents previous scans' half-leaf caches
  // from replacing query preparation, dispatch and scanning in this diagnostic.
  const predicate = list.compileTextSearch(item.term, item.options);
  let score = 0;
  for (const index of item.indexes) if (predicate(index)) score += index + 1;
  return score;
}
export function checkCase(api, item) {
  const list = build(api, item), predicate = list.compileTextSearch(item.term, item.options);
  assert.deepEqual(list.toArray(), item.values, item.id);
  assert.deepEqual(item.indexes.map(index => predicate(index)), expected(item), item.id);
  assert.equal(scan(list, item), expectedScore(item));
  return { id: item.id, rows, requestedIndexes: item.indexes.length, expectedScore: expectedScore(item) };
}
export function caseManifest(cases = makeCases()) {
  assert.equal(cases.length, 12);
  return cases.map(item => {
    const bytes = item.values.map(value => Buffer.byteLength(value));
    assert.equal(new Set(item.values).size, 1);
    return { id: item.id, rows, term: item.term, options: item.options, distribution: item.distribution,
      distinctValues: 1, access: item.access, requestedIndexes: item.indexes.length,
      minUtf8Bytes: Math.min(...bytes), maxUtf8Bytes: Math.max(...bytes),
      fixtureSha256: createHash('sha256').update(JSON.stringify(item)).digest('hex') };
  });
}
