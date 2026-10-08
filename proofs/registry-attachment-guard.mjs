import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { manifest, sha256, sourceGuard } from './worker-arena-source-guard.mjs';
import { protocol } from './registry-attachment-protocol.mjs';

export const PROOF_PATHS = [
  '.github/workflows/registry-attachment-controls.yml',
  'proofs/registry-attachment-controls.manifest.json', 'proofs/registry-attachment-controls.md',
  'proofs/registry-attachment-protocol.mjs', 'proofs/registry-attachment-guard.mjs',
  'proofs/registry-attachment-subject.mjs', 'proofs/run-registry-attachment-controls.mjs',
  'proofs/registry-attachment-tests.node.mjs',
  'proofs/worker-arena-source-guard.mjs', 'proofs/worker-arena-benchmark.mjs',
  'proofs/worker-arenas.mjs', 'proofs/node-worker.mjs', 'proofs/worker-sessions.mjs', 'proofs/typed-json-worker.mjs',
];
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
export function pinnedGuard(baseline, candidate, proofRoot) {
  const result = sourceGuard(baseline, candidate, protocol.pins.candidate);
  assert.equal(result.passed, true, result.errors.join('; '));
  assert.deepEqual(result.differences, ['arena.ts', 'shared.ts']);
  for (const variant of ['baseline', 'candidate']) {
    const state = result[variant];
    assert.equal(state.commit, protocol.pins[variant]);
    assert.equal(state.source.sha256, protocol.pins.source[variant], `${variant} exact historical source manifest mismatch`);
    assert.equal(state.build.sha256, protocol.pins.build[variant], `${variant} exact historical emitted build mismatch`);
    for (const file of state.source.files.filter(file => !file.path.endsWith('.wasm'))) {
      const bytes = execFileSync('git', ['show', `${state.commit}:${file.path}`], { cwd: state.root });
      assert.equal(sha256(bytes), file.sha256, `Tracked source does not match commit: ${file.path}`);
    }
  }
  assert.equal(sha256(readFileSync(join(proofRoot, 'proofs/worker-arena-benchmark.mjs'))), protocol.pins.originalHarnessSha256);
  result.proofs = manifest(proofRoot, PROOF_PATHS);
  assert(result.proofs.files.every(file => file.sha256));
  result.proofCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proofRoot, encoding: 'utf8' }).trim();
  result.proofStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...PROOF_PATHS], { cwd: proofRoot, encoding: 'utf8' });
  return result;
}
