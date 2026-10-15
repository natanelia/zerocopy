// Pure, prospective protocol arithmetic. No subject import, clock reads or I/O.
import { createHash } from 'node:crypto';

export const ENGINES = Object.freeze(['node', 'bun']);
export const VARIANTS = Object.freeze(['baseline', 'candidate']);
export const LIMITS = Object.freeze({
  rounds: 16, warmupBatches: 8, measuredBatches: 4, verificationBatches: 3,
  countAlignment: 16_384, minimumCount: 16_384, maximumCount: 16_777_216,
  pilotCounts: Object.freeze([262_144, 1_048_576, 4_194_304, 16_777_216]),
  pilotLadderCountSum: 22_282_240, maximumPilotReads: 66_846_720, pilotWarmupBatches: 8, pilotSampleBatches: 3,
  maximumCalibrationBatches: 55, maximumCalibrationReads: 429_654_016, pilotMinimumNs: 5_000_000,
  pilotMaximumNs: 200_000_000, targetNs: 20_000_000,
  verificationMinimumNs: 16_000_000, verificationMaximumNs: 40_000_000,
  readMinimumNs: 8_000_000, clockMultiplier: 1_000,
  clockDeltaCount: 10_000, clockPairCount: 1_000,
  cvLimit: 0.05, warmupDriftLimit: 0.03, measuredDriftLimit: 0.05,
  primaryUpperRatio: 0.95, controlPointRatio: 1, controlUpperRatio: 1.02,
  t15: 2.131449545559323, validationChildren: 4, calibrationChildren: 12,
  mainChildren: 384, totalChildren: 400, maximumEntries: 32_768,
  maximumExtraQueryStrings: 4_096, rssBytes: 1_073_741_824,
  childSeconds: 10, studySeconds: 600, minimumSetupSeconds: 0.5,
  feasibilityHeadroom: 1.5, analysisSeconds: 30,
  validationBufferBytes: 268_435_456, validationInputEntries: 41_472,
  validationWriterHandles: 30, validationReaderHandles: 12,
  validationStartupHandles: 2, validationSnapshotHandles: 44,
  validationPayloadBuffers: 24, validationReaderBuffers: 12,
  validationSetOperations: 12, validationDeleteOperations: 6,
});

const MISS_HASH = '637f3d4acc8590ffbafc3a6b4247e6e72a423aee4abccc1b3f8ead8d7307ede2';
const SMALL_HASH = '4dbaddaae9a6652f48eac1be0d1f29f7516d6d4f6748c2ceb31052093c94b694';
export const CASES = Object.freeze([
  ['P1', 'sole-primary', 'get', 128, 100000, 104096, 0, SMALL_HASH, MISS_HASH, 4096],
  ['P2', 'supporting-miss', 'has', 256, 100000, 104096, 0,
    'cc389e4e6112337e00a2df4e3a88d398013a8d8c7dbc58a08057a6a257a677d5', MISS_HASH, 0],
  ['C1', 'dense-nonzero-miss-control', 'get', 8192, 100000, 104096, 0,
    'cf12e855c52cdda1e5d98f36102b3123e90f49dee0c6e058087a29b99bb8cdda', MISS_HASH, 4096],
  ['C2', 'saturated-hit-control', 'get', 32768, 16384, 32768, 16384,
    'd26d73428a9d9ddaa8327122e2b54645e275d05458b6ccf01d920bb73abde737',
    '9f2b8afd0d61bc16dda9da2bd49a821d43ceaf62e32b06ea2ce66c6b928f9076', 402661376],
  ['C3', 'cached-hit-control', 'get', 128, 0, 128, 128, SMALL_HASH,
    'c8345917d3d4671442cc10dfb0b3416bd439b0c71014536d0a5ad1f6d969ca56', 8256],
  ['C4', 'empty-control', 'get', 0, 100000, 104096, 0,
    '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', MISS_HASH, 4096],
].map(([id, role, operation, entryCount, queryStart, queryStop, seedCount,
  entryArraySha256, queryArraySha256, expectedChecksumPerPass]) => Object.freeze({
  id, role, operation, entryCount, queryStart, queryStop, seedCount,
  queryCount: queryStop - queryStart, entryArraySha256, queryArraySha256,
  expectedChecksumPerPass,
})));

const caseById = new Map(CASES.map(c => [c.id, c]));
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const countValid = n => Number.isSafeInteger(n) && n >= LIMITS.minimumCount &&
  n <= LIMITS.maximumCount && n % LIMITS.countAlignment === 0;
