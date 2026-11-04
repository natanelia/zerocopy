import assert from 'node:assert/strict';

/** Accept the historical four-case runner and the six-case publication runner. */
export function assertInvestigationReport(result) {
  const layouts = {
    'zerocopy-investigation-benchmark/v2': ['centralized', 'immutable', 'replicated', 'shared'],
    'zerocopy-investigation-benchmark/v3': ['centralized', 'immutable', 'immutable-full', 'replicated', 'replicated-full', 'shared'],
  };
  assert.ok(Object.hasOwn(layouts, result.schema), `Unknown investigation report schema: ${result.schema}`);
  const paths = layouts[result.schema], rounds = [0, 1, 2, 3, 4, 5, 6];
  assert.equal(result.config.samplesPerPath, rounds.length);
  assert.deepEqual([...result.config.paths].sort(), paths);
  assert.deepEqual(Object.keys(result.samples).sort(), paths);
  assert.equal(result.raw.length, paths.length * rounds.length);
  for (const path of paths) {
    const phases = result.samples[path], rows = result.raw.filter(row => row.path === path);
    assert.deepEqual(Object.keys(phases).sort(), ['initial', 'query', 'update']);
    assert.deepEqual(rows.map(row => row.round).sort((a, b) => a - b), rounds);
    for (const [phase, values] of Object.entries(phases)) {
      assert.equal(values.length, rounds.length);
      assert.ok(values.every(value => Number.isFinite(value) && value >= 0));
      for (const row of rows) assert.equal(row[`${phase}Ms`], values[row.round]);
    }
  }
}
