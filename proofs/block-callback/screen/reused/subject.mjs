import assert from 'node:assert/strict';
import { CONFIG } from '../protocol.mjs';
export async function measureSingle({ entryUrl, harnessUrl, workload, phase, repeat: commonRepeat, warmupScans: commonWarmupScans }) {
  const S = await import(entryUrl), { fixture, equal, materialize } = await import(harnessUrl);
  const { item, expected } = fixture(S, workload), { operation, size } = workload;
  const allocating = operation === 'compact', reverse = operation.endsWith('Reverse');
  const want = reverse ? expected.slice().reverse() : expected;
  equal(materialize(allocating ? S.compact(item) : item, operation), want, 'pre-warm correctness');
  const expectedJson = JSON.stringify(want);
  let last;
  const scan = repeat => {
    let count = 0;
    if (allocating) for (let i = 0; i < repeat; i++) { last = S.compact(item); count += last.size; }
    else if (operation === 'forEach' || operation === 'forEachReverse') {
      for (let i = 0; i < repeat; i++) item[operation](value => { if (value !== undefined) count++; });
    } else for (let i = 0; i < repeat; i++) { last = item[operation](); count += last.length; }
    return count;
  };
  const gc = () => {
    if (!allocating) return 0;
    last = undefined;
    const start = performance.now();
    if (process.versions.bun) Bun.gc(true);
    else { if (typeof globalThis.gc !== 'function') throw new Error('Compaction requires --expose-gc'); globalThis.gc(); }
    return performance.now() - start;
  };
  const timed = repeat => {
    const start = performance.now(), count = scan(repeat), ms = performance.now() - start;
    if (count !== size * repeat) throw new Error('Scan count mismatch');
    return ms;
  };
  const warm = (batchRepeat, requiredScans, requireElapsedTime) => {
    const start = performance.now(), result = { scans: 0, batches: [], elapsedMs: 0, explicitGcMs: 0, gcCalls: 0, capped: false };
    while (result.scans < requiredScans || requireElapsedTime && result.elapsedMs < CONFIG.warmupMs) {
      if (performance.now() - start >= CONFIG.maxWarmupMs) { result.capped = true; break; }
      const batch = allocating ? CONFIG.compactGcEvery : batchRepeat;
      const count = result.scans < requiredScans ? Math.min(batch, requiredScans - result.scans) : batch;
      const ms = timed(count); result.batches.push({ repeat: count, ms }); result.scans += count; result.elapsedMs += ms;
      if (allocating) { result.explicitGcMs += gc(); result.gcCalls++; }
    }
    result.wallMs = performance.now() - start; return result;
  };
  const validateLast = () => {
    if (allocating && last) equal(last.toArray(), expected, 'last compaction');
    else if (last) equal(last, want, 'last array');
    globalThis.__blockTraversalSink = last;
  };
  if (phase === 'pilot') {
    let repeat = allocating ? 8 : size <= 32 ? 128 : 2;
    const warmup = warm(repeat, allocating ? CONFIG.compactWarmupCalls : Math.ceil(CONFIG.warmupMinElements / Math.max(1, size)), !allocating);
    const calibration = [], maximum = allocating ? CONFIG.compactMaxRepeat : CONFIG.scanMaxRepeat;
    for (let attempt = 0; attempt < 16; attempt++) {
      const samples = [], gcMs = [];
      for (let i = 0; i < 3; i++) { gcMs.push(gc()); samples.push(timed(repeat)); }
      validateLast(); calibration.push({ repeat, samples, explicitGcMs: gcMs });
      const fastest = Math.min(...samples), capped = repeat === maximum && fastest < CONFIG.targetBatchMs * 1.25;
      if (fastest >= CONFIG.targetBatchMs * 1.25 || capped) return { phase, expectedJson, repeat, minMsPerScan: fastest / repeat, warmup, calibration, repeatCapped: capped };
      repeat = Math.min(maximum, Math.ceil(repeat * Math.min(16, Math.max(1.1, CONFIG.targetBatchMs * 1.5 / Math.max(fastest, 0.001)))));
    }
    throw new Error(`Pilot failed to calibrate: ${workload.name}`);
  }
  assert.equal(phase, 'measure');
  assert.ok(Number.isSafeInteger(commonRepeat) && commonRepeat > 0);
  assert.ok(Number.isSafeInteger(commonWarmupScans) && commonWarmupScans > 0);
  if (allocating) { assert.equal(commonWarmupScans, CONFIG.compactWarmupCalls); assert.ok(commonRepeat <= CONFIG.compactMaxRepeat); }
  const warmup = warm(commonRepeat, commonWarmupScans, false), samples = [], explicitGcMs = [];
  for (let sample = 0; sample < CONFIG.samples; sample++) { explicitGcMs.push(gc()); samples.push(timed(commonRepeat)); }
  validateLast();
  return { phase, expectedJson, repeat: commonRepeat, prescribedWarmupScans: commonWarmupScans, warmup, samples, explicitGcMs,
    belowTargetBatches: samples.filter(ms => ms < CONFIG.measuredBatchFloorMs).length,
    warmupTimeShort: !allocating && warmup.elapsedMs < CONFIG.measuredWarmupFloorMs, warmupWorkShort: warmup.scans !== commonWarmupScans };
}
