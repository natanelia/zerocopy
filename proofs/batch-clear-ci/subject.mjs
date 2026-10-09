// Only explicit calibrate/measure modes read the operation clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {median, summary} from './math.mjs';
import {fixture, setup, runBody, validateMap, semanticState, digest, bytesDigest, normalize} from './fixtures.mjs';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

// Verified for the pinned Linux Node/Bun process.resourceUsage API.
// Linux ru_maxrss is KiB; process.memoryUsage and backing capacities use bytes.
export function resourceSummary(resourceUsage) {
  return {resourceUsage, resourceUsageUnits: {maxRSS: 'KiB', bytesPerMaxRSSUnit: 1024},
    maxRSSBytes: resourceUsage.maxRSS * 1024,
    resourceUsageScope: 'Process-reported high-water RSS; separate from sampled RSS and per-Arena backing capacity'};
}

export async function runSubject(config) {
  const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
  assert(['untimed', 'calibrate', 'measure'].includes(config.mode));
  assert(['baseline', 'candidate'].includes(config.arm));
  assert.equal(process.arch, protocol.architecture); assert.equal(process.platform, 'linux');
  const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
  assert.equal(runtime, config.runtime);
  assert.equal(runtime === 'node' ? process.version : Bun.version, protocol.runtimeVersions[runtime]);
  const timed = config.mode !== 'untimed';
  if (!timed) Object.defineProperty(performance, 'now', {value: () => { throw Error('Operation clocks forbidden in untimed mode'); }, configurable: false});
  const api = await import(pathToFileURL(config.entrypoint).href);
  api.configureMemory({maximumBytes: protocol.memory.maximumArenaBytes});
  const collect = runtime === 'bun' ? () => Bun.gc(true) : () => { assert.equal(typeof globalThis.gc, 'function'); globalThis.gc(); };
  let highRss = 0, chunks = 0;
  function memory() {
    const m = process.memoryUsage(); highRss = Math.max(highRss, m.rss);
    assert(m.rss <= protocol.memory.maximumSubjectRssBytes, 'Subject RSS ceiling'); return m;
  }
  function reset(spec) { if (spec.shape === 'sorted') api.resetSortedMap(); else api.resetMap(); }
  function chunk(spec, input, operations, phase) {
    assert(spec.ladder.includes(operations));
    reset(spec); collect(); memory();
    let root = setup(api, spec, input);
    collect(); // Symmetric post-setup GC outside every measured body.
    const retainedUsed = root.arena.used, beforeCapacity = root.arena.memory.buffer.byteLength;
    const retainedPayload = bytesDigest(root.arena.buf.subarray(65536, retainedUsed));
    const descriptor = root.toWorkerData();
    const started = timed ? performance.now() : null;
    let result = runBody(api, spec, root, input, operations);
    const durationMs = timed ? performance.now() - started : null;
    const semantics = semanticState(root, result.output, retainedUsed);
    assert.equal(result.checksum, operations * spec.resultSize); assert(Number.isSafeInteger(result.checksum));
    assert.deepEqual(root.toWorkerData(), descriptor); assert.equal(semantics.sourceOldPrefix, retainedPayload);
    if (spec.operation === 'compact') {
      assert.notEqual(result.output.arena, root.arena); assert.equal(root.arena.used, retainedUsed);
      assert.equal(root.arena.memory.buffer.byteLength, beforeCapacity);
    } else { assert.equal(result.output.arena, root.arena); assert(root.arena.used > retainedUsed); }
    assert(semantics.sourceCapacity <= protocol.memory.maximumArenaBytes);
    assert(semantics.outputCapacity <= protocol.memory.maximumArenaBytes);
    const outputEntries = validateMap(result.output, input.expected);
    const oldExpected = new Map(input.seed.map(([k, v]) => [normalize(k), v]));
    const sourceEntries = validateMap(root, oldExpected);
    if (spec.operation === 'setMany') for (const [k] of input.entries) {
      assert.equal(root.has(k), oldExpected.has(normalize(k)));
      assert.equal(result.output.get(k), input.expected.get(normalize(k)));
    }
    assert.equal(bytesDigest(root.arena.buf.subarray(65536, retainedUsed)), retainedPayload);
    assert.equal(digest([input.entries, input.seed]), input.inputDigest);
    const afterValidation = memory(), checksum = result.checksum;
    result = null; root = null; reset(spec); collect();
    const afterCleanup = memory(); chunks++;
    return {phase, operation: spec.operation, operations, publicCalls: operations, itemsPerOperation: spec.itemsPerOperation,
      durationMs, nsPerOperation: timed ? durationMs * 1e6 / operations : null,
      nsPerInputEntry: timed ? durationMs * 1e6 / operations / spec.itemsPerOperation : null,
      checksum, retainedUsed, beforeCapacity, retainedPayload, semantics, outputEntries, sourceEntries, afterValidation, afterCleanup};
  }
  emit({kind: 'start', mode: config.mode, runtime, arm: config.arm, version: runtime === 'node' ? process.version : Bun.version, pid: process.pid, arch: process.arch});
  const offset = config.block ?? 0;
  const cases = [...protocol.cases.slice(offset), ...protocol.cases.slice(0, offset)];
  for (const spec of cases) {
    const input = fixture(spec), rows = [];
    if (config.mode === 'untimed') {
      rows.push(chunk(spec, input, spec.ladder[0], 'untimed-minimum'));
      rows.push(chunk(spec, input, spec.ladder.at(-1), 'untimed-maximum'));
    } else if (config.mode === 'calibrate') {
      for (let i = 0; i < protocol.calibration.warmupChunks; i++) rows.push(chunk(spec, input, spec.ladder.at(-1), 'calibration-warmup'));
      const warmupBodyMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
      emit({kind: 'calibration-diagnostics', case: spec.id, warmupBodyMs, insufficientWarmup: warmupBodyMs < protocol.calibration.minimumWarmupBodyMs});
      for (const operations of spec.ladder) for (let sample = 0; sample < protocol.calibration.samplesPerLevel; sample++) rows.push({...chunk(spec, input, operations, 'calibration'), sample});
    } else {
      const work = config.work[spec.id]; assert(work && spec.ladder.includes(work.operations));
      for (let i = 0; i < protocol.measurement.warmupChunks; i++) rows.push({...chunk(spec, input, work.operations, 'warmup'), sample: i});
      for (let i = 0; i < protocol.measurement.samples; i++) rows.push({...chunk(spec, input, work.operations, 'measurement'), sample: i});
      const warm = rows.filter(row => row.phase === 'warmup').map(row => row.durationMs);
      const measurement = rows.filter(row => row.phase === 'measurement');
      const window = protocol.measurement.warmupComparisonWindow;
      const relativeWarmupDrift = median(warm.slice(-window)) / median(warm.slice(-2 * window, -window)) - 1;
      const warmupBodyMs = warm.reduce((sum, x) => sum + x, 0);
      const stats = summary(measurement.map(row => row.nsPerOperation));
      emit({kind: 'diagnostics', case: spec.id, calibrationFloor: !work.targetMet, calibrationWarmupFlag: work.calibrationWarmupFlag,
        minimumDurationFloor: measurement.some(row => row.durationMs < protocol.measurement.minimumChunkMs), warmupBodyMs,
        insufficientWarmup: warmupBodyMs < protocol.measurement.minimumWarmupBodyMs, relativeWarmupDrift,
        warmupFlag: Math.abs(relativeWarmupDrift) > protocol.measurement.warmupDriftFraction,
        variabilityFlag: stats.relativeMad > protocol.statistics.sampleRelativeMadDiagnosticFraction, stats});
    }
    emit({kind: 'case', case: spec.id, operation: spec.operation, unit: spec.unit, itemsPerOperation: spec.itemsPerOperation,
      inputDigest: input.inputDigest, expectedDigest: input.expectedDigest, inputEntries: input.entries.length, retainedRootEntries: input.seed.length, rows});
  }
  api.resetMap(); api.resetSortedMap(); collect(); memory();
  emit({kind: 'complete', chunks, highRss, ...resourceSummary(process.resourceUsage()), operationClocks: timed});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSubject(JSON.parse(readFileSync(process.argv[2], 'utf8')));
