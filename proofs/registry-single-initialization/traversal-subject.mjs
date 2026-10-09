import assert from 'node:assert/strict';
import { modules, fixture, runSubject } from './common.mjs';

await runSubject(async ({ root, role, mode, count, copy }) => {
  assert.equal(mode, 'attach');
  const { Arena, S } = await modules(root);
  const setup = fixture(S, count, copy);
  let dependencySetCalls = 0, arenaValuesYielded = 0;
  const originalSet = Map.prototype.set, originalValues = Map.prototype.values;
  let attached;
  Map.prototype.set = function (key, value) {
    if (value instanceof Arena) dependencySetCalls++;
    return originalSet.call(this, key, value);
  };
  try { attached = await S.initWorker(setup.data); }
  finally { Map.prototype.set = originalSet; }
  Map.prototype.values = function* () {
    for (const value of originalValues.call(this)) {
      if (value instanceof Arena) arenaValuesYielded++;
      yield value;
    }
  };
  try { assert.equal(S.getWorkerData(attached, { copy }).arenas.length, count); }
  finally { Map.prototype.values = originalValues; }
  const expected = role === 'main' ? count * count : count;
  assert.equal(dependencySetCalls, expected);
  assert.equal(arenaValuesYielded, expected);
  assert.equal(Map.prototype.set, originalSet);
  assert.equal(Map.prototype.values, originalValues);
  return { metric: 'Map-prototype-operations-containing-Arena-values', dependencySetCalls, arenaValuesYielded,
    note: 'Separate fresh process with unmodified dist. These traversal counts are not Map allocations or settled Map counts.' };
});
