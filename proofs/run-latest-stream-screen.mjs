import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { protocol, randomSource, shuffle, scheduleCase, variantFor, summarizeCase, applyRunIntegrity } from './latest-stream-screen-protocol.mjs';
import { sha256, pinnedGuard, verifyPinnedSnapshot, verifyGate, sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment, treeManifest, proofFiles, proofFingerprint, createEvidenceDirectory } from './latest-stream-screen-guard.mjs';

export function readSubjectLog(path, expectedRequest) {
  const events = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const results = events.filter(row => row.event === 'result'); assert.equal(results.length, 1, 'Missing terminal subject result');
  const start = events[0]; assert.equal(start?.event, 'start'); assert.equal(events[1]?.event, 'setup');
  assert.equal(events.at(-1)?.event, 'result'); assert.deepEqual(events[1].metadata, start.metadata);
  if (expectedRequest) assert.deepEqual(start.request, expectedRequest, 'Subject request differs from controller plan');
  const { phase, config, repeat } = start.request, result = results[0].result;
  assert.equal(result.phase, phase);
  const batches = [];
  if (phase === 'verify') {
    assert.equal(result.verified, true); batches.push({ kind: 'verify', index: 0, repeat: 2 });
  } else if (phase === 'measure') {
    assert.equal(result.repeat, repeat); assert.equal(result.warmup.length, config.warmupBatches); assert.equal(result.measured.length, config.samples);
    for (const [kind, rows] of [['warmup', result.warmup], ['measured', result.measured]]) rows.forEach((row, index) => batches.push({ kind, index, repeat, row }));
  } else {
    assert.equal(phase, 'pilot'); assert.equal(result.warmup.length, 2);
    result.warmup.forEach((row, index) => batches.push({ kind: 'pilot-warmup', index, repeat: 1, row }));
    assert(result.calibration.length >= 1 && result.calibration.length <= config.pilotMaxSteps);
    let expectedRepeat = 1, calibrated = false;
    result.calibration.forEach((step, index) => {
      assert.equal(calibrated, false, 'Pilot continued after target was reached'); assert.equal(step.repeat, expectedRepeat);
      assert.equal(step.samples.length, config.pilotSamples);
      step.samples.forEach((row, n) => batches.push({ kind: 'pilot', index: index * config.pilotSamples + n, repeat: step.repeat, row }));
      const fastest = Math.min(...step.samples.map(row => row.elapsedMs)); calibrated = fastest >= config.pilotTargetMs;
      if (!calibrated && step.repeat === config.maxRepeats) assert.equal(index, result.calibration.length - 1);
      expectedRepeat = Math.min(config.maxRepeats, Math.max(step.repeat + 1, Math.ceil(step.repeat * config.pilotTargetMs / Math.max(fastest, .001))));
    });
    assert.equal(result.repeat, result.calibration.at(-1).repeat); assert.equal(result.capped, !calibrated);
    if (!calibrated) assert(result.calibration.length === config.pilotMaxSteps || result.repeat === config.maxRepeats, 'Pilot stopped before cap');
  }
  let offset = 2;
  for (const batch of batches) {
    let elapsedMs = phase === 'verify' ? null : 0;
    for (let n = 0; n < batch.repeat; n++) {
      const event = events[offset++]; assert.equal(event?.event, 'round'); assert.equal(event.kind, batch.kind); assert.equal(event.index, batch.index); assert.equal(event.repetition, n);
      const trace = event.trace;
      if (phase === 'verify') for (const key of ['elapsedMs', 'startNs', 'endNs', 'completionNs']) assert.equal(trace[key], null);
      else {
        assert(Number.isFinite(trace.elapsedMs) && trace.elapsedMs > 0);
        const start = BigInt(trace.startNs), end = BigInt(trace.endNs), completion = BigInt(trace.completionNs);
        assert(start <= end && end <= completion); assert.equal(trace.elapsedMs, Number(end - start) / 1e6); elapsedMs += trace.elapsedMs;
      }
    }
    const event = events[offset++]; assert.equal(event?.event, 'batch'); assert.equal(event.kind, batch.kind); assert.equal(event.index, batch.index);
    assert.deepEqual(event.row, { repeat: batch.repeat, elapsedMs, msPerBurst: phase === 'verify' ? null : elapsedMs / batch.repeat });
    if (batch.row) assert.deepEqual(event.row, batch.row);
  }
  assert.equal(offset, events.length - 1, 'Unexpected missing or additional subject events');
  const { updates, streams, consumer } = start.request.workload;
  const rounds = events.filter(row => row.event === 'round'); assert.equal(rounds.length, results[0].result.rounds);
  for (let index = 0; index < rounds.length; index++) {
    const t = rounds[index].trace, startVersion = index * updates;
    assert.equal(t.id, index); assert.equal(t.startVersion, startVersion); assert.equal(t.retainedInitialValid, true);
    assert.deepEqual(t.delivered, Array.from({ length: updates }, (_, n) => startVersion + n + 1));
    assert.deepEqual(t.deliveredValues, Array.from({ length: updates }, (_, n) => (n + 1) % 2));
    const expected = consumer === 'paused' ? [startVersion + updates] : t.delivered;
    assert.equal(t.consumed.length, streams); assert.equal(t.consumedValues.length, streams);
    for (let i = 0; i < streams; i++) { assert.deepEqual(t.consumed[i], expected); assert.deepEqual(t.consumedValues[i], expected.map(v => v % 2)); }
    assert.deepEqual(t.initialConsumed, consumer === 'waiting' ? Array(streams).fill(startVersion) : []);
    assert.deepEqual(t.overwritten, consumer === 'paused'
      ? { initialVersion: startVersion, updateVersions: t.delivered.slice(0, -1), perStreamCount: updates }
      : { updateVersions: [], perStreamCount: 0 });
  }
  return { result: results[0].result, metadata: start.metadata, traceRounds: rounds.length, rawSha256: sha256(readFileSync(path)) };
}

