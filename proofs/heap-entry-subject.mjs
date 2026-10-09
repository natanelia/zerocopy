import assert from 'node:assert/strict';
import { CONFIG, variation } from './heap-entry-protocol.mjs';
import { fixture, fixtureIdentity, consume, scan, expectedBatch } from './heap-entry-workloads.mjs';
export async function subject(request) {
  assert.equal(process.arch, CONFIG.architecture);
  const runtime = process.versions.bun ? 'bun' : 'node';
  assert.equal(runtime === 'bun' ? process.versions.bun : process.versions.node, CONFIG.runtimes[runtime]);
  const api = await import(request.entryUrl), { item, expected } = fixture(api, request.workload);
  assert.deepEqual(consume(item, request.workload), expected, 'untimed expected value/priority checksums');
  const identity = fixtureIdentity(api, item);
  const timed = repeat => {
    const start = performance.now(), checksum = scan(item, request.workload, repeat), ms = performance.now() - start;
    // Validate and escape the actual timed result after the measurement boundary.
    assert.deepEqual(checksum, expectedBatch(expected, repeat), 'timed value/priority checksums');
    globalThis.__heapEntrySink = checksum;
    return ms;
  };
  const warm = (batch, requiredScans, requireTime) => {
    const result = { scans: 0, ms: 0, batches: [], capped: false }, started = performance.now();
    while (result.scans < requiredScans || requireTime && result.ms < CONFIG.warmupTargetMs) {
      if (performance.now() - started >= CONFIG.pilotWarmupLimitMs) { result.capped = true; break; }
      const repeat = requiredScans > result.scans ? Math.min(batch, requiredScans - result.scans) : batch;
      const ms = timed(repeat); result.scans += repeat; result.ms += ms; result.batches.push({ repeat, ms });
    }
    result.wallMs = performance.now() - started;
    return result;
  };
  if (request.phase === 'pilot') {
    let repeat = Math.max(1, Math.floor(4096 / Math.max(1, request.workload.size)));
    const warmup = warm(repeat, repeat, true), calibration = [];
    let capped = false, minMsPerIteration = null;
    for (let step = 0; step < 16; step++) {
      const samples = Array.from({ length: 3 }, () => timed(repeat)), fastest = Math.min(...samples);
      calibration.push({ repeat, samples, variance: variation(samples) }); minMsPerIteration = fastest / repeat;
      if (fastest >= CONFIG.batchTargetMs * 1.25) break;
      if (repeat === CONFIG.repeatLimit || step === 15) { capped = true; break; }
      repeat = Math.min(CONFIG.repeatLimit, Math.ceil(repeat * Math.min(12, Math.max(1.1, CONFIG.batchTargetMs * 1.5 / Math.max(fastest, 0.001)))));
    }
    return { phase: 'pilot', runtime, expected, identity, repeat, minMsPerIteration, warmup, calibration, capped,
      invalid: [...(capped ? ['pilot-calibration-capped'] : []), ...(warmup.capped ? ['pilot-warmup-capped'] : []),
        ...(warmup.ms < CONFIG.warmupFloorMs ? ['pilot-warmup-below-floor'] : [])] };
  }
  assert.equal(request.phase, 'measure');
  assert(Number.isSafeInteger(request.repeat) && request.repeat > 0 && request.repeat <= CONFIG.repeatLimit);
  assert(Number.isSafeInteger(request.warmupScans) && request.warmupScans > 0);
  const warmup = warm(request.repeat, request.warmupScans, false);
  const samples = Array.from({ length: CONFIG.samples }, () => timed(request.repeat));
  return { phase: 'measure', runtime, expected, identity, repeat: request.repeat, prescribedWarmupScans: request.warmupScans, warmup, samples,
    batchMs: variation(samples), msPerIteration: variation(samples.map(ms => ms / request.repeat)),
    targetMisses: { batches: samples.filter(ms => ms < CONFIG.batchTargetMs).length, warmup: warmup.ms < CONFIG.warmupTargetMs },
    invalid: [...(warmup.capped ? ['warmup-capped'] : []), ...(warmup.scans !== request.warmupScans ? ['warmup-work-short'] : []),
      ...(warmup.ms < CONFIG.warmupFloorMs ? ['warmup-below-floor'] : []),
      ...(samples.some(ms => ms < CONFIG.batchFloorMs) ? ['sample-below-floor'] : []),
      ...(samples.some(ms => !Number.isFinite(ms) || ms <= 0) ? ['invalid-duration'] : [])] };
}
