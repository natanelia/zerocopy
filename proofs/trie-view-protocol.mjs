import assert from 'node:assert/strict';

// Frozen before any pilot. These are work targets with explicit 4x batch and 3.33x warmup
// floor headroom; only the 10ms / 150ms floors decide timing validity.
export const CONFIG = Object.freeze({
  schemaVersion: 1, seed: 20261008, quartets: 4, samples: 21,
  pilotWarmupMs: 500, pilotWarmupMinCalls: 1024, pilotWarmupMaxMs: 15000,
  pilotCalibrationTargetMs: 40, pilotCalibrationSteps: 16, pilotSamples: 3,
  batchTargetMs: 40, warmupTargetMs: 500, rateSafetyFactor: 1,
  minBatchMs: 10, minWarmupMs: 150, maxRepeat: 10000000,
  maxWarmupCalls: 100000000, subjectTimeoutMs: 180000,
  margin: 1.02, confidenceLevel: 0.95, tCriticalDf3: 3.182446305284263,
});
export const MODES = Object.freeze([
  Object.freeze({ mode: 'ab', left: 'baseline', right: 'candidate' }),
  Object.freeze({ mode: 'aa-baseline', left: 'baseline', right: 'baseline' }),
]);
export const median = values => {
  assert(values.length && values.every(n => Number.isFinite(n) && n > 0));
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function randomSource(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
export function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function makeSchedule(random) {
  const all = Array.from({ length: CONFIG.quartets }, (_, block) => shuffle(MODES, random).map(mode => ({ ...mode, block, key: random() }))).flat();
  for (const { mode } of MODES) {
    const group = all.filter(p => p.mode === mode).sort((a, b) => a.key - b.key || a.block - b.block);
    group.forEach((p, i) => { p.roles = i < 2 ? ['left', 'right', 'right', 'left'] : ['right', 'left', 'left', 'right']; });
  }
  return all.map(({ key, ...rest }) => rest);
}
export function studyFor(cases) {
  const random = randomSource(CONFIG.seed);
  return { schemaVersion: 1, config: CONFIG, rows: shuffle(cases, random).map(workload => ({ workload,
    pilotOrder: shuffle(['baseline', 'candidate'], random), schedule: makeSchedule(random) })),
    measuredSubjects: cases.length * 32, measuredBatches: cases.length * 32 * CONFIG.samples,
    pilots: cases.length * 2, modes: MODES };
}
function positive(n, label) { assert(Number.isFinite(n) && n > 0, `Invalid ${label}`); }
function integer(n, max, label) { assert(Number.isSafeInteger(n) && n > 0 && n <= max, `Invalid ${label}`); }
export function validatePilot(pilot) {
  assert.equal(pilot.phase, 'pilot'); assert.equal(pilot.status, 'completed');
  assert(pilot.probes.length > 0 && pilot.probes.length <= CONFIG.pilotCalibrationSteps);
  assert.equal(pilot.prewarm.targetMs, CONFIG.pilotWarmupMs);
  positive(pilot.prewarm.elapsedMs, 'pilot warmup time'); integer(pilot.prewarm.operations, CONFIG.maxWarmupCalls, 'pilot warmup calls');
  assert.equal(typeof pilot.prewarm.capped, 'boolean');
  for (const probe of pilot.probes) {
    integer(probe.repeat, CONFIG.maxRepeat, 'pilot repeat');
    assert.equal(probe.samples.length, CONFIG.pilotSamples); probe.samples.forEach(ms => positive(ms, 'pilot batch'));
  }
  const estimate = Math.min(...pilot.probes.flatMap(probe => probe.samples.map(ms => ms / probe.repeat)));
  assert.equal(pilot.estimateMsPerOperation, estimate, 'Pilot rate must use fastest observed post-warmup sample');
  return estimate;
}
export function commonPlan(pilots) {
  assert.deepEqual(Object.keys(pilots).sort(), ['baseline', 'candidate']);
  const values = Object.values(pilots), fastest = Math.min(...values.map(validatePilot));
  assert.equal(values[0].expectedDigest, values[1].expectedDigest, 'Build workload outputs differ');
  const repeat = Math.ceil(CONFIG.batchTargetMs * CONFIG.rateSafetyFactor / fastest);
  const warmupOperations = Math.ceil((CONFIG.warmupTargetMs * CONFIG.rateSafetyFactor / fastest) / repeat) * repeat;
  const reasons = [];
  if (repeat > CONFIG.maxRepeat) reasons.push('repeat cap');
  if (warmupOperations > CONFIG.maxWarmupCalls) reasons.push('warmup work cap');
  for (const [build, p] of Object.entries(pilots)) {
    const last = p.probes.at(-1);
    if (p.prewarm.capped || p.prewarm.elapsedMs < CONFIG.pilotWarmupMs || p.prewarm.operations < CONFIG.pilotWarmupMinCalls) reasons.push(`${build} pilot warmup`);
    if (Math.min(...last.samples) < CONFIG.pilotCalibrationTargetMs) reasons.push(`${build} pilot calibration cap`);
    if (p.flags?.length) reasons.push(...p.flags.map(flag => `${build}: ${flag}`));
  }
  return { repeat, warmupOperations, fastestPilotMsPerOperation: fastest,
    expectedDigest: values[0].expectedDigest, validityReasons: reasons, valid: reasons.length === 0 };
}
export function validateMeasured(subject, plan) {
  assert.equal(subject.phase, 'measure'); assert.equal(subject.status, 'completed');
  integer(subject.repeat, CONFIG.maxRepeat, 'measured repeat'); assert.equal(subject.repeat, plan.repeat);
  assert.equal(subject.prescribedWarmupOperations, plan.warmupOperations);
  assert.equal(subject.expectedDigest, plan.expectedDigest); assert.equal(subject.samples.length, CONFIG.samples);
  subject.samples.forEach(ms => positive(ms, 'measured batch'));
  assert.equal(subject.warmup.operations, plan.warmupOperations, 'Fixed warmup work changed');
  assert.equal(subject.warmup.operations, subject.warmup.batches.reduce((sum, b) => sum + b.repeat, 0));
  assert.equal(subject.warmup.elapsedMs, subject.warmup.batches.reduce((sum, b) => sum + b.ms, 0));
  subject.warmup.batches.forEach(b => { integer(b.repeat, plan.repeat, 'warmup batch work'); positive(b.ms, 'warmup batch time'); });
  return [...(subject.flags ?? []), ...(subject.samples.some(ms => ms < CONFIG.minBatchMs) ? ['batch below floor'] : []),
    ...(subject.warmup.elapsedMs < CONFIG.minWarmupMs ? ['warmup below floor'] : [])];
}
export function logInterval(logs) {
  assert(logs.length <= CONFIG.quartets && logs.every(Number.isFinite));
  if (!logs.length) return { quartets: 0, geometricMean: null, lower: null, upper: null, classification: 'inconclusive' };
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  if (logs.length !== CONFIG.quartets) return { quartets: logs.length, geometricMean: Math.exp(mean), lower: null, upper: null, classification: 'inconclusive' };
  const variance = logs.reduce((sum, n) => sum + (n - mean) ** 2, 0) / 3;
  const half = CONFIG.tCriticalDf3 * Math.sqrt(variance / 4), lower = Math.exp(mean - half), upper = Math.exp(mean + half);
  return { quartets: 4, degreesOfFreedom: 3, confidenceLevel: CONFIG.confidenceLevel, margin: CONFIG.margin,
    geometricMean: Math.exp(mean), lower, upper,
    classification: lower > CONFIG.margin ? 'detected material loss' : upper <= CONFIG.margin ? 'evidence within margin' : 'inconclusive' };
}
export function hasControlDrift(interval) {
  return interval.quartets === CONFIG.quartets && (interval.geometricMean < 1 / CONFIG.margin || interval.geometricMean > CONFIG.margin)
    && (interval.lower > 1 || interval.upper < 1);
}
export function summarize(row) {
  const summary = {};
  for (const mode of MODES) {
    const blocks = row.blocks.filter(b => b.mode === mode.mode && b.subjects.length === 4);
    const logs = [], pairs = [], flags = [...(row.plan?.validityReasons ?? [])];
    for (const block of blocks) {
      const local = [];
      for (const subject of block.subjects) flags.push(...validateMeasured(subject, row.plan));
      for (let index = 0; index < 4; index += 2) {
        const pair = block.subjects.slice(index, index + 2), left = pair.find(p => p.role === 'left'), right = pair.find(p => p.role === 'right');
        assert(left && right, 'Quartet lost role balance');
        const leftMs = median(left.samples) / left.repeat, rightMs = median(right.samples) / right.repeat;
        pairs.push({ block: block.block, pair: index / 2, leftMs, rightMs, latencyRatio: rightMs / leftMs }); local.push(Math.log(rightMs / leftMs));
      }
      logs.push((local[0] + local[1]) / 2);
    }
    summary[mode.mode] = { leftBuild: mode.left, rightBuild: mode.right, pairs, quartetLogLatencyRatios: logs, interval: logInterval(logs),
      leftMedianMs: pairs.length ? median(pairs.map(p => p.leftMs)) : null, rightMedianMs: pairs.length ? median(pairs.map(p => p.rightMs)) : null,
      validityReasons: [...new Set(flags)] };
  }
  const drift = hasControlDrift(summary['aa-baseline'].interval);
  const anyFlags = Object.values(summary).some(s => s.validityReasons.length || s.interval.quartets !== CONFIG.quartets);
  for (const value of Object.values(summary)) {
    value.controlDrift = drift; value.inferenceUsable = !drift && !anyFlags;
    value.conclusion = drift ? 'control-drift-inconclusive' : anyFlags ? 'invalid-or-incomplete' : value.interval.classification;
  }
  return summary;
}
export function gateStatus(record, cases) {
  if (record.status !== 'completed' || record.rows.length !== cases.length) return 'incomplete';
  let gain = false;
  for (const row of record.rows) {
    const s = row.summary;
    if (s['aa-baseline'].controlDrift) return 'control-drift-inconclusive';
    if (!s.ab.inferenceUsable || !s['aa-baseline'].inferenceUsable) return 'invalid-or-incomplete';
  }
  if (record.rows.some(row => row.summary.ab.interval.classification === 'detected material loss')) return 'detected-material-loss';
  if (record.rows.some(row => row.summary.ab.interval.classification !== 'evidence within margin')) return 'statistical-inconclusive';
  gain = record.rows.some(row => row.workload.target && row.summary.ab.interval.upper < 1);
  return gain ? 'x64-screen-within-margin-with-target-gain' : 'within-margin-without-established-target-gain';
}
