import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize, summarizeCases } from '../assets/catalog-benchmark-results.mjs';

test('fixed-count summaries use all samples and reject incomplete or invalid runs', () => {
  assert.deepEqual(summarize([7, 1, 6, 2, 5, 3, 4]), { median: 4, min: 1, max: 7, p25: 2.5, p75: 5.5 });
  for (const values of [[1, 2], [1, 2, 3, 4, 5, 6, NaN], [1, 2, 3, 4, 5, 6, -1]]) assert.throws(() => summarize(values));
});

test('summaries exclude warmups, keep cases separate and take the median of each sample total', () => {
  const triples = [[1, 100, 3], [2, 2, 100], [100, 3, 1], [4, 4, 4], [5, 5, 5], [6, 6, 6], [7, 7, 7]];
  const raw = [1, 2].map(round => ({ caseId: 'a', warmup: true, round, sequence: round, constructionMs: 1000, publicationMs: 1000, firstRoundTripMs: 1000, total: 3000 }));
  raw.push(...triples.map(([constructionMs, publicationMs, firstRoundTripMs], index) => ({ caseId: 'a', warmup: false, round: index + 3, sequence: index + 3, status: 'passed', constructionMs, publicationMs, firstRoundTripMs, total: constructionMs + publicationMs + firstRoundTripMs })));
  const summary = summarizeCases(raw, [{ id: 'a' }], () => ['constructionMs', 'publicationMs', 'firstRoundTripMs', 'total']);
  assert.equal(summary.a.total.median, 21);
  assert.notEqual(summary.a.total.median, summary.a.constructionMs.median + summary.a.publicationMs.median + summary.a.firstRoundTripMs.median);
  assert.throws(() => summarizeCases(raw.slice(1, 7), [{ id: 'a' }], () => ['total']));
  assert.throws(() => summarizeCases(raw, [{ id: 'other' }], () => ['total']));
  assert.throws(() => summarizeCases(raw, [{ id: 'a' }, { id: 'a' }], () => ['total']));
  for (const altered of [
    raw.map((item, index) => index === 8 ? { ...item, round: 8 } : item),
    raw.map((item, index) => index === 8 ? { ...item, sequence: 8 } : item),
    raw.map((item, index) => index === 8 ? { ...item, status: 'failed' } : item),
    raw.map((item, index) => index === 8 ? { ...item, warmup: true } : item),
  ]) assert.throws(() => summarizeCases(altered, [{ id: 'a' }], () => ['total']));
});
