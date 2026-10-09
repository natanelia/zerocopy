// The original subject, workload catalogue and statistical protocol are unchanged.
// This adapter consumes sealed builds and adds bounded, durable supervision.
import assert from 'node:assert/strict';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { CASES } from './trie-view-workloads.mjs';
import { CONFIG, studyFor, commonPlan, validatePilot, validateMeasured, summarize, gateStatus } from './trie-view-protocol.mjs';
import { fullManifest, prepareSubject, physicalReceipt, validateRecord, writeJson, requiredResult } from './trie-view-gate.mjs';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, TOOLCHAIN, sha256 } from './trie-view-source.mjs';
import { CLEANUP_TIMEOUT_MS, runBoundedCommand } from './trie-view-prerequisites.mjs';
import { INPUT, TIMING_PROOF_FILES, validateInput, verifyTimingIdentity, verifyTimingInvocation } from './radix-timing-input.mjs';

export const CONTROLLER_TIMEOUT_MS = 45 * 60 * 1000;
const repository = fileURLToPath(new URL('..', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); }
export function prepare(inputDirectory, directory, runtime) {
  assert(['node', 'bun'].includes(runtime)); directory = resolve(directory);
  assert(!existsSync(directory), 'Never replace a frozen study');
  const identity = verifyTimingIdentity(), event = json(process.env.GITHUB_EVENT_PATH);
  const invocation = verifyTimingInvocation(process.env, event, identity), input = validateInput(inputDirectory);
  mkdirSync(directory);
  const bundleFiles = {};
  for (const variant of ['baseline', 'candidate']) {
    const bundle = join(directory, 'bundles', variant);
    copy(join(input.bundles[variant].root, 'dist'), join(bundle, 'dist'));
    copy(join(input.bundles[variant].root, 'package.json'), join(bundle, 'package.json'));
    bundleFiles[variant] = fullManifest(bundle);
    assert.equal(bundleFiles[variant]['package.json'], input.bundles[variant].packageSha256);
    assert.deepEqual(fullManifest(join(bundle, 'dist')), input.bundles[variant].files);
  }
  for (const file of TIMING_PROOF_FILES) copy(join(repository, file), join(directory, 'proof-source', file));
  copy(process.env.GITHUB_EVENT_PATH, join(directory, 'push-event.json'));
  const frozen = { schemaVersion: 1, purpose: 'radix-timing-after-sealed-correctness', study: studyFor(CASES), frozenAt: new Date().toISOString(),
    invocation, pushEventSha256: sha256(JSON.stringify(event)), proofCommit: identity.head, runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, controllerTimeoutMs: CONTROLLER_TIMEOUT_MS,
    prerequisites: { runtime, correctnessArtifact: INPUT.artifact, correctnessReceiptSha256: input.prerequisiteSha256 },
    correctness: input, bundleFiles, proofFiles: fullManifest(join(directory, 'proof-source')), sourceIdentity: identity };
  writeJson(join(directory, 'frozen-study.json'), frozen);
  writeFileSync(join(directory, 'frozen-study.sha256'), sha256(readFileSync(join(directory, 'frozen-study.json'))) + '\n', { flag: 'wx' });
  checkFrozen(directory); return frozen;
}
export function checkFrozen(directory) {
  const bytes = readFileSync(join(directory, 'frozen-study.json'));
  assert.equal(sha256(bytes), readFileSync(join(directory, 'frozen-study.sha256'), 'utf8').trim());
  const frozen = JSON.parse(bytes); assert.equal(frozen.purpose, 'radix-timing-after-sealed-correctness');
  assert.deepEqual(frozen.study, studyFor(CASES)); assert.equal(frozen.controllerTimeoutMs, CONTROLLER_TIMEOUT_MS);
  assert.deepEqual(verifyTimingIdentity(), frozen.sourceIdentity);
  const event = json(join(directory, 'push-event.json'));
  assert.equal(sha256(JSON.stringify(event)), frozen.pushEventSha256);
  assert.deepEqual(verifyTimingInvocation({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: event.ref, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: frozen.proofCommit }, event, frozen.sourceIdentity), frozen.invocation);
  assert.deepEqual(validateInput(frozen.correctness.directory), frozen.correctness);
  assert.equal(frozen.prerequisites.correctnessArtifact, INPUT.artifact);
  assert.equal(frozen.prerequisites.correctnessReceiptSha256, frozen.correctness.prerequisiteSha256);
  assert.deepEqual(fullManifest(join(directory, 'proof-source')), frozen.proofFiles);
  for (const file of TIMING_PROOF_FILES) assert.equal(sha256(readFileSync(join(repository, file))), frozen.proofFiles[file]);
  for (const variant of ['baseline', 'candidate']) assert.deepEqual(fullManifest(join(directory, 'bundles', variant)), frozen.bundleFiles[variant]);
  return frozen;
}
export async function capturedChild(executable, args, cwd, prefix, options = {}) {
  mkdirSync(dirname(prefix), { recursive: true });
  const stdoutFd = openSync(prefix + '.stdout', 'wx'), stderrFd = openSync(prefix + '.stderr', 'wx');
  let result;
  try { result = await runBoundedCommand(executable, args, cwd, stdoutFd, CONFIG.subjectTimeoutMs, { ...options, stderrFd }); }
  finally { closeSync(stdoutFd); closeSync(stderrFd); }
  return { ...result, stdout: readFileSync(prefix + '.stdout'), stderr: readFileSync(prefix + '.stderr') };
}
export function requireChildSuccess(child) {
  assert.equal(child.status, 0, 'Subject failed; all raw/partial output retained');
  assert.equal(child.signal, null); assert.equal(child.error, null); assert.equal(child.timedOut, false); assert.equal(child.interrupted, null);
  assert.equal(child.cleanup?.status, 'verified-no-live-processes'); assert.deepEqual(child.cleanup.survivors, []);
  assert.equal(child.cleanup.timeoutMs, CLEANUP_TIMEOUT_MS);
}
export function validateTimingRecord(record, frozen, directory) {
  validateRecord(record, frozen, directory);
  assert.equal(record.controllerTimeoutMs, CONTROLLER_TIMEOUT_MS);
  for (const attempt of record.attempts) requireChildSuccess({ status: attempt.exitStatus, signal: attempt.signal, error: attempt.error,
    timedOut: attempt.timedOut, interrupted: attempt.interrupted, cleanup: attempt.cleanup });
}
// Original chronology: all two-build pilots, all common plans, then all seeded
// AB and independent baseline-AA quartets. The injected subject is also used by
// synthetic chronology tests and never changes the study or stopping rules.
export async function executeStudy(record, study, subject, checkpoint, freezePlans, progress = () => {}) {
  for (const rowPlan of study.rows) {
    const row = { ...rowPlan, pilots: {}, blocks: [] }; record.rows.push(row); checkpoint();
    for (const build of row.pilotOrder) { row.pilots[build] = await subject(build, row.workload, 'pilot'); checkpoint(); }
    row.plan = commonPlan(row.pilots); checkpoint();
  }
  freezePlans(record.rows.map(({ workload, plan }) => ({ workload, plan })));
  record.plansFrozenBeforeMeasurement = true; checkpoint();
  assert(record.rows.every(row => row.plan.valid), 'Pilot floor/cap failed; measurements not started and complete pilot evidence retained');
  for (const row of record.rows) for (const planned of row.schedule) {
    const block = { ...planned, subjects: [] }; row.blocks.push(block); checkpoint();
    for (const role of planned.roles) { block.subjects.push({ ...await subject(planned[role], row.workload, 'measure', row.plan), role }); checkpoint(); }
    progress(row, planned);
  }
}
export async function run(directory) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'No local latency measurements');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'A rerun requires separate review');
  const identity = verifyTimingIdentity(), event = json(process.env.GITHUB_EVENT_PATH);
  const invocation = verifyTimingInvocation(process.env, event, identity);
  assert.equal(process.arch, 'x64'); assert.equal(process.platform, 'linux');
  const runtime = process.versions.bun ? 'bun' : 'node';
  assert.equal(runtime === 'bun' ? process.versions.bun : process.versions.node, TOOLCHAIN[runtime]);
  assert.equal(process.env.NODE_OPTIONS ?? '', ''); assert.equal(process.env.BUN_OPTIONS ?? '', ''); assert.deepEqual(process.execArgv, []);
  directory = resolve(directory);
  const frozen = checkFrozen(directory); assert.deepEqual(frozen.invocation, invocation);
  assert.equal(frozen.runId, process.env.GITHUB_RUN_ID); assert.equal(frozen.proofCommit, process.env.GITHUB_SHA);
  assert.equal(frozen.prerequisites.runtime, runtime); assert.equal(frozen.runAttempt, '1');
  const resultPath = join(directory, `${runtime}.json`); assert(!existsSync(resultPath), 'No overwrite or retry');
  const temporary = realpathSync(mkdtempSync(join(os.tmpdir(), 'trie-view-neutral-'))), neutral = join(temporary, 'subject');
  const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), runtime, config: CONFIG,
    baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT, proofCommit: frozen.proofCommit, runId: frozen.runId, runAttempt: 1,
    frozenStudySha256: sha256(readFileSync(join(directory, 'frozen-study.json'))), neutralPhysicalRoot: neutral, invocation,
    controllerTimeoutMs: CONTROLLER_TIMEOUT_MS,
    controller: { executable: realpathSync(process.execPath), node: process.version, bun: process.versions.bun ?? null, arch: process.arch, platform: process.platform,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length }, attempts: [], rows: [], plansFrozenBeforeMeasurement: false };
  const checkpoint = () => { for (const row of record.rows) row.summary = summarize(row); record.gate = gateStatus(record, CASES); writeJson(resultPath, record); };
  const abort = new AbortController(), deadlineAt = Date.now() + CONTROLLER_TIMEOUT_MS;
  const deadline = setTimeout(() => abort.abort('controller deadline'), CONTROLLER_TIMEOUT_MS);
  const requireActive = () => assert(!abort.signal.aborted && Date.now() < deadlineAt, `Controller stopped: ${abort.signal.reason ?? 'controller deadline'}`);
  const onTerm = () => abort.abort('SIGTERM'), onInt = () => abort.abort('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  const subject = async (build, workload, phase, plan) => {
    requireActive();
    const attempt = { sequence: record.attempts.length, build, workload: workload.name, phase, startedAt: new Date().toISOString() }; record.attempts.push(attempt); checkpoint();
    attempt.before = prepareSubject(directory, build, neutral, frozen); checkpoint();
    const entryUrl = pathToFileURL(join(neutral, 'dist/shared.js')).href;
    const args = [join(neutral, 'proofs/trie-view-subject.mjs'), entryUrl, workload.name, phase,
      ...(phase === 'measure' ? [String(plan.repeat), String(plan.warmupOperations)] : [])];
    attempt.command = { executable: realpathSync(process.execPath), args, cwd: neutral, flags: [], compileCacheDisabled: true }; checkpoint();
    const prefix = join(directory, 'child-output', String(attempt.sequence).padStart(4, '0'));
    attempt.stdout = { path: relative(directory, prefix + '.stdout'), sha256: null };
    attempt.stderr = { path: relative(directory, prefix + '.stderr'), sha256: null }; checkpoint();
    const child = await capturedChild(process.execPath, args, neutral, prefix, { signal: abort.signal,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '', TRIE_VIEW_GATE_TIMING: '1' } });
    Object.assign(attempt, { finishedAt: new Date().toISOString(), exitStatus: child.status, signal: child.signal, error: child.error,
      timedOut: child.timedOut, interrupted: child.interrupted, cleanup: child.cleanup,
      stdout: { path: relative(directory, prefix + '.stdout'), sha256: sha256(child.stdout) }, stderr: { path: relative(directory, prefix + '.stderr'), sha256: sha256(child.stderr) } });
    try { attempt.after = physicalReceipt(neutral); } catch (error) { attempt.after = null; attempt.receiptError = String(error.stack ?? error); }
    checkpoint(); requireChildSuccess(child); assert.deepEqual(attempt.after, attempt.before, 'Subject files changed');
    const parsed = JSON.parse(child.stdout.toString()); assert.equal(parsed.phase, phase); assert.equal(parsed.workload, workload.name); assert.equal(parsed.status, 'completed'); assert.equal(parsed.entryUrl, entryUrl);
    assert.equal(parsed.runtime.name, runtime);
    if (phase === 'pilot') validatePilot(parsed); else validateMeasured(parsed, plan);
    return { ...parsed, sequence: attempt.sequence, build };
  };
  try {
    checkpoint();
    await executeStudy(record, frozen.study, subject, checkpoint, plans => {
      const path = join(directory, `${runtime}-plans.json`); assert(!existsSync(path)); writeJson(path, plans);
      record.plansSha256 = sha256(readFileSync(path)); record.plansFrozenAt = new Date().toISOString();
    }, (row, block) => console.log(`${runtime}: ${row.workload.name}, ${block.mode}, quartet ${block.block + 1}/4`));
    requireActive();
    assert.equal(sha256(readFileSync(join(directory, `${runtime}-plans.json`))), record.plansSha256);
    checkFrozen(directory);
    requireActive();
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint(); validateTimingRecord(record, frozen, directory);
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); record.finishedAt = new Date().toISOString(); checkpoint(); throw error; }
  finally { clearTimeout(deadline); process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); rmSync(temporary, { recursive: true, force: true }); }
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prepare') { assert.equal(args.length, 3); prepare(...args); }
  else if (mode === 'run') { assert.equal(args.length, 1); await run(args[0]); }
  else if (mode === 'verify') { const frozen = checkFrozen(args[0]); validateTimingRecord(requiredResult(args[0], frozen), frozen, resolve(args[0])); }
  else throw new Error('Unknown timing-recovery mode');
}
