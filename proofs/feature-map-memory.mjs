/** Sequential fresh-process retained-memory comparison. No speed or benefit threshold. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, tmpdir, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_SCHEMA, METHOD, KINDS, READER_COUNTS, STAGES, READ_COUNT, EDIT_COUNT, STREAM_EDITS,
  PROCESS_TIMEOUT_MS, validateCase, validateStage, validateAnswers, summarize } from './feature-map-memory-model.mjs';
import { stageRuntime, sha256 } from './feature-map-memory-runtime.mjs';
import { queryIds } from '../website/assets/feature-core.mjs';
import { reference } from '../website/assets/feature-reference.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const output = resolve(process.env.FEATURE_MEMORY_OUT || join(root, 'proofs/results/feature-map-memory', startedAt.replaceAll(':', '-')));
const entries = Number(process.env.FEATURE_MEMORY_ENTRIES || 100000), trials = Number(process.env.FEATURE_MEMORY_TRIALS || 3);
const readerCounts = (process.env.FEATURE_MEMORY_READERS || READER_COUNTS.join(',')).split(',').map(Number);
const kinds = (process.env.FEATURE_MEMORY_KINDS || KINDS.join(',')).split(',');
assert.ok(Number.isSafeInteger(trials) && trials >= 1 && trials <= 10, 'Invalid trial count');
for (const values of [readerCounts, kinds]) {
  assert.ok(values.length, 'Empty case selection');
  assert.equal(new Set(values).size, values.length, 'Duplicate case selection');
}
for (const kind of kinds) for (const readers of readerCounts) validateCase({ kind, readers, entries });
const isFullMatrix = entries === 100000 && trials === 3 && kinds.length === KINDS.length && KINDS.every(kind => kinds.includes(kind))
  && readerCounts.length === READER_COUNTS.length && READER_COUNTS.every(readers => readerCounts.includes(readers));
const recordingType = isFullMatrix ? 'full-matrix' : 'diagnostic';
const intendedRunCount = trials * kinds.length * readerCounts.length;
if (existsSync(output)) assert.equal(readdirSync(output).length, 0, 'Use a new empty result directory; recordings are never overwritten');
mkdirSync(output, { recursive: true });
const writeJSON = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const proofHashes = () => Object.fromEntries(readdirSync(join(root, 'proofs')).filter(name => /^feature-map-memory.*\.(mjs|md)$/.test(name)).sort().map(name => [name, sha256(readFileSync(join(root, 'proofs', name)))]));
const hashesBefore = proofHashes();
const samples = [];
let runtime;

function runProcess(name, args, timeout) {
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  // Save both successful and failed process streams before parsing or assertions.
  writeFileSync(join(output, `${name}.stdout.jsonl`), run.stdout ?? '');
  writeFileSync(join(output, `${name}.stderr.log`), run.stderr ?? '');
  writeJSON(`${name}.process.json`, { command: process.execPath, args, timeoutMs: timeout, status: run.status, signal: run.signal,
    error: run.error ? { name: run.error.name, code: run.error.code, message: run.error.message } : null });
  assert.equal(run.error, undefined, `${name}: process error; see retained logs`);
  assert.equal(run.status, 0, `${name}: process failed; see retained logs\n${run.stderr ?? ''}`);
  return (run.stdout ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function verifyRecords(records, config) {
  const sequence = records.map(record => record.type === 'stage' ? `stage:${record.name}` : record.type === 'answer' ? `answer:${record.phase}:${record.retained}` : record.type);
  assert.deepEqual(sequence, ['config', 'baseline', 'stage:loaded', 'answer:cold:false', 'answer:warm:false', 'stage:queried',
    'answer:validation:false', 'answer:validation:true', 'stage:edited-retained', 'answer:validation:false', 'stage:released',
    'answer:validation:false', 'stage:streamed', 'stopped'], 'Incomplete or reordered process record');
  assert.deepEqual(records.filter(record => record.type === 'stage').map(record => record.name), STAGES);
  assert.equal(records[0].kind, config.kind); assert.equal(records[0].readers, config.readers); assert.equal(records[0].entries, config.entries);
  const baseline = records.find(record => record.type === 'baseline');
  assert.equal(baseline.threads.length, config.readers + 2);
  assert.ok(baseline.threads.every(thread => thread.arenas.length === 0), 'Baseline contains a collection root');
  for (const record of records.filter(record => record.type === 'stage')) validateStage(record, config);
  const ids = queryIds(config.entries), revisions = [0, 0, 1, 0, 1, STREAM_EDITS + 1];
  for (const [index, record] of records.filter(record => record.type === 'answer').entries()) validateAnswers(record.value, config, revisions[index], reference(config.entries, revisions[index], ids));
  const stopped = records.at(-1);
  assert.deepEqual(stopped.threads.map(thread => thread.role), ['controller'], 'Worker lifecycle did not finish');
  if (config.kind === 'shared') {
    const find = name => records.find(record => record.name === name).memory;
    assert.equal(find('loaded').wasmCapacityBytes, find('queried').wasmCapacityBytes, 'Read queries allocated shared capacity');
    assert.equal(find('loaded').arenaUsedBytes, find('queried').arenaUsedBytes, 'Read queries allocated arena bytes');
    assert.equal(find('edited-retained').wasmCapacityBytes, find('released').wasmCapacityBytes, 'Release unexpectedly reclaimed arena capacity');
    assert.equal(find('edited-retained').arenaUsedBytes, find('released').arenaUsedBytes, 'Release unexpectedly reclaimed arena allocations');
  }
}

try {
  runtime = mkdtempSync(join(tmpdir(), 'zerocopy-feature-map-memory-'));
  const modules = stageRuntime(root, runtime);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(git.status, 0, 'Cannot identify source commit');
  const sourceCommit = git.stdout.trim();
  const gitStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(gitStatus.status, 0, 'Cannot identify working-tree state');
  const runtimeSourceCommit = process.env.FEATURE_MEMORY_RUNTIME_SOURCE || process.env.FEATURE_MEMORY_SOURCE || sourceCommit;
  assert.match(runtimeSourceCommit, /^[a-f\d]{40}$/i, 'Record the full runtime source commit');
  const manifest = { schema: MEMORY_SCHEMA, method: METHOD, startedAt, sourceCommit, workingTreeDirty: Boolean(gitStatus.stdout.trim()), runtimeSourceCommit,
    recordingType, intendedRunCount, chartEligible: false,
    runtime: process.version, v8: process.versions.v8, platform: process.platform, osRelease: release(), arch: process.arch,
    cpu: cpus()[0]?.model, logicalCPUs: cpus().length, systemMemoryBytes: totalmem(), trials, entries, readerCounts, kinds,
    readCount: READ_COUNT, editCount: EDIT_COUNT, streamEdits: STREAM_EDITS, chartStage: 'edited-retained',
    warmup: 'Imported workers and MessageChannels; no collection allocation before baseline. Cold and warm denote the first and repeated request, not a process/JIT reset. The zero-reader owner can reuse decoded objects between its two jobs within the first request.',
    retainedAnswers: 'Each data isolate retains its latest bounded answer; the controller retains baseline usage records but no dataset or reference map.',
    nativeLifetime: 'Clone the current Map only if it is the retained initial root; mutate the exclusively owned latest Map on subsequent replacements.',
    ...modules, proofHashes: hashesBefore };
  writeJSON('manifest.json', manifest);
  const calibrationRecords = runProcess('calibration', ['--expose-gc', join(root, 'proofs/feature-map-memory-calibration.mjs')], 60000);
  assert.equal(calibrationRecords.length, 1);
  const calibration = calibrationRecords[0];
  writeJSON('calibration.json', calibration);
  for (let trial = 0; trial < trials; trial++) {
    const order = kinds.map((_, index) => kinds[(index + trial) % kinds.length]);
    for (const kind of order) for (const readers of readerCounts) {
      const config = { kind, readers, entries, runtime };
      const name = `${kind}-${readers}-trial-${trial + 1}`;
      const records = runProcess(name, ['--expose-gc', join(root, 'proofs/feature-map-memory-case.mjs'), JSON.stringify(config)], PROCESS_TIMEOUT_MS);
      const sample = { trial: trial + 1, kind, readers, entries, records };
      // Preserve parsed evidence even if independent validation rejects it.
      writeJSON(`${name}.json`, sample);
      verifyRecords(records, config);
      samples.push(sample);
      const edited = records.find(record => record.name === 'edited-retained');
      console.log(`${trial + 1}/${trials} ${kind} readers=${readers}: ${(edited.memory.retainedBytes / 1048576).toFixed(3)} MiB retained`);
    }
  }
  assert.deepEqual(proofHashes(), hashesBefore, 'Proof source changed during recording');
  // The executable inputs were staged before measurement; verify every staged byte stayed fixed.
  for (const [name, hash] of Object.entries(modules.hashes)) assert.equal(sha256(readFileSync(join(runtime, name))), hash, `Runtime module changed: ${name}`);
  for (const [name, hash] of Object.entries(modules.hashes).filter(([name]) => name.startsWith('assets/'))) assert.equal(sha256(readFileSync(join(root, 'website', name))), hash, `Website adapter changed during recording: ${name}`);
  assert.equal(samples.length, intendedRunCount, 'The complete declared matrix did not finish');
  const result = { ...manifest, status: 'verified', chartEligible: isFullMatrix, measuredAt: new Date().toISOString(), runCount: samples.length, calibration,
    dispersion: 'Median and observed minimum–maximum over fresh processes; no confidence interval or performance gate.', summary: summarize(samples) };
  writeJSON('summary.json', result);
  writeJSON('terminal.json', { status: 'verified', recordingType, chartEligible: isFullMatrix, completedAt: result.measuredAt, verifiedRuns: samples.length, intendedRunCount });
  console.log(`Verified ${samples.length} fresh-process runs; every current and retained answer matched the independent reference.`);
} catch (error) {
  const failure = { status: 'failed', recordingType, chartEligible: false, failedAt: new Date().toISOString(), verifiedRuns: samples.length, intendedRunCount, message: error.message, stack: error.stack };
  writeJSON('failure.json', failure);
  writeJSON('terminal.json', failure);
  throw error;
} finally { if (runtime) rmSync(runtime, { recursive: true, force: true }); }
