import assert from 'node:assert/strict';
export const BASELINE = '3773c6e519c7c0958da13727ed1082f449f3ee25';
export const CANDIDATE = '4dea268e4c64acac832bb310efc83de597b27abc';
export const CANDIDATE_TREE = '6e180bc39a10866289816ba5aa6747b1adb18eae';
export const CONFIG = Object.freeze({ attempt: 1, runtimes: { node: '22.23.3', bun: '1.4.2' }, architecture: 'x64',
  quartets: 4, samples: 21, batchTargetMs: 40, batchFloorMs: 10, warmupTargetMs: 500, warmupFloorMs: 150,
  pilotWarmupLimitMs: 10000, repeatLimit: 10000000, subjectTimeoutMs: 120000, seed: 20261008,
  confidence: 0.95, df: 3, tCritical: 3.182446305284263, margin: 1.02, gainThreshold: 0.98 });
export const MODES = Object.freeze(['ab', 'aa-baseline']);
export const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
export function variation(values) {
  if (!values.length) return { n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length < 2 ? 0 : values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1);
  return { n: values.length, min: Math.min(...values), max: Math.max(...values), median: median(values), mean, variance, sd: Math.sqrt(variance), cv: Math.sqrt(variance) / mean };
}
export function randomSource(seed) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }; }
export function shuffle(values, random) { const out = [...values]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
export function makeSchedule(random) {
  const schedules = MODES.flatMap(mode => shuffle([['left', 'right', 'right', 'left'], ['left', 'right', 'right', 'left'],
    ['right', 'left', 'left', 'right'], ['right', 'left', 'left', 'right']], random).map((roles, block) => ({ mode, block, roles })));
  return Array.from({ length: CONFIG.quartets }, (_, i) => shuffle(schedules.filter(s => s.block === i), random)).flat();
}
export function interval(logs) {
  if (logs.length !== 4 || logs.some(x => !Number.isFinite(x))) return { quartets: logs.length, lower: null, upper: null, geometricMean: null, classification: 'incomplete' };
  const mean = logs.reduce((a, b) => a + b, 0) / 4;
  const variance = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 3;
  const half = CONFIG.tCritical * Math.sqrt(variance / 4), lower = Math.exp(mean - half), upper = Math.exp(mean + half);
  return { quartets: 4, geometricMean: Math.exp(mean), lower, upper, logVariance: variance, confidence: CONFIG.confidence, df: 3,
    classification: lower > CONFIG.margin ? 'material-loss' : upper < CONFIG.gainThreshold ? 'material-gain' : upper <= CONFIG.margin ? 'within-margin' : 'inconclusive' };
}
export function controlDrift(ci) { return ci.lower !== null && (ci.geometricMean < 1 / CONFIG.margin || ci.geometricMean > CONFIG.margin) && (ci.upper < 1 || ci.lower > 1); }
export function summarize(row) {
  const modes = {};
  const invalid = [...(row.invalid ?? [])];
  if (!row.plan) invalid.push('missing-common-plan');
  for (const mode of MODES) {
    const pairs = [], logs = [], batches = [], processLatencies = [];
    for (const block of row.blocks.filter(b => b.mode === mode)) {
      if (block.subjects.length !== 4 || block.subjects.some(s => s.status !== 'passed')) { invalid.push(`${mode}/${block.block}:incomplete-quartet`); continue; }
      const local = [];
      for (let i = 0; i < 4; i += 2) {
        const pair = block.subjects.slice(i, i + 2), left = pair.find(s => s.role === 'left'), right = pair.find(s => s.role === 'right');
        assert.equal(left.repeat, right.repeat, 'unequal timed work');
        assert.equal(left.prescribedWarmupScans, right.prescribedWarmupScans, 'unequal warmup work');
        const leftMs = median(left.samples) / left.repeat, rightMs = median(right.samples) / right.repeat;
        const ratio = rightMs / leftMs;
        pairs.push({ block: block.block, pair: i / 2, first: pair[0].role, leftMs, rightMs, ratio }); local.push(Math.log(ratio));
      }
      logs.push((local[0] + local[1]) / 2);
      for (const subject of block.subjects) {
        batches.push(...subject.samples); processLatencies.push(median(subject.samples) / subject.repeat);
        for (const reason of subject.invalid) invalid.push(`${mode}/${block.block}/${subject.sequence}:${reason}`);
      }
    }
    if (logs.length !== 4) invalid.push(`${mode}:requires-four-quartets`);
    modes[mode] = { ratio: mode === 'ab' ? 'candidate/baseline' : 'baseline-right/baseline-left', pairs, quartetLogRatios: logs,
      interval: interval(logs), batchMs: variation(batches), processMsPerIteration: variation(processLatencies) };
  }
  const drift = controlDrift(modes['aa-baseline'].interval);
  if (drift) invalid.push('matched-AA-drift');
  const unique = [...new Set(invalid)];
  return { modes, invalid: unique, usable: unique.length === 0, conclusion: unique.length ? 'invalid-or-incomplete' : modes.ab.interval.classification };
}
export function gate(rows, complete) {
  if (!complete || rows.length !== 32 || ['node', 'bun'].some(runtime => new Set(rows.filter(r => r.runtime === runtime).map(r => r.workload.name)).size !== 16)) return 'incomplete';
  if (rows.some(r => r.summary.usable && r.summary.modes.ab.interval.lower > CONFIG.margin)) return 'hold-material-loss';
  if (rows.some(r => !r.summary.usable)) return 'hold-invalid-cells';
  for (const runtime of ['node', 'bun']) if (!rows.some(r => r.runtime === runtime && r.workload.target && r.summary.modes.ab.interval.upper < CONFIG.gainThreshold)) return 'hold-no-established-gain-in-each-runtime';
  if (rows.some(r => r.summary.modes.ab.interval.upper > CONFIG.margin)) return 'scoped-review-required-inconclusive-cells';
  return 'strong-clear-requires-human-review';
}
