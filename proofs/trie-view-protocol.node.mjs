import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, studyFor, commonPlan, validatePilot, validateMeasured, summarize, logInterval, hasControlDrift, gateStatus } from './trie-view-protocol.mjs';
const copy = value => structuredClone(value);
const cases = Array.from({ length: 20 }, (_, i) => ({ name: `case-${i}`, target: i >= 14 }));
const pilot = (rate = 1) => ({ phase: 'pilot', status: 'completed', expectedDigest: 'same',
  prewarm: { targetMs: 500, elapsedMs: 500, operations: 1024, capped: false },
  probes: [{ repeat: 40, samples: [40 * rate, 44 * rate, 48 * rate] }], estimateMsPerOperation: rate, flags: [] });
const measured = (plan, rate = 1) => ({ phase: 'measure', status: 'completed', expectedDigest: plan.expectedDigest,
  repeat: plan.repeat, prescribedWarmupOperations: plan.warmupOperations,
  warmup: { operations: plan.warmupOperations, elapsedMs: 500, batches: [{ repeat: plan.warmupOperations, ms: 500 }] },
  samples: Array(21).fill(plan.repeat * rate), flags: [] });
function subject(plan, rate) {
  const result = measured(plan, rate); result.warmup.batches = Array.from({ length: plan.warmupOperations / plan.repeat }, () => ({ repeat: plan.repeat, ms: 500 / (plan.warmupOperations / plan.repeat) }));
  result.warmup.elapsedMs = result.warmup.batches.reduce((sum, b) => sum + b.ms, 0); return result;
}
function row(ratio = 1, aaRatio = 1) {
  const planned = studyFor(cases).rows[0], pilots = { baseline: pilot(), candidate: pilot() }, plan = commonPlan(pilots);
  return { ...planned, pilots, plan, blocks: planned.schedule.map(block => ({ ...block, subjects: block.roles.map(role => ({
    ...subject(plan, role === 'left' ? 1 : block.mode === 'ab' ? ratio : aaRatio), role, build: block[role] })) })) };
}
test('protocol freezes40ms/500ms headroom and10ms/150ms floors with21 batches', () => {
  assert.equal(CONFIG.pilotCalibrationTargetMs, 40); assert.equal(CONFIG.batchTargetMs, 40); assert.equal(CONFIG.warmupTargetMs, 500);
  assert.equal(CONFIG.rateSafetyFactor, 1); assert.equal(CONFIG.minBatchMs, 10); assert.equal(CONFIG.minWarmupMs, 150); assert.equal(CONFIG.samples, 21);
});
test('seeded20-cell study has four balanced quartets per AB/baselineAA before pilots', () => {
  const study = studyFor(cases); assert.deepEqual(study, studyFor(cases)); assert.equal(study.measuredSubjects, 640); assert.equal(study.measuredBatches, 13440);
  for (const row of study.rows) for (const mode of ['ab', 'aa-baseline']) {
    const blocks = row.schedule.filter(b => b.mode === mode); assert.equal(blocks.length, 4);
    assert.equal(blocks.filter(b => b.roles.join('') === 'leftrightrightleft').length, 2);
    assert.equal(blocks.filter(b => b.roles.join('') === 'rightleftleftright').length, 2);
  }
});
test('common plan uses faster build, including fastest earlier post-warm sample', () => {
  const fast = pilot(0.25); fast.probes.push({ repeat: 200, samples: [50, 60, 70] });
  const plan = commonPlan({ baseline: pilot(2), candidate: fast }); assert.equal(plan.repeat, 160); assert.equal(plan.warmupOperations, 2080); assert(plan.valid);
  fast.estimateMsPerOperation = 0.26; assert.throws(() => validatePilot(fast), /fastest observed/);
});
test('pilot terminal undershoot/cap invalidates and never adds measured work', () => {
  const p = pilot(); p.probes[0].samples = [39, 40, 40]; p.estimateMsPerOperation = 39 / 40;
  const plan = commonPlan({ baseline: p, candidate: pilot() }); assert.equal(plan.valid, false); assert(plan.validityReasons.some(r => r.includes('calibration cap')));
  const tiny = pilot(0.00000001); tiny.probes.push({ repeat: 10000000, samples: [0.1, 0.2, 0.3] });
  assert.equal(commonPlan({ baseline: tiny, candidate: tiny }).valid, false);
});
test('pilot checks reject output mismatch, missing probe, bogus rate and short samples', () => {
  const wrong = pilot(); wrong.expectedDigest = 'different'; assert.throws(() => commonPlan({ baseline: pilot(), candidate: wrong }));
  const empty = pilot(); empty.probes = []; assert.throws(() => validatePilot(empty));
  const short = pilot(); short.probes[0].samples.pop(); assert.throws(() => validatePilot(short));
});
test('all21 batches and identical fixed warmup are required; floors only flag', () => {
  const plan = commonPlan({ baseline: pilot(), candidate: pilot() }), s = subject(plan, 1); assert.deepEqual(validateMeasured(s, plan), []);
  s.samples[0] = 9.99; assert(validateMeasured(s, plan).includes('batch below floor')); assert.equal(s.samples.length, 21);
  const short = copy(s); short.samples.pop(); assert.throws(() => validateMeasured(short, plan));
  const added = copy(s); added.warmup.operations++; assert.throws(() => validateMeasured(added, plan));
});
test('quartets, not pairs or batches, determine df3 Student-t intervals', () => {
  const values = [0, 0.01, 0.02, 0.03], interval = logInterval(values);
  const mean = 0.015, variance = values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 3;
  assert.equal(interval.degreesOfFreedom, 3); assert.equal(interval.lower, Math.exp(mean - CONFIG.tCriticalDf3 * Math.sqrt(variance / 4)));
  assert.equal(logInterval(values.slice(0, 3)).lower, null); assert.throws(() => logInterval([0, 0, 0, 0, 0]));
});
test('AA drift uses point outside band plus CI excluding1, not CI outside band', () => {
  assert(hasControlDrift({ quartets: 4, geometricMean: 1.025, lower: 1.005, upper: 1.046 }));
  assert(hasControlDrift({ quartets: 4, geometricMean: 0.975, lower: 0.95, upper: 0.999 }));
  assert(!hasControlDrift({ quartets: 4, geometricMean: 1.01, lower: 1.001, upper: 1.019 }));
  assert(!hasControlDrift({ quartets: 4, geometricMean: 1.025, lower: 0.999, upper: 1.05 }));
});
test('AA drift invalidates AB without normalization; control floors invalidate row', () => {
  const r = row(0.8, 1.03), s = summarize(r); assert.equal(s.ab.interval.geometricMean, 0.8); assert.equal(s.ab.conclusion, 'control-drift-inconclusive');
  const low = row(); low.blocks.find(b => b.mode === 'aa-baseline').subjects[0].samples[0] = 9;
  assert.equal(summarize(low).ab.inferenceUsable, false);
});
test('loss, within margin and inconclusive are disjoint; no tradeoff or automatic acceptance', () => {
  assert.equal(logInterval(Array(4).fill(Math.log(1.03))).classification, 'detected material loss');
  assert.equal(logInterval(Array(4).fill(Math.log(1.01))).classification, 'evidence within margin');
  assert.equal(logInterval([Math.log(0.9), Math.log(1.1), 0, 0]).classification, 'inconclusive');
  const r = row(0.9); r.workload.target = true; r.summary = summarize(r);
  assert.equal(gateStatus({ status: 'completed', rows: [r] }, [r.workload]), 'x64-screen-within-margin-with-target-gain');
  const uncertain = row(); uncertain.blocks.filter(b => b.mode === 'ab')[0].subjects[0].samples.fill(20); uncertain.summary = summarize(uncertain);
  assert.equal(gateStatus({ status: 'completed', rows: [r, uncertain] }, [r.workload, uncertain.workload]), 'statistical-inconclusive');
});
