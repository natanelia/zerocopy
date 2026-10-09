// Prerequisite identity/cache/activation repair only. No observer or timing work.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const HERE = dirname(fileURLToPath(import.meta.url));
export const PINS = JSON.parse(readFileSync(join(HERE, 'block-reuse-build-pins.json'), 'utf8'));
export const BRANCH = 'proof/block-reuse-timing-recovery-20261009';
export const RECOVERY_FILES = ['block-reuse-recovery.mjs', 'block-reuse-recovery.node.mjs', 'block-reuse-build-pins.json', 'block-reuse.bun.lock'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = file => { const bytes = readFileSync(file); return { bytes: bytes.length, sha256: sha256(bytes) }; };
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 });
const gitText = (root, ...args) => git(root, ...args).toString().trim();
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export function inventory(root) {
  const files = [];
  const visit = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), `Unexpected symlink: ${path}`);
      if (stat.isDirectory()) visit(path);
      else { assert(stat.isFile()); files.push({ path: relative(root, path), ...digest(path) }); }
    }
  };
  if (existsSync(root)) visit(root); return files;
}
export function runtimePin(ref) {
  const pin = [PINS.baseline, PINS.candidate].find(pin => pin.commit === ref);
  assert(pin, 'Unknown runtime source pin'); return pin;
}
export function runtimeGeneratedPaths(ref) {
  const pin = runtimePin(ref);
  return new Set([...pin.wasm.map(f => f.path), ...pin.dist.map(f => 'dist/' + f.path), 'geometry-kernels.wat']);
}
export function verifyRuntimeInputs(root, trackedPaths, runtimeRef, { installedLock = false } = {}) {
  const known = new Set(trackedPaths), generated = runtimeGeneratedPaths(runtimeRef);
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), rel = relative(root, path);
      if (['.git', 'node_modules'].includes(rel)) continue;
      const stat = lstatSync(path); assert(!stat.isSymbolicLink(), `Unexpected source symlink: ${rel}`);
      if (stat.isDirectory()) visit(path);
      else {
        assert(stat.isFile());
        if (installedLock && rel === 'bun.lock') assert.equal(digest(path).sha256, PINS.lockSha256, 'Changed installed lock');
        else assert(known.has(rel) || generated.has(rel), `Unexpected ${runtimeRef} input: ${rel}`);
      }
    }
  }; visit(root);
}
export function exactSource(root, head, runtimeRef, options = {}) {
  assert.equal(gitText(root, 'rev-parse', 'HEAD'), head);
  const files = git(root, 'ls-tree', '-rz', head).toString().split('\0').filter(Boolean).map(line => {
    const [, mode, type, blob, path] = /^(\d+) (\S+) ([a-f0-9]{40})\t(.+)$/.exec(line) ?? [];
    assert.equal(type, 'blob'); assert(['100644', '100755'].includes(mode));
    const stat = lstatSync(join(root, path)); assert(stat.isFile());
    assert.equal(stat.mode & 0o111, mode === '100755' ? 0o111 : 0, `Changed source executable mode: ${path}`);
    const bytes = readFileSync(join(root, path));
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), blob, `Changed source: ${path}`);
    return { path, mode, blob, bytes: bytes.length, sha256: sha256(bytes) };
  });
  verifyRuntimeInputs(root, files.map(f => f.path), runtimeRef, options);
  return { head, tree: gitText(root, 'rev-parse', head + '^{tree}'), files };
}
export function verifyBuild(root, runtimeRef) {
  const pin = runtimePin(runtimeRef);
  const wasm = pin.wasm.map(({ path }) => ({ path, ...digest(join(root, path)) }));
  const dist = inventory(join(root, 'dist'));
  assert.deepEqual(wasm, pin.wasm, 'Rebuilt WASM differs from frozen original-run arm');
  assert.deepEqual(dist, pin.dist, 'Rebuilt dist differs from frozen original-run arm');
  return { wasm, dist };
}
export function verifyInvocation(env, event, head, tree, parents, message) {
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_REF, 'refs/heads/' + BRANCH); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.BLOCK_REUSE_ATTEMPT, '1'); assert.equal(env.GITHUB_SHA, head);
  assert.equal(event.after, head); assert.equal(event.ref, env.GITHUB_REF);
  assert.equal(event.before, '0'.repeat(40)); assert.equal(event.created, true);
  assert.equal(event.forced, false); assert.equal(event.deleted, false);
  assert.equal(parents, PINS.candidate.commit, 'One proof commit directly above unchanged runtime required');
  const trailers = message.split('\n').filter(line => line.startsWith('Reviewed-Tree:'));
  assert.deepEqual(trailers, ['Reviewed-Tree: ' + tree], 'One exact Reviewed-Tree trailer required');
  return { branch: BRANCH, head, tree, parents, before: event.before, created: true, forced: false, runAttempt: 1 };
}
export function activation(root, env = process.env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const head = gitText(root, 'rev-parse', 'HEAD'), tree = gitText(root, 'rev-parse', 'HEAD^{tree}');
  return verifyInvocation(env, event, head, tree, gitText(root, 'show', '-s', '--format=%P', head), gitText(root, 'show', '-s', '--format=%B', head));
}
export function cacheReceipt(root) {
  assert(lstatSync(root).isDirectory()); assert.equal(realpathSync(root), resolve(root), 'Cache root cannot be an alias');
  const files = inventory(root);
  return { root, realpath: realpathSync(root), files, inventorySha256: sha256(JSON.stringify(files)) };
}
export function configSource(root, cache) {
  // Only the physical cache destination changes. Vitest's original settings,
  // default reporter, runner, sequencer, discovery and timeouts stay untouched.
  return `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};\nexport default { ...base, cacheDir: ${JSON.stringify(cache)} };\n`;
}
export function prepareCaches(roots, evidenceRoot) {
  const out = {};
  for (const [name, root] of Object.entries(roots)) {
    const directory = join(evidenceRoot, name), cache = join(directory, 'isolated-cache');
    mkdirSync(directory, { recursive: true }); assert(!existsSync(cache), 'No cache resume/replacement allowed'); mkdirSync(cache);
    const before = cacheReceipt(cache); assert.deepEqual(before.files, []);
    const config = join(directory, 'standard-cache.config.mjs'); writeFileSync(config, configSource(root, cache), { flag: 'wx' });
    save(join(directory, 'cache-before.json'), before);
    out[name] = { root: cache, before, config: { path: config, ...digest(config) } };
  }
  assert.notEqual(out.baseline.before.realpath, out.candidate.before.realpath);
  assert.equal(out.baseline.before.inventorySha256, out.candidate.before.inventorySha256);
  return out;
}
export function validateStandardSuite(arm, stdout, cacheRoot) {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const count = arm === 'baseline' ? 774 : 784, modules = PINS[arm].testFiles.length;
  assert.match(clean, new RegExp(`Test Files\\s+${modules} passed \\(${modules}\\)`), 'Full standard module summary missing');
  assert.match(clean, new RegExp(`Tests\\s+${count} passed \\(${count}\\)`), 'Full standard test summary missing');
  const path = 'vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json';
  const result = JSON.parse(readFileSync(join(cacheRoot, path), 'utf8'));
  assert.equal(result.version, PINS.compilers.vitest.version);
  assert.deepEqual(result.results.map(([name]) => name).sort(), PINS[arm].testFiles.map(f => ':' + f.path).sort(), 'Missing/extra cached module');
  assert(result.results.every(([, result]) => result.failed === false), 'Failed cached module');
  return { modules, tests: count, defaultReporter: true, resultCache: { path, ...digest(join(cacheRoot, path)) } };
}
export function sealArtifacts(directory) {
  const files = inventory(directory).filter(file => !['artifacts.json', 'SHA256SUMS'].includes(file.path));
  save(join(directory, 'artifacts.json'), { completeArchiveInventory: true, files });
  writeFileSync(join(directory, 'SHA256SUMS'), [...files, { path: 'artifacts.json', ...digest(join(directory, 'artifacts.json')) }].map(f => `${f.sha256}  ${f.path}\n`).join(''));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'activation') console.log(JSON.stringify(activation(resolve(directory))));
  else if (mode === 'seal') sealArtifacts(resolve(directory));
  else throw new Error('Only activation or seal is supported');
}
