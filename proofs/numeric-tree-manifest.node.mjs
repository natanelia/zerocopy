import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, verify } from './numeric-tree-manifest.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'numeric-inventory-'));
  const base = join(root, 'base'), candidate = join(root, 'candidate');
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  for (const dir of [base, candidate]) { mkdirSync(dir); git(dir, 'init', '-q'); writeFileSync(join(dir, 'same'), 'unchanged'); writeFileSync(join(dir, 'change'), dir === base ? 'before' : 'after'); }
  writeFileSync(join(base, 'deleted'), 'old'); writeFileSync(join(candidate, 'added'), 'new');
  for (const dir of [base, candidate]) { git(dir, 'add', '.'); git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); }
  const manifest = { version: 2, kind: 'current-file-inventory', baselineCommit: git(base, 'rev-parse', 'HEAD'), baselineTree: git(base, 'write-tree'), sourceParent: git(candidate, 'rev-parse', 'HEAD'), files: inventory(base, candidate) };
  try { run({ root, base, candidate, git, manifest }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('inventory covers additions, modifications and deletions', () => fixture(({ base, candidate, manifest }) => {
  assert.deepEqual(manifest.files.map(f => [f.path, f.status]), [['added', 'added'], ['change', 'modified'], ['deleted', 'deleted']]);
  assert.deepEqual(verify(manifest, base, candidate), { filesVerified: 3, baselineTreeVerified: true, baselineCommitVerified: true });
}));
test('missing, extra, wrong-size and wrong-hash inventory entries fail', () => fixture(({ base, candidate, manifest }) => {
  for (const change of [m => m.files.pop(), m => m.files.push(m.files[0]), m => m.files[0].bytes++, m => m.files[0].sha256 = '0'.repeat(64)]) {
    const copy = structuredClone(manifest); change(copy); assert.throws(() => verify(copy, base, candidate));
  }
}));
test('wrong baseline identity fails', () => fixture(({ base, candidate, manifest }) => {
  assert.throws(() => verify({ ...manifest, baselineTree: '0'.repeat(40) }, base, candidate));
  assert.throws(() => verify({ ...manifest, baselineCommit: '0'.repeat(40) }, base, candidate));
}));
test('unstaged baseline and candidate source changes fail', () => fixture(({ base, candidate, manifest }) => {
  writeFileSync(join(candidate, 'change'), 'not staged'); assert.throws(() => verify(manifest, base, candidate));
  writeFileSync(join(candidate, 'change'), 'after'); writeFileSync(join(base, 'same'), 'not staged'); assert.throws(() => verify(manifest, base, candidate));
}));
test('symbolic links are hashed as link text, not their target contents', () => fixture(({ base, candidate, git }) => {
  symlinkSync('missing-target', join(candidate, 'link')); git(candidate, 'add', 'link');
  const row = inventory(base, candidate).find(f => f.path === 'link'); assert.equal(row.mode, '120000'); assert.equal(row.bytes, 'missing-target'.length);
}));
test('compiler snapshot includes exact transitive packages and their license files', () => {
  const root = mkdtempSync(join(tmpdir(), 'numeric-toolkit-'));
  try {
    const project = join(root, 'project'), compiler = join(project, 'node_modules/assemblyscript');
    const dep = join(compiler, 'node_modules/dependency'); mkdirSync(dep, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ devDependencies: { assemblyscript: '0.28.20' } }));
    writeFileSync(join(compiler, 'package.json'), JSON.stringify({ name: 'assemblyscript', version: '0.28.20', dependencies: { dependency: '1.0.0' } }));
    writeFileSync(join(compiler, 'LICENSE'), 'fixture compiler license');
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dependency', version: '1.0.0' }));
    writeFileSync(join(dep, 'LICENSE'), 'fixture dependency license');
    const out = join(root, 'out'); const script = fileURLToPath(new URL('./numeric-tree-toolkit.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { env: { ...process.env, CANDIDATE_DIR: project, TOOLKIT_DIR: out }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.packages.map(p => [p.name, p.version]), [['assemblyscript', '0.28.20'], ['dependency', '1.0.0']]);
    assert.ok(manifest.files['node_modules/dependency/LICENSE']); assert.ok(manifest.files['node_modules/assemblyscript/LICENSE']);
    const duplicate = spawnSync(process.execPath, [script], { env: { ...process.env, CANDIDATE_DIR: project, TOOLKIT_DIR: out }, encoding: 'utf8' });
    assert.notEqual(duplicate.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('final gate checks raw status and refuses missing or failed endpoints', async () => {
  const { validatePhase } = await import('./numeric-tree-gate.mjs');
  const { endpoints } = await import('./numeric-tree-process.mjs');
  const report = { kind: 'aa', fullCoverage: true, error: null, pass: true,
    rows: endpoints().map(r => ({ ...r, pointPass: true, confidencePass: true, pass: true })),
    cohorts: Array.from({ length: 11 }, () => ({ error: null, pass: true })) };
  assert.doesNotThrow(() => validatePhase(report, 'aa'));
  for (const change of [r => r.pass = false, r => r.fullCoverage = false,
    r => r.error = 'failure', r => r.rows.pop(), r => r.rows[0].confidencePass = false,
    r => r.cohorts.pop(), r => r.cohorts[0].error = 'failure']) {
    const copy = structuredClone(report); change(copy); assert.throws(() => validatePhase(copy, 'aa'));
  }
  assert.throws(() => validatePhase(report, 'ab'));
});
