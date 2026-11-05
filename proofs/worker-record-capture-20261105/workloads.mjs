import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'worker-record-capture-20261105',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['worker-protocol.ts'],
  aaCases: ['publish-record-128', 'publish-single'],
  cases: [
    { name: 'publish-record-512', role: 'wide changed-record target', kind: 'publish', size: 512, repetitions: 16 },
    { name: 'publish-record-128', role: 'changed-record target', kind: 'publish', size: 128, repetitions: 64 },
    { name: 'publish-same-record-128', role: 'unchanged record target', kind: 'publish', same: true, size: 128, repetitions: 64 },
    { name: 'publish-frozen-record-128', role: 'frozen changed-record target', kind: 'publish', frozen: true, size: 128, repetitions: 64 },
    { name: 'create-record-128', role: 'complete state creation target', kind: 'create', size: 128, repetitions: 64 },
    { name: 'update-key-record-128', role: 'complete named-key update target', kind: 'update', size: 128, repetitions: 64 },
    { name: 'publish-small-record-4', role: 'small-record boundary', kind: 'publish', size: 4, repetitions: 1024 },
    { name: 'publish-empty-record', role: 'empty-record boundary', kind: 'publish', size: 0, repetitions: 8192 },
    { name: 'publish-single', role: 'unchanged single-collection path control', kind: 'single', size: 1, repetitions: 2048 },
    { name: 'worker-data-record-128', role: 'unchanged worker-data capture control', kind: 'worker-data', size: 128, repetitions: 128 },
  ],
};

const digest = value => createHash('sha256').update(value).digest('hex');

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const W = await import(pathToFileURL(join(directory, 'dist/worker.js')));
  const keys = Array.from({ length: spec.size }, (_, i) => `collection-${i}`);
  const first = Object.create(null), second = Object.create(null);
  const snapshots = [];
  // Distinct snapshots share a bounded arena; fixture writes are not timed.
  // Half the named collections are maps and half lists, as in columnar UI state.
  for (let i = 0; i < spec.size; i++) {
    const value = i % 2
      ? new S.SharedList('number').pushMany([i, i + 0.25, -i])
      : new S.SharedMap('number').setMany([['value', i], ['other', i + 0.5]]);
    first[keys[i]] = second[keys[i]] = value;
    snapshots.push(value);
  }
  const oldMap = spec.size ? first[keys[0]] : new S.SharedMap('number').set('value', 0);
  const newMap = oldMap.set('value', -1);
  if (spec.size) second[keys[0]] = newMap;
  snapshots.push(oldMap, newMap);
  const inputA = spec.frozen ? Object.freeze({ ...first }) : { ...first };
  const inputB = spec.frozen ? Object.freeze({ ...second }) : { ...second };
  const source = Object.fromEntries(snapshots.map((value, i) => [`source-${i}`, value]));
  const original = S.getWorkerData(source, { copy: true });
  const expectedWorkerData = spec.kind === 'worker-data' ? S.getWorkerData(inputA, { copy: false }) : undefined;
  const initial = spec.kind === 'single' ? oldMap : inputA;
  const state = W.createSharedState(initial, { copy: false, publish: { strategy: 'immediate' } });
  let calls = 0;
  const expectedValues = keys.map((key, i) => [key, i % 2 ? ['list', [i, i + 0.25, -i]] : ['map', [['value', i], ['other', i + 0.5]]]]);
  const verifyRecord = value => {
    assert.ok(Object.isFrozen(value));
    assert.equal(Object.getPrototypeOf(value), null);
    assert.deepEqual(Object.keys(value), keys);
    const reference = spec.size && value[keys[0]] === newMap ? second : first;
    for (const key of keys) assert.strictEqual(value[key], reference[key]);
  };
  return {
    operation() {
      calls++;
      if (spec.kind === 'create') return W.createSharedState(inputA, { copy: false, publish: { strategy: 'immediate' } });
      if (spec.kind === 'worker-data') return S.getWorkerData(inputA, { copy: false });
      if (spec.kind === 'single') state.publish(calls % 2 ? newMap : oldMap);
      else if (spec.kind === 'update') state.update(keys[0], () => calls % 2 ? newMap : oldMap);
      else state.publish(spec.same || calls % 2 === 0 ? inputA : inputB);
      return state.current;
    },
    verify(result) {
      if (spec.kind === 'single') {
        assert.ok(result === oldMap || result === newMap);
        assert.ok(Object.isFrozen(result));
      } else if (spec.kind === 'create') {
        assert.equal(result.version, 0); assert.equal(result.closed, false);
        verifyRecord(result.current); result.dispose(); assert.equal(result.closed, true);
      } else if (spec.kind === 'worker-data') {
        assert.deepEqual(result, expectedWorkerData);
        assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.structures));
        assert.ok(Object.isFrozen(result.arenas));
      } else verifyRecord(result);
    },
    checkInvariant() {
      const current = S.getWorkerData(source, { copy: true });
      assert.deepEqual(current, original);
      assert.equal(state.version, ['create', 'worker-data'].includes(spec.kind) || spec.same || spec.size === 0 ? 0 : calls);
      assert.deepEqual(Object.keys(inputA), keys); assert.deepEqual(Object.keys(inputB), keys);
      for (const key of keys) {
        assert.strictEqual(inputA[key], first[key]); assert.strictEqual(inputB[key], second[key]);
      }
      assert.equal(Object.isFrozen(inputA), !!spec.frozen);
      assert.equal(Object.isFrozen(inputB), !!spec.frozen);
    },
    expectedDigest: digest(JSON.stringify({ keys, expectedValues, secondFirst: -1, kind: spec.kind, same: !!spec.same })),
    fixture: { kind: spec.kind, size: spec.size, frozen: !!spec.frozen, same: !!spec.same,
      names: keys, sourceArenaBytes: original.arenas.map(arena => arena.used),
      writes: 'prebuilt; only first collection changes between two retained snapshots',
      reads: 'publish/update include current getter; creation disposal is outside timing' },
  };
}
