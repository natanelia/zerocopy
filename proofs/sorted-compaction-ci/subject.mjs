// Only explicit calibrate/measure modes read the operation clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {median, summary} from './math.mjs';
import {fixture, setup, runBody, validate, reset, postBodyCache} from './fixtures.mjs';
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
  let highRss = 0, chunks = 0, nextBody = 0;
  function memory() {
    const m = process.memoryUsage(); highRss = Math.max(highRss, m.rss);
    assert(m.rss <= protocol.memory.maximumSubjectRssBytes, 'Subject RSS ceiling'); return m;
  }
  function chunk(spec, input, operations, phase) {
    assert(spec.ladder.includes(operations));
    reset(api); collect(); memory();
    let context = setup(api, spec, input, operations, protocol);
    collect(); memory(); // Setup, priming and GC are outside the body.
    const started = timed ? performance.now() : null;
    runBody(api, spec, input, context, operations);
    const durationMs = timed ? performance.now() - started : null;
    const observationId = `${config.id}/${nextBody++}`;
    emit({kind: 'body-observation', observationId, case: spec.id, phase, operations,
      durationMs, nsPerOperation: timed ? durationMs * 1e6 / operations : null, validated: false});
    const cacheAfterBody = postBodyCache(spec, input, context);
    let semantics;
    try { semantics = validate(spec, input, context, operations, protocol, config.arm); }
    finally { context.restore(); }
    const afterValidation = memory();
    context = null; reset(api); collect();
    const afterCleanup = memory(); chunks++;
    return {phase, operation: spec.operation, operations, publicCalls: operations, itemsPerOperation: spec.itemsPerOperation,
      durationMs, nsPerOperation: timed ? durationMs * 1e6 / operations : null,
      observationId, cacheAfterBody, semantics, afterValidation, afterCleanup};
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
      inputDigest: input.inputDigest, expectedDigest: input.expectedDigest, inputEntries: input.entries.length, retainedRootEntries: input.entries.length, rows});
  }
  api.resetMap(); api.resetSortedMap(); collect(); memory();
  emit({kind: 'complete', chunks, highRss, ...resourceSummary(process.resourceUsage()), operationClocks: timed});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSubject(JSON.parse(readFileSync(process.argv[2], 'utf8')));
