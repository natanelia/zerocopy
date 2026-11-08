import assert from 'node:assert/strict';

export const cases = [
  { name: 'create-distinct-1024', operation: 'create', fields: 1024, alias: false },
  { name: 'publish-distinct-1024', operation: 'publish', fields: 1024, alias: false },
  { name: 'create-alias-1024', operation: 'create', fields: 1024, alias: true },
  { name: 'publish-alias-noop-1024', operation: 'noop', fields: 1024, alias: true },
  { name: 'create-distinct-32', operation: 'create', fields: 32, alias: false },
  { name: 'publish-distinct-1', operation: 'publish', fields: 1, alias: false },
  { name: 'create-record-1', operation: 'create', fields: 1, alias: false },
  { name: 'create-single-snapshot', operation: 'create', fields: 1, alias: false, single: true },
];

export function createWorkload(api, worker, spec) {
  api.resetMap();
  const base = new api.SharedMap('number').set('value', 1);
  const keys = Array.from({ length: spec.fields }, (_, i) => `field-${i}`);
  const maps = keys.map((_, i) => spec.alias ? base : base.set('value', i + 1));
  const recordA = Object.fromEntries(keys.map((key, i) => [key, maps[i]]));
  const replacement = maps.at(-1).set('value', spec.fields + 100);
  const recordB = { ...recordA };
  if (spec.operation !== 'noop') recordB[keys.at(-1)] = replacement;
  const sourceA = spec.single ? base : recordA, sourceB = spec.single ? replacement : recordB;
  const payload = api.getWorkerData({ ...recordA, replacement }, { copy: false });
  const arena = payload.arenas[0];
  assert.equal(payload.arenas.length, 1);
  const bytes = new Uint8Array(arena.memory.buffer).slice();
  const descriptors = maps.map(map => map.toWorkerData());
  const options = { copy: false, publish: { strategy: 'immediate' } };
  let state, initialCurrent, results, observed, observedVersions, notifications;

  function checkRecord(actual, expected) {
    if (spec.single) { assert.equal(actual, expected); return; }
    assert.equal(Object.getPrototypeOf(actual), null);
    assert.equal(Object.isFrozen(actual), true);
    assert.deepEqual(Object.keys(actual), keys);
    for (const key of keys) assert.equal(actual[key], expected[key]);
  }

  return {
    spec,
    setup(iterations) {
      state?.dispose();
      state = undefined;
      results = new Array(iterations);
      observed = new Array(iterations);
      observedVersions = new Array(iterations);
      notifications = 0;
      if (spec.operation !== 'create') {
        state = worker.createSharedState(sourceA, options);
        initialCurrent = state.current;
        state.subscribe((current, version) => {
          observed[notifications] = current;
          observedVersions[notifications++] = version;
        });
      }
    },
    run(iterations) {
      let checksum = 0;
      if (spec.operation === 'create') {
        for (let i = 0; i < iterations; i++) {
          const created = worker.createSharedState(sourceA, options);
          results[i] = created.current;
          checksum += created.version;
          created.dispose();
          checksum += Number(created.closed);
        }
      } else {
        for (let i = 0; i < iterations; i++) {
          checksum += state.publish(i & 1 ? sourceA : sourceB);
          results[i] = state.current;
        }
      }
      return checksum;
    },
    verify(checksum, iterations) {
      if (spec.operation === 'create') {
        assert.equal(checksum, iterations);
        for (const actual of results) checkRecord(actual, sourceA);
      } else if (spec.operation === 'noop') {
        assert.equal(checksum, 0); assert.equal(state.version, 0); assert.equal(notifications, 0);
        for (const actual of results) assert.equal(actual, initialCurrent);
        checkRecord(state.current, sourceA);
      } else {
        assert.equal(checksum, iterations * (iterations + 1) / 2);
        assert.equal(state.version, iterations); assert.equal(notifications, iterations);
        for (let i = 0; i < iterations; i++) {
          checkRecord(results[i], i & 1 ? sourceA : sourceB);
          assert.equal(observed[i], results[i]); assert.equal(observedVersions[i], i + 1);
        }
      }
      assert.deepEqual(new Uint8Array(arena.memory.buffer), bytes);
      for (let i = 0; i < maps.length; i++) {
        assert.equal(recordA[keys[i]], maps[i]);
        assert.deepEqual(maps[i].toWorkerData(), descriptors[i]);
        assert.equal(maps[i].get('value'), spec.alias ? 1 : i + 1);
      }
      assert.equal(replacement.get('value'), spec.fields + 100);
      assert.equal(Object.isFrozen(recordA), false); assert.equal(Object.isFrozen(recordB), false);
    },
    close() { state?.dispose(); },
  };
}
