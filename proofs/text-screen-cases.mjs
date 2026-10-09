/** Frozen, deterministic public-API cases. This file never reads a clock. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const rows = 1024;
const indexList = Array.from({ length: rows }, (_, i) => i);
function text(i, length, kind, repeated = false) {
  const chars = Array(length).fill(kind === 'dense' ? 'a' : 'x');
  if (!repeated) chars.splice(0, 8, ...String(i).padStart(8, '0'));
  if (kind === 'sparse' || kind === 'late') for (const at of [240, 496, 752]) chars[at] = 'n';
  if (kind === 'late') chars.splice(length - 6, 6, ...'needle');
  return chars.join('');
}
function make(id, length, kind, extra = {}) {
  const repeated = extra.distribution === 'repeated';
  const values = Array.from({ length: rows }, (_, i) => text(i, length, kind, repeated));
  return { id, values, indexes: indexList, term: 'needle', options: { caseSensitive: true },
    distribution: repeated ? 'repeated' : 'unique', access: 'sequential', ...extra };
}
export function makeCases() { return [
  make('long-sparse-miss-unique', 1024, 'sparse'),
  make('long-sparse-miss-repeated', 1024, 'sparse', { distribution: 'repeated' }),
  make('long-sparse-latehit-unique', 1024, 'late'),
  make('long-dense-miss-unique', 1024, 'dense', { term: 'aaaaaaab' }),
  make('tiny-earlyhit-repeated', 3, 'plain', { distribution: 'repeated', values: Array(rows).fill('ok!'), term: 'ok' }),
  make('short-miss-unique', 12, 'plain'),
  ...[15, 16, 17].map(starts => make(`boundary-${starts}-starts-unique`, starts + 5, 'plain')),
  make('long-sparse-access-unique', 1024, 'sparse', {
    access: 'one-index-per-half-leaf', indexes: indexList.filter(i => i % 16 === 0),
  }),
  make('long-alternating-access-unique', 1024, 'sparse', {
    access: 'alternate-between-two-half-leaves',
    indexes: Array.from({ length: rows / 32 }, (_, leaf) =>
      Array.from({ length: 16 }, (_, i) => [leaf * 32 + i, leaf * 32 + 16 + i]).flat()).flat(),
  }),
  make('unicode-negative-fallback-unique', 1024, 'sparse', {
    options: { caseSensitive: false },
    values: Array.from({ length: rows }, (_, i) => text(i, 1021, 'sparse') + 'K'),
  }),
]; }
export function expected(item) {
  const term = item.options.caseSensitive ? item.term : item.term.toLowerCase();
  return item.indexes.map(index => (item.options.caseSensitive ? item.values[index] : item.values[index].toLowerCase()).includes(term));
}
export function expectedScore(item) {
  return expected(item).reduce((sum, hit, i) => sum + (hit ? item.indexes[i] + 1 : 0), 0);
}
export function build(api, item) {
  api.resetSharedList();
  return new api.SharedList('string').pushMany(item.values);
}
// A new public compiled predicate on every operation includes query preparation,
// block-cache initialization, traversal, kernel dispatch, and Unicode fallback.
export function scan(list, item) {
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
  return cases.map(item => {
    const bytes = item.values.map(value => Buffer.byteLength(value));
    assert.equal(new Set(item.values).size, item.distribution === 'repeated' ? 1 : rows);
    return { id: item.id, rows, term: item.term, options: item.options,
      distribution: item.distribution, distinctValues: new Set(item.values).size,
      access: item.access, requestedIndexes: item.indexes.length,
      minUtf8Bytes: Math.min(...bytes), maxUtf8Bytes: Math.max(...bytes),
      fixtureSha256: createHash('sha256').update(JSON.stringify(item)).digest('hex') };
  });
}