// Centering preserves an exact repeated value and reduces cancellation in logs.
const average = xs => xs[0] + xs.reduce((sum, n) => sum + (n - xs[0]), 0) / xs.length;
const median = xs => {
  const sorted = [...xs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const cellKey = x => `${x.round}/${x.caseId}/${x.engine}/${x.variant}`;
const groupKey = x => `${x.caseId}/${x.engine}`;

export function schedule() {
  const result = [];
  for (let round = 0; round < LIMITS.rounds; round++) {
    for (let visit = 0; visit < CASES.length; visit++) {
      const caseIndex = (round + visit) % CASES.length;
      const caseId = CASES[caseIndex].id;
      const engines = round % 2 ? [...ENGINES].reverse() : ENGINES;
      for (const engine of engines) {
        const engineIndex = ENGINES.indexOf(engine);
        const variants = (round + caseIndex + engineIndex) % 2
          ? [...VARIANTS].reverse() : VARIANTS;
        for (const variant of variants) result.push({ round, caseId, engine, variant });
      }
    }
  }
  return result;
}

export function fixture(caseId, absentQueries = undefined) {
  const definition = caseById.get(caseId);
  if (!definition) throw new RangeError(`Unknown case: ${caseId}`);
  const key = id => `k${String(id).padStart(7, '0')}`;
  const entries = Array.from({ length: definition.entryCount }, (_, id) => [key(id), id + 1]);
  // Hit queries and all seeds reuse the keys already stored in entries.
  const sha256 = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  const missingQueries = definition.queryStart === 100000;
  if (absentQueries !== undefined && (!Array.isArray(absentQueries) || absentQueries.length !== 4096 ||
    sha256(absentQueries) !== MISS_HASH)) throw new Error('Invalid shared absent-query array');
  const queries = missingQueries && absentQueries !== undefined ? absentQueries :
    Array.from({ length: definition.queryCount }, (_, offset) => {
    const id = definition.queryStart + offset;
    return id < entries.length ? entries[id][0] : key(id);
  });
  const seedKeys = entries.slice(0, definition.seedCount).map(entry => entry[0]);
  const entryArraySha256 = sha256(entries);
  const queryArraySha256 = sha256(queries);
  if (entryArraySha256 !== definition.entryArraySha256 || queryArraySha256 !== definition.queryArraySha256)
    throw new Error(`Fixture expansion hash mismatch: ${caseId}`);
  return { ...definition, entries, queries, seedKeys, entryArraySha256, queryArraySha256 };
}

export function chooseCount(stages, clock) {
  const unresolved = (reason, nextCount = null) => ({ resolved: false, clear: false, N: null,
    reason, pending: nextCount !== null, nextCount });
  if (!clock || clock.clear !== true) return unresolved('invalid-calibration-clock');
  if (!Array.isArray(stages) || stages.length > LIMITS.pilotCounts.length)
    return unresolved('invalid-pilot-sequence');
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const validBatch = b => b && b.count === stage.count && positive(b.ns) && b.checksumValid === true;
    if (!stage || stage.count !== LIMITS.pilotCounts[i] ||
      !Array.isArray(stage.warmup) || stage.warmup.length !== LIMITS.pilotWarmupBatches ||
      !stage.warmup.every(validBatch)) return unresolved('invalid-pilot-sequence');
    if (!readiness(stage.warmup.map(b => b.ns)).clear) return unresolved('pilot-warmup-unready');
    if (!Array.isArray(stage.pilots) || stage.pilots.length > LIMITS.pilotSampleBatches ||
      !stage.pilots.every(validBatch)) return unresolved('invalid-pilot-sequence');
    if (stage.pilots.some(b => b.ns > LIMITS.pilotMaximumNs)) return unresolved('pilot-exceeds-200ms');
    if (stage.pilots.length !== LIMITS.pilotSampleBatches) return unresolved('invalid-pilot-sequence');
    const pilotMedianNs = median(stage.pilots.map(b => b.ns));
    if (pilotMedianNs >= LIMITS.pilotMinimumNs) {
      if (i !== stages.length - 1) return unresolved('pilots-after-first-usable-pilot');
      const predicted = stage.count * LIMITS.targetNs / pilotMedianNs;
      const N = Math.min(LIMITS.maximumCount, Math.max(LIMITS.minimumCount,
        Math.ceil(predicted / LIMITS.countAlignment) * LIMITS.countAlignment));
      return { resolved: true, clear: true, N, reason: null, pending: false, nextCount: null,
        selectedPilotIndex: i, pilotMedianNs, predictedCount: predicted };
    }
  }
  return stages.length === LIMITS.pilotCounts.length
    ? unresolved('no-pilot-reaches-5ms')
    : unresolved('awaiting-next-pilot', LIMITS.pilotCounts[stages.length]);
}

// SD is the sample SD; CV is a fraction. Empty or invalid input is explicit.
export function describe(values) {
  if (!Array.isArray(values) || Array.from(values).some(n => !Number.isFinite(n)))
    return { valid: false, count: Array.isArray(values) ? values.length : 0,
      mean: null, median: null, sd: null, cv: null, min: null, max: null };
  if (!values.length) return { valid: true, count: 0, mean: null, median: null,
    sd: null, cv: null, min: null, max: null };
  const mean = average(values);
  const sd = values.length > 1
    ? Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1)) : null;
  return { valid: true, count: values.length, mean, median: median(values), sd,
    cv: sd === null || mean === 0 ? null : sd / Math.abs(mean),
    min: Math.min(...values), max: Math.max(...values) };
}

