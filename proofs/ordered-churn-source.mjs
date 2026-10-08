import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
export const BASELINE_COMMIT = '3773c6e519c7c0958da13727ed1082f449f3ee25';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const median = values => { const sorted = [...values].sort((a, b) => a - b), n = sorted.length; return n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  if (result.status) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
export function bundleManifest(entry) {
  const root = dirname(resolve(entry)), paths = [];
  const walk = dir => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name); if (item.isSymbolicLink()) throw new Error(`Bundle symlink: ${path}`);
    if (item.isDirectory()) walk(path); else if (/\.(js|wasm)$/.test(path)) paths.push(path);
  } }; walk(root);
  return Object.fromEntries(paths.sort().map(path => [relative(root, path), sha256(readFileSync(path))]));
}
export function prepareComparison(baseline, candidate) {
  const paths = { baseline: resolve(baseline), candidate: resolve(candidate) }, repo = dirname(dirname(paths.candidate));
  const candidateCommit = (process.env.CANDIDATE_COMMIT ?? git(repo, ['rev-parse', 'HEAD']).toString().trim());
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error('Candidate commit must be an immutable full SHA');
  const refs = { baseline: BASELINE_COMMIT, candidate: candidateCommit };
  const production = file => (/^[^/]+\.ts$/.test(file) && !file.endsWith('.test.ts')) || file === 'package.json' || /^scripts\/build[^/]*\.(mjs|ts)$/.test(file);
  const names = new Set();
  for (const ref of Object.values(refs)) for (const file of git(repo, ['ls-tree', '-r', '--name-only', ref]).toString().trim().split('\n')) if (production(file)) names.add(file);
  const sourceManifests = {};
  for (const [variant, ref] of Object.entries(refs)) {
    const root = dirname(dirname(paths[variant])), files = {};
    for (const file of [...names].sort()) {
      const expected = git(repo, ['show', `${ref}:${file}`]);
      files[file] = sha256(readFileSync(join(root, file)));
      assert.equal(files[file], sha256(expected), `Source is not pinned ${variant}/${file}`);
    }
    // Reused generated kernels must be byte-identical, even for portable builds.
    const wasm = Object.fromEntries(readdirSync(root).filter(file => file.endsWith('.wasm')).sort().map(file => [file, sha256(readFileSync(join(root, file)))]));
    assert(Object.keys(wasm).length >= 4, 'Missing generated kernels');
    sourceManifests[variant] = { root, files, wasm };
  }
  const sourceDiff = [...names].filter(file => sourceManifests.baseline.files[file] !== sourceManifests.candidate.files[file]).sort();
  assert.deepEqual(sourceDiff, ['shared-ordered-map.ts'], 'Unrelated runtime/build source difference');
  assert.deepEqual(sourceManifests.baseline.wasm, sourceManifests.candidate.wasm, 'Generated kernels differ');
  return { paths, sourcePaths: paths, sourceManifests, sourceDiff, candidateCommit,
    manifests: Object.fromEntries(Object.entries(paths).map(([key, entry]) => [key, bundleManifest(entry)])), cleanup() {} };
}
