import assert from 'node:assert/strict';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CONFIG, variation } from './heap-insert-protocol.mjs';
import { canonicalWorkload, fixture, fixtureIdentity, checkFixture, runBatch, verifyBatch } from './heap-insert-workloads.mjs';

// Pure prospective rule: a 64MiB ceiling may end calibration at >=20ms;
// repeat/step ceilings cannot. This does not change the measured 10ms floor.
export function calibrationDecision({ repeat, repeatCap, repeatCapReason, samples, step, lastStep = 15 }) {
  const valid = samples.length > 0 && samples.every(ms => Number.isFinite(ms) && ms > 0);
  const fastest = valid ? Math.min(...samples) : null;
  const memoryCeilingReached = repeat === repeatCap && repeatCapReason === 'used-byte-budget';
  const normalTargetMiss = !valid || fastest < CONFIG.batchTargetMs * 1.25;
  let reason, accepted = false, stop = true;
  if (!valid) reason = 'invalid-duration';
  else if (!normalTargetMiss) { accepted = true; reason = 'normal-target'; }
  else if (memoryCeilingReached) {
    accepted = fastest >= CONFIG.memoryCeilingPilotFloorMs;
    reason = accepted ? 'memory-ceiling-floor' : 'below-memory-ceiling-floor';
  } else if (repeat >= repeatCap) reason = 'global-repeat-limit';
  else if (step >= lastStep) reason = 'calibration-step-limit';
  else { stop = false; reason = 'continue'; }
  return { stop, accepted, capped: stop && !accepted, reason, fastest, memoryCeilingReached, normalTargetMiss };
}