export function readiness(batchNs, measured = false) {
  const expected = measured ? LIMITS.measuredBatches : LIMITS.warmupBatches;
  if (!Array.isArray(batchNs) || batchNs.length !== expected || Array.from(batchNs).some(n => !positive(n)))
    return { clear: false, reason: 'invalid-batch-count-or-duration', cv: null, drift: null };
  const lastFour = batchNs.slice(-4);
  const statistics = describe(lastFour);
  const firstTwoMean = average(lastFour.slice(0, 2));
  const lastTwoMean = average(lastFour.slice(2));
  const drift = Math.abs(lastTwoMean - firstTwoMean) / firstTwoMean;
  const driftLimit = measured ? LIMITS.measuredDriftLimit : LIMITS.warmupDriftLimit;
  const clear = statistics.cv <= LIMITS.cvLimit && drift <= driftLimit;
  return { clear, reason: clear ? null : 'batch-variation-or-drift', cv: statistics.cv,
    drift, firstTwoMean, lastTwoMean, statistics, cvLimit: LIMITS.cvLimit, driftLimit };
}

export function clockSummary(deltasNs, pairsNs) {
  const valid = Array.isArray(deltasNs) && deltasNs.length === LIMITS.clockDeltaCount &&
    Array.from(deltasNs).every(nonnegative) && Array.isArray(pairsNs) &&
    pairsNs.length === LIMITS.clockPairCount && Array.from(pairsNs).every(nonnegative);
  if (!valid) return { clear: false, reason: 'invalid-clock-sample-count-or-duration',
    minPositiveNs: null, medianDeltaNs: null, p99DeltaNs: null, medianPairNs: null };
  const positives = deltasNs.filter(positive);
  const minPositiveNs = positives.length ? Math.min(...positives) : null;
  const medianPairNs = median(pairsNs);
  const clear = positive(minPositiveNs) && positive(medianPairNs);
  return { clear, reason: clear ? null : 'missing-positive-clock-estimate', minPositiveNs,
    medianDeltaNs: median(deltasNs),
    // p99 uses the nearest-rank definition, fixed before execution.
    p99DeltaNs: [...deltasNs].sort((a, b) => a - b)[Math.ceil(deltasNs.length * 0.99) - 1],
    medianPairNs, deltaCount: deltasNs.length, pairCount: pairsNs.length,
    deltas: describe(deltasNs), pairs: describe(pairsNs) };
}

function clockFloor(clock) {
  return clock && clock.clear !== false && positive(clock.minPositiveNs) && positive(clock.medianPairNs)
    ? LIMITS.clockMultiplier * Math.max(clock.minPositiveNs, clock.medianPairNs) : null;
}

export function readResolution(batchNs, clock) {
  const clockMinimumNs = clockFloor(clock);
  const minimumNs = clockMinimumNs === null ? null : Math.max(LIMITS.readMinimumNs, clockMinimumNs);
  const clear = minimumNs !== null && Array.isArray(batchNs) &&
    batchNs.length === LIMITS.measuredBatches && Array.from(batchNs).every(ns => positive(ns) && ns >= minimumNs);
  return { clear, reason: clear ? null : 'missing-clock-or-short-read-batch', minimumNs,
    clockMinimumNs, absoluteMinimumNs: LIMITS.readMinimumNs };
}

