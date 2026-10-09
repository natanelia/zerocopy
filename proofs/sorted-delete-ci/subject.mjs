// Only explicit admitted calibrate/measure modes read the operation clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {median, summary} from './math.mjs';
import {untimedCounts, arenaFootprint, createTemplate, prepareChunk, performDeletes, cacheSummary,
  verifyPostCache, validateOutputs, correctnessPrelude, bytesDigest} from './fixtures.mjs';

export function bodyWithClock(mode, body, clock = () => performance.now()) {
  assert(['untimed', 'calibrate', 'measure'].includes(mode));
  if (mode === 'untimed') { body(); return null; }
  const start = clock(); body(); return clock() - start;
}
export function requireTimedAdmission(config, directory) {
  if (config.mode === 'untimed') return;
  const admission = JSON.parse(readFileSync(path.join(directory, 'admission.json')));
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json')));
  assert.equal(admission.mode, 'ci-screen'); assert.equal(admission.promotionAllowed, false);
  assert.deepEqual(admission.fullStandardGateStatus, {baseline: 'passed-fresh-exact-source', candidate: 'passed-fresh-exact-source'});
  assert(['baseline', 'candidate'].includes(config.arm));
  assert.equal(path.resolve(config.entrypoint), path.join(manifest.sources[config.arm].path, 'dist/shared.js'));
}

