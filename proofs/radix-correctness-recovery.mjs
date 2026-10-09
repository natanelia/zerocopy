// Correctness-only recovery. This module never imports or invokes timing code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, CANDIDATE_TREE, TOOLCHAIN,
  FROZEN_PROOF_SHA256, WASM_SHA256, BUNDLE_SHA256, assertCaptureDelta,
  assertPinnedManifest, wasmManifest, bundleManifest, compilerManifest, sha256,
} from './trie-view-source.mjs';
import { COMMON_CHECKS, CLEANUP_TIMEOUT_MS, PREREQUISITE_TIMEOUT_MS, runCheck } from './trie-view-prerequisites.mjs';

export const PRIOR_PROOF = 'aea884493421b1ff067a39e65f0f4b9d4d11e68a';
export const PRIOR_TREE = 'e40aae8025dc0a994e790b1961a9e7b511dede43';
export const BRANCH = 'proof/radix-correctness-recovery-20261009';
export const PURPOSE = 'radix-correctness-only-recovery-v1';
export const OVERLAY_FILES = Object.freeze(['trie-view-capture.test.ts', 'proofs/trie-view-fixtures.ts']);
export const RECOVERY_CHANGES = Object.freeze({
  '.github/workflows/radix-correctness-recovery.yml': 'A',
  'proofs/radix-correctness-recovery.mjs': 'A',
  'proofs/radix-correctness-recovery.node.mjs': 'A',
  'proofs/radix-correctness-recovery.md': 'A',
  'proofs/radix-correctness-history.json': 'A',
  'proofs/trie-view-prerequisites.mjs': 'M',
  'proofs/trie-view-prerequisites.node.mjs': 'M',
});
const here = dirname(fileURLToPath(import.meta.url)), repository = dirname(here);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { writeFileSync(path + '.pending', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.pending', path); };
const git = (root, ...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const gitText = (root, ...args) => git(root, ...args).toString().trim();
function regular(path) { assert(lstatSync(path).isFile(), `Not a regular file: ${path}`); return readFileSync(path); }
function entries(root, ref) {
  return git(root, 'ls-tree', '-rz', ref).toString().split('\0').filter(Boolean).map(line => {
    const [, mode, type, oid, file] = /^(\d+) (\S+) ([a-f0-9]{40})\t(.+)$/.exec(line) ?? [];
    assert.equal(type, 'blob'); assert(['100644', '100755'].includes(mode), `Unsupported source mode ${file}`);
    return { mode, oid, file };
  });
}
export function exactTreeFiles(root, ref, files = entries(root, ref)) {
  return Object.fromEntries(files.map(({ oid, file }) => {
    const bytes = regular(join(root, file));
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(actual, oid, `Changed immutable source: ${file}`);
    return [file, sha256(bytes)];
  }));
}
function sourceAdditions(root, tracked, allowLocks = false) {
  const found = [];
  const visit = (directory, prefix = '') => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (!prefix && item.name === '.git') continue;
      if (!prefix && item.name === 'node_modules') { assert(item.isDirectory() || item.isSymbolicLink()); continue; }
      if (!prefix && item.name === 'dist') assert(item.isDirectory(), 'Generated dist must be a real directory');
      if (item.isDirectory()) visit(join(directory, item.name), name + '/');
      else found.push(name);
    }
  };
  visit(root);
  const outputs = new Set(['geometry-kernels.wat', ...Object.keys(WASM_SHA256), ...(allowLocks ? ['bun.lock', 'bun.lockb'] : [])]);
  return found.filter(file => !Object.hasOwn(tracked, file) && !outputs.has(file) && !/^dist\/.+\.(?:js|wasm|d\.ts)$/.test(file)).sort();
}
export function verifyRecoveryIdentity(root = repository) {
  const head = gitText(root, 'rev-parse', 'HEAD');
  assert.equal(gitText(root, 'show', '-s', '--format=%P', head), PRIOR_PROOF, 'Recovery must be one direct proof commit on the published failed gate');
  assert.equal(gitText(root, 'rev-parse', `${PRIOR_PROOF}^{tree}`), PRIOR_TREE);
  assert.equal(gitText(root, 'show', '-s', '--format=%P', PRIOR_PROOF), CANDIDATE_RUNTIME_COMMIT);
  assert.equal(gitText(root, 'rev-parse', `${CANDIDATE_RUNTIME_COMMIT}^{tree}`), CANDIDATE_TREE);
  assert.equal(gitText(root, 'show', '-s', '--format=%P', CANDIDATE_RUNTIME_COMMIT), BASELINE_COMMIT);
  const changes = gitText(root, 'diff', '--name-status', PRIOR_PROOF, head).split('\n').sort();
  assert.deepEqual(changes, Object.entries(RECOVERY_CHANGES).map(([file, status]) => `${status}\t${file}`).sort());
  // The entire checked-out proof tree is verified, not only its runtime files.
  const files = exactTreeFiles(root, head);
  assert.deepEqual(sourceAdditions(root, files, true), [], 'Unexpected proof inputs, including ignored files');
  return { head, parent: PRIOR_PROOF, parentTree: PRIOR_TREE, files };
}
export function verifyInvocation(env, event, head) {
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_REF, `refs/heads/${BRANCH}`); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GITHUB_SHA, head); assert.equal(event.ref, env.GITHUB_REF); assert.equal(event.after, head);
  assert.equal(event.before, '0'.repeat(40)); assert.equal(event.created, true);
  assert.equal(event.forced, false); assert.equal(event.deleted, false);
  return { event: 'push', branch: BRANCH, after: head, before: event.before, created: true, runAttempt: 1 };
}
export function verifyRuntimeTree(root, ref, overlay = false) {
  assert.equal(gitText(root, 'rev-parse', 'HEAD'), ref, 'Runtime worktree HEAD changed');
  const files = exactTreeFiles(root, ref);
  const expectedExtra = overlay ? OVERLAY_FILES : [];
  const extras = sourceAdditions(root, files);
  assert.deepEqual(extras, [...expectedExtra].sort(), 'Unexpected runtime worktree additions');
  const overlayFiles = {};
  if (overlay) for (const file of OVERLAY_FILES) {
    overlayFiles[file] = sha256(regular(join(root, file)));
    assert.equal(overlayFiles[file], FROZEN_PROOF_SHA256[file], `Changed semantic overlay: ${file}`);
  }
  return { root: resolve(root), ref, files, overlayFiles };
}
export function verifySources(baseline, candidate, overlay = false) {
  const identity = verifyRecoveryIdentity();
  const sources = {
    baseline: verifyRuntimeTree(baseline, BASELINE_COMMIT, overlay),
    candidate: verifyRuntimeTree(candidate, CANDIDATE_RUNTIME_COMMIT),
  };
  assertCaptureDelta(regular(join(baseline, 'arena.ts')), regular(join(candidate, 'arena.ts')));
  for (const [file, expected] of Object.entries(FROZEN_PROOF_SHA256)) assert.equal(sources.candidate.files[file], expected);
  for (const file of OVERLAY_FILES) if (overlay) assert.equal(sources.baseline.overlayFiles[file], sources.candidate.files[file]);
  return { identity, sources };
}
export function installOverlay(baseline, candidate) {
  verifySources(baseline, candidate, false);
  for (const file of OVERLAY_FILES) writeFileSync(join(baseline, file), regular(join(candidate, file)), { flag: 'wx' });
  return verifySources(baseline, candidate, true);
}
export function verifyBuilds(baseline, candidate) {
  const receipt = verifySources(baseline, candidate, true);
  for (const [name, root] of Object.entries({ baseline, candidate })) {
    receipt.sources[name].wasm = assertPinnedManifest(wasmManifest(root), WASM_SHA256, `${name}: all 12 independently rebuilt WASM files`);
    receipt.sources[name].bundles = assertPinnedManifest(bundleManifest(join(root, 'dist/shared.js')), BUNDLE_SHA256[name], `${name}: all rebuilt JS files`);
    receipt.sources[name].compilers = compilerManifest(root);
  }
  return receipt;
}
export function recoveryPlan(baseline, candidate, proof = repository) {
  baseline = resolve(baseline); candidate = resolve(candidate); proof = resolve(proof);
  assert(new Set([baseline, candidate, proof]).size === 3, 'Use three distinct worktrees');
  const self = join(proof, 'proofs/radix-correctness-recovery.mjs');
  const plan = [], add = (phase, build, name, cwd, ...command) => plan.push({ phase, build, name, cwd, command, timeoutMs: PREREQUISITE_TIMEOUT_MS });
  add('setup', 'gate', 'runtime', proof, 'node', self, 'runtime');
  add('setup', 'gate', 'install', proof, 'bun', 'install');
  add('setup', 'gate', 'baseline-worktree', proof, 'git', 'worktree', 'add', '--detach', baseline, BASELINE_COMMIT);
  add('setup', 'gate', 'candidate-worktree', proof, 'git', 'worktree', 'add', '--detach', candidate, CANDIDATE_RUNTIME_COMMIT);
  add('setup', 'gate', 'dependencies', proof, 'node', self, 'link-dependencies', baseline, candidate);
  add('setup', 'gate', 'sources', proof, 'node', self, 'sources', baseline, candidate);
  add('setup', 'gate', 'compilers', proof, 'node', 'proofs/trie-view-source.mjs', 'compiler', proof);
  for (const [build, root] of Object.entries({ baseline, candidate })) {
    const checks = [
      ['build-wasm', 'bun', 'run', 'build:wasm'], ['build-browser', 'bun', 'run', 'build:browser'],
      ['build-types', 'bun', 'run', 'build:types'], ['typecheck', 'bun', 'run', 'typecheck'],
      ['worker-types', 'node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json'],
      ['type-values', 'bun', 'run', 'typecheck:values'], ['type-redux', 'bun', 'run', 'typecheck:redux'],
      ['type-geometry', 'bun', 'run', 'typecheck:geometry'], ['unit', 'bun', 'run', 'test'],
      ['package', 'bun', 'run', 'check:package'], ['worker-tasks-node', 'node', '--test', 'proofs/worker-tasks.mjs'],
      ['node-worker', 'node', 'proofs/node-worker.mjs'], ['redux-node', 'node', 'proofs/redux-node.mjs'],
      ['typed-json-worker', 'node', 'proofs/typed-json-worker.mjs'],
    ];
    for (const [name, ...command] of checks) add('validate', build, name, root, ...command);
    for (const runtime of ['node', 'bun']) add('validate', build, `actual-workers-${runtime}`, proof, runtime, 'proofs/trie-view-workers.mjs', join(root, 'dist/shared.js'));
    assert.deepEqual(plan.filter(check => check.build === build).map(check => check.name), [...COMMON_CHECKS]);
  }
  add('validate', 'candidate', 'mechanism', candidate, 'bun', 'proofs/trie-view-mechanism.ts');
  add('validate', 'gate', 'source-tests', proof, 'node', '--test', 'proofs/trie-view-source.node.mjs');
  add('validate', 'gate', 'runner-tests', proof, 'node', '--test', 'proofs/trie-view-prerequisites.node.mjs');
  add('validate', 'gate', 'recovery-tests', proof, 'node', '--test', 'proofs/radix-correctness-recovery.node.mjs');
  add('validate', 'gate', 'semantic-overlay', proof, 'node', self, 'overlay', baseline, candidate);
  add('validate', 'baseline', 'semantic-overlay', baseline, 'bun', 'run', 'test', 'trie-view-capture.test.ts');
  add('validate', 'gate', 'exact-builds', proof, 'node', self, 'builds', baseline, candidate);
  assert.equal(new Set(plan.map(check => `${check.build}/${check.name}`)).size, plan.length);
  return plan;
}
export function validateReceipts(directory, plan, requireCompleted = false) {
  const receipt = json(join(directory, 'prerequisites.json'));
  assert.equal(receipt.purpose, PURPOSE); assert.equal(receipt.noTiming, true);
  assert.equal(receipt.baseline, BASELINE_COMMIT); assert.equal(receipt.candidate, CANDIDATE_RUNTIME_COMMIT);
  assert.equal(receipt.status, requireCompleted ? 'completed' : 'partial');
  assert.deepEqual(receipt.plan, plan); assert.equal(receipt.planSha256, sha256(JSON.stringify(plan)));
  assert.equal(receipt.checks.length, plan.length, 'Missing or extra recovery prerequisite receipts');
  for (let index = 0; index < plan.length; index++) {
    const expected = plan[index], check = receipt.checks[index];
    for (const key of ['build', 'name', 'cwd', 'command', 'timeoutMs']) assert.deepEqual(check[key], expected[key], `Wrong recovery command/order: ${key}`);
    assert.equal(check.outcome, 'pass'); assert.equal(check.status, 0);
    assert.equal(check.signal, null); assert.equal(check.error, null); assert.equal(check.timedOut, false); assert.equal(check.interrupted, null);
    assert.equal(check.cleanup?.status, 'verified-no-live-processes'); assert.deepEqual(check.cleanup.survivors, []);
    assert.equal(check.cleanup.timeoutMs, CLEANUP_TIMEOUT_MS);
    assert.equal(typeof check.started, 'string'); assert.equal(typeof check.finished, 'string');
    assert.equal(check.log, `logs/${check.build}-${check.name}.log`);
    assert.equal(check.sha256, sha256(regular(join(directory, check.log))));
  }
  return receipt;
}
function loadPlan(directory, baseline, candidate) {
  const manifest = json(join(directory, 'prerequisites.json')), expected = recoveryPlan(baseline, candidate);
  assert.equal(manifest.purpose, PURPOSE); assert.deepEqual(manifest.plan, expected);
  assert.equal(manifest.planSha256, sha256(JSON.stringify(expected)));
  const identity = verifyRecoveryIdentity();
  assert.equal(manifest.recoveryCommit, identity.head);
  assert.equal(manifest.historySha256, sha256(regular(join(here, 'radix-correctness-history.json'))));
  assert.deepEqual(manifest.invocation, verifyInvocation(process.env, json(join(directory, 'source/push-event.json')), identity.head));
  return expected;
}
export function stopsRecovery(check, result) {
  return check.phase === 'setup' || check.build === 'gate' || result.cleanup?.status !== 'verified-no-live-processes'
    || Boolean(result.interrupted) || result.timedOut === true;
}
async function executePhase(phase, directory, baseline, candidate) {
  const plan = loadPlan(directory, baseline, candidate), required = plan.map(check => `${check.build}/${check.name}`);
  let passed = true;
  for (const check of plan.filter(check => check.phase === phase)) {
    const existing = json(join(directory, 'prerequisites.json')).checks;
    assert.deepEqual(existing.map(item => `${item.build}/${item.name}`), required.slice(0, plan.indexOf(check)), 'Recovery checks must execute once in declared order');
    const [command, ...args] = check.command;
    const ok = await runCheck(directory, check.build, check.name, check.cwd, command, args, required);
    passed = passed && ok;
    const result = json(join(directory, 'prerequisites.json')).checks.at(-1);
    if (!ok && stopsRecovery(check, result)) return false;
  }
  return passed;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, first, second, third] = process.argv.slice(2);
  let result;
  if (mode === 'runtime') {
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.versions.node, TOOLCHAIN.node);
    assert.equal(execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), TOOLCHAIN.bun);
    result = { node: process.version, bun: TOOLCHAIN.bun, platform: process.platform, arch: process.arch, purpose: PURPOSE };
  } else if (mode === 'initialize') {
    const identity = verifyRecoveryIdentity(), event = json(process.env.GITHUB_EVENT_PATH);
    const invocation = verifyInvocation(process.env, event, identity.head), plan = recoveryPlan(second, third);
    assert(!existsSync(join(first, 'prerequisites.json')), 'Never replace earlier recovery evidence');
    mkdirSync(join(first, 'logs'), { recursive: true });
    result = { schema: 3, purpose: PURPOSE, noTiming: true, status: 'partial', baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT,
      recoveryCommit: identity.head, invocation, priorRun: 37867002724, priorProof: PRIOR_PROOF,
      historySha256: sha256(regular(join(here, 'radix-correctness-history.json'))), plan, planSha256: sha256(JSON.stringify(plan)), checks: [] };
    save(join(first, 'prerequisites.json'), result);
  } else if (mode === 'setup' || mode === 'validate') {
    process.exitCode = await executePhase(mode, first, second, third) ? 0 : 1;
  } else if (mode === 'link-dependencies') {
    for (const root of [first, second]) { symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules')); assert.equal(realpathSync(join(root, 'node_modules')), realpathSync(join(repository, 'node_modules'))); }
    result = { dependencies: join(repository, 'node_modules'), roots: [first, second] };
  } else if (mode === 'sources') result = verifySources(first, second);
  else if (mode === 'overlay') result = installOverlay(first, second);
  else if (mode === 'builds') result = verifyBuilds(first, second);
  else if (mode === 'seal') {
    const plan = loadPlan(first, second, third), receipt = validateReceipts(first, plan);
    verifyBuilds(second, third);
    receipt.status = 'completed'; receipt.finished = new Date().toISOString(); save(join(first, 'prerequisites.json'), receipt);
    validateReceipts(first, plan, true); result = { purpose: PURPOSE, noTiming: true, checks: plan.length, status: 'completed' };
  } else throw new Error('Unknown correctness-only mode');
  if (result) console.log(JSON.stringify(result, null, 2));
}
