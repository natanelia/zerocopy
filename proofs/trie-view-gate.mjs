import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, cpSync, realpathSync, lstatSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { CASES } from './trie-view-workloads.mjs';
import { CONFIG, studyFor, commonPlan, validatePilot, validateMeasured, summarize, gateStatus } from './trie-view-protocol.mjs';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, TOOLCHAIN, prepareComparison, bundleManifest, sha256 } from './trie-view-source.mjs';
import { validatePrerequisites } from './trie-view-prerequisites.mjs';

const here = dirname(fileURLToPath(import.meta.url)), repository = dirname(here);
export const PROOF_FILES = Object.freeze([
  'proofs/trie-view-capture.md', 'proofs/trie-view-gate.md', 'proofs/trie-view-gate.mjs', 'proofs/trie-view-gate.node.mjs',
  'proofs/trie-view-protocol.mjs', 'proofs/trie-view-protocol.node.mjs', 'proofs/trie-view-source.mjs', 'proofs/trie-view-source.node.mjs',
  'proofs/trie-view-workloads.mjs', 'proofs/trie-view-subject.mjs', 'proofs/trie-view-workloads.node.mjs',
  'proofs/trie-view-prerequisites.mjs', 'proofs/trie-view-prerequisites.node.mjs',
  'proofs/trie-view-worker-types.baseline.txt', 'proofs/trie-view-worker-types.expected.json',
  'proofs/trie-view-fixtures.ts', 'proofs/trie-view-mechanism.ts', 'proofs/trie-view-worker.mjs', 'proofs/trie-view-workers.mjs',
  'trie-view-capture.test.ts', '.github/workflows/trie-view-capture.yml',
]);
const SUBJECT_FILES = ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs'];
export const writeJson = (path, object) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path + '.tmp', JSON.stringify(object, null, 2) + '\n'); renameSync(path + '.tmp', path); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function fullManifest(root) {
  const entries = {};
  function walk(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, item.name); assert(!item.isSymbolicLink(), `Symlink in frozen evidence: ${path}`);
      if (item.isDirectory()) walk(path); else { assert(item.isFile(), `Nonregular evidence: ${path}`); entries[relative(root, path)] = sha256(readFileSync(path)); }
    }
  }
  walk(root); return entries;
}
function copy(source, target) { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }); }
export const prerequisites = validatePrerequisites;
export function prepare(baseline, candidate, directory) {
  directory = resolve(directory); assert(!existsSync(directory), 'Freeze output must be new; never overwrite evidence');
  const checks = prerequisites(dirname(directory));
  const comparison = prepareComparison(baseline, candidate), study = studyFor(CASES);
  mkdirSync(directory, { recursive: true });
  const bundles = {}, sources = {};
  for (const variant of ['baseline', 'candidate']) {
    const root = dirname(dirname(comparison.paths[variant])), bundle = join(directory, 'bundles', variant), source = join(directory, 'sources', variant);
    copy(join(root, 'dist'), join(bundle, 'dist')); copy(join(root, 'package.json'), join(bundle, 'package.json'));
    for (const file of Object.keys(comparison.sourceManifests[variant].files)) copy(join(root, file), join(source, file));
    for (const file of Object.keys(comparison.sourceManifests[variant].validationFiles)) copy(join(root, file), join(source, file));
    for (const file of Object.keys(comparison.sourceManifests[variant].wasm)) copy(join(root, file), join(source, file));
    bundles[variant] = fullManifest(bundle); sources[variant] = fullManifest(source);
  }
  for (const file of PROOF_FILES) copy(join(repository, file), join(directory, 'proof-source', file));
  // Visible copy and include-hidden-files workflow setting independently retain hidden workflow evidence.
  copy(join(repository, '.github/workflows/trie-view-capture.yml'), join(directory, 'workflow.yml'));
  const { cleanup, ...serialComparison } = comparison;
  const frozen = { schemaVersion: 1, study, frozenAt: new Date().toISOString(), proofCommit: process.env.GITHUB_SHA ?? comparison.gateCommit,
    runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    prerequisites: checks, comparison: serialComparison, bundleFiles: bundles, sourceFiles: sources,
    proofFiles: fullManifest(join(directory, 'proof-source')), workflowSha256: sha256(readFileSync(join(directory, 'workflow.yml'))) };
  writeJson(join(directory, 'frozen-study.json'), frozen);
  writeFileSync(join(directory, 'frozen-study.sha256'), sha256(readFileSync(join(directory, 'frozen-study.json'))) + '\n');
  checkFrozen(directory); return frozen;
}
export function checkFrozen(directory) {
  const bytes = readFileSync(join(directory, 'frozen-study.json'));
  assert.equal(sha256(bytes), readFileSync(join(directory, 'frozen-study.sha256'), 'utf8').trim(), 'Frozen study modified');
  const frozen = JSON.parse(bytes); assert.deepEqual(frozen.study, studyFor(CASES));
  assert.deepEqual(prerequisites(dirname(directory)), frozen.prerequisites);
  assert.deepEqual(fullManifest(join(directory, 'proof-source')), frozen.proofFiles, 'Archived proof source changed');
  for (const file of PROOF_FILES) assert.equal(sha256(readFileSync(join(repository, file))), frozen.proofFiles[file], `Executing proof changed: ${file}`);
  assert.equal(sha256(readFileSync(join(directory, 'workflow.yml'))), frozen.workflowSha256);
  for (const variant of ['baseline', 'candidate']) {
    assert.deepEqual(fullManifest(join(directory, 'bundles', variant)), frozen.bundleFiles[variant]);
    assert.deepEqual(fullManifest(join(directory, 'sources', variant)), frozen.sourceFiles[variant]);
    assert.deepEqual(bundleManifest(join(directory, 'bundles', variant, 'dist/shared.js')), frozen.comparison.manifests[variant]);
    assert.equal(frozen.bundleFiles[variant]['package.json'], frozen.comparison.sourceManifests[variant].files['package.json']);
  }
  return frozen;
}
export function prepareSubject(directory, build, neutral, frozen) {
  assert(['baseline', 'candidate'].includes(build)); rmSync(neutral, { recursive: true, force: true });
  copy(join(directory, 'bundles', build), neutral);
  for (const file of SUBJECT_FILES) copy(join(directory, 'proof-source', 'proofs', file), join(neutral, 'proofs', file));
  const manifest = fullManifest(neutral), expected = { ...frozen.bundleFiles[build] };
  for (const file of SUBJECT_FILES) expected[`proofs/${file}`] = frozen.proofFiles[`proofs/${file}`];
  assert.deepEqual(manifest, Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))));
  return physicalReceipt(neutral);
}
export function physicalReceipt(neutral) {
  const entry = join(neutral, 'dist/shared.js'), packagePath = join(neutral, 'package.json'), subject = join(neutral, 'proofs/trie-view-subject.mjs');
  assert(!lstatSync(neutral).isSymbolicLink());
  const receipt = { requestedRoot: resolve(neutral), physicalRoot: realpathSync(neutral), requestedEntry: resolve(entry), physicalEntry: realpathSync(entry),
    physicalPackage: realpathSync(packagePath), physicalSubject: realpathSync(subject), files: fullManifest(neutral) };
  assert.equal(receipt.requestedRoot, receipt.physicalRoot); assert.equal(receipt.requestedEntry, receipt.physicalEntry);
  return receipt;
}
export function captureResult(attempt, child, directory, neutral) {
  attempt.finishedAt = new Date().toISOString(); attempt.exitStatus = child.status; attempt.signal = child.signal ?? null; attempt.error = child.error ? String(child.error) : null;
  const prefix = join(directory, 'child-output', String(attempt.sequence).padStart(4, '0')); mkdirSync(dirname(prefix), { recursive: true });
  writeFileSync(prefix + '.stdout', child.stdout ?? ''); writeFileSync(prefix + '.stderr', child.stderr ?? '');
  attempt.stdout = { path: relative(directory, prefix + '.stdout'), sha256: sha256(readFileSync(prefix + '.stdout')) };
  attempt.stderr = { path: relative(directory, prefix + '.stderr'), sha256: sha256(readFileSync(prefix + '.stderr')) };
  try { attempt.after = physicalReceipt(neutral); } catch (error) { attempt.receiptError = String(error.stack ?? error); attempt.after = null; }
}
export function assertSummaryEqual(saved, computed) {
  if (typeof saved === 'number' && typeof computed === 'number') {
    assert(Number.isFinite(saved) && Number.isFinite(computed));
    assert(Math.abs(saved - computed) <= 32 * Number.EPSILON * Math.max(1, Math.abs(saved), Math.abs(computed))); return;
  }
  if (saved && computed && typeof saved === 'object' && typeof computed === 'object') {
    assert.equal(Array.isArray(saved), Array.isArray(computed)); assert.deepEqual(Object.keys(saved), Object.keys(computed));
    for (const key of Object.keys(saved)) assertSummaryEqual(saved[key], computed[key]); return;
  }
  assert.equal(saved, computed);
}
export function validateExecutionOrder(record, study) {
  let sequence = 0;
  const bindSlot = (subject, expected) => {
    assert.equal(subject.sequence, sequence, 'Subject does not occupy its frozen execution slot');
    const attempt = record.attempts[sequence++]; assert(attempt, 'Missing execution slot');
    assert.equal(attempt.sequence, subject.sequence);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(subject[key], value, `Subject ${key} differs from frozen execution slot`);
      if (key !== 'role') assert.equal(attempt[key], value, `Attempt ${key} differs from frozen execution slot`);
    }
  };
  for (let index = 0; index < study.rows.length; index++) {
    const expected = study.rows[index], row = record.rows[index];
    for (const build of expected.pilotOrder) bindSlot(row.pilots[build], { build, phase: 'pilot', workload: expected.workload.name });
  }
  for (let index = 0; index < study.rows.length; index++) {
    const expected = study.rows[index], row = record.rows[index];
    for (let block = 0; block < expected.schedule.length; block++) {
      const planned = expected.schedule[block];
      for (let slot = 0; slot < 4; slot++) {
        const role = planned.roles[slot];
        bindSlot(row.blocks[block].subjects[slot], { build: planned[role], role, phase: 'measure', workload: expected.workload.name });
      }
    }
  }
  assert.equal(sequence, record.attempts.length, 'Unexpected execution slots');
}
export function validateRecord(record, frozen, directory) {
  assert.equal(record.status, 'completed'); assert.deepEqual(record.config, CONFIG); assert.equal(record.rows.length, frozen.study.rows.length);
  assert(['node', 'bun'].includes(frozen.prerequisites.runtime));
  assert.equal(record.runtime, frozen.prerequisites.runtime, 'Wrong runtime result for this artifact');
  assert.equal(record.controller.platform, 'linux'); assert.equal(record.controller.arch, 'x64');
  assert.equal(record.runtime === 'bun' ? record.controller.bun : record.controller.node, record.runtime === 'bun' ? TOOLCHAIN.bun : `v${TOOLCHAIN.node}`);
  assert.equal(record.attempts.length, frozen.study.pilots + frozen.study.measuredSubjects);
  assert.equal(record.plansFrozenBeforeMeasurement, true);
  assert.equal(record.baseline, BASELINE_COMMIT); assert.equal(record.candidate, CANDIDATE_RUNTIME_COMMIT);
  assert.equal(record.proofCommit, frozen.proofCommit); assert.equal(record.runId, frozen.runId); assert.equal(record.runAttempt, 1);
  validateExecutionOrder(record, frozen.study);
  if (directory) {
    assert.equal(record.frozenStudySha256, sha256(readFileSync(join(directory, 'frozen-study.json'))));
    assert.equal(record.plansSha256, sha256(readFileSync(join(directory, `${record.runtime}-plans.json`))));
    assert.deepEqual(readJson(join(directory, `${record.runtime}-plans.json`)), record.rows.map(({ workload, plan }) => ({ workload, plan })));
  }
  let sequence = 0;
  for (const attempt of record.attempts) {
    assert.equal(attempt.sequence, sequence++); assert.equal(attempt.exitStatus, 0); assert.equal(attempt.signal, null); assert.equal(attempt.error, null);
    assert.equal(attempt.before.physicalRoot, record.neutralPhysicalRoot); assert.deepEqual(attempt.after, attempt.before);
    const expectedFiles = { ...frozen.bundleFiles[attempt.build] };
    for (const file of SUBJECT_FILES) expectedFiles[`proofs/${file}`] = frozen.proofFiles[`proofs/${file}`];
    assert.deepEqual(attempt.before.files, Object.fromEntries(Object.entries(expectedFiles).sort(([a], [b]) => a.localeCompare(b))));
    if (directory) for (const output of [attempt.stdout, attempt.stderr]) {
      assert(output.path.startsWith('child-output/') && !output.path.split('/').includes('..'));
      assert.equal(sha256(readFileSync(join(directory, output.path))), output.sha256);
    }
  }
  assert(record.attempts.slice(0, frozen.study.pilots).every(a => a.phase === 'pilot'));
  assert(record.attempts.slice(frozen.study.pilots).every(a => a.phase === 'measure'));
  const used = new Set();
  const bind = subject => {
    assert(!used.has(subject.sequence), 'Reused subject'); used.add(subject.sequence);
    const attempt = record.attempts[subject.sequence]; assert(attempt);
    assert.equal(attempt.build, subject.build); assert.equal(attempt.workload, subject.workload); assert.equal(attempt.phase, subject.phase);
    assert.equal(subject.runtime.name, record.runtime); assert.equal(subject.runtime.version, TOOLCHAIN[record.runtime]);
    assert.equal(subject.runtime.platform, 'linux'); assert.equal(subject.runtime.arch, 'x64'); assert.deepEqual(subject.runtime.execArgv, []);
    assert.equal(subject.physical.physicalRoot, attempt.before.physicalRoot);
    assert.equal(subject.physical.physicalEntry, attempt.before.physicalEntry);
    assert.equal(subject.physical.physicalPackage, attempt.before.physicalPackage);
    assert.equal(subject.physical.packageSha256, frozen.bundleFiles[subject.build]['package.json']);
    for (const file of SUBJECT_FILES) assert.equal(subject.sourceSha256[file], frozen.proofFiles[`proofs/${file}`]);
    assert.equal(subject.actualDigest, subject.expectedDigest);
    assert.deepEqual(subject.guards.after, subject.guards.before);
    assert.equal(subject.guards.allocatedSharedBytes, 0); assert.equal(subject.guards.immutableBytes, true);
    if (directory) {
      const { sequence, build, role, ...raw } = subject;
      assert.deepEqual(JSON.parse(readFileSync(join(directory, attempt.stdout.path), 'utf8')), raw, 'Parsed subject differs from archived stdout');
    }
  };
  for (let rowIndex = 0; rowIndex < record.rows.length; rowIndex++) {
    const row = record.rows[rowIndex], expected = frozen.study.rows[rowIndex];
    assert.deepEqual(row.workload, expected.workload); assert.deepEqual(row.pilotOrder, expected.pilotOrder); assert.deepEqual(row.schedule, expected.schedule);
    assert.deepEqual(row.plan, commonPlan(row.pilots)); assert.equal(row.blocks.length, row.schedule.length);
    for (const build of row.pilotOrder) {
      const pilot = row.pilots[build]; assert.equal(pilot.build, build); assert.equal(pilot.workload, row.workload.name); validatePilot(pilot); bind(pilot);
    }
    for (let index = 0; index < row.schedule.length; index++) {
      const block = row.blocks[index], { subjects, ...actual } = block, planned = row.schedule[index]; assert.deepEqual(actual, planned); assert.equal(subjects.length, 4);
      for (let i = 0; i < 4; i++) {
        const s = subjects[i]; assert.equal(s.role, planned.roles[i]); assert.equal(s.build, planned[s.role]); assert.equal(s.workload, row.workload.name);
        validateMeasured(s, row.plan); bind(s);
      }
    }
    assertSummaryEqual(row.summary, summarize(row));
  }
  assert.equal(used.size, record.attempts.length);
  assert.equal(record.gate, gateStatus(record, CASES));
}
export function run(directory) {
  directory = resolve(directory);
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'No local latency measurements');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'A rerun requires a separately reviewed protocol');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/perf/trie-view-capture-20261008', 'Only the reviewed branch may run this screen');
  assert.equal(process.arch, 'x64'); assert.equal(process.platform, 'linux');
  const runtime = process.versions.bun ? 'bun' : 'node';
  assert.equal(runtime === 'bun' ? process.versions.bun : process.version, runtime === 'bun' ? '1.4.2' : 'v22.23.3');
  assert.equal(process.env.NODE_OPTIONS ?? '', '', 'No nondefault runtime flags'); assert.equal(process.env.BUN_OPTIONS ?? '', ''); assert.deepEqual(process.execArgv, []);
  const frozen = checkFrozen(directory); assert.equal(frozen.runId, process.env.GITHUB_RUN_ID); assert.equal(frozen.proofCommit, process.env.GITHUB_SHA);
  assert.equal(frozen.prerequisites.runtime, runtime); assert.equal(frozen.runAttempt, '1');
  const resultPath = join(directory, `${runtime}.json`); assert(!existsSync(resultPath), 'No overwrite or retry');
  const temporary = realpathSync(mkdtempSync(join(os.tmpdir(), 'trie-view-neutral-'))), neutral = join(temporary, 'subject');
  const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), runtime, config: CONFIG,
    baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT, proofCommit: frozen.proofCommit, runId: frozen.runId, runAttempt: 1,
    frozenStudySha256: sha256(readFileSync(join(directory, 'frozen-study.json'))), neutralPhysicalRoot: neutral,
    controller: { executable: realpathSync(process.execPath), node: process.version, bun: process.versions.bun ?? null, arch: process.arch, platform: process.platform,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length }, attempts: [], rows: [], plansFrozenBeforeMeasurement: false };
  const checkpoint = () => { for (const row of record.rows) row.summary = summarize(row); record.gate = gateStatus(record, CASES); writeJson(resultPath, record); };
  const subject = (build, workload, phase, plan) => {
    const attempt = { sequence: record.attempts.length, build, workload: workload.name, phase, startedAt: new Date().toISOString() }; record.attempts.push(attempt); checkpoint();
    attempt.before = prepareSubject(directory, build, neutral, frozen); checkpoint();
    const entryUrl = pathToFileURL(join(neutral, 'dist/shared.js')).href;
    const args = [join(neutral, 'proofs/trie-view-subject.mjs'), entryUrl, workload.name, phase,
      ...(phase === 'measure' ? [String(plan.repeat), String(plan.warmupOperations)] : [])];
    attempt.command = { executable: realpathSync(process.execPath), args, cwd: neutral, flags: [], compileCacheDisabled: true }; checkpoint();
    const child = spawnSync(process.execPath, args, { cwd: neutral, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CONFIG.subjectTimeoutMs,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '', TRIE_VIEW_GATE_TIMING: '1' } });
    captureResult(attempt, child, directory, neutral); checkpoint();
    assert.equal(child.status, 0, `Subject ${attempt.sequence} failed; all raw/partial output retained`); assert.deepEqual(attempt.after, attempt.before, 'Subject files changed');
    const parsed = JSON.parse(child.stdout); assert.equal(parsed.phase, phase); assert.equal(parsed.workload, workload.name); assert.equal(parsed.status, 'completed'); assert.equal(parsed.entryUrl, entryUrl);
    assert.equal(parsed.runtime.name, runtime);
    if (phase === 'pilot') validatePilot(parsed); else validateMeasured(parsed, plan);
    return { ...parsed, sequence: attempt.sequence, build };
  };
  try {
    checkpoint();
    // Every plan is frozen before the first measured process. No measured output
    // can influence workload, schedule, calibration, warmup, caps or sampling.
    for (const rowPlan of frozen.study.rows) {
      const row = { ...rowPlan, pilots: {}, blocks: [] }; record.rows.push(row); checkpoint();
      for (const build of row.pilotOrder) { row.pilots[build] = subject(build, row.workload, 'pilot'); checkpoint(); }
      row.plan = commonPlan(row.pilots); checkpoint();
    }
    writeJson(join(directory, `${runtime}-plans.json`), record.rows.map(({ workload, plan }) => ({ workload, plan })));
    record.plansSha256 = sha256(readFileSync(join(directory, `${runtime}-plans.json`))); record.plansFrozenAt = new Date().toISOString();
    record.plansFrozenBeforeMeasurement = true; checkpoint();
    assert(record.rows.every(row => row.plan.valid), 'Pilot floor/cap failed; measurements not started and complete pilot evidence retained');
    for (const row of record.rows) {
      for (const planned of row.schedule) {
        const block = { ...planned, subjects: [] }; row.blocks.push(block); checkpoint();
        for (const role of planned.roles) { block.subjects.push({ ...subject(planned[role], row.workload, 'measure', row.plan), role }); checkpoint(); }
        console.log(`${runtime}: ${row.workload.name}, ${planned.mode}, quartet ${planned.block + 1}/4`);
      }
    }
    assert.equal(sha256(readFileSync(join(directory, `${runtime}-plans.json`))), record.plansSha256); checkFrozen(directory);
    const afterComparison = prepareComparison(dirname(dirname(frozen.comparison.paths.baseline)), dirname(dirname(frozen.comparison.paths.candidate)));
    assert.deepEqual(afterComparison.sourceManifests, frozen.comparison.sourceManifests); assert.deepEqual(afterComparison.manifests, frozen.comparison.manifests);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint(); validateRecord(record, frozen, directory);
  } catch (error) {
    record.status = 'failed'; record.error = String(error.stack ?? error); record.finishedAt = new Date().toISOString(); checkpoint(); throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return record;
}
export function requiredResult(directory, frozen) {
  const runtime = frozen.prerequisites.runtime;
  assert(['node', 'bun'].includes(runtime), 'Missing artifact runtime identity');
  const path = join(directory, `${runtime}.json`);
  assert(existsSync(path), `Missing required ${runtime} result; measurements are not complete`);
  const record = readJson(path);
  assert.equal(record.runtime, runtime, 'Wrong runtime result for this artifact');
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prepare') { assert.equal(args.length, 3); prepare(...args); }
  else if (mode === 'run') { assert.equal(args.length, 1); run(args[0]); }
  else if (mode === 'verify') { assert.equal(args.length, 1); const frozen = checkFrozen(args[0]); validateRecord(requiredResult(args[0], frozen), frozen, resolve(args[0])); }
  else throw new Error('Usage: trie-view-gate.mjs prepare BASE_ROOT CANDIDATE_ROOT OUTPUT | run OUTPUT | verify OUTPUT');
}