export function startupResolution(ns, clock) {
  const minimumNs = clockFloor(clock);
  const clear = minimumNs !== null && positive(ns) && ns > minimumNs;
  return { clear, reason: clear ? null : 'missing-clock-or-short-startup', minimumNs };
}

// Each calibration is baseline-only and contains three verification batch objects.
// launchStartupSetupNs is supervisor launch through fixture/copy/setup, excluding reads.
export function feasibility(calibrations, elapsedSeconds) {
  const errors = [];
  if (!nonnegative(elapsedSeconds)) errors.push('invalid-elapsed-seconds');
  if (!Array.isArray(calibrations) || calibrations.length !== LIMITS.calibrationChildren)
    errors.push('expected-12-baseline-calibrations');
  const seen = new Set();
  const cells = [];
  for (const c of Array.isArray(calibrations) ? calibrations : []) {
    const key = c && groupKey(c);
    if (!c || c.variant !== 'baseline' || !caseById.has(c.caseId) || !ENGINES.includes(c.engine) || seen.has(key)) {
      errors.push('invalid-or-duplicate-baseline-calibration');
      continue;
    }
    seen.add(key);
    const verification = c.verification?.map(batch => batch?.ns);
    if (!nonnegative(c.launchStartupSetupNs) || verification?.length !== LIMITS.verificationBatches ||
      verification.some(ns => !positive(ns))) {
      errors.push(`invalid-feasibility-observation:${key}`);
      continue;
    }
    const verificationMedianNs = median(verification);
    const s = Math.max(LIMITS.minimumSetupSeconds, c.launchStartupSetupNs / 1e9);
    const b = Math.max(LIMITS.targetNs / 1e9, verificationMedianNs / 1e9);
    cells.push({ caseId: c.caseId, engine: c.engine, setupSeconds: s,
      batchSeconds: b, verificationMedianNs });
  }
  if (seen.size !== LIMITS.calibrationChildren) errors.push('incomplete-calibration-grid');
  const valid = errors.length === 0;
  const forecastSeconds = valid ? 32 * cells.reduce((sum, c) => sum + c.setupSeconds + 12 * c.batchSeconds, 0) : null;
  const reservedMainSeconds = valid ? LIMITS.feasibilityHeadroom * forecastSeconds : null;
  const projectedTotalSeconds = valid ? elapsedSeconds + reservedMainSeconds + LIMITS.analysisSeconds : null;
  const clear = valid && projectedTotalSeconds <= LIMITS.studySeconds;
  return { clear, reason: clear ? null : valid ? 'budget-infeasible' : 'invalid-calibration-input',
    errors, cells, elapsedSeconds, forecastSeconds, reservedMainSeconds,
    analysisSeconds: LIMITS.analysisSeconds, projectedTotalSeconds, deadlineSeconds: LIMITS.studySeconds };
}

function fixedInterval(logRatios, allowInference) {
  const ready = allowInference && logRatios.length === LIMITS.rounds && logRatios.every(Number.isFinite);
  if (!ready) return { n: logRatios.filter(Number.isFinite).length, df: null, t: null,
    logMean: null, logSd: null, ratio: { point: null, lower: null, upper: null },
    gain: { point: null, lower: null, upper: null } };
  const statistics = describe(logRatios);
  const halfWidth = LIMITS.t15 * statistics.sd / Math.sqrt(LIMITS.rounds);
  const ratio = { point: Math.exp(statistics.mean), lower: Math.exp(statistics.mean - halfWidth),
    upper: Math.exp(statistics.mean + halfWidth) };
  return { n: LIMITS.rounds, df: 15, t: LIMITS.t15, logMean: statistics.mean,
    logSd: statistics.sd, ratio,
    gain: { point: 1 - ratio.point, lower: 1 - ratio.upper, upper: 1 - ratio.lower } };
}

function batchIntegrity(batches, n, definition, expectedLength) {
  return countValid(n) && Array.isArray(batches) && batches.length === expectedLength &&
    Array.from(batches).every(batch => batch && positive(batch.ns) && batch.count === n &&
      batch.checksum === definition.expectedChecksumPerPass * (n / definition.queryCount));
}

