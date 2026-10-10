import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, compareSources, sourceGuard, sourcePaths } from './worker-arena-source-guard.mjs';
const state = files => ({ source: { files: Object.entries(files).map(([path, sha256]) => ({ path, sha256 })) } });
const baseline = { 'arena.ts': 'old-arena', 'shared.ts': 'old-shared', 'other.ts': 'same', 'persistent-core.wasm': 'wasm', 'package.json': 'package', 'scripts/build-browser.ts': 'build' };
test('allows only the two reviewed runtime files', () => {
  const result = compareSources(state(baseline), state({ ...baseline, 'arena.ts': 'new-arena', 'shared.ts': 'new-shared' }));
  assert.deepEqual(result.differences, ['arena.ts', 'shared.ts']);
  assert.deepEqual(result.rejected, []);
});
test('rejects unrelated changed, added, and removed source paths', () => {
  for (const path of ['other.ts', 'persistent-core.wasm', 'package.json', 'scripts/build-browser.ts']) {
    assert.deepEqual(compareSources(state(baseline), state({ ...baseline, [path]: 'changed' })).rejected, [path]);
    const removed = { ...baseline }; delete removed[path];
    assert.deepEqual(compareSources(state(baseline), state(removed)).rejected, [path]);
  }
  assert.deepEqual(compareSources(state(baseline), state({ ...baseline, 'new.ts': 'added' })).rejected, ['new.ts']);
});
test('uses the union even when missing files are explicitly represented', () => {
  assert.deepEqual(compareSources(state({ ...baseline, 'removed.ts': 'old' }), state({ ...baseline, 'removed.ts': null, 'added.ts': 'new' })).rejected, ['added.ts', 'removed.ts']);
});

test('discovers the stated source/configuration union without tests or nested app files', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-arena-discovery-'));
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'demo'));
    for (const path of ['arena.ts', 'kernel.as.ts', 'other.mts', 'helper.js', 'core.wasm', 'package.json', 'tsconfig.json', 'bunfig.toml', 'reader.test.ts', 'helper.spec.mjs', 'scripts/build-browser.ts', 'scripts/build-helper.mjs', 'scripts/check.mjs', 'demo/app.ts']) writeFileSync(join(root, path), path);
    assert.deepEqual(sourcePaths(root), ['arena.ts', 'bunfig.toml', 'core.wasm', 'helper.js', 'kernel.as.ts', 'other.mts', 'package.json', 'scripts/build-browser.ts', 'scripts/build-helper.mjs', 'tsconfig.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('captures actual Git HEAD, per-file hashes, and clean/dirty source state', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-arena-capture-'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'arena.ts'), 'original');
    writeFileSync(join(root, 'dist/shared.js'), 'built');
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Guard test', '-c', 'user.email=guard@example.invalid', 'commit', '-qm', 'fixture']);
    const clean = capture(root);
    assert.equal(clean.commit, git(['rev-parse', 'HEAD']));
    assert.equal(clean.sourceDirty, false); assert.equal(clean.worktreeDirty, false);
    assert.equal(clean.source.files.length, 2); assert.equal(clean.build.files.length, 1);
    writeFileSync(join(root, 'arena.ts'), 'changed'); writeFileSync(join(root, 'new.ts'), 'added');
    const dirty = capture(root);
    assert.equal(dirty.sourceDirty, true); assert.equal(dirty.worktreeDirty, true);
    assert.notEqual(dirty.source.sha256, clean.source.sha256);
    assert(dirty.sourceStatus.includes(' M arena.ts')); // Keep porcelain's leading XY column.
    assert(dirty.sourceStatus.some(line => line.includes('new.ts')));
    const rejected = sourceGuard(root, root, 'incorrect-head');
    assert.equal(rejected.passed, false);
    assert(rejected.errors.some(error => error.includes('Baseline must be')));
    assert(rejected.errors.some(error => error.includes('Candidate HEAD')));
    assert(rejected.errors.some(error => error.includes('source is dirty')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
