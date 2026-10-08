/** Reject unrelated production changes before a worker-registry comparison. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const BASELINE_COMMIT = '3331f2f0e9e0c3c61832e5f04b12e18c1889d96c';
export const ALLOWED_SOURCE_CHANGES = ['arena.ts', 'shared.ts'];
export const GUARD_SCOPE = {
  root: 'Root TS/JS source files excluding .test/.spec files, root WASM binaries, package.json, tsconfig*.json, and bunfig.toml/json',
  scripts: 'Direct scripts/build-* and scripts/build.* files',
  boundary: 'Scoped to this repository layout and the pinned baseline; not a recursive universal build-input graph',
};
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
export function sourcePaths(root) {
  // Conservatively include root TS/JS files except tests, including AS sources
  // and configuration/benchmark TS. Generated WASM must match as well.
  const paths = readdirSync(root, { withFileTypes: true })
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && ((/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) || entry.name.endsWith('.wasm') || /^tsconfig.*\.json$/.test(entry.name) || /^bunfig\.(?:toml|json)$/.test(entry.name)))
    .map(entry => entry.name);
  paths.push('package.json');
  const scripts = join(root, 'scripts');
  if (existsSync(scripts)) for (const entry of readdirSync(scripts, { withFileTypes: true })) {
    if ((entry.isFile() || entry.isSymbolicLink()) && /^build[-.]/.test(entry.name)) paths.push(`scripts/${entry.name}`);
  }
  return paths.sort();
}
export function manifest(root, paths) {
  const files = [...new Set(paths)].sort().map(path => {
    const location = join(root, path);
    return { path, sha256: existsSync(location) ? sha256(readFileSync(location)) : null };
  });
  return { sha256: sha256(files.map(file => `${file.path}\0${file.sha256 ?? '<missing>'}`).join('\n')), files };
}
export function capture(root, paths = sourcePaths(root)) {
  const guardedTrackedPaths = paths.filter(path => !path.endsWith('.wasm'));
  const sourceStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...guardedTrackedPaths]);
  const worktreeStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    root, commit: git(root, ['rev-parse', 'HEAD']),
    sourceDirty: sourceStatus.length > 0, sourceStatus: sourceStatus.split('\n').filter(Boolean),
    worktreeDirty: worktreeStatus.length > 0, worktreeStatus: worktreeStatus.split('\n').filter(Boolean),
    source: manifest(root, paths),
    build: manifest(root, readdirSync(join(root, 'dist')).filter(path => path.endsWith('.js')).map(path => `dist/${path}`)),
  };
}
export function compareSources(baseline, candidate) {
  const before = new Map(baseline.source.files.map(file => [file.path, file.sha256]));
  const after = new Map(candidate.source.files.map(file => [file.path, file.sha256]));
  const differences = [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter(path => before.get(path) !== after.get(path));
  const rejected = differences.filter(path => !ALLOWED_SOURCE_CHANGES.includes(path));
  return { differences, rejected, allowedDifferences: ALLOWED_SOURCE_CHANGES };
}
export function sourceGuard(baselineRoot, candidateRoot, expectedCandidateCommit) {
  const paths = [...new Set([...sourcePaths(baselineRoot), ...sourcePaths(candidateRoot)])].sort();
  const baseline = capture(baselineRoot, paths), candidate = capture(candidateRoot, paths);
  const comparison = compareSources(baseline, candidate), errors = [];
  if (baseline.commit !== BASELINE_COMMIT) errors.push(`Baseline must be ${BASELINE_COMMIT}; got ${baseline.commit}`);
  if (!expectedCandidateCommit || candidate.commit !== expectedCandidateCommit) errors.push(`Candidate HEAD does not match expected explicit commit ${expectedCandidateCommit ?? '<unset>'}`);
  if (baseline.sourceDirty || candidate.sourceDirty) errors.push('Guarded production source is dirty');
  if (comparison.rejected.length) errors.push(`Unrelated production differences: ${comparison.rejected.join(', ')}`);
  return { passed: errors.length === 0, errors, scope: GUARD_SCOPE, baseline, candidate, ...comparison };
}
