import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, cpSync, realpathSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { CASES, CONFIG, MODES, makeSchedule, summarize, gateStatus, prepareSubject } from './block-traversal-performance.mjs';
import { BASELINE_COMMIT, prepareComparison, bundleManifest, sha256 } from './block-traversal-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PIN = Object.freeze({
  candidate: 'da9b432cdf4028c62582455376f18657be65fdf8',
  candidateTree: '84882edc46755995393fbb7aac0f743707c86059', baseline: BASELINE_COMMIT,
  run: '37831469272', artifact: '11575288547',
  zipSha256: '552b08659340e950c4795776b90a340c7dad346bd23c4882caa9510b565d3b3b',
  recordSha256: { node: '1273d9efb90af8385108f46f5ac878a1b32d249065c3f9497420cdf5f0527086', bun: 'ee6d8be7c17acafcd7a26d40e12d21b4328c9346aa9ff1e90e6716a47a21164a' },
  helpers: {
    'block-traversal-performance.mjs': '98298f94e469bb6033649472b82b5fa2599c31051504cfe1825ff890b89bc654',
    'block-traversal-workloads.mjs': 'a033d884c43e50967ae4a93f827d36a98597d96853deeb2607c4c1d78f95bcca',
    'block-traversal-source.mjs': 'b2f8b60854f3afd6bd2ead5213dda8e1b21330edc716b9b54f832d235b345d11',
    'block-traversal-browser.mjs': 'a970f79512e568817ec682e76fefb25b4f1f301e44cd3847594341477f0a2560',
    'block-traversal-worker.mjs': 'eb85deae56d78edd2a8cefd1d2b0e456f0d03ee0202b051dc8dc1ee2642a1391',
    'block-traversal-worker-check.mjs': 'e69bdbf7e4db7e657ca3d15924b44f2f33df1859ea60ca4d73f34877dd17c53c',
  },
});
export const OLD_PLANS = Object.freeze([
  ['linked/number/0/append/toArray', 386202, 4634424, 4.198320309061063e-5],
  ['doubly/number/0/append/toArray', 391881, 4702572, 4.1872486800840044e-5],
  ['doubly/number/0/append/toArrayReverse', 345230, 4487990, 4.20562784230802e-5],
].map(Object.freeze));
const emptyDigest = sha256('[]');
export const writeJson = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path + '.tmp', JSON.stringify(data, null, 2) + '\n'); renameSync(path + '.tmp', path); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function git(root, args) {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, `git ${args.join(' ')}: ${child.stderr}`); return child.stdout.trim();
}
export function fixedStudy() {
  let state = CONFIG.seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  return { schemaVersion: 1, runtime: 'bun', bunVersion: '1.4.2', arch: 'x64', original: PIN, config: CONFIG,
    newPilots: 0, multiplier: 2, measuredSubjects: 96, timedBatches: 2016,
    rows: OLD_PLANS.map(([name, repeat, warmupScans, fastestPilotMsPerScan]) => ({
      workload: CASES.find(c => c.name === name),
      originalPlan: { repeat, warmupScans, fastestPilotMsPerScan, expectedDigest: emptyDigest, repeatCapped: false, pilotWarmupCapped: false },
      plan: { repeat: repeat * 2, warmupScans: warmupScans * 2, expectedDigest: emptyDigest, repeatCapped: false, pilotWarmupCapped: false },
      schedule: makeSchedule(random),
    })),
    interpretation: 'A fixed-work supplement only. Original results remain immutable and Bun remains flagged-inconclusive. No pilots, adaptive work, retries, exclusions, A/A normalization, or changes to the original kernel, floors, df3 interval, 2% margin, or drift rule. Later correctness requires every new cell valid and within margin, plus original evidence free of material loss, drift, and all other validity flags. Original statistical uncertainty remains.' };
}
export function assertFixedStudy(study) { assert.deepEqual(study, fixedStudy(), 'Frozen study differs from predeclared three-cell protocol'); }
export function fullManifest(root) {
  const entries = {};
  function walk(dir) { for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name); assert(!item.isSymbolicLink(), `Archive symlink: ${path}`);
    if (item.isDirectory()) walk(path); else { assert(item.isFile(), `Nonregular archive file: ${path}`); entries[relative(root, path)] = sha256(readFileSync(path)); }
  } } walk(root); return entries;
}
export function verifyHelpers(root = here) {
  for (const [file, hash] of Object.entries(PIN.helpers)) assert.equal(sha256(readFileSync(join(root, file))), hash, `Original helper changed: ${file}`);
}
// Node/V8 and Bun/JSC Math.log/exp may differ in the final binary64 bits.
// This only compares derived arithmetic, never raw samples, hashes, flags or classifications.
export function assertSummaryEqual(saved, recomputed, path = 'summary') {
  if (typeof saved === 'number' && typeof recomputed === 'number') {
    if (/\.(?:block|pair|quartets|belowTargetBatches|warmupCappedSubjects|warmupTimeShortSubjects|warmupWorkShortSubjects|confidenceLevel|margin)$/.test(path)) { assert.equal(saved, recomputed, `Exact summary field mismatch: ${path}`); return; }
    assert(Number.isFinite(saved) && Number.isFinite(recomputed));
    assert(Math.abs(saved - recomputed) <= 32 * Number.EPSILON * Math.max(1, Math.abs(saved), Math.abs(recomputed)), `Derived numeric mismatch: ${path}`); return;
  }
  if (saved && recomputed && typeof saved === 'object' && typeof recomputed === 'object') {
    assert.equal(Array.isArray(saved), Array.isArray(recomputed)); assert.deepEqual(Object.keys(saved), Object.keys(recomputed), `Summary schema mismatch: ${path}`);
    for (const key of Object.keys(saved)) assertSummaryEqual(saved[key], recomputed[key], `${path}.${key}`); return;
  }
  assert.equal(saved, recomputed, `Summary mismatch: ${path}`);
}
export function validateOriginalRecords(records) {
  const allowed = new Set(OLD_PLANS.map(p => p[0])), flagged = [], counts = {};
  for (const runtime of ['node', 'bun']) {
    const record = records[runtime];
    assert.equal(record.status, 'completed'); assert.equal(record.runtime, runtime);
    assert.equal(record.baselineCommit, PIN.baseline); assert.equal(record.candidateCommit, PIN.candidate);
    assert.deepEqual(record.config, CONFIG); assert.equal(record.rows.length, 40);
    assert.deepEqual([...record.rows.map(r => r.name)].sort(), CASES.map(c => c.name).sort());
    assert.deepEqual(record.harnessSha256, Object.fromEntries(Object.entries(PIN.helpers).slice(0, 3)));
    counts[runtime] = { withinMargin: 0, statisticalInconclusive: 0, timingFlagged: 0 };
    for (const row of record.rows) {
      const actual = summarize(row); assertSummaryEqual(row.summary, actual, `${runtime}/${row.name}`);
      assert(!row.plan.repeatCapped && !row.plan.pilotWarmupCapped, 'Original plan cap');
      for (const [mode] of MODES) {
        const s = actual[mode]; assert.equal(s.interval.quartets, 4); assert.equal(s.controlDrift, false, 'Original control drift');
        assert.notEqual(s.interval.classification, 'detected material loss', 'Original material loss');
        assert.equal(s.warmupCappedSubjects, 0); assert.equal(s.warmupWorkShortSubjects, 0);
        if (s.belowTargetBatches || s.warmupTimeShortSubjects) {
          assert(runtime === 'bun' && mode === 'ab' && allowed.has(row.name), 'Other original timing flag');
          flagged.push(row.name);
        }
      }
      const s = actual.ab;
      if (!s.inferenceUsable) counts[runtime].timingFlagged++;
      else if (s.conclusion === 'evidence within margin') counts[runtime].withinMargin++;
      else counts[runtime].statisticalInconclusive++;
    }
    assert.equal(gateStatus(record), runtime === 'node' ? 'eligible-for-later-correctness' : 'flagged-inconclusive');
    assert.equal(record.gate, gateStatus(record));
  }
  assert.deepEqual(flagged.sort(), [...allowed].sort(), 'Exact original timing-flagged cells required');
  for (const row of fixedStudy().rows) assert.deepEqual(records.bun.rows.find(r => r.name === row.workload.name).plan, row.originalPlan, 'Original plan values changed');
  assert.deepEqual(counts, { node: { withinMargin: 32, statisticalInconclusive: 8, timingFlagged: 0 }, bun: { withinMargin: 34, statisticalInconclusive: 3, timingFlagged: 3 } });
  return { originalRun: PIN.run, originalArtifact: PIN.artifact, originalGates: { node: records.node.gate, bun: records.bun.gate }, counts,
    originalStatisticalInconclusiveCells: Object.entries(records).flatMap(([runtime, r]) => r.rows.filter(row => row.summary.ab.conclusion === 'inconclusive').map(row => `${runtime}/${row.name}`)),
    permittedTimingFlaggedCells: [...allowed], materialLoss: false, controlDrift: false, otherFlags: false };
}
export function readOriginal(directory) {
  assert.equal(sha256(readFileSync(join(directory, 'original.zip'))), PIN.zipSha256, 'Original artifact ZIP changed');
  const records = {};
  for (const runtime of ['node', 'bun']) {
    const bytes = readFileSync(join(directory, `${runtime}.json`));
    assert.equal(sha256(bytes), PIN.recordSha256[runtime], `Original ${runtime} record changed`); records[runtime] = JSON.parse(bytes);
  }
  return { records, assessment: validateOriginalRecords(records) };
}
export function extractOriginal(zip, directory) {
  assert.equal(sha256(readFileSync(zip)), PIN.zipSha256, 'Wrong original artifact ZIP');
  assert(!existsSync(directory), 'Do not overwrite an original evidence directory'); mkdirSync(directory, { recursive: true });
  cpSync(zip, join(directory, 'original.zip'));
  const script = `import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert sorted(z.namelist()) == sorted(['baseline-counts.json','bun.json','baseline-workers.json','candidate-counts.json','candidate-workers.json','fixture-checks.log','node.json','sources.json'])\n for name in z.namelist():\n  (p/name).write_bytes(z.read(name))\n`;
  const child = spawnSync('python3', ['-c', script, zip, directory], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); return readOriginal(directory);
}
function proofFiles() { return ['block-traversal-empty-controls.mjs', 'block-traversal-empty-controls.node.mjs', 'block-traversal-empty-controls.md', 'block-traversal-empty-controls-plan.json']; }
export function prepare(zip, baseline, candidate, output) {
  assert(!existsSync(output), 'Evidence output must be new; no overwrite or retry');
  verifyHelpers(); const study = fixedStudy(); assertFixedStudy(readJson(join(here, 'block-traversal-empty-controls-plan.json')));
  assert.equal(process.env.CANDIDATE_COMMIT, PIN.candidate, 'Candidate identity must be exact da9b');
  const comparison = prepareComparison(baseline, candidate);
  assert.equal(git(dirname(dirname(resolve(candidate))), ['rev-parse', `${PIN.candidate}^{tree}`]), PIN.candidateTree);
  const { records, assessment } = extractOriginal(zip, join(output, 'original'));
  // New builds must reproduce every emitted JS/WASM byte in the audited original study.
  for (const runtime of ['node', 'bun']) assert.deepEqual(comparison.manifests, records[runtime].manifests, 'Original emitted bundle identity changed');
  const helpers = join(output, 'original-helpers'); mkdirSync(helpers);
  for (const file of Object.keys(PIN.helpers)) cpSync(join(here, file), join(helpers, file)); verifyHelpers(helpers);
  const bundles = {};
  for (const variant of ['baseline', 'candidate']) {
    const target = join(output, 'bundles', variant), source = dirname(dirname(comparison.paths[variant]));
    mkdirSync(target, { recursive: true }); cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true }); cpSync(join(source, 'package.json'), join(target, 'package.json'));
    bundles[variant] = fullManifest(target);
  }
  const proofRoot = join(output, 'proof-source'); mkdirSync(proofRoot);
  for (const file of proofFiles()) cpSync(join(here, file), join(proofRoot, file));
  // Visible path avoids the upload-artifact default exclusion of hidden workflows.
  cpSync(join(here, '../.github/workflows/block-traversal-empty-controls.yml'), join(proofRoot, 'workflow.yml'));
  const frozen = { study, frozenAt: new Date().toISOString(), proofCommit: process.env.GITHUB_SHA ?? git(join(here, '..'), ['rev-parse', 'HEAD']),
    runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, originalAssessment: assessment,
    sourceComparison: comparison, bundleFiles: bundles, proofFiles: fullManifest(proofRoot), helperFiles: fullManifest(helpers) };
  writeJson(join(output, 'frozen-study.json'), frozen);
  writeFileSync(join(output, 'frozen-study.sha256'), sha256(readFileSync(join(output, 'frozen-study.json'))) + '\n');
  return frozen;
}
export function checkFrozen(directory) {
  const bytes = readFileSync(join(directory, 'frozen-study.json'));
  assert.equal(sha256(bytes), readFileSync(join(directory, 'frozen-study.sha256'), 'utf8').trim(), 'Frozen study changed');
  const frozen = JSON.parse(bytes); assertFixedStudy(frozen.study); verifyHelpers(join(directory, 'original-helpers')); verifyHelpers();
  assert.deepEqual(fullManifest(join(directory, 'original-helpers')), frozen.helperFiles);
  assert.deepEqual(fullManifest(join(directory, 'proof-source')), frozen.proofFiles);
  for (const file of proofFiles()) assert.equal(sha256(readFileSync(join(here, file))), frozen.proofFiles[file], 'Proof implementation changed after freeze');
  assert.equal(sha256(readFileSync(join(here, '../.github/workflows/block-traversal-empty-controls.yml'))), frozen.proofFiles['workflow.yml']);
  for (const variant of ['baseline', 'candidate']) {
    assert.deepEqual(fullManifest(join(directory, 'bundles', variant)), frozen.bundleFiles[variant], 'Archived complete bundle changed');
    assert.deepEqual(bundleManifest(join(directory, 'bundles', variant, 'dist', 'shared.js')), frozen.sourceComparison.manifests[variant], 'Archived executable bytes differ from frozen source pair');
    assert.equal(frozen.bundleFiles[variant]['package.json'], frozen.sourceComparison.sourceManifests[variant].files['package.json']);
  }
  return frozen;
}
export function verifyOriginalComparison(frozen, records) {
  const comparison = frozen.sourceComparison; assert.equal(comparison.candidateCommit, PIN.candidate); assert.deepEqual(comparison.sourceDiff, ['arena.ts']);
  for (const record of Object.values(records)) {
    assert.deepEqual(comparison.manifests, record.manifests, 'Frozen builds differ from original evidence');
    for (const variant of ['baseline', 'candidate']) {
      assert.deepEqual(comparison.sourceManifests[variant].files, record.sourceManifests[variant].files);
      assert.deepEqual(comparison.sourceManifests[variant].wasm, record.sourceManifests[variant].wasm);
    }
  }
}
export function validateSubject(subject, row, planned, role) {
  assert.equal(subject.build, planned[role]); assert.equal(subject.role, role); assert.equal(subject.phase, 'measure');
  assert.equal(subject.repeat, row.plan.repeat); assert.equal(subject.prescribedWarmupScans, row.plan.warmupScans);
  assert.equal(subject.digest, row.plan.expectedDigest); assert.equal(subject.samples.length, CONFIG.samples);
  for (const ms of subject.samples) assert(Number.isFinite(ms) && ms > 0, 'Invalid timed batch');
  assert.equal(subject.belowTargetBatches, subject.samples.filter(ms => ms < CONFIG.targetBatchMs).length);
  assert.equal(subject.warmupTimeShort, subject.warmup.elapsedMs < CONFIG.warmupMs);
  assert.equal(subject.warmupWorkShort, subject.warmup.scans !== row.plan.warmupScans);
  assert.equal(subject.warmup.scans, subject.warmup.batches.reduce((n, b) => n + b.repeat, 0));
  assert.equal(subject.warmup.elapsedMs, subject.warmup.batches.reduce((n, b) => n + b.ms, 0));
  assert.equal(typeof subject.warmup.capped, 'boolean');
  for (const batch of subject.warmup.batches) { assert(Number.isSafeInteger(batch.repeat) && batch.repeat > 0 && batch.repeat <= row.plan.repeat); assert(Number.isFinite(batch.ms) && batch.ms > 0); }
  assert.equal(subject.explicitGcMs.length, CONFIG.samples); assert(subject.explicitGcMs.every(ms => ms === 0));
}
export function supplementStatus(record) {
  if (record.status !== 'completed' || record.rows.length !== 3) return 'incomplete';
  const study = fixedStudy(); let drift = false, flags = false, loss = false, uncertain = false;
  for (let i = 0; i < 3; i++) {
    const row = record.rows[i], frozen = study.rows[i]; assert.equal(row.name, frozen.workload.name); assert.deepEqual(row.plan, frozen.plan);
    assert.equal(row.blocks.length, 8);
    for (let b = 0; b < 8; b++) {
      const block = row.blocks[b], planned = frozen.schedule[b], { subjects, ...schedule } = block; assert.deepEqual(schedule, planned); assert.equal(subjects.length, 4);
      for (let s = 0; s < 4; s++) validateSubject(subjects[s], row, planned, planned.roles[s]);
    }
    const actual = summarize(row); assertSummaryEqual(row.summary, actual, 'supplement');
    for (const [mode] of MODES) {
      const s = actual[mode]; drift ||= s.controlDrift; flags ||= !s.inferenceUsable;
      if (mode === 'ab') { loss ||= s.interval.classification === 'detected material loss'; uncertain ||= s.conclusion !== 'evidence within margin'; }
    }
  }
  return drift ? 'control-drift-inconclusive' : flags ? 'flagged-inconclusive' : loss ? 'detected-material-loss' : uncertain ? 'statistical-inconclusive' : 'eligible-for-later-correctness';
}
export function physicalReceipt(neutral) {
  const entry = join(neutral, 'dist', 'shared.js');
  return { requestedEntry: resolve(entry), physicalRoot: realpathSync(neutral), physicalEntry: realpathSync(entry), physicalPackage: realpathSync(join(neutral, 'package.json')), files: fullManifest(neutral) };
}
export function captureChildResult(attempt, child, directory, neutral) {
  // Preserve exit metadata even if a damaged/missing physical bundle prevents its after-receipt.
  Object.assign(attempt, { finishedAt: new Date().toISOString(), status: child.status, signal: child.signal, error: child.error ? String(child.error) : null });
  const output = join(directory, 'child-output'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `${attempt.sequence}.stdout`), child.stdout ?? ''); writeFileSync(join(output, `${attempt.sequence}.stderr`), child.stderr ?? '');
  try { attempt.after = physicalReceipt(neutral); }
  catch (error) { attempt.after = null; attempt.receiptError = String(error.stack ?? error); }
}
export function run(directory) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'No local timings: this fixed study runs only in its reviewed CI job');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'No adaptive reruns'); assert.equal(process.versions.bun, '1.4.2'); assert.equal(process.arch, 'x64');
  const frozen = checkFrozen(directory); assert.equal(frozen.runId, process.env.GITHUB_RUN_ID); assert.equal(frozen.proofCommit, process.env.GITHUB_SHA);
  const { records, assessment } = readOriginal(join(directory, 'original')); verifyOriginalComparison(frozen, records); assert.deepEqual(assessment, frozen.originalAssessment);
  const resultPath = join(directory, 'supplement.json'); assert(!existsSync(resultPath), 'Never overwrite or retry measured evidence');
  const temporary = mkdtempSync(join(os.tmpdir(), 'block-traversal-neutral-')), neutral = join(temporary, 'subject');
  const helper = join(resolve(directory), 'original-helpers', 'block-traversal-workloads.mjs');
  const kernel = join(resolve(directory), 'original-helpers', 'block-traversal-performance.mjs');
  const record = { schemaVersion: 1, status: 'running', runtime: 'bun', config: CONFIG, baselineCommit: PIN.baseline, candidateCommit: PIN.candidate,
    proofCommit: frozen.proofCommit, runId: frozen.runId, runAttempt: 1, frozenStudySha256: sha256(readFileSync(join(directory, 'frozen-study.json'))),
    startedAt: new Date().toISOString(), originalAssessment: assessment, neutralPath: resolve(neutral), attempts: [], rows: [],
    controller: { version: process.version, bun: process.versions.bun, arch: process.arch, platform: process.platform, cpu: os.cpus()[0]?.model } };
  const checkpoint = () => { for (const row of record.rows) row.summary = summarize(row); record.gate = supplementStatus(record); writeJson(resultPath, record); };
  try {
    checkpoint();
    for (const frozenRow of frozen.study.rows) {
      const row = { ...frozenRow.workload, plan: frozenRow.plan, schedule: frozenRow.schedule, blocks: [] }; record.rows.push(row);
      for (const planned of row.schedule) {
        const block = { ...planned, subjects: [] }; row.blocks.push(block);
        for (const role of planned.roles) {
          const build = planned[role], source = join(resolve(directory), 'bundles', build, 'dist', 'shared.js');
          const entry = prepareSubject(source, neutral, frozen.sourceComparison.manifests[build], frozen.sourceComparison.sourceManifests[build].files['package.json']);
          const before = physicalReceipt(neutral); assert.deepEqual(before.files, frozen.bundleFiles[build]);
          const sequence = record.attempts.length, attempt = { sequence, workload: row.name, mode: planned.mode, block: planned.block, role, build, before, startedAt: new Date().toISOString() };
          record.attempts.push(attempt); checkpoint();
          const request = { workload: frozenRow.workload, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans, entryUrl: pathToFileURL(entry).href, harnessUrl: pathToFileURL(helper).href };
          const child = spawnSync(process.execPath, [kernel, '--subject', JSON.stringify(request)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CONFIG.subjectTimeoutMs,
            env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } });
          captureChildResult(attempt, child, directory, neutral); checkpoint();
          assert(!attempt.receiptError, attempt.receiptError);
          assert.deepEqual(attempt.after, before, 'Neutral physical path or complete emitted bundle changed during child');
          assert.equal(child.status, 0, String(child.error ?? child.stderr));
          const subject = { sequence, build, role, ...JSON.parse(child.stdout) }; validateSubject(subject, row, planned, role); block.subjects.push(subject); checkpoint();
        }
        console.log(`bun ${row.name} quartet ${planned.block + 1} ${planned.mode}`);
      }
    }
    assert.equal(record.attempts.length, 96); checkFrozen(directory);
    assert.deepEqual(prepareComparison(frozen.sourceComparison.paths.baseline, frozen.sourceComparison.paths.candidate).sourceManifests, frozen.sourceComparison.sourceManifests);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); record.finishedAt = new Date().toISOString(); checkpoint(); throw error; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
  return record;
}
export function verifyForBrowser(directory, expectedProofCommit = process.env.GITHUB_SHA) {
  const frozen = checkFrozen(directory), { records, assessment } = readOriginal(join(directory, 'original')), record = readJson(join(directory, 'supplement.json'));
  verifyOriginalComparison(frozen, records);
  assert.deepEqual(assessment, frozen.originalAssessment); assert.deepEqual(record.originalAssessment, assessment);
  assert.equal(frozen.proofCommit, expectedProofCommit); assert.equal(record.proofCommit, expectedProofCommit);
  assert.equal(record.frozenStudySha256, sha256(readFileSync(join(directory, 'frozen-study.json'))));
  assert.equal(record.runtime, 'bun'); assert.deepEqual(record.config, CONFIG); assert.equal(record.controller.bun, '1.4.2'); assert.equal(record.controller.arch, 'x64');
  assert.equal(record.baselineCommit, PIN.baseline); assert.equal(record.candidateCommit, PIN.candidate); assert.equal(record.runAttempt, 1);
  assert.equal(record.runId, frozen.runId); assert.equal(record.attempts.length, 96); assert.equal(record.gate, supplementStatus(record));
  assert.equal(record.gate, 'eligible-for-later-correctness', 'All three new cells must be valid and within margin');
  const subjects = record.rows.flatMap(row => row.blocks.flatMap(block => block.subjects));
  for (let i = 0; i < 96; i++) {
    const attempt = record.attempts[i], subject = subjects[i]; assert.equal(attempt.sequence, i); assert.equal(subject.sequence, i); assert.equal(attempt.status, 0); assert.equal(attempt.signal, null); assert.equal(attempt.error, null); assert(!attempt.receiptError);
    assert.equal(attempt.build, subject.build); assert.equal(attempt.role, subject.role); assert.deepEqual(attempt.after, attempt.before);
    assert.equal(attempt.before.physicalRoot, record.neutralPath); assert.equal(attempt.before.physicalEntry, join(record.neutralPath, 'dist', 'shared.js'));
    assert.equal(attempt.before.physicalPackage, join(record.neutralPath, 'package.json')); assert.deepEqual(attempt.before.files, frozen.bundleFiles[subject.build]);
    const raw = readJson(join(directory, 'child-output', `${i}.stdout`)); assert.deepEqual(subject, { sequence: i, build: attempt.build, role: attempt.role, ...raw });
  }
  return { eligibility: record.gate, originalAssessment: assessment, proofCommit: expectedProofCommit, candidateCommit: PIN.candidate, baselineCommit: PIN.baseline,
    note: 'Original Bun gate remains flagged. Eleven original cells remain statistically inconclusive. Eligibility permits browser correctness only; it is not adoption or equivalence.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--prepare') console.log(JSON.stringify(prepare(...args), null, 2));
  else if (command === '--run') run(...args);
  else if (command === '--verify-browser') console.log(JSON.stringify(verifyForBrowser(...args), null, 2));
  else if (command === '--verify-original') console.log(JSON.stringify(readOriginal(...args).assessment, null, 2));
  else throw new Error('Use --prepare ZIP BASE/dist/shared.js CANDIDATE/dist/shared.js OUTPUT, --run OUTPUT, --verify-browser OUTPUT, or --verify-original ORIGINAL-DIRECTORY');
}
