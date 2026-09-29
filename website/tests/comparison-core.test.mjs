import test from 'node:test';
import assert from 'node:assert/strict';
import { transferCounts, prefixColumns, validateMode } from '../assets/comparison-core.mjs';
import { generateColumns, appendNative } from '../assets/explorer-core.mjs';
test('incremental baseline clones only the delta while shared publication clones no events', () => {
  assert.equal(transferCounts({ total: 100000, initial: true }).native.clonedEvents, 200000);
  const update = transferCounts({ total: 102000, appended: 2000 });
  assert.equal(update.immutable.clonedEvents, 4000); assert.equal(update.native.clonedEvents, 4000); assert.equal(update.shared.clonedEvents, 0);
  assert.equal(transferCounts({ total: 102000, appended: 2000, mode: 'full' }).native.clonedEvents, 204000);
  assert.equal(transferCounts({ total: 102000, appended: 2000, frozen: true }).shared.publishedSnapshots, 0);
  assert.throws(() => transferCounts({ total: -1 })); assert.throws(() => validateMode('slow'));
});
test('Immutable.js replica counts match native for every replication mode and freeze state', () => {
  for (const mode of ['incremental', 'full']) for (const frozen of [false, true]) for (const initial of [false, true]) {
    const counts = transferCounts({ total: 3000, appended: 2000, mode, frozen, initial });
    assert.deepEqual(counts.immutable, counts.native);
  }
});
test('native append-only data can retain its original prefix too', () => {
  const data = generateColumns(0, 1000), retained = prefixColumns(data, 1000);
  appendNative(data, generateColumns(1000, 2000));
  assert.deepEqual(prefixColumns(data, 1000), retained); assert.equal(data.time.length, 3000);
  assert.throws(() => prefixColumns(data, 4000));
});
