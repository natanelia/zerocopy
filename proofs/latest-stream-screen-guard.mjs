// Physical-copy helpers adapted from the reviewed registry-attachment guard.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { protocol } from './latest-stream-screen-protocol.mjs';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const proofFiles = ['latest-stream-screen.manifest.json', 'latest-stream-screen.md', 'latest-stream-screen-protocol.mjs', 'latest-stream-screen-guard.mjs', 'latest-stream-screen-subject.mjs', 'latest-stream-screen-tests.node.mjs', 'run-latest-stream-screen.mjs', 'gate-latest-stream-screen.mjs'];
export function proofFingerprint(root) {
  const paths = [...proofFiles.map(path => `proofs/${path}`), '.github/workflows/latest-stream-screen.yml'];
  return Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(root, path)))]));
}
export function treeManifest(root) {
  assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), `Must be physical directory: ${root}`);
  const entries = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const location = join(dir, entry.name), path = relative(root, location).split(sep).join('/');
      assert(!entry.isSymbolicLink(), `Symlink forbidden: ${path}`);
      if (entry.isDirectory()) { entries.push({ path: path + '/', sha256: null }); walk(location); }
      else { assert(entry.isFile(), `Non-regular file: ${path}`); entries.push({ path, sha256: sha256(readFileSync(location)) }); }
    }
  }
  walk(root);
  return { sha256: sha256(JSON.stringify(entries)), entries };
}
export function createEvidenceDirectory(directory) {
  // Never overwrite partial or completed evidence from an earlier invocation.
  mkdirSync(directory);
}
export function sourceContext(root) {
  root = realpathSync(root);
  const packagePath = join(root, 'package.json'), dist = join(root, 'dist');
  assert(lstatSync(packagePath).isFile() && !lstatSync(packagePath).isSymbolicLink());
  assert(existsSync(join(dist, 'shared.js')));
  return { root, dist, packageBytes: readFileSync(packagePath), distManifest: treeManifest(dist) };
}
export function verifyContext(context) {
  assert.deepEqual(readFileSync(join(context.root, 'package.json')), context.packageBytes, 'Source package changed');
  assert.deepEqual(treeManifest(context.dist), context.distManifest, 'Source bundle changed');
}
export function stageCanonical(context, canonical, subjectBytes, additional = {}) {
  verifyContext(context);
  // Only the private subject directory owned by this invocation is replaced.
  canonical = resolve(canonical);
  assert.equal(realpathSync(dirname(canonical)), dirname(canonical), 'Canonical parent must be physical');
  if (existsSync(canonical)) assert(!lstatSync(canonical).isSymbolicLink(), 'Canonical root cannot be symlink');
  rmSync(canonical, { recursive: true, force: true }); mkdirSync(canonical);
  cpSync(context.dist, join(canonical, 'dist'), { recursive: true, dereference: false });
  writeFileSync(join(canonical, 'package.json'), context.packageBytes);
  writeFileSync(join(canonical, 'subject.mjs'), subjectBytes);
  for (const [path, bytes] of Object.entries(additional)) {
    const target = resolve(canonical, path);
    assert(target.startsWith(canonical + sep), 'Additional proof must stay inside staging');
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  assert.equal(realpathSync(canonical), canonical);
  assert.deepEqual(treeManifest(join(canonical, 'dist')), context.distManifest);
  return treeManifest(canonical);
}
export function checkAfterSubject(context, canonical, before) {
  verifyContext(context);
  const after = treeManifest(canonical);
  assert.deepEqual(after, before, 'Staged package changed during subject');
  return after;
}
export function cleanEnvironment(env = process.env) {
  const result = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ']) if (env[name] !== undefined) result[name] = env[name];
  result.NODE_DISABLE_COMPILE_CACHE = '1';
  return result;
}
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
export function runtimePaths(root) {
  return [
    ...readdirSync(root).filter(name => /\.(?:ts|tsx|js|mjs|cjs|wasm)$/.test(name) && !/\.(?:test|spec)\./.test(name)),
    ...readdirSync(join(root, 'scripts')).filter(name => /^build[-.]/.test(name)).map(name => `scripts/${name}`),
    'package.json', ...readdirSync(root).filter(name => /^tsconfig.*\.json$|^bunfig\./.test(name)),
  ].sort();
}
export function exactSource(repo, root, variant) {
  root = realpathSync(root);
  const commit = protocol.pins[variant]; assert(commit);
  const objects = git(repo, ['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean).map(row => {
    const [header, path] = row.split('\t'), [mode, type, object] = header.split(' ');
    assert.equal(type, 'blob'); assert(['100644', '100755'].includes(mode)); return { path, object };
  });
  if (variant === 'candidate') assert.equal(git(repo, ['rev-parse', `${commit}^{tree}`]).toString().trim(), protocol.pins.candidateTree);
  const tracked = objects.map(row => row.path);
  const files = {};
  for (const { path, object } of objects) {
    const location = join(root, path);
    assert(lstatSync(location).isFile() && !lstatSync(location).isSymbolicLink(), `Not a regular pinned source: ${path}`);
    const bytes = readFileSync(location);
    const gitObject = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(gitObject, object, `${variant} source differs from pinned commit: ${path}`); files[path] = sha256(bytes);
  }
  const runtime = {};
  for (const path of runtimePaths(root)) {
    if (!path.endsWith('.wasm')) assert(tracked.includes(path), `Untracked runtime/build input: ${path}`);
    assert(!lstatSync(join(root, path)).isSymbolicLink()); runtime[path] = sha256(readFileSync(join(root, path)));
  }
  assert.equal(runtime['worker.ts'], protocol.pins.workerSource[variant]);
  assert.equal(runtime['persistent-core.wasm'], protocol.pins.persistentWasm);
  if (variant === 'candidate') assert.equal(files['worker.test.ts'], protocol.pins.candidateTests);
  const build = {};
  for (const row of treeManifest(join(root, 'dist')).entries) if (row.path.endsWith('.js')) build[row.path] = row.sha256;
  if (protocol.pins.builds) assert.deepEqual(build, protocol.pins.builds[variant], `${variant} emitted JS differs from reviewed build`);
  return { root, commit, files, runtime, build, packageSha256: files['package.json'] };
}
export function verifyPinnedSnapshot(snapshot) {
  for (const [path, digest] of Object.entries(snapshot.files)) assert.equal(sha256(readFileSync(join(snapshot.root, path))), digest, `Pinned source changed: ${path}`);
  const runtime = Object.fromEntries(runtimePaths(snapshot.root).map(path => [path, sha256(readFileSync(join(snapshot.root, path)))]));
  assert.deepEqual(runtime, snapshot.runtime, 'Runtime inputs changed during the study');
}
export function pinnedGuard(repo, baselineRoot, candidateRoot) {
  const baseline = exactSource(repo, baselineRoot, 'baseline'), candidate = exactSource(repo, candidateRoot, 'candidate');
  const paths = [...new Set([...Object.keys(baseline.runtime), ...Object.keys(candidate.runtime)])].sort();
  const differences = paths.filter(path => baseline.runtime[path] !== candidate.runtime[path]);
  assert.deepEqual(differences, ['worker.ts'], 'Only worker.ts may differ among runtime/build inputs');
  assert.equal(baseline.packageSha256, candidate.packageSha256);
  assert(protocol.pins.builds, 'Reviewed exact JS build pins are required');
  return { baseline, candidate, differences };
}
export const requiredGateChecks = ['typecheck', 'build:types', 'typecheck:redux', 'typecheck:values', 'typecheck:geometry', 'public-worker-types', 'full-unit', 'node-worker', 'worker-sessions', 'worker-tasks', 'typed-json-worker', 'stream-correctness'];
export function compilerContext(root) {
  const packages = {};
  for (const name of Object.keys(protocol.pins.compilers)) {
    const directory = realpathSync(join(root, 'node_modules', name));
    packages[name] = { version: JSON.parse(readFileSync(join(directory, 'package.json'))).version, sha256: treeManifest(directory).sha256 };
  }
  assert.deepEqual(packages, protocol.pins.compilers, 'Compiler packages differ from reviewed pins');
  return packages;
}
export function verifyGate(receipt, comparison, proofs) {
  assert.equal(receipt.status, 'passed', 'Full unit CI gate must pass before timing');
  assert.equal(receipt.node, protocol.toolchain.node); assert.equal(receipt.bun, protocol.toolchain.bun);
  assert.equal(receipt.bunRevision, protocol.toolchain.bunRevision);
  assert.deepEqual(receipt.compilers, protocol.pins.compilers, 'Missing exact compiler pins');
  assert(proofs && receipt.proofs, 'Exact protocol and kernel gate hashes are required');
  assert.deepEqual(receipt.proofs, proofs, 'Protocol/kernel changed since correctness gate');
  for (const variant of ['baseline', 'candidate']) {
    assert.deepEqual(receipt.sources[variant], comparison[variant]);
    for (const required of requiredGateChecks) {
      const checks = receipt.checks.filter(row => row.variant === variant && row.name === required);
      assert(checks.length === 1 && checks[0].status === 0 && checks[0].signal === null && checks[0].logSha256, `Missing successful ${variant}/${required}`);
    }
  }
  assert.equal(receipt.strictWorkerTypecheck.disposition, 'built-public-consumers-passed');
  assert.equal(receipt.strictWorkerTypecheck.diagnosticCount, 0);
  assert.equal(receipt.strictWorkerTypecheck.passed, true);
}
