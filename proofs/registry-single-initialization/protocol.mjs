import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
export const protocol = JSON.parse(readFileSync(new URL('./gate.json', import.meta.url)));
export const median = values => {
  assert(values.length && values.every(v => Number.isFinite(v) && v > 0));
  const sorted = [...values].sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
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
export function scheduleCase(row, seed) {
  assert([4, 8].includes(row.quartets));
  const random = randomSource(seed);
  const orders = Object.fromEntries(row.arms.map(arm => [arm, shuffle(Array(row.quartets / 2).fill('ABBA').concat(Array(row.quartets / 2).fill('BAAB')), random)]));
  return Array.from({ length: row.quartets }, (_, q) => shuffle(row.arms, random).map(arm => ({
    quartet: q + 1, arm, order: orders[arm][q], roles: [...orders[arm][q]],
  }))).flat();
}
export function variantFor(arm, role) {
  assert(Object.hasOwn(protocol.arms, arm) && ['A', 'B'].includes(role));
  return protocol.arms[arm][role === 'A' ? 0 : 1];
}
export function interval(logs) {
  const n = logs.length;
  assert([4, 8].includes(n) && logs.every(Number.isFinite));
  const df = n - 1, tCritical = protocol.tCriticalByDf[df];
  const meanLog = logs.reduce((a, b) => a + b, 0) / n;
  const variance = logs.reduce((sum, x) => sum + (x - meanLog) ** 2, 0) / df;
  const standardError = Math.sqrt(variance / n);
  const ratio = Math.exp(meanLog), lower = Math.exp(meanLog - tCritical * standardError), upper = Math.exp(meanLog + tCritical * standardError);
  return { ratio, ci95: [lower, upper], meanLog, standardError, df, tCritical, quartetLogs: logs,
    classification: lower > protocol.margin ? 'material-slowdown-signal' : upper <= protocol.margin ? 'within-2%-margin' : 'inconclusive',
    materialRoleDrift: (ratio < 1 / protocol.margin || ratio > protocol.margin) && (upper < 1 || lower > 1) };
}
export function settingsFor(row) {
  const bounds = protocol.pilotBounds[row.operation];
  return { samples: protocol.samples, warmups: protocol.warmups, minimumBatchMs: protocol.minimumBatchMs,
    pilotTargetBatchMs: protocol.pilotTargetBatchMs, pilotMaximumBatches: protocol.pilotMaximumBatches,
    initialIterations: bounds.initial, maximumIterations: bounds.maximum };
}
export function freezeWork(row, pilots) {
  assert.deepEqual(Object.keys(pilots).sort(), [...protocol.variants].sort());
  const iterations = Math.max(...Object.values(pilots).map(p => p.result.prescribedIterations));
  assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= protocol.pilotBounds[row.operation].maximum, 'Common pilot work exceeds the prospective cap; no measurements admitted');
  return { iterations, warmupOperationsPerProcess: protocol.warmups * iterations, measuredOperationsPerProcess: protocol.samples * iterations };
}
export function validateResult(result, request, row, variant) {
  assert.deepEqual(result.request, request);
  assert.equal(result.phase, request.phase); assert.equal(result.operation, row.operation); assert.equal(result.arenas, row.arenas);
  assert.equal(result.correctness.checkedAllLeaves, Math.max(1, row.arenas - 1));
  assert.equal(result.correctness.sharedReexportArenas, row.arenas);
  assert(Number.isFinite(result.sink));
  if (row.subject === 'original') {
    assert.equal(result.correctness.nestedReadOnly, true);
    const count = variant === 'main' ? row.arenas ** 2 : row.arenas;
    assert.equal(result.dependencySets, count); assert.equal(result.traversedArenaValues, count);
  } else {
    assert.equal(result.correctness.nestedReadOnly, false); assert.equal(result.correctness.retainedOwnedSnapshot, true);
    assert.equal(result.dependencySets, null); assert.equal(result.traversedArenaValues, null);
  }
  const settings = settingsFor(row);
  assert.deepEqual(request.settings, settings);
  const validateBatch = (batch, phase, index, iterations) => {
    assert.equal(batch.phase, phase); assert.equal(batch.index, index); assert.equal(batch.iterations, iterations);
    assert(Number.isFinite(batch.elapsedMs) && batch.elapsedMs > 0);
    assert.equal(batch.msPerOperation, batch.elapsedMs / iterations);
    assert.equal(batch.shortBatch, batch.elapsedMs < settings.minimumBatchMs);
  };
  if (request.phase === 'pilot') {
    assert(result.calibration.length > 0 && result.calibration.length <= settings.pilotMaximumBatches);
    let count = settings.initialIterations;
    for (const [index, batch] of result.calibration.entries()) {
      validateBatch(batch, 'pilot-calibration', index, count);
      const stopped = batch.elapsedMs >= settings.pilotTargetBatchMs || count >= settings.maximumIterations;
      if (stopped) assert.equal(index + 1, result.calibration.length, 'Pilot continued after stopping rule');
      else {
        // The frozen subject also increments after the final calibration batch
        // when its batch budget is exhausted, before the fixed pilot warmups.
        count = Math.min(settings.maximumIterations, Math.max(count + 1, Math.ceil(count * Math.min(8, settings.pilotTargetBatchMs / Math.max(batch.elapsedMs, 0.001)))));
      }
    }
    const last = result.calibration.at(-1);
    assert(last.elapsedMs >= settings.pilotTargetBatchMs || last.iterations >= settings.maximumIterations || result.calibration.length === settings.pilotMaximumBatches, 'Pilot stopped before the prescribed rule');
    assert.equal(result.iterations, count);
    assert.equal(result.warmup.length, settings.warmups); assert.equal(result.measured.length, 0);
    result.warmup.forEach((b, i) => validateBatch(b, 'pilot-warmup', i, count));
    const fastest = Math.min(...result.warmup.map(b => b.msPerOperation));
    assert.equal(result.fastestPilotMsPerOperation, fastest);
    assert.equal(result.prescribedIterations, Math.max(count, Math.ceil(settings.pilotTargetBatchMs / fastest)));
  } else {
    assert.equal(request.phase, 'measure');
    assert(Number.isSafeInteger(request.iterations) && request.iterations > 0 && request.iterations <= settings.maximumIterations);
    assert.equal(result.iterations, request.iterations); assert.equal(result.calibration.length, 0);
    assert.equal(result.warmup.length, settings.warmups); assert.equal(result.measured.length, settings.samples);
    assert.equal(result.fastestPilotMsPerOperation, null); assert.equal(result.prescribedIterations, null);
    result.warmup.forEach((b, i) => validateBatch(b, 'warmup', i, request.iterations));
    result.measured.forEach((b, i) => validateBatch(b, 'sample', i, request.iterations));
  }
}
export function summarizeCase(row, { runComplete = false, integrityComplete = false } = {}) {
  const arms = {};
  for (const arm of row.arms) {
    const matching = row.blocks.filter(b => b.arm === arm), complete = matching.filter(b => b.subjects.length === 4);
    const pairs = [], logs = [];
    for (const block of complete) {
      const local = [];
      assert.equal(block.subjects.map(s => s.role).join(''), block.order);
      for (const index of [0, 2]) {
        const pair = block.subjects.slice(index, index + 2), a = pair.find(x => x.role === 'A'), b = pair.find(x => x.role === 'B');
        assert(a && b);
        const aMs = median(a.result.measured.map(x => x.msPerOperation)), bMs = median(b.result.measured.map(x => x.msPerOperation));
        local.push(Math.log(bMs / aMs));
        pairs.push({ quartet: block.quartet, order: block.order, aMs, bMs, ratio: bMs / aMs });
      }
      logs.push((local[0] + local[1]) / 2);
    }
    const subjects = matching.flatMap(b => b.subjects);
    const shortBatches = subjects.reduce((n, s) => n + [...s.result.warmup, ...s.result.measured].filter(b => b.elapsedMs < protocol.minimumBatchMs).length, 0);
    arms[arm] = { completeQuartets: complete.length, pairs, shortBatches,
      processMedians: subjects.map(s => ({ ordinal: s.ordinal, role: s.role, variant: s.variant, msPerOperation: median(s.result.measured.map(b => b.msPerOperation)) })),
      inference: complete.length === row.quartets ? interval(logs) : null };
  }
  const invalidationReasons = [];
  if (!runComplete) invalidationReasons.push('run-not-completed');
  if (!integrityComplete) invalidationReasons.push('final-integrity-not-completed');
  for (const [arm, summary] of Object.entries(arms)) {
    if (!summary.inference) invalidationReasons.push(arm + '-incomplete');
    if (summary.shortBatches) invalidationReasons.push(arm + '-short-warmup-or-sample');
    if (arm.startsWith('aa-') && summary.inference?.materialRoleDrift) invalidationReasons.push(arm + '-material-role-drift');
  }
  const inferenceValid = invalidationReasons.length === 0;
  const accepted = arms.acceptance.inference?.ci95[1] <= protocol.margin;
  const nonregressing = arms.repair.inference?.ci95[1] <= protocol.margin;
  const primaryDecisions = row.primary ? {
    cleanupWithinMainMargin: accepted,
    directCleanupImprovement: arms.repair.inference?.ci95[1] < 1,
    originalLossReproduced: arms.bridge.inference?.ci95[0] > protocol.margin,
  } : null;
  const reexportBenefit = row.operation !== 'reexport' || arms.acceptance.inference?.ci95[1] < 1;
  const passed = inferenceValid && (row.primary ? Object.values(primaryDecisions).every(Boolean) : accepted && nonregressing && reexportBenefit);
  return { arms, inferenceValid, invalidationReasons, primaryDecisions, passed,
    interpretation: !inferenceValid ? 'invalid; retain all raw results' : passed ? (row.primary ? 'bounded-primary-repair-criteria-met' : 'bounded-control-criteria-met') : 'criteria-not-established',
    normalization: 'none', pooling: 'none', intervalScope: 'pointwise only' };
}
export function stageDecision(rows, stage, state) {
  const expected = protocol.cases.filter(row => row.stage === stage);
  assert.deepEqual(rows.map(r => r.id), expected.map(r => r.id));
  for (const [i, row] of rows.entries()) {
    for (const key of ['stage', 'arch', 'subject', 'operation', 'arenas', 'primary', 'quartets', 'arms']) assert.deepEqual(row[key], expected[i][key], 'Case definition changed: ' + row.id + ':' + key);
    const schedule = scheduleCase(expected[i], protocol.seed + protocol.cases.indexOf(expected[i]));
    assert(row.blocks.length <= schedule.length);
    assert.deepEqual(row.blocks.map(({ subjects, ...block }) => block), schedule.slice(0, row.blocks.length), 'Quartet schedule changed or duplicated');
    for (const block of row.blocks) {
      assert(block.subjects.length <= 4);
      assert.deepEqual(block.subjects.map(s => s.role), block.roles.slice(0, block.subjects.length));
      for (const subject of block.subjects) assert.equal(subject.variant, variantFor(block.arm, subject.role));
    }
  }
  const summaries = rows.map(row => ({ id: row.id, ...summarizeCase(row, state) }));
  return { stage, summaries, passed: summaries.every(s => s.passed), stage2Permitted: stage === 1 && summaries.every(s => s.passed),
    stage2Disposition: stage === 1 ? (summaries.every(s => s.passed) ? 'permitted-but-not-yet-run' : 'not-run-gate-not-met') : 'current-stage',
    scope: 'Bounded screen only; broad repair still requires remaining architecture/runtime controls' };
}
