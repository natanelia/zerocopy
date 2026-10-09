// Load the one sealed correctness artifact. No builds, tests, pilots or timings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullManifest, PROOF_FILES } from './trie-view-gate.mjs';
import { recoveryPlan, validateReceipts, exactTreeFiles } from './radix-correctness-recovery.mjs';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, BUNDLE_SHA256, WASM_SHA256, COMPILER_SHA256, FROZEN_PROOF_SHA256,
  assertPinnedManifest, bundleManifest, wasmManifest, sha256 } from './trie-view-source.mjs';

export const INPUT = Object.freeze({
  run: 37873312900, job: 113636051426, artifact: 11591645832,
  commit: 'ce3a0ec38f156dd361a0e285dd602f937c082692', tree: 'abed8dd6ecf9b9498fe10c45040a382273a2c67b',
  zipSha256: '3f9966fd9e5265a539c9400eeb2a3c8dc38024822019c1ba441725cd68ace06b',
  tarSha256: 'b483b1a63f74e19040a4b552985921ea839e19738e36a22a4a7fdd49a82e0f4b',
  baselineRoot: '/home/runner/work/_temp/radix-correctness-baseline',
  candidateRoot: '/home/runner/work/_temp/radix-correctness-candidate', proofRoot: '/home/runner/work/zerocopy/zerocopy',
});
export const BRANCH = 'proof/radix-timing-recovery-20261009';
export const TIMING_CHANGES = Object.freeze({
  '.github/workflows/radix-timing-recovery.yml': 'A', 'proofs/radix-timing-input.mjs': 'A',
  'proofs/radix-timing-recovery.mjs': 'A', 'proofs/radix-timing-recovery.node.mjs': 'A',
  'proofs/radix-timing-recovery.md': 'A', 'proofs/trie-view-prerequisites.mjs': 'M',
});
export const TIMING_PROOF_FILES = Object.freeze([...new Set([...PROOF_FILES, ...Object.keys(TIMING_CHANGES),
  'proofs/radix-correctness-recovery.mjs', 'proofs/radix-correctness-history.json'])].sort());