function readObservation(receipt, definition) {
  if (!receipt) return null;
  const warmupNs = Array.isArray(receipt.warmup) ? receipt.warmup.map(b => b?.ns) : [];
  const measuredNs = Array.isArray(receipt.measured) ? receipt.measured.map(b => b?.ns) : [];
  const batchClear = batchIntegrity(receipt.warmup, receipt.N, definition, LIMITS.warmupBatches) &&
    batchIntegrity(receipt.measured, receipt.N, definition, LIMITS.measuredBatches);
  const warmup = readiness(warmupNs);
  const measured = readiness(measuredNs, true);
  const resolution = readResolution(measuredNs, receipt.clock);
  const usableTime = countValid(receipt.N) && measuredNs.length === LIMITS.measuredBatches && measuredNs.every(positive);
  const totalNs = usableTime ? measuredNs.reduce((sum, ns) => sum + ns, 0) : null;
  return { N: receipt.N ?? null, batchNs: measuredNs, totalNs,
    nsPerRead: totalNs === null ? null : totalNs / (LIMITS.measuredBatches * receipt.N),
    qualityClear: receipt.complete !== false && receipt.qualityClear === true &&
      batchClear && warmup.clear && measured.clear && resolution.clear,
    batchClear, warmup, measured, resolution };
}

function outcome(interval, qualityClear, primary) {
  const { point, lower, upper } = interval.ratio;
  const inferential = [point, lower, upper].every(positive);
  const confidentAdverse = qualityClear && inferential && lower > LIMITS.controlUpperRatio;
  const qualifies = primary && qualityClear && inferential && upper <= LIMITS.primaryUpperRatio;
  const controlClear = !primary && qualityClear && inferential &&
    point <= LIMITS.controlPointRatio && upper <= LIMITS.controlUpperRatio;
  return { confidentAdverse, qualifies, controlClear,
    status: confidentAdverse ? 'blocked' : qualifies ? 'qualifying' : controlClear ? 'clear' : 'unresolved' };
}

