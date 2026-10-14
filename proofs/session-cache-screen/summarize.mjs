import { CASES, MIN_BATCH_MS, MIN_COLD_MS, BOOTSTRAP_SEED } from './cases.mjs';
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
function interval(logs) {
  let seed = BOOTSTRAP_SEED;
  const uniform = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const resamples = [];
  for (let b = 0; b < 10000; b++) {
    let sum = 0;
    for (let j = 0; j < 7; j++) sum += logs[Math.floor(uniform() * 7)];
    resamples.push(Math.exp(sum / 7));
  }
  resamples.sort((a, b) => a - b);
  return { lower: resamples[249], upper: resamples[9749] };
}
function endpoint(study, engine, c, name) {
  const pairs = [], issues = [];
  for (let pair = 0; pair < 7; pair++) {
    const get = variant => {
      const attempt = study.attempts.find(a => a.engine === engine && a.pair === pair && a.variant === variant);
      const row = attempt?.events.find(event => event.event === 'case' && event.case === c.id);
      return { attempt, row };
    };
    const a = get('baseline'), b = get('candidate');
    if (!a.attempt?.valid || !b.attempt?.valid || !a.row?.valid || !b.row?.valid) {
      issues.push(`pair${pair}: missing, failed or capped subject`); continue;
    }
    const base = name === 'updateMs' ? a.row.aggregateMs / a.row.count : a.row[name];
    const candidate = name === 'updateMs' ? b.row.aggregateMs / b.row.count : b.row[name];
    if (!(base > 0 && candidate > 0 && Number.isFinite(base) && Number.isFinite(candidate))) {
      issues.push(`pair${pair}: invalid endpoint`); continue;
    }
    if (name === 'updateMs' ? Math.min(a.row.aggregateMs, b.row.aggregateMs) < MIN_BATCH_MS
      : Math.min(base, candidate) < MIN_COLD_MS) issues.push(`pair${pair}: short endpoint`);
    pairs.push({ pair, baselineMs: base, candidateMs: candidate, ratio: candidate / base });
  }
  if (pairs.length !== 7) return { engine, case: c.id, endpoint: name, status: 'unresolved', pairs, issues };
  const ratios = pairs.map(p => p.ratio), logs = ratios.map(Math.log), average = mean(logs);
  const sd = Math.sqrt(logs.reduce((sum, value) => sum + (value - average) ** 2, 0) / 6);
  const rangeRatio = Math.max(...ratios) / Math.min(...ratios);
  if (rangeRatio > 1.25 || sd > Math.log(1.10)) issues.push('excessive paired variability');
  if (!study.complete) issues.push('incomplete or invalidated study');
  const estimate = Math.exp(average), ci = interval(logs);
  const status = ci.lower > 1.02 ? 'blocked' : issues.length || estimate > 1 || ci.upper > 1.02 ? 'unresolved' : 'cleared';
  const absolute = field => ({ median: median(pairs.map(p => p[field])), min: Math.min(...pairs.map(p => p[field])), max: Math.max(...pairs.map(p => p[field])) });
  return { engine, case: c.id, endpoint: name, status, estimate, ci, logRatioSampleSD: sd,
    pairedRatioRangeFactor: rangeRatio, baselineMs: absolute('baselineMs'), candidateMs: absolute('candidateMs'), pairs, issues };
}
export function summarize(study) {
  const endpoints = [];
  for (const engine of ['node', 'bun']) for (const c of CASES) {
    for (const name of ['updateMs', 'readinessMs', 'attachmentMs', 'initialReadMs']) endpoints.push(endpoint(study, engine, c, name));
  }
  const qualifiedPrimaries = CASES.filter(c => c.primary && ['node', 'bun'].every(engine => {
    const e = endpoints.find(e => e.engine === engine && e.case === c.id && e.endpoint === 'updateMs');
    return e.issues.length === 0 && e.pairs.length === 7 && e.ci?.upper <= 0.95;
  })).map(c => c.id);
  const blocked = endpoints.filter(e => e.status === 'blocked').map(e => `${e.engine}/${e.case}/${e.endpoint}`);
  const unresolved = endpoints.filter(e => e.status === 'unresolved').map(e => `${e.engine}/${e.case}/${e.endpoint}`);
  return { complete: study.complete, status: blocked.length ? 'blocked' : !qualifiedPrimaries.length ? 'no-qualifying-primary'
    : unresolved.length ? 'scoped-primary-qualified-with-unresolved-guards' : 'scoped-primary-qualified-controls-cleared',
    qualifiedPrimaries, blocked, unresolved, endpoints,
    estimator: 'exp(mean of 7 paired log ratios of process means); revisions are not independent trials',
    uncertainty: '10,000 paired bootstrap resamples; xorshift32; empirical nearest-rank 2.5/97.5 percentiles; descriptive only',
    seed: BOOTSTRAP_SEED, minimumAggregateMs: MIN_BATCH_MS, minimumColdMs: MIN_COLD_MS,
    noRegressionClaim: false, mergeClearance: false,
    limits: 'Supported-session synthetic screen only. No demo timing, memory benefit, universal speed claim, CI clearance, or merge authorization.' };
}
