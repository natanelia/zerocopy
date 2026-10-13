import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, READER_COUNTS, validateCase, recordingProfile } from './feature-map-memory-model.mjs';

const fixed = { entries: 100000, trials: 3, kinds: KINDS };
test('the original full matrix remains exactly zero, two and four readers', () => {
  assert.deepEqual(READER_COUNTS, [0, 2, 4]);
  assert.equal(recordingProfile({ ...fixed, readerCounts: [0, 2, 4] }), 'full-matrix');
  assert.equal(recordingProfile({ ...fixed, readerCounts: [4, 0, 2] }), 'full-matrix');
});
test('eight readers form a separate complete twelve-case cohort', () => {
  assert.equal(recordingProfile({ ...fixed, readerCounts: [8] }), 'eight-reader-cohort');
  for (const kind of KINDS) validateCase({ kind, readers: 8, entries: 100000 });
});
test('mixed, incomplete, duplicate or reduced workloads are not chart cohorts', () => {
  for (const readerCounts of [[0, 2, 4, 8], [2, 4], [4, 8], [8, 8], []]) {
    assert.equal(recordingProfile({ ...fixed, readerCounts }), 'diagnostic');
  }
  for (const value of [{ entries: 1000 }, { trials: 1 }, { kinds: ['shared', 'native'] }, { kinds: ['shared', 'native', 'native', 'immer'] }]) {
    assert.equal(recordingProfile({ ...fixed, readerCounts: [8], ...value }), 'diagnostic');
  }
  for (const readers of [1, 6, 9]) assert.throws(() => validateCase({ kind: 'shared', readers, entries: 100000 }));
});
