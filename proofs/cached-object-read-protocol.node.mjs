import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, SETTINGS, campaign, schedule, chooseWork, decide, interval, jsonHash, median, sameWork, summarizeCell, verifySubject } from './cached-object-read-protocol.mjs';

function result(ms = 40) {
  const fixture = { deterministic: true };
  return { schema: 1, workload: CASES[0].id, phase: 'measure',
    runtime: { name: 'node', version: SETTINGS.node, arch: 'x64' },
    packageDigest: 'package', fixture, fixtureDigest: jsonHash(fixture), postFixtureDigest: jsonHash(fixture),
    opsPerSweep: 512, expectedPerSweep: 512, sweeps: 100,
    warm: { sweeps: 1500, sink: 768000, ms: 500 },
    samples: Array.from({ length: 21 }, () => ({ sweeps: 100, sink: 51200, ms })) };
}
function expectation() { return { runtime: 'node', workload: CASES[0].id, phase: 'measure', packageDigest: 'package', sweeps: 100, warmSweeps: 1500 }; }
function records(factor = 0.8, drift = 0) {
  return schedule('node', CASES[0].id).map((entry, i) => ({ ...entry,
    result: result(40 * Math.exp(drift * i) * (entry.group === 'ab' && entry.label === 'B' ? factor : 1)) }));
}
test('prospective screen is four targets and eight controls, including both independent cache pressures', () => {
  assert.equal(CASES.length, 12);
  assert.equal(CASES.filter(c => c.target).length, 4);
  assert.equal(CASES.filter(c => c.addressSaturated).length, 1);
  assert.equal(CASES.filter(c => c.saturated).length, 1);
});
test('seeded schedule has exactly 48 fresh subjects per cell and 1152 total', () => {
  const plan = campaign();
  assert.deepEqual(plan, campaign());
  assert.equal(plan.length, 1152);
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const s = schedule(runtime, spec.id);
    assert.equal(s.length, 48);
    for (const group of ['ab', 'baseline-aa', 'candidate-aa']) {
      const subset = s.filter(c => c.group === group);
      assert.equal(subset.length, 16);
      const labels = [];
      for (let q = 0; q < 4; q++) {
        const quartet = subset.filter(c => c.quartet === q);
        assert.deepEqual(quartet.map(c => c.position), [0, 1, 2, 3]);
        labels.push(quartet.map(c => c.label).join(''));
        if (group !== 'ab') assert.equal(new Set(quartet.map(c => c.role)).size, 1);
      }
      assert.deepEqual(labels.sort(), ['ABBA', 'ABBA', 'BAAB', 'BAAB']);
    }
  }
  for (let i = 0; i < plan.length; i += 4) {
    const quartet = plan.slice(i, i + 4);
    assert.ok(quartet.every(c => c.runtime === quartet[0].runtime && c.workload === quartet[0].workload
      && c.group === quartet[0].group && c.quartet === quartet[0].quartet));
  }
});
test('pilot calibration chooses common work prospectively for both roles', () => {
  const p = (sweeps, ms) => ({ phase: 'pilot', pilot: [{ sweeps, ms, sink: 0 }] });
  assert.deepEqual(chooseWork([p(100, 40), p(200, 50)]), { sweeps: 200, warmSweeps: 2000 });
  assert.throws(() => chooseWork([p(100, 39), p(200, 50)]));
  assert.throws(() => chooseWork([p(100, 40)]));
});
test('strict complete record validation catches mismatched source, work and fixture', () => {
  assert.equal(verifySubject(result(), expectation()).samples.length, 21);
  for (const change of [
    r => { r.packageDigest = 'other'; },
    r => { r.sweeps++; },
    r => { r.samples[0].sweeps++; },
    r => { r.samples[0].sink++; },
    r => { r.samples.pop(); },
    r => { r.runtime.version = 'wrong'; },
    r => { r.fixture.deterministic = false; },
    r => { r.postFixtureDigest = 'mutated'; },
  ]) {
    const r = result(); change(r);
    assert.throws(() => verifySubject(r, expectation()));
  }
});
test('every sample and fixed warmup must clear floors; no exclusion', () => {
  for (const change of [
    r => { r.samples[0].ms = 9.999; },
    r => { r.samples[0].ms = NaN; },
    r => { r.samples[0].ms = Infinity; },
    r => { r.warm.ms = 149.999; },
  ]) { const r = result(); change(r); assert.throws(() => verifySubject(r, expectation())); }
  const r = result(10); r.warm.ms = 150;
  verifySubject(r, expectation());
});
test('same-work comparison rejects descriptor/byte identity changes', () => {
  const a = result(), b = result();
  sameWork(a, b);
  b.fixture.deterministic = false;
  assert.throws(() => sameWork(a, b));
});
test('within-subject median requires all 21 samples', () => {
  assert.equal(median(Array.from({ length: 21 }, (_, i) => i + 1)), 11);
  assert.throws(() => median([1, 2]));
});
test('four-quartet log estimator recovers ratio under linear log drift', () => {
  for (const drift of [0, 0.001, -0.001]) {
    const summary = summarizeCell(records(0.8, drift));
    assert.ok(Math.abs(summary.ab.ratio - 0.8) < 1e-12);
    assert.ok(Math.abs(summary['baseline-aa'].ratio - 1) < 1e-12);
    assert.ok(Math.abs(summary['candidate-aa'].ratio - 1) < 1e-12);
    assert.equal(summary.ab.df, 3);
  }
});
test('reference t interval and empty/partial quartets fail closed', () => {
  const got = interval([-0.03, -0.01, 0.01, 0.03]);
  const half = 3.182446305284263 * Math.sqrt((0.0009 + 0.0001 + 0.0001 + 0.0009) / 3 / 4);
  assert.ok(Math.abs(got.lower - Math.exp(-half)) < 1e-14);
  assert.ok(Math.abs(got.upper - Math.exp(half)) < 1e-14);
  assert.throws(() => interval([0, 0, 0]));
  assert.throws(() => summarizeCell(records().slice(1)));
  const duplicate = records(); duplicate[1] = duplicate[0];
  assert.throws(() => summarizeCell(duplicate));
});
test('AA drift follows point outside margin AND interval excludes one', () => {
  const r = records(0.8);
  for (const item of r) if (item.group === 'baseline-aa' && item.label === 'B') item.result = result(41.2);
  const summary = summarizeCell(r);
  assert.equal(summary.aaAdverse, true);
  assert.equal(summary.aaEquivalent, false);
});
test('strong clear, scoped exploratory gain, uncertainty and adverse intervals stay distinct', () => {
  const good = summarizeCell(records(0.8));
  const cells = ['node', 'bun'].flatMap(runtime => CASES.map(spec => ({ runtime, workload: spec.id, summary: structuredClone(good) })));
  assert.equal(decide(cells).strongClear, true);
  cells[4].summary.abClear = false;
  cells[4].summary.ab.upper = 1.1;
  assert.equal(decide(cells).strongClear, false);
  assert.ok(decide(cells).scopedGains.length > 0);
  cells[4].summary.abAdverse = true;
  assert.equal(decide(cells).scopedGains.length, 0);
  assert.equal(decide(cells).anyAdverse, true);
});

test('AA evidence that meets only one drift condition does not invalidate', () => {
  for (const logs of [
    Array(4).fill(Math.log(1.01)),
    [-0.07, 0.13, -0.07, 0.13],
  ]) {
    const r = records(0.8);
    for (const item of r) if (item.group === 'baseline-aa' && item.label === 'B') {
      item.result = result(40 * Math.exp(logs[item.quartet]));
    }
    assert.equal(summarizeCell(r).aaAdverse, false);
  }
});
test('AA equivalence is an extra label and does not erase a scoped gain', () => {
  const good = summarizeCell(records(0.8));
  const cells = ['node', 'bun'].flatMap(runtime => CASES.map(spec => ({ runtime, workload: spec.id, summary: structuredClone(good) })));
  cells[0].summary.aaEquivalent = false;
  assert.equal(decide(cells).strongClear, true);
  assert.equal(decide(cells).aaEquivalenceClear, false);
  assert.ok(decide(cells).scopedGains.includes('node/' + CASES[0].id));
});