async function main() {
  const [baseline, candidate, output, mode, gatePath] = process.argv.slice(2);
  assert(baseline && candidate && output && ['--verify', '--measure'].includes(mode), 'Usage: node proofs/run-latest-stream-screen.mjs BASE_ROOT CANDIDATE_ROOT OUTPUT --verify|--measure [GATE.json]');
  const verifyOnly = mode === '--verify', proofRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  if (!verifyOnly) assert.equal(process.versions.node, protocol.toolchain.node, 'Timed controller requires exact pinned Node22');
  const comparison = pinnedGuard(proofRoot, resolve(baseline), resolve(candidate));
  const proofs = proofFingerprint(proofRoot);
  if (!verifyOnly) { assert(gatePath, 'Full unit gate receipt required before pilots'); verifyGate(JSON.parse(readFileSync(gatePath)), comparison, proofs); }
  const outputRoot = resolve(output); createEvidenceDirectory(outputRoot);
  const contexts = Object.fromEntries(['baseline', 'candidate'].map(v => [v, sourceContext(comparison[v].root)]));
  assert.deepEqual(contexts.baseline.packageBytes, contexts.candidate.packageBytes);
  for (const variant of ['baseline', 'candidate']) {
    const target = join(outputRoot, 'bundles', variant); mkdirSync(target, { recursive: true });
    cpSync(contexts[variant].dist, join(target, 'dist'), { recursive: true }); writeFileSync(join(target, 'package.json'), contexts[variant].packageBytes);
  }
  const proofDirectory = join(outputRoot, 'protocol'); mkdirSync(proofDirectory, { recursive: true });
  for (const file of proofFiles) cpSync(join(proofRoot, 'proofs', file), join(proofDirectory, file));
  cpSync(join(proofRoot, '.github/workflows/latest-stream-screen.yml'), join(proofDirectory, 'latest-stream-screen.yml'));
  if (gatePath) cpSync(gatePath, join(outputRoot, 'unit-gate.json'));
  const subjectBytes = readFileSync(new URL('./latest-stream-screen-subject.mjs', import.meta.url));
  const temp = realpathSync(mkdtempSync(join(os.tmpdir(), 'stream-screen-'))), canonical = join(temp, 'subject');
  const config = Object.fromEntries(['minimumBatchMs', 'pilotTargetMs', 'pilotSamples', 'pilotMaxSteps', 'maxRepeats', 'warmupBatches', 'samples', 'sessionTimeoutMs', 'fixtureEntries'].map(key => [key, protocol[key]]));
  const record = { status: 'running', integrityComplete: false, verifyOnly, startedAt: new Date().toISOString(),
    controller: { node: process.versions.node, platform: process.platform, arch: process.arch, cpus: os.cpus(), osRelease: os.release(), executable: realpathSync(process.execPath), environmentKeys: Object.keys(cleanEnvironment()).sort() },
    protocol, proofs, protocolFiles: treeManifest(proofDirectory), comparison, canonicalPath: canonical, rows: [], subjects: [] };
  const checkpoint = () => {
    for (const row of record.rows) if (!verifyOnly) row.summary = applyRunIntegrity(summarizeCase(row.blocks, row.pilots), record);
    writeFileSync(join(outputRoot, 'results.json'), JSON.stringify(record, null, 2) + '\n');
  };
  function subject(variant, request) {
    assert.deepEqual(proofFingerprint(proofRoot), proofs, 'Protocol source changed during study');
    for (const role of ['baseline', 'candidate']) verifyPinnedSnapshot(comparison[role]);
    const before = stageCanonical(contexts[variant], canonical, subjectBytes);
    const id = record.subjects.length, name = String(id).padStart(3, '0');
    const rawPath = join(outputRoot, `${name}.ndjson`), errPath = join(outputRoot, `${name}.stderr`);
    const receipt = { id, variant, request, startedAt: new Date().toISOString(), sourcePath: contexts[variant].root,
      canonicalPath: canonical, sourceBefore: treeManifest(contexts[variant].dist), canonicalBefore: before, rawFile: name + '.ndjson', stderrFile: name + '.stderr' };
    record.subjects.push(receipt); checkpoint();
    const out = openSync(rawPath, 'wx'), err = openSync(errPath, 'wx');
    let child;
    try {
      child = spawnSync(process.execPath, [join(canonical, 'subject.mjs'), JSON.stringify(request)], { cwd: canonical, env: cleanEnvironment(), stdio: ['ignore', out, err], timeout: protocol.subjectTimeoutMs });
    } finally {
      closeSync(out); closeSync(err);
      receipt.finishedAt = new Date().toISOString();
      receipt.status = child?.status ?? null; receipt.signal = child?.signal ?? null;
      receipt.error = child?.error?.message ?? null;
      try {
        receipt.canonicalAfter = checkAfterSubject(contexts[variant], canonical, before);
        receipt.sourceAfter = treeManifest(contexts[variant].dist);
        for (const role of ['baseline', 'candidate']) verifyPinnedSnapshot(comparison[role]);
        assert.deepEqual(proofFingerprint(proofRoot), proofs, 'Protocol source changed during subject');
      } catch (error) { receipt.integrityError = error.stack; throw error; }
      finally { checkpoint(); }
    }
    assert.equal(child.status, 0, `Subject ${id} failed; inspect retained ${errPath}`); assert.equal(child.signal, null);
    const result = readSubjectLog(rawPath, request);
    assert.equal(result.metadata.sharedPath, join(canonical, 'dist/shared.js')); assert.equal(result.metadata.workerPath, join(canonical, 'dist/worker.js'));
    assert.equal(result.metadata.subjectPath, join(canonical, 'subject.mjs')); assert.equal(result.metadata.node, process.versions.node);
    assert.equal(result.metadata.publisher.delivery, 'all'); assert.equal(result.metadata.publisher.maxPending, request.workload.updates);
    Object.assign(receipt, result); checkpoint(); return { id, result: result.result };
  }
  try {
    const random = randomSource(protocol.seed);
    for (let index = 0; index < protocol.cases.length; index++) {
      const workload = protocol.cases[index], row = { workload, pilots: {}, blocks: [] }; record.rows.push(row);
      if (verifyOnly) {
        row.verification = {};
        for (const variant of ['baseline', 'candidate']) row.verification[variant] = subject(variant, { workload, config, phase: 'verify' });
        continue;
      }
      row.pilotOrder = shuffle(['baseline', 'candidate'], random);
      for (const variant of row.pilotOrder) row.pilots[variant] = subject(variant, { workload, config, phase: 'pilot' });
      row.repeat = Math.max(...Object.values(row.pilots).map(p => p.result.repeat));
      row.schedule = scheduleCase(protocol.seed + index); checkpoint();
      // Pilot cap flags are retained and invalidate inference; no timing-driven retries.
      for (const planned of row.schedule) {
        const block = { ...planned, subjects: [] }; row.blocks.push(block);
        for (const role of planned.roles) {
          const variant = variantFor(planned.mode, role);
          block.subjects.push({ role, variant, ...subject(variant, { workload, config, phase: 'measure', repeat: row.repeat }) }); checkpoint();
        }
      }
    }
    assert.deepEqual(pinnedGuard(proofRoot, resolve(baseline), resolve(candidate)), comparison);
    for (const variant of ['baseline', 'candidate']) assert.deepEqual(treeManifest(join(outputRoot, 'bundles', variant, 'dist')), contexts[variant].distManifest);
    assert.deepEqual(treeManifest(proofDirectory), record.protocolFiles);
    assert.deepEqual(proofFingerprint(proofRoot), proofs);
    record.integrityComplete = true; record.status = 'completed';
  } catch (error) { record.status = 'failed'; record.error = error.stack; throw error; }
  finally { record.finishedAt = new Date().toISOString(); checkpoint(); }
  console.log(JSON.stringify({ status: record.status, verifyOnly, cases: record.rows.length, subjects: record.subjects.length, outputRoot }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