export async function subject(request) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'No local latency collection');
  assert.equal(process.env.HEAP_INSERT_CI_SUBJECT, '1');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  assert(typeof request.progressPath === 'string' && isAbsolute(request.progressPath), 'Expected absolute progress journal path');
  const fd = openSync(request.progressPath, 'wx');
  const progress = row => appendFileSync(fd, JSON.stringify({ ...row, recordedAt: new Date().toISOString() }) + '\n');
  try {
    progress({ event: 'subject-start', phase: request.phase, workload: request.workload.name,
      requestedRepeat: request.repeat ?? null, requestedWarmupScans: request.warmupScans ?? null });
    const result = await runSubject(request, progress);
    progress({ event: 'subject-result', result });
    return result;
  } catch (error) {
    progress({ event: 'subject-error', error: String(error.stack ?? error) });
    throw error;
  } finally { closeSync(fd); }
}
async function runSubject(request, progress) {
  assert.equal(process.arch, CONFIG.architecture);
  const runtime = process.versions.bun ? 'bun' : 'node';
  assert.equal(runtime === 'bun' ? process.versions.bun : process.versions.node, CONFIG.runtimes[runtime]);
  const workload = canonicalWorkload(request.workload), api = await import(request.entryUrl);
  const { expected, identity, limits, observations: fixtureObservations } = checkFixture(api, workload);
  progress({ event: 'limits', limits, expected, identity, fixtureObservations });
  let stage = 'warmup', batchOrdinal = 0;
  const timed = repeat => {
    assert(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= limits.repeatCap);
    // Exactly one fresh arena, never a precreated arena array. Preparation and
    // full validation are excluded; public mutation and natural growth are timed.
    const prepared = fixture(api, workload);
    assert.deepEqual(fixtureIdentity(api, prepared), identity, 'Batch input identity changed');
    const memoryBefore = process.memoryUsage();
    const start = performance.now(), result = runBatch(prepared, workload, repeat), ms = performance.now() - start;
    const memoryAfter = process.memoryUsage();
    // Preserve a completed timing boundary even if untimed validation fails.
    progress({ event: 'batch-measured', stage, batchOrdinal, repeat, ms,
      checksum: result.checksum, rootSink: result.rootSink, processMemory: { before: memoryBefore, after: memoryAfter } });
    const observations = verifyBatch(prepared, workload, repeat, result);
    const batch = { ms, observations: { repeat, ...observations, processMemory: { before: memoryBefore, after: memoryAfter } } };
    progress({ event: 'batch', stage, batchOrdinal: batchOrdinal++, ...batch });
    return batch;
  };
  const warm = (batch, requiredScans, requireTime) => {
    const result = { scans: 0, ms: 0, batches: [], capped: false, capReasons: [], worstUsedBytes: 0 }, started = performance.now();
    const cap = reason => { result.capped = true; result.capReasons.push(reason); };
    while (result.scans < requiredScans || requireTime && result.ms < CONFIG.warmupTargetMs) {
      if (performance.now() - started >= CONFIG.pilotWarmupLimitMs) { cap('wall-time'); break; }
      if (result.batches.length >= limits.maxWarmupBatches) { cap('batch-count'); break; }
      if (result.scans >= limits.maxWarmupScans) { cap('iteration-count'); break; }
      const desired = requiredScans > result.scans ? Math.min(batch, requiredScans - result.scans) : batch;
      const repeat = Math.min(desired, limits.maxWarmupScans - result.scans);
      const worstUsedBytes = limits.initialUsedBytes + limits.worstBytesPerIteration * repeat;
      if (result.worstUsedBytes + worstUsedBytes > limits.warmupUsedByteCap) { cap('cumulative-used-bytes'); break; }
      const { ms, observations } = timed(repeat);
      result.scans += repeat; result.ms += ms; result.worstUsedBytes += worstUsedBytes;
      result.batches.push({ repeat, ms, observations });
      // Only disposable pilot warmup adapts batch size. Measured warmup uses
      // the controller's fixed, whole-batch, equal-work prescription.
      if (requireTime && ms < CONFIG.batchTargetMs) batch = Math.min(limits.repeatCap,
        Math.ceil(batch * Math.min(12, Math.max(1.1, CONFIG.batchTargetMs / Math.max(ms, 0.001)))));
    }
    result.wallMs = performance.now() - started;
    progress({ event: 'warmup-finished', requiredScans, requireTime, warmup: result });
    return result;
  };
  if (request.phase === 'pilot') {
    const work = workload.operation === 'entries' ? workload.size : workload.operationsPerIteration;
    let repeat = Math.min(limits.repeatCap, Math.max(1, Math.floor(65536 / Math.max(1, work))));
    const warmup = warm(repeat, repeat, true), calibration = [];
    repeat = Math.max(repeat, warmup.batches.at(-1)?.repeat ?? repeat);
    let capped = false, minMsPerIteration = null, decision;
    stage = 'calibration';
    for (let step = 0; step < 16; step++) {
      const batches = Array.from({ length: 3 }, () => timed(repeat)), samples = batches.map(batch => batch.ms);
      const fastest = Math.min(...samples);
      decision = calibrationDecision({ repeat, repeatCap: limits.repeatCap,
        repeatCapReason: limits.repeatCapReason, samples, step });
      calibration.push({ repeat, samples, variance: variation(samples), observations: batches.map(batch => batch.observations), decision });
      progress({ event: 'calibration-step', step, ...calibration.at(-1) });
      minMsPerIteration = fastest / repeat;
      if (decision.stop) { capped = decision.capped; break; }
      repeat = Math.min(CONFIG.repeatLimit, limits.repeatCap,
        Math.ceil(repeat * Math.min(12, Math.max(1.1, CONFIG.batchTargetMs * 1.5 / Math.max(fastest, 0.001)))));
    }
    return { phase: 'pilot', runtime, expected, identity, limits, fixtureObservations, repeat, minMsPerIteration, warmup, calibration, capped,
      memoryCeilingReached: decision.memoryCeilingReached, normalTargetMiss: decision.normalTargetMiss, calibrationDecision: decision,
      invalid: [...(capped ? ['pilot-calibration-capped'] : []), ...(warmup.capped ? ['pilot-warmup-capped'] : []),
        ...(capped ? ['pilot-calibration-cap:' + decision.reason] : []),
        ...warmup.capReasons.map(reason => 'pilot-warmup-cap:' + reason),
        ...(warmup.batches.some(batch => !Number.isFinite(batch.ms) || batch.ms <= 0) ? ['pilot-invalid-warmup-duration'] : []),
        ...(calibration.some(step => step.samples.some(ms => !Number.isFinite(ms) || ms <= 0)) ? ['pilot-invalid-duration'] : []),
        ...(warmup.ms < CONFIG.warmupFloorMs ? ['pilot-warmup-below-floor'] : [])] };
  }
  assert.equal(request.phase, 'measure');
  assert(Number.isSafeInteger(request.repeat) && request.repeat > 0 && request.repeat <= Math.min(CONFIG.repeatLimit, limits.repeatCap));
  assert(Number.isSafeInteger(request.warmupScans) && request.warmupScans > 0 && request.warmupScans <= limits.maxWarmupScans);
  assert.equal(request.warmupScans % request.repeat, 0, 'Common warmup must use whole batches');
  const warmup = warm(request.repeat, request.warmupScans, false);
  stage = 'measurement';
  const batches = Array.from({ length: CONFIG.samples }, () => timed(request.repeat)), samples = batches.map(batch => batch.ms);
  return { phase: 'measure', runtime, expected, identity, limits, fixtureObservations, repeat: request.repeat,
    prescribedWarmupScans: request.warmupScans, warmup, samples, observations: batches.map(batch => batch.observations),
    batchMs: variation(samples), msPerIteration: variation(samples.map(ms => ms / request.repeat)),
    msPerOperation: variation(samples.map(ms => ms / (request.repeat * workload.operationsPerIteration))),
    targetMisses: { batches: samples.filter(ms => ms < CONFIG.batchTargetMs).length, warmup: warmup.ms < CONFIG.warmupTargetMs },
    invalid: [...(warmup.capped ? ['warmup-capped'] : []), ...(warmup.scans !== request.warmupScans ? ['warmup-work-short'] : []),
      ...warmup.capReasons.map(reason => 'warmup-cap:' + reason),
      ...(warmup.batches.some(batch => !Number.isFinite(batch.ms) || batch.ms <= 0) ? ['invalid-warmup-duration'] : []),
      ...(warmup.ms < CONFIG.warmupFloorMs ? ['warmup-below-floor'] : []),
      ...(samples.some(ms => ms < CONFIG.batchFloorMs) ? ['sample-below-floor'] : []),
      ...(samples.some(ms => !Number.isFinite(ms) || ms <= 0) ? ['invalid-duration'] : [])] };
}
