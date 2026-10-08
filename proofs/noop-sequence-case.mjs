import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CASES, inputs, makeFixture, writeSequence, storage, validate, changedOperations, repeatCap, PAYLOAD_CAP, MIN_BATCH_MS, checkFixtures } from './noop-sequence-workloads.mjs';
import { median } from './noop-sequence-source.mjs';

export async function subject(config) {
  const S = await import(pathToFileURL(config.module).href);
  if (config.mode === 'checks') return { mode: 'checks', runtime: process.versions, rows: checkFixtures(S, config.reuse) };
  assert(['pilot', 'measure'].includes(config.mode));
  const workload = CASES.find(c => c.name === config.name); assert(workload);
  const gc = typeof Bun === 'undefined' ? globalThis.gc : () => Bun.gc(true);
  assert.equal(typeof gc, 'function', 'Node requires --expose-gc');
  const { expected, pattern } = inputs(workload);
  // Only these two handles persist between batches. Clear both before replacing
  // the module's current arena and collecting the previous batch's arena.
  let source = null, latest = null;
  function setup() {
    source = null; latest = null; S.resetSharedList(); gc();
    source = makeFixture(S, workload, expected); latest = source;
    const before = storage(S, source); gc();
    return before;
  }
  const initial = setup(), cap = repeatCap(workload, initial.used);
  function batch(repeat) {
    assert(Number.isSafeInteger(repeat) && repeat >= 20 && repeat % 20 === 0 && repeat <= cap);
    const before = setup(); assert.equal(before.used, initial.used);
    const start = performance.now();
    latest = writeSequence(latest, workload.index, pattern, repeat);
    const ms = performance.now() - start;
    const after = storage(S, latest);
    validate(latest, source, expected);
    const allocated = after.used - before.used;
    assert.equal(allocated, workload.bytesPerWrite * (config.reuse ? changedOperations(workload, repeat) : repeat));
    assert(after.used - 65536 <= PAYLOAD_CAP, 'Payload cap exceeded');
    return { repeat, ms, fixtureUsed: before.used, allocated, used: after.used,
      backingBytesBefore: before.byteLength, backingBytesAfter: after.byteLength, changed: changedOperations(workload, repeat) };
  }
  if (config.mode === 'pilot') {
    const warm = [], warmRepeat = Math.min(cap, 20000);
    // Pilot work is excluded from inference. Measured subjects use a common
    // frozen warmup schedule derived from both pilot durations below.
    for (let i = 0; i < 5; i++) warm.push(batch(warmRepeat));
    const calibration = []; let repeat = 20;
    for (;;) {
      const record = batch(repeat); calibration.push(record);
      if (record.ms >= MIN_BATCH_MS * 1.5 || repeat === cap) break;
      repeat = Math.min(cap, Math.ceil(repeat * Math.min(8, Math.max(1.5, MIN_BATCH_MS * 1.8 / Math.max(record.ms, 0.001))) / 20) * 20);
    }
    return { mode: 'pilot', cap, repeat, fixtureUsed: initial.used, warm, calibration, runtime: process.versions };
  }
  assert(config.repeat <= cap && config.cap === cap, 'Frozen repeat plan changed');
  assert(Number.isSafeInteger(config.warmBatches) && config.warmBatches >= 5 && config.warmBatches <= 100);
  const warm = Array.from({ length: config.warmBatches }, () => batch(config.repeat));
  const samples = Array.from({ length: 11 }, () => batch(config.repeat));
  const warmTimedMs = warm.reduce((sum, row) => sum + row.ms, 0), flags = [];
  if (samples.some(s => s.ms < MIN_BATCH_MS)) flags.push('batch-below-10ms');
  if (warmTimedMs < 100) flags.push('warm-work-below-100ms');
  if (config.pilotCappedBelowFloor) flags.push('pilot-cap-below-10ms');
  return { mode: 'measure', cap, repeat: config.repeat, warm, warmTimedMs, samples, medianMs: median(samples.map(s => s.ms)), flags, runtime: process.versions };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await subject(JSON.parse(process.argv[2]))));
