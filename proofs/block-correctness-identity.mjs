import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const HERE = dirname(fileURLToPath(import.meta.url)), PROOF = dirname(HERE);
export const PINS = JSON.parse(readFileSync(join(HERE, 'block-correctness-pins.json'), 'utf8'));
export const BRANCH = 'proof/block-correctness-diagnostic-20261009';
export const FILES = Object.freeze(['.github/workflows/block-correctness-diagnostic.yml', ...[
  'block-correctness.bun.lock', 'block-correctness-pins.json', 'block-correctness-trace.mjs',
  'block-correctness-reporter.mjs', 'block-correctness-runner.mjs', 'block-correctness-sequencer.mjs',
  'block-correctness-command.mjs', 'block-correctness-identity.mjs', 'block-correctness-diagnostic.mjs',
  'block-correctness-protocol.node.mjs', 'block-correctness-diagnostic.md',
].map(f => 'proofs/' + f)]);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = path => ({ bytes: statSync(path).size, sha256: sha256(readFileSync(path)) });
export const git = (root, ...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
export const gitText = (root, ...args) => git(root, ...args).toString().trim();
export function inventory(root) {
  const out = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), `Unexpected symlink in evidence/cache: ${path}`);
      if (stat.isDirectory()) visit(path);
      else { assert(stat.isFile()); out.push({ path: relative(root, path), ...digest(path) }); }
    }
  };
  if (existsSync(root)) visit(root); return out;
}
export function copyFiles(source, files, destination) {
  for (const { path } of files) {
    const target = join(destination, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(source, path), target);
  }
}
export function exactTree(root, ref, { runtime = false } = {}) {
  assert.equal(gitText(root, 'rev-parse', 'HEAD'), ref);
  const files = git(root, 'ls-tree', '-rz', ref).toString().split('\0').filter(Boolean).map(line => {
    const [, mode, type, blob, path] = /^(\d+) (\S+) ([a-f0-9]{40})\t(.+)$/.exec(line) ?? [];
    assert.equal(type, 'blob'); assert(['100644', '100755'].includes(mode));
    const file = join(root, path); assert(lstatSync(file).isFile());
    const bytes = readFileSync(file), actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(actual, blob, `Changed frozen source: ${path}`); return { path, mode, blob, ...digest(file) };
  });
  if (runtime) {
    const known = new Set(files.map(x => x.path));
    const visit = directory => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), rel = relative(root, path);
        if (['.git', 'node_modules'].includes(rel)) continue;
        const stat = lstatSync(path);
        assert(!stat.isSymbolicLink(), `Unexpected runtime symlink: ${rel}`);
        if (stat.isDirectory()) visit(path);
        else assert(known.has(rel) || Object.keys(PINS).some(arm => PINS[arm]?.wasm?.some(x => x.path === rel))
          || rel === 'geometry-kernels.wat' || PINS.baseline.dist.some(x => 'dist/' + x.path === rel), `Unexpected runtime input: ${rel}`);
      }
    }; visit(root);
  }
  return { root, ref, tree: gitText(root, 'rev-parse', ref + '^{tree}'), files };
}
export function proofIdentity(root = PROOF) {
  const head = gitText(root, 'rev-parse', 'HEAD');
  assert.equal(gitText(root, 'show', '-s', '--format=%P', head), PINS.candidate.commit, 'Diagnostic must be one new proof commit on unchanged candidate');
  const changes = gitText(root, 'diff', '--name-status', PINS.candidate.commit, head).split('\n').sort();
  assert.deepEqual(changes, FILES.map(f => 'A\t' + f).sort(), 'Only declared new diagnostic files may differ');
  return exactTree(root, head);
}
export function verifyInvocation(env, event, head) {
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_REF, 'refs/heads/' + BRANCH); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GITHUB_SHA, head); assert.equal(event.after, head); assert.equal(event.ref, env.GITHUB_REF);
  assert.equal(event.before, '0'.repeat(40)); assert.equal(event.created, true); assert.equal(event.forced, false); assert.equal(event.deleted, false);
  return { event: 'push', branch: BRANCH, head, before: event.before, created: true, runAttempt: 1 };
}
export function dependencyIdentity(root, name) {
  const directory = realpathSync(join(root, 'node_modules', name));
  const files = [];
  const visit = (folder, prefix = '') => {
    for (const name of readdirSync(folder).sort()) {
      if (name === 'node_modules') continue;
      const path = join(folder, name), rel = prefix + name, stat = lstatSync(path);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) visit(path, rel + '/'); else { assert(stat.isFile()); files.push({ path: rel, ...digest(path) }); }
    }
  }; visit(directory);
  return { version: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version, sha256: sha256(JSON.stringify(files)), directory, files };
}
export function cacheReceipt(root) {
  assert(lstatSync(root).isDirectory()); assert.equal(realpathSync(root), resolve(root));
  const files = inventory(root);
  return { root, realpath: realpathSync(root), resultRelativePath: 'vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json',
    files, inventorySha256: sha256(JSON.stringify(files)) };
}
export function configSource(root, cache) {
  // Static import lets Vite use its standard config loader for the original TS config.
  return `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};\nimport Sequencer from ${JSON.stringify(join(HERE, 'block-correctness-sequencer.mjs'))};\nexport default { ...base, root: ${JSON.stringify(root)}, cacheDir: ${JSON.stringify(cache)}, test: { ...base.test, reporters: ['default', ${JSON.stringify(join(HERE, 'block-correctness-reporter.mjs'))}], runner: ${JSON.stringify(join(HERE, 'block-correctness-runner.mjs'))}, sequence: { ...base.test?.sequence, sequencer: Sequencer } } };\n`;
}
