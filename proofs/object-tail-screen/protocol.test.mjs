import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, GROUPS, campaign, chooseThree, summarize, summarizeGroup, aaDrift, aaEquivalent } from './protocol.mjs';
import { jsonHash } from './cached-object-read-protocol.mjs';
const sample = ms => {
  const fixture = { stable: true };
  return { fixture, fixtureDigest: jsonHash(fixture), opsPerSweep: 512, expectedPerSweep: 512,
    samples: Array.from({ length: 21 }, () => ({ ms })) };
};
const synthetic = (drift = 0) => campaign().map((r, i) => ({ ...r,
  result: sample(40 * Math.exp(i * drift) * ({ baseline: 1, original: 0.9, refinement: 0.8 }[r.role])) }));
const outcomes = () => campaign().map((r, ordinal) => ({ ...r, ordinal, valid: true }));
test('only three unchanged original cases, two comparisons and three source AA groups', () => {
  assert.deepEqual(CASES.map(c => c.id), ['map-object-512', 'map-number-512', 'map-string-512']);
  assert.equal(Object.keys(GROUPS).length, 5); assert.equal(campaign().length, 240);
  assert.deepEqual(campaign(), campaign());
  for (const spec of CASES) for (const group of Object.keys(GROUPS)) {
    const records = campaign().filter(r => r.workload === spec.id && r.group === group);
    assert.equal(records.length, 16);
    const orientations = [];
    for (let q = 0; q < 4; q++) {
      const part = records.filter(r => r.quartet === q);
      orientations.push(part.map(r => r.label).join(''));
      assert.deepEqual(part.map(r => r.position), [0, 1, 2, 3]);
      if (group.endsWith('-aa')) assert.equal(new Set(part.map(r => r.role)).size, 1);
    }
    assert.deepEqual(orientations.sort(), ['ABBA', 'ABBA', 'BAAB', 'BAAB']);
  }
});
test('quartets remain contiguous and both comparisons plus all AA occur in every cell round', () => {
  const plan = campaign();
  for (let i = 0; i < plan.length; i += 4) assert.ok(plan.slice(i, i + 4).every(r => r.workload === plan[i].workload && r.group === plan[i].group && r.quartet === plan[i].quartet));
  for (const spec of CASES) for (let q = 0; q < 4; q++) assert.equal(plan.filter(r => r.workload === spec.id && r.quartet === q).length, 20);
});
test('three-source calibration is one common maximum using unchanged original pair calibration', () => {
  const p = (sweeps, ms) => ({ phase: 'pilot', pilot: [{ sweeps, ms }] });
  assert.deepEqual(chooseThree([p(100, 40), p(200, 50), p(400, 100)]), { sweeps: 400, warmSweeps: 2000 });
  assert.throws(() => chooseThree([p(1, 40), p(1, 40)]));
  assert.throws(() => chooseThree([p(1, 40), p(1, 40), p(1, 39)]));
});
test('all ratios and AA recover under positive and negative linear log drift', () => {
  for (const drift of [0, 0.0001, -0.0001]) {
    const summary = summarize(synthetic(drift), outcomes());
    assert.equal(summary.focusedDiagnosticClear, true); assert.equal(summary.globalClearance, false);
    for (const cell of summary.cells) {
      assert.ok(Math.abs(cell.groups['baseline-refinement'].ratio - 0.8) < 1e-12);
      assert.ok(Math.abs(cell.groups['original-refinement'].ratio - 0.8 / 0.9) < 1e-12);
      for (const role of ['baseline', 'original', 'refinement']) assert.ok(Math.abs(cell.groups[role + '-aa'].ratio - 1) < 1e-12);
    }
  }
});
test('partial, duplicate and out-of-order schedules fail closed without discarding valid groups', () => {
  const records = synthetic(), validOutcomes = outcomes();
  records.splice(0, 1); validOutcomes[0].valid = false; validOutcomes[0].reason = 'synthetic failure';
  const summary = summarize(records, validOutcomes);
  assert.equal(summary.complete, false); assert.equal(summary.focusedDiagnosticClear, false);
  assert.ok(summary.cells.some(c => Object.values(c.groups).some(g => g.invalid)));
  assert.throws(() => summarize(synthetic(), outcomes().slice(1)));
  const subset = synthetic().filter(r => r.workload === CASES[0].id && r.group === 'baseline-refinement');
  subset[1] = subset[0]; assert.throws(() => summarizeGroup(subset, CASES[0].id, 'baseline-refinement'));
});
test('shared refinement AA drift invalidates both comparisons', () => {
  const records = synthetic();
  for (const r of records) if (r.group === 'refinement-aa' && r.label === 'B') r.result = sample(33.6);
  const summary = summarize(records, outcomes()); assert.equal(summary.focusedDiagnosticClear, false);
  for (const cell of summary.cells) for (const c of Object.values(cell.comparisons)) assert.equal(c.aaDrift, true);
});
test('AA conjunction and equivalence remain separate', () => {
  assert.equal(aaDrift({ ratio: 1.03, lower: 0.99, upper: 1.07 }), false);
  assert.equal(aaDrift({ ratio: 1.01, lower: 1.005, upper: 1.015 }), false);
  assert.equal(aaDrift({ ratio: 1.03, lower: 1.01, upper: 1.05 }), true);
  assert.equal(aaEquivalent({ lower: 0.99, upper: 1.01 }), true);
});
test('no point estimate or inconclusive control can clear concern', () => {
  const records = synthetic();
  for (const r of records) if (r.workload === 'map-number-512' && r.group === 'baseline-refinement' && r.label === 'B') r.result = sample(44);
  const summary = summarize(records, outcomes());
  assert.equal(summary.primitiveConcernsCleared, false); assert.equal(summary.focusedDiagnosticClear, false);
  assert.equal(summary.cells[1].comparisons.baseline.label, 'adverse');
});