export const SOURCE_ARCHIVES = Object.freeze({
  'recovery-source.tar': 'cf41a1c1ea62ba7d3c19740949a1429c2d26f08f47b3b0fa665a5f092b2dc7c3',
  'original-failed-gate-source.tar': 'efa05a6d30f755ff1351a7d3f17b491587f866b29375cfe562c9ca6eb84d3b15',
  'baseline-source.tar': 'f395ff48f71a43b1714ed0069f6e5dd07fdb5c6b1a3a6eea9ab380006cfbbae5',
  'candidate-source.tar': '83b7233d817ad1c97802154419ba831a13b11a1a9eb2557b90b7595def0488ee',
});
const root = fileURLToPath(new URL('..', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
export function verifyMetadata(run, jobs, artifacts) {
  assert.equal(run.id, INPUT.run); assert.equal(run.head_sha, INPUT.commit); assert.equal(run.head_commit.tree_id, INPUT.tree);
  assert.equal(run.path, '.github/workflows/radix-correctness-recovery.yml'); assert.equal(run.run_attempt, 1);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.repository.full_name, 'natanelia/zerocopy');
  assert.equal(jobs.total_count, 1); assert.equal(jobs.jobs.length, 1);
  const job = jobs.jobs[0]; assert.equal(job.id, INPUT.job); assert.equal(job.run_id, INPUT.run);
  assert.equal(job.head_sha, INPUT.commit); assert.equal(job.run_attempt, 1); assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  for (const name of ['Run both original suites once and the matched baseline semantic overlay', 'Seal only complete passing correctness evidence', 'Upload portable correctness-only evidence']) {
    const step = job.steps.find(step => step.name === name); assert(step); assert.equal(step.status, 'completed'); assert.equal(step.conclusion, 'success');
  }
  const matches = artifacts.artifacts.filter(artifact => artifact.id === INPUT.artifact); assert.equal(matches.length, 1);
  const artifact = matches[0]; assert.equal(artifact.name, `radix-correctness-recovery-${INPUT.commit}`);
  assert.equal(artifact.workflow_run.id, INPUT.run); assert.equal(artifact.workflow_run.head_sha, INPUT.commit);
  assert.equal(artifact.digest, `sha256:${INPUT.zipSha256}`); assert.equal(artifact.expired, false);
  return { run: INPUT.run, job: INPUT.job, artifact: INPUT.artifact, commit: INPUT.commit, tree: INPUT.tree, conclusion: 'success' };
}
export function verifyTimingIdentity() {
  const head = git('rev-parse', 'HEAD').toString().trim(), parent = git('show', '-s', '--format=%P', head).toString().trim();
  assert.equal(parent, INPUT.commit, 'One proof commit on the sealed correctness recovery is required');
  assert.equal(git('rev-parse', `${INPUT.commit}^{tree}`).toString().trim(), INPUT.tree);
  assert.deepEqual(git('diff', '--name-status', parent, head).toString().trim().split('\n').sort(), Object.entries(TIMING_CHANGES).map(([file, status]) => `${status}\t${file}`).sort());
  const files = exactTreeFiles(root, head);
  const others = [...git('ls-files', '--others', '--exclude-standard').toString().split('\n'), ...git('ls-files', '--others', '--ignored', '--exclude-standard').toString().split('\n')].filter(Boolean);
  assert(others.every(file => file.startsWith('dist/')), `Untracked timing input: ${others.find(file => !file.startsWith('dist/'))}`);
  for (const name of ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs', 'trie-view-gate.mjs']) {
    assert.equal(files[`proofs/${name}`], sha256(git('show', `${INPUT.commit}:proofs/${name}`)), `Original method/protocol/controller helper changed: ${name}`);
  }
  return { head, parent, parentTree: INPUT.tree, files };
}
export function verifyTimingInvocation(env, event, identity) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'No local latency measurements');
  assert.equal(env.GITHUB_EVENT_NAME, 'push'); assert.equal(env.GITHUB_REF, `refs/heads/${BRANCH}`); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GITHUB_SHA, identity.head); assert.equal(identity.parent, INPUT.commit);
  assert.equal(event.ref, env.GITHUB_REF); assert.equal(event.after, identity.head); assert.equal(event.before, '0'.repeat(40));
  assert.equal(event.created, true); assert.equal(event.forced, false); assert.equal(event.deleted, false);
  return { eventName: 'push', ref: event.ref, before: event.before, after: event.after, created: true, forced: false, deleted: false, runAttempt: 1 };
}
// The outer ZIP and inner tar are fixed known bytes before either is extracted.
export function unpackInput(directory) {
  assert.equal(sha256(readFileSync(join(directory, 'correctness.zip'))), INPUT.zipSha256, 'Wrong correctness ZIP');
  const packed = join(directory, 'packed'); mkdirSync(packed);
  const names = execFileSync('unzip', ['-Z1', join(directory, 'correctness.zip')], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(names, ['radix-view.tar.gz', 'radix-view.tar.gz.sha256']);
  execFileSync('unzip', ['-q', join(directory, 'correctness.zip'), '-d', packed]);
  assert.equal(sha256(readFileSync(join(packed, 'radix-view.tar.gz'))), INPUT.tarSha256, 'Wrong correctness tar');
  assert.equal(readFileSync(join(packed, 'radix-view.tar.gz.sha256'), 'utf8').trim(), `${INPUT.tarSha256}  radix-view.tar.gz`);
  const evidence = join(directory, 'evidence'); mkdirSync(evidence);
  execFileSync('tar', ['-xzf', join(packed, 'radix-view.tar.gz'), '--no-same-owner', '--no-same-permissions', '-C', evidence]);
  return validateInput(directory);
}
function exactExtractedManifest(directory) {
  // Bind every extracted byte and pathname to the pinned tar, including hidden
  // files; reject symlinks, unexpected files and escaped archive paths.
  const program = `import hashlib,json,pathlib,tarfile,sys
p=json.load(sys.stdin); root=pathlib.Path(p['root']); expected={}
with tarfile.open(p['tar']) as archive:
 for member in archive.getmembers():
  name=pathlib.PurePosixPath(member.name)
  assert not name.is_absolute() and '..' not in name.parts
  assert member.isdir() or member.isfile()
  if member.isfile():
   key=str(name); expected[key]=hashlib.sha256(archive.extractfile(member).read()).hexdigest()
actual={}
for file in root.rglob('*'):
 assert not file.is_symlink()
 if file.is_file(): actual[file.relative_to(root).as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
 else: assert file.is_dir()
assert actual==expected
print(json.dumps(actual,sort_keys=True))`;
  return JSON.parse(execFileSync('python3', ['-c', program], { input: JSON.stringify({ root: join(directory, 'evidence'), tar: join(directory, 'packed/radix-view.tar.gz') }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}
export function validateInput(directory) {
  directory = resolve(directory);
  const metadata = verifyMetadata(json(join(directory, 'run.json')), json(join(directory, 'jobs.json')), json(join(directory, 'artifacts.json')));
  const metadataFiles = Object.fromEntries(['run.json', 'jobs.json', 'artifacts.json'].map(file => [file, sha256(readFileSync(join(directory, file)))]));
  assert.equal(sha256(readFileSync(join(directory, 'correctness.zip'))), INPUT.zipSha256);
  assert.equal(sha256(readFileSync(join(directory, 'packed/radix-view.tar.gz'))), INPUT.tarSha256);
  const evidenceFiles = exactExtractedManifest(directory), evidence = join(directory, 'evidence');
  const plan = recoveryPlan(INPUT.baselineRoot, INPUT.candidateRoot, INPUT.proofRoot), checks = validateReceipts(evidence, plan, true);
  assert.equal(checks.recoveryCommit, INPUT.commit); assert.equal(checks.baseline, BASELINE_COMMIT); assert.equal(checks.candidate, CANDIDATE_RUNTIME_COMMIT);
  for (const [file, expected] of Object.entries(SOURCE_ARCHIVES)) assert.equal(sha256(readFileSync(join(evidence, 'source', file))), expected);
  const final = JSON.parse(readFileSync(join(evidence, 'logs/gate-exact-builds.log'), 'utf8').split('\n').slice(1).join('\n'));
  assert.equal(final.identity.head, INPUT.commit);
  const bundles = {}, sourceRoots = { baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT };
  for (const [variant, ref] of Object.entries(sourceRoots)) {
    const build = join(evidence, 'builds', variant), files = final.sources[variant].files;
    assert.equal(final.sources[variant].ref, ref);
    const tracked = git('ls-tree', '-r', '--name-only', ref).toString().trim().split('\n');
    assert.deepEqual(Object.keys(files).sort(), tracked.sort());
    for (const file of tracked) assert.equal(files[file], sha256(git('show', `${ref}:${file}`)));
    assert.equal(sha256(readFileSync(join(build, 'package.json'))), files['package.json']);
    assertPinnedManifest(wasmManifest(build), WASM_SHA256); assertPinnedManifest(bundleManifest(join(build, 'dist/shared.js')), BUNDLE_SHA256[variant]);
    for (const [name, expected] of Object.entries(COMPILER_SHA256)) assert.equal(final.sources[variant].compilers[name].sha256, expected);
    bundles[variant] = { root: build, packageSha256: files['package.json'], files: fullManifest(join(build, 'dist')) };
  }
  for (const file of ['trie-view-capture.test.ts', 'proofs/trie-view-fixtures.ts']) {
    const baseline = readFileSync(join(evidence, 'builds/baseline', file)), candidate = readFileSync(join(evidence, 'builds/candidate', file));
    assert.deepEqual(baseline, candidate); assert.equal(sha256(baseline), FROZEN_PROOF_SHA256[file]);
  }
  assert.equal(sha256(readFileSync(join(evidence, 'source/radix-correctness-history.json'))), checks.historySha256);
  assert(!Object.keys(evidenceFiles).some(file => file.startsWith('gate/')));
  return { metadata, metadataFiles, directory, zipSha256: INPUT.zipSha256, tarSha256: INPUT.tarSha256, evidenceFiles,
    prerequisiteSha256: sha256(readFileSync(join(evidence, 'prerequisites.json'))), checks, bundles, sourceManifests: final.sources };
}
export function stageWorkloadChecks(directory) {
  const input = validateInput(directory), dist = join(root, 'dist'); assert(!existsSync(dist), 'Do not replace prior test bundles');
  cpSync(join(input.bundles.candidate.root, 'dist'), dist, { recursive: true });
  assert.deepEqual(fullManifest(dist), input.bundles.candidate.files);
  return { untimedTestBundle: dist, files: fullManifest(dist) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  const result = mode === 'unpack' ? unpackInput(directory) : mode === 'validate' ? validateInput(directory) : mode === 'stage-tests' ? stageWorkloadChecks(directory) : null;
  assert(result, 'Unknown input-loader mode'); console.log(JSON.stringify(result, null, 2));
}
