/** Recompute a completed v4 export without rerunning or importing its statistics. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) throw new Error('Usage: node proofs/benchmark-integration-20261115/verify.mjs EXPORT.json');
const bytes = readFileSync(file);
const data = JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
assert.equal(data.schema, 'zerocopy-product-catalog-browser/v4');
assert.equal(data.status, 'complete');
assert.equal(data.identityStatus, 'verified');
assert.equal(data.sourceCommit, data.buildIdentity.sourceCommit);
assert.match(data.sourceCommit, /^[0-9a-f]{40}$/);
assert.equal(data.assetVerification.verified, true);
for (const name of ['libraryFilesSHA256', 'benchmarkFilesSHA256', 'vendorFilesSHA256']) {
  assert.deepEqual(data.assetVerification[name], data.buildIdentity[name]);
  assert.ok(Object.keys(data.buildIdentity[name]).length > 0);
  for (const hash of Object.values(data.buildIdentity[name])) assert.match(hash, /^[a-f0-9]{64}$/);
}
assert.equal(data.buildIdentity.librarySHA256, data.buildIdentity.libraryFilesSHA256['shared.js']);
assert.equal(data.config.requestedIds, 1000);
assert.equal(data.config.uniqueIds, new Set(data.config.ids).size);
assert.equal(data.config.readers, 2);
assert.equal(data.config.edits, 100);
assert.equal(data.config.warmups, 2);
assert.equal(data.config.samplesPerCase, 7);
assert.deepEqual(data.failures, []);
assert.equal(data.raw.length, 99);
assert.equal(data.legacy.raw.length, 63);
assert.equal(data.cases.length, 11);
assert.equal(data.legacy.cases.length, 7);
assert.equal(data.execution.length, 162);
assert.equal(data.legacy.schema, 'zerocopy-product-catalog-browser/v3');

function stats(values) {
  assert.equal(values.length, 7);
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[3], min: sorted[0], max: sorted[6], p25: (sorted[1] + sorted[2]) / 2, p75: (sorted[4] + sorted[5]) / 2 };
}
const all = new Map();
for (const [track, section] of [['reads', data], ['legacy', data.legacy]]) {
  for (const definition of section.cases) {
    const samples = section.raw.filter(sample => sample.caseId === definition.id);
    assert.deepEqual(samples.map(sample => sample.round).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const sample of samples) {
      assert.equal(sample.warmup, sample.round <= 2);
      assert.ok(!all.has(sample.sequence)); all.set(sample.sequence, { track, sample });
      if (track === 'reads') {
        assert.equal(sample.status, 'passed');
        assert.equal(sample.api, definition.api);
        assert.equal(sample.workload, definition.workload);
        assert.equal(sample.freeze, definition.freeze);
        assert.equal(sample.constructionToFirstAnswerMs, sample.constructionMs + sample.publicationMs + sample.firstRoundTripMs);
        for (const [query, phase] of [['first', 'firstQueryMs'], ['repeat', 'repeatQueryMs'], ['updated', 'updatedQueryMs'], ['retained', 'retainedQueryMs']]) {
          assert.equal(sample.readerTimings[query].length, 2);
          assert.equal(sample[phase], Math.max(...sample.readerTimings[query]));
          assert.equal(sample.verification[query].length, 2);
          for (const check of sample.verification[query]) {
            assert.equal(check.passed, true); assert.equal(check.found, 910); assert.equal(check.missing, 90);
            assert.equal(check.requested, 1000); assert.equal(check.idsFieldsCountsMissesAndOrder, true);
          }
        }
        assert.equal(sample.verification.contracts.length, 2);
        for (const reader of sample.verification.contracts) {
          assert.deepEqual(Object.keys(reader), ['first', 'repeat', 'updated', 'retained']);
          assert.ok(Object.values(reader).every(check => check.passed));
        }
      } else {
        assert.equal(sample.verification.updated.answer.validation.unavailable, 100);
        assert.equal(sample.verification.initial.answer.validation.unavailable, 0);
        assert.equal(sample.verification.updated.answer.lookup.found, 910);
        const initial = sample.kind === 'shared' ? 0 : data.config.entries;
        const edited = sample.kind === 'shared' ? 0 : sample.updateMode === 'full' ? data.config.entries : 100;
        assert.deepEqual(sample.publication.initial, { recordsPerReader: initial, totalRecords: initial * 2 });
        assert.deepEqual(sample.publication.edit, { recordsPerReader: edited, totalRecords: edited * 2 });
        if (sample.updateMode === 'full') assert.equal(sample.firstQueryMs, undefined);
      }
    }
    for (const [phase, summary] of Object.entries(section.summary[definition.id])) {
      assert.deepEqual(summary, stats(samples.filter(sample => !sample.warmup).map(sample => sample[phase])), `${definition.id}: ${phase}`);
    }
  }
}
for (let i = 0; i < data.execution.length; i++) {
  const execution = data.execution[i], round = Math.floor(i / data.schedule.length);
  const expected = data.schedule[(i % data.schedule.length + round) % data.schedule.length];
  assert.equal(execution.sequence, i + 1); assert.equal(execution.round, round + 1);
  assert.equal(execution.status, 'passed'); assert.equal(execution.track, expected.track); assert.equal(execution.caseId, expected.caseId);
  const stored = all.get(i + 1);
  assert.equal(stored.track, execution.track); assert.equal(stored.sample.caseId, execution.caseId);
}
console.log(JSON.stringify({ status: 'passed', sourceCommit: data.sourceCommit, readSamples: data.raw.length, legacySamples: data.legacy.raw.length, perSampleTotals: 'verified', displayedSummaries: 'recomputed', executionOrder: 'verified' }, null, 2));