// mainReceipts must remain in launch order. A failed slot may be a minimal receipt;
// it must never be replaced, discarded or repaired by sorting. Every endpoint is
// emitted even when no observation exists. Only exact fixed-n inference is used.
export function summarize(mainReceipts) {
  const expected = schedule();
  const receipts = Array.isArray(mainReceipts) ? mainReceipts : [];
  const errors = [];
  if (!Array.isArray(mainReceipts) || receipts.length !== expected.length) errors.push('incomplete-or-extra-main-schedule');
  const byKey = new Map();
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index];
    if (!receipt || !expected[index] || cellKey(receipt) !== cellKey(expected[index]))
      errors.push(`schedule-mismatch:${index}`);
    if (!receipt) continue;
    const key = cellKey(receipt);
    if (byKey.has(key)) {
      errors.push(`duplicate-cell:${key}`);
      // Never silently choose one of duplicate observations.
      byKey.set(key, null);
    } else byKey.set(key, receipt);
  }
  const scheduleClear = errors.length === 0;
  const readEndpoints = [];
  for (const definition of CASES) for (const engine of ENGINES) {
    const pairs = Array.from({ length: LIMITS.rounds }, (_, round) => {
      const base = { round, caseId: definition.id, engine };
      const baseline = readObservation(byKey.get(cellKey({ ...base, variant: 'baseline' })), definition);
      const candidate = readObservation(byKey.get(cellKey({ ...base, variant: 'candidate' })), definition);
      const usable = positive(baseline?.nsPerRead) && positive(candidate?.nsPerRead) && baseline.N === candidate.N;
      const ratio = usable ? candidate.nsPerRead / baseline.nsPerRead : null;
      return { round, baseline, candidate, ratio, logRatio: ratio === null ? null : Math.log(ratio) };
    });
    const counts = pairs.flatMap(pair => VARIANTS.map(v => pair[v]?.N));
    const countClear = counts.length === 32 && counts.every(n => countValid(n) && n === counts[0]);
    const qualityClear = scheduleClear && countClear && pairs.every(pair => pair.baseline?.qualityClear && pair.candidate?.qualityClear);
    const interval = fixedInterval(pairs.map(pair => pair.logRatio), scheduleClear);
    const statistics = Object.fromEntries(VARIANTS.map(variant => {
      const observations = pairs.map(pair => pair[variant]).filter(Boolean);
      const batches = observations.flatMap(x => x.batchNs).filter(positive);
      const processes = observations.map(x => x.totalNs).filter(positive);
      const nsPerRead = observations.map(x => x.nsPerRead).filter(positive);
      return [variant, { batchNs: describe(batches), batchMs: describe(batches.map(n => n / 1e6)),
        processNs: describe(processes), processMs: describe(processes.map(n => n / 1e6)), nsPerRead: describe(nsPerRead) }];
    }));
    readEndpoints.push({ kind: 'read', caseId: definition.id, engine, role: definition.role,
      qualityClear, countClear, pairs, pairedRatios: pairs.map(pair => pair.ratio),
      pairedLogRatios: pairs.map(pair => pair.logRatio), statistics, ...interval,
      ...outcome(interval, qualityClear, definition.id === 'P1') });
  }
  const startupEndpoints = [];
  for (const engine of ENGINES) for (const metric of ['spawnToReadyNs', 'importToReadyNs']) {
    const rounds = Array.from({ length: LIMITS.rounds }, (_, round) => {
      const constituents = CASES.map(definition => {
        const base = { round, caseId: definition.id, engine };
        const observations = Object.fromEntries(VARIANTS.map(variant => {
          const receipt = byKey.get(cellKey({ ...base, variant }));
          if (!receipt) return [variant, null];
          const ns = receipt.startup?.[metric];
          const clock = metric === 'spawnToReadyNs' ? receipt.supervisorClock : receipt.clock;
          const resolution = startupResolution(ns, clock);
          return [variant, { ns: positive(ns) ? ns : null, resolution,
            qualityClear: receipt.complete !== false && resolution.clear }];
        }));
        const usable = positive(observations.baseline?.ns) && positive(observations.candidate?.ns);
        const ratio = usable ? observations.candidate.ns / observations.baseline.ns : null;
        return { caseId: definition.id, ...observations, ratio, logRatio: ratio === null ? null : Math.log(ratio) };
      });
      const logRatio = constituents.every(c => Number.isFinite(c.logRatio))
        ? average(constituents.map(c => c.logRatio)) : null;
      return { round, constituents, logRatio, ratio: logRatio === null ? null : Math.exp(logRatio) };
    });
    const qualityClear = scheduleClear && rounds.every(r => r.constituents.every(c =>
      c.baseline?.qualityClear && c.candidate?.qualityClear));
    const interval = fixedInterval(rounds.map(r => r.logRatio), scheduleClear);
    const statistics = Object.fromEntries(VARIANTS.map(variant => {
      const times = rounds.flatMap(r => r.constituents.map(c => c[variant]?.ns)).filter(positive);
      return [variant, { observationNs: describe(times), observationMs: describe(times.map(n => n / 1e6)) }];
    }));
    startupEndpoints.push({ kind: 'startup', engine, metric, qualityClear, rounds, statistics,
      pairedRatios: rounds.map(r => r.ratio), pairedLogRatios: rounds.map(r => r.logRatio),
      ...interval, ...outcome(interval, qualityClear, false) });
  }
  const endpoints = [...readEndpoints, ...startupEndpoints];
  const qualityClear = scheduleClear && endpoints.every(endpoint => endpoint.qualityClear);
  const studyIntegrityClear = scheduleClear && receipts.every(r => r.complete !== false) &&
    readEndpoints.every(e => e.countClear && e.pairs.every(p => p.baseline?.batchClear && p.candidate?.batchClear)) &&
    startupEndpoints.every(e => e.rounds.every(r => r.constituents.every(c => positive(c.baseline?.ns) && positive(c.candidate?.ns))));
  const primaryQualified = studyIntegrityClear && readEndpoints.filter(e => e.caseId === 'P1').every(e => e.qualifies);
  const controlsCleared = studyIntegrityClear && endpoints.filter(e => !(e.kind === 'read' && e.caseId === 'P1')).every(e => e.controlClear);
  const materialHarmVeto = studyIntegrityClear && endpoints.some(e => e.confidentAdverse);
  const promisingLead = primaryQualified && !materialHarmVeto;
  const diagnosticFollowOnEligible = promisingLead;
  const regressionClearance = promisingLead && controlsCleared;
  // Preserve the old strict aliases; follow-on proposals use the explicit diagnostic flag.
  const eligible = regressionClearance, controlsClear = controlsCleared, blocked = materialHarmVeto;
  const status = materialHarmVeto ? 'blocked-by-confident-material-harm' : regressionClearance ? 'regression-clearance'
    : promisingLead ? 'promising-lead-with-unresolved-controls' : 'no-qualifying-lead';
  return { status, eligible, scheduleClear, studyIntegrityClear, qualityClear, primaryQualified,
    materialHarmVeto, controlsCleared, promisingLead, diagnosticFollowOnEligible, regressionClearance,
    controlsClear, blocked,
    expectedProcesses: LIMITS.mainChildren, receivedProcesses: receipts.length, errors,
    readEndpoints, startupEndpoints, endpoints,
    eligibilityScope: 'Data-only; supervisor must additionally enforce source/correctness authentication and every late failure.' };
}
