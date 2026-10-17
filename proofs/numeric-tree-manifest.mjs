import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const manifestPath = 'proofs/experiments/numeric-tree-20261017/manifest.json';
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
function tracked(dir) {
  const entries = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: dir, encoding: 'utf8' }).split('\0').filter(Boolean);
  return new Map(entries.map(entry => {
    const split = entry.indexOf('\t'); assert.ok(split > 0);
    const [mode, blob, stage] = entry.slice(0, split).split(' '); const path = entry.slice(split + 1);
    assert.equal(stage, '0', 'Unmerged source index');
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Invalid source path');
    return [path, { mode, blob }];
  }).filter(([path]) => path !== manifestPath));
}
function state(dir, path, entry) {
  const absolute = resolve(dir, path);
  const bytes = lstatSync(absolute).isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
  const blob = hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
  assert.equal(blob, entry.blob, `Stage the source before making its inventory: ${path}`);
  return { mode: entry.mode, bytes: bytes.length, sha256: hash('sha256', bytes) };
}
export function inventory(baseDir, candidateDir) {
  const base = tracked(baseDir); const candidate = tracked(candidateDir); const files = [];
  for (const path of [...new Set([...base.keys(), ...candidate.keys()])].sort()) {
    const before = base.has(path) ? state(baseDir, path, base.get(path)) : null;
    const after = candidate.has(path) ? state(candidateDir, path, candidate.get(path)) : null;
    if (JSON.stringify(before) !== JSON.stringify(after)) files.push({ path, status: !before ? 'added' : !after ? 'deleted' : 'modified', ...after });
  }
  return files;
}
export function verify(manifest, baseDir, candidateDir) {
  assert.equal(manifest.version, 2); assert.equal(manifest.kind, 'current-file-inventory');
  assert.match(manifest.baselineCommit, /^[0-9a-f]{40}$/); assert.match(manifest.sourceParent, /^[0-9a-f]{40}$/);
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: baseDir, encoding: 'utf8' });
  if (head.status === 0) assert.equal(head.stdout.trim(), manifest.baselineCommit, 'Different baseline commit');
  assert.equal(manifest.baselineTree, execFileSync('git', ['write-tree'], { cwd: baseDir, encoding: 'utf8' }).trim(), 'Different baseline tree');
  assert.deepEqual(manifest.files, inventory(baseDir, candidateDir), 'Stale, missing or extra inventory entry');
  return { filesVerified: manifest.files.length, baselineTreeVerified: true, baselineCommitVerified: head.status === 0 };
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const baseDir = resolve(process.env.BASE_DIR ?? '../zerocopy-base');
  const candidateDir = resolve(process.env.CANDIDATE_DIR ?? '.');
  const path = resolve(candidateDir, manifestPath);
  if (process.argv.includes('--write')) {
    assert.match(process.env.BASELINE_COMMIT ?? '', /^[0-9a-f]{40}$/);
    assert.match(process.env.SOURCE_PARENT ?? '', /^[0-9a-f]{40}$/);
    const manifest = { version: 2, kind: 'current-file-inventory', baselineCommit: process.env.BASELINE_COMMIT,
      baselineTree: execFileSync('git', ['write-tree'], { cwd: baseDir, encoding: 'utf8' }).trim(), sourceParent: process.env.SOURCE_PARENT,
      notes: ['This inventories the staged source, not a performance acceptance decision.',
        'The inventory excludes itself to avoid a recursive digest.',
        'manifest-before-stage4.json preserves the superseded inventory verbatim. Its entries do not describe the current tree.',
        'Historical test outcomes and generated-binary digests stay with their original stage reports and hosted artifacts.'],
      files: inventory(baseDir, candidateDir) };
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log(JSON.stringify(verify(JSON.parse(readFileSync(path, 'utf8')), baseDir, candidateDir)));
}
