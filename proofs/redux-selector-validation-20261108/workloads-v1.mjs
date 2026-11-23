import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'redux-selector-validation-20261108',
  baseline: '0ac8a005268335a6116f025e75f670b5cee6843e',
  changedSources: ['redux.ts'],
  pilotCases: ['same-map-number', 'same-map-object', 'same-map-rotating-keys', 'different-map-control', 'different-arena-control', 'new-selector-control'],
  aaCases: ['same-map-number', 'different-map-control'],
  cases: [
    { name: 'same-map-number', role: 'target', mode: 'fixed', type: 'number', count: 8192, calls: 1, repetitions: 131072 },
    { name: 'same-map-object', role: 'target', mode: 'fixed', type: 'object', count: 8192, calls: 1, repetitions: 131072 },
    { name: 'same-map-missing-key', role: 'target', mode: 'missing', type: 'number', count: 8192, calls: 1, repetitions: 131072 },
    { name: 'same-map-rotating-keys', role: 'target', mode: 'keys', type: 'number', count: 8192, calls: 1, repetitions: 131072 },
    { name: 'component-selectors-256', role: 'target', mode: 'components', type: 'number', count: 8192, calls: 256, repetitions: 512 },
    { name: 'different-map-control', role: 'changed snapshot control', mode: 'snapshots', type: 'number', count: 8192, calls: 1, repetitions: 131072 },
    { name: 'different-arena-control', role: 'changed arena control', mode: 'arenas', type: 'number', count: 8192, calls: 1, repetitions: 131072 },
    { name: 'new-selector-control', role: 'single-use selector control', mode: 'new', type: 'number', count: 8192, calls: 1, repetitions: 131072 },
  ],
};

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const R = await import(pathToFileURL(join(directory, 'dist/redux.js')));
  const keys = Array.from({ length: spec.count }, (_, i) => `entity/${i}`);
  const input = keys.map((key, i) => [key, spec.type === 'object' ? { index: i, child: ['é', i % 3 === 0] } : i]);
  const source = S.compact(new S.SharedMap(spec.type).setMany(input));
  const second = spec.mode === 'arenas' ? S.compact(source) : source.set('unrelated', spec.type === 'object' ? { index: -1 } : -1);
  // Repeated unrelated state changes keep the selected immutable collection.
  // State objects and snapshots are prepared before the timed region.
  const changing = spec.mode === 'snapshots' || spec.mode === 'arenas';
  const states = Array.from({ length: 64 }, (_, revision) => ({ data: changing && revision % 2 ? second : source, revision }));
  const selectMap = state => state.data;
  const selectKey = (_state, key) => key;
  const select = R.createSharedMapEntrySelector(selectMap, selectKey);
  let cursor = 0;
  const selectedKey = keys[4095], selected = select(states[0], selectedKey);
  const expectedValue = spec.type === 'object' ? selected.index : selected;
  assert.equal(expectedValue, 4095);
  let operation, expected;
  if (spec.mode === 'keys') {
    // Every key resolves to its independent native oracle value. Subtracting
    // that value makes the output constant while still consuming every read.
    operation = () => {
      const i = cursor++ & 255;
      return select(states[i & 63], keys[i]) - i;
    };
    expected = 0;
  } else if (spec.mode === 'components') {
    const selectors = Array.from({ length: spec.calls }, (_, i) => R.createSharedMapValueSelector(selectMap, () => keys[i]));
    operation = () => {
      const state = states[cursor++ & 63];
      let sum = 0;
      for (let i = 0; i < selectors.length; i++) sum += selectors[i](state);
      return sum;
    };
    expected = spec.calls * (spec.calls - 1) / 2;
  } else if (spec.mode === 'new') {
    operation = () => R.createSharedMapEntrySelector(selectMap, selectKey)(states[cursor++ & 63], selectedKey);
    expected = 4095;
  } else if (spec.mode === 'missing') {
    operation = () => select(states[cursor++ & 63], 'not-present');
    expected = undefined;
  } else {
    operation = () => {
      const result = select(states[cursor++ & 63], selectedKey);
      return spec.type === 'object' ? result.index : result;
    };
    expected = 4095;
  }
  const retained = { source, second };
  const packet = S.getWorkerData(retained, { copy: true });
  const shared = S.getWorkerData(retained, { copy: false });
  const descriptors = Object.values(retained).map(map => map.toWorkerData());
  const oracle = { result: expected === undefined ? ['undefined'] : expected, entries: input };
  return {
    operation,
    verify(result) { assert.equal(result, expected); },
    expectedDigest: createHash('sha256').update(JSON.stringify(oracle)).digest('hex'),
    checkInvariant() {
      assert.deepEqual(Object.values(retained).map(map => map.toWorkerData()), descriptors);
      const current = S.getWorkerData(retained, { copy: false });
      assert.deepEqual(current.arenas.map(arena => arena.used), packet.arenas.map(arena => arena.used));
      for (let i = 0; i < packet.arenas.length; i++) {
        assert.deepEqual(new Uint8Array(shared.arenas[i].memory.buffer, 0, packet.arenas[i].used), packet.arenas[i].copy);
      }
      assert.equal(source.size, spec.count);
      for (let i = 0; i < input.length; i++) assert.deepEqual(source.get(keys[i]), input[i][1]);
      assert.deepEqual(select(states[0], selectedKey), input[4095][1]);
      assert.ok(Object.isFrozen(source));
    },
    fixture: {
      type: spec.type, size: spec.count, callsPerOperation: spec.calls,
      stateCount: states.length, mode: spec.mode, selectedIndex: 4095,
      usedBytes: packet.arenas.map(arena => arena.used),
      oracle: 'native input values; complete retained snapshot and backing-byte verification after each batch',
    },
  };
}