export async function main() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const protocol = JSON.parse(readFileSync(path.join(directory, 'protocol.json'), 'utf8'));
  assert(['untimed', 'calibrate', 'measure'].includes(config.mode));
  assert.equal(process.arch, protocol.architecture);
  const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
  assert.equal(runtime, config.runtime);
  assert.equal(runtime === 'node' ? process.version : Bun.version, protocol.runtimeVersions[runtime]);
  // Fail before importing the arm or reaching any operation clock if admission is absent.
  requireTimedAdmission(config, directory);
  const api = await import(pathToFileURL(config.entrypoint).href);
  api.configureMemory({maximumBytes: protocol.memory.maximumArenaBytes});
  const collect = runtime === 'bun' ? () => Bun.gc(true) : () => { assert.equal(typeof globalThis.gc, 'function'); globalThis.gc(); };
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const timed = config.mode !== 'untimed';
  let highRss = 0, highSummedArenaCapacity = 0, chunks = 0;

  function resources(arenas = [], measured = [], outputSlots = 0) {
    const memory = process.memoryUsage(); highRss = Math.max(highRss, memory.rss);
    assert(memory.rss <= protocol.memory.maximumSubjectRssBytes, 'Subject RSS limit includes all owners, retained outputs and setup');
    const footprint = arenaFootprint(arenas, measured, outputSlots, protocol.memory.maximumArenaBytes);
    highSummedArenaCapacity = Math.max(highSummedArenaCapacity, footprint.summedArenaCapacity);
    return {rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
      external: memory.external, arrayBuffers: memory.arrayBuffers ?? null,
      ...footprint};
  }
  function chunk(spec, template, operations, phase) {
    assert(spec.ladder.includes(operations), 'Untimed and timed work both use literal ladder entries');
    let bundle = prepareChunk(api, spec, template, operations,
      measured => resources([...template.owners, ...measured], measured));
    let outputs = new Array(operations).fill(null);
    collect();
    const before = resources(bundle.allOwners, bundle.measuredOwners, operations);
    const beforeCache = cacheSummary(bundle.measuredOwners);
    let retained = new Map(bundle.measuredOwners.map(arena => [arena, {
      used: arena.used, capacity: arena.memory.buffer.byteLength,
      payload: bytesDigest(arena.buf.subarray(65536, arena.used)),
    }]));
    const durationMs = bodyWithClock(config.mode, () => performDeletes(spec, bundle, outputs));
    const afterBody = resources(bundle.allOwners, bundle.measuredOwners, operations);
    const afterCache = cacheSummary(bundle.measuredOwners);
    verifyPostCache(spec, bundle); // Before validation lookups can move cache roots.
    validateOutputs(spec, template, bundle, outputs, retained);
    const afterValidation = resources(bundle.allOwners, bundle.measuredOwners, operations);
    const payloads = [...retained.values()].map(value => value.payload);
    const state = {sourceRoots: bundle.sources.length, owners: bundle.measuredOwners.length,
      sourceSize: spec.size, queryDigest: bundle.queryDigest,
      retainedPayloadDigests: payloads, beforeCache, afterCache};
    outputs = null; bundle = null; retained = null;
    collect(); const afterCleanup = resources(template.owners);
    chunks++;
    return {phase, operation: 'delete', operations, durationMs,
      nsPerOperation: timed ? durationMs * 1e6 / operations : null,
      units: protocol.units, state, before, afterBody, afterValidation, afterCleanup};
  }
  emit({kind: 'start', mode: config.mode, runtime, version: runtime === 'node' ? process.version : Bun.version,
    pid: process.pid, arch: process.arch, untimedMinimum: protocol.untimedMinimum});
  if (!timed) emit({kind: 'correctness-prelude', ...(await correctnessPrelude(api))});
  const offset = config.block ?? 0;
  const cases = [...protocol.cases.slice(offset), ...protocol.cases.slice(0, offset)];
  for (const spec of cases) {
    let template = createTemplate(api, spec); const rows = [];
    resources(template.owners);
    if (config.mode === 'untimed') {
      const [minimum, maximum] = untimedCounts(spec);
      rows.push(chunk(spec, template, minimum, 'untimed-minimum'));
      rows.push(chunk(spec, template, maximum, 'untimed-maximum'));
    } else if (config.mode === 'calibrate') {
      for (let i = 0; i < protocol.calibration.warmupChunks; i++) rows.push(chunk(spec, template, spec.ladder.at(-1), 'calibration-warmup'));
      const warmupBodyMs = rows.reduce((sum, x) => sum + x.durationMs, 0);
      emit({kind: 'calibration-diagnostics', case: spec.id, warmupBodyMs,
        insufficientWarmup: warmupBodyMs < protocol.calibration.minimumWarmupBodyMs});
      for (const operations of spec.ladder) for (let sample = 0; sample < protocol.calibration.samplesPerLevel; sample++) rows.push({...chunk(spec, template, operations, 'calibration'), sample});
    } else {
      const work = config.work[spec.id]; assert(work && spec.ladder.includes(work.operations));
      for (let i = 0; i < protocol.measurement.warmupChunks; i++) rows.push({...chunk(spec, template, work.operations, 'warmup'), sample: i});
      for (let i = 0; i < protocol.measurement.samples; i++) rows.push({...chunk(spec, template, work.operations, 'measurement'), sample: i});
      const warm = rows.filter(x => x.phase === 'warmup').map(x => x.durationMs);
      const measured = rows.filter(x => x.phase === 'measurement'), window = protocol.measurement.warmupComparisonWindow;
      const relativeWarmupDrift = median(warm.slice(-window)) / median(warm.slice(-2 * window, -window)) - 1;
      const warmupBodyMs = warm.reduce((sum, x) => sum + x, 0);
      const stats = summary(measured.map(x => x.nsPerOperation));
      emit({kind: 'diagnostics', case: spec.id, calibrationFloor: !work.targetMet,
        calibrationWarmupFlag: work.calibrationWarmupFlag,
        minimumDurationFloor: measured.some(x => x.durationMs < protocol.measurement.minimumChunkMs),
        warmupBodyMs, insufficientWarmup: warmupBodyMs < protocol.measurement.minimumWarmupBodyMs,
        relativeWarmupDrift, warmupFlag: Math.abs(relativeWarmupDrift) > protocol.measurement.warmupDriftFraction,
        variabilityFlag: stats.relativeMad > protocol.statistics.sampleRelativeMadDiagnosticFraction, stats});
    }
    emit({kind: 'case', case: spec.id, operation: 'delete', inputDigest: template.inputDigest, rows});
    template = null;
    if (spec.kind === 'control') api.resetMap(); else api.resetSortedMap();
    collect(); resources();
  }
  api.resetMap(); api.resetSortedMap(); collect(); resources();
  emit({kind: 'complete', chunks, highRss, highSummedArenaCapacity, operationClocks: timed, resourceUsage: process.resourceUsage()});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
