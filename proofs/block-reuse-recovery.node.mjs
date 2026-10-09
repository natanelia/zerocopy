import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PINS, BRANCH, runtimeGeneratedPaths, verifyRuntimeInputs, verifyInvocation, cacheReceipt, configSource,
  prepareCaches, validateStandardSuite, sealArtifacts, digest, exactSource } from './block-reuse-recovery.mjs';
const temporary = () => mkdtempSync(join(tmpdir(), 'block-recovery-check-'));
const put = (root, path, text = '') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

for (const [trackedMode, physicalMode, changedMode] of [['100644', 0o644, 0o755], ['100755', 0o755, 0o644]]) {
  test(`exact source rejects ${trackedMode} executable-mode drift even with core.filemode=false`, () => {
    const root = temporary(), path = join(root, 'source.ts');
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    try {
      git('init', '--quiet'); git('config', 'core.filemode', 'false');
      put(root, 'source.ts', 'export const unchanged = true;\n'); chmodSync(path, physicalMode);
      git('add', 'source.ts'); git('update-index', '--chmod=' + (trackedMode === '100755' ? '+x' : '-x'), 'source.ts');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Frozen mode fixture');
      const head = git('rev-parse', 'HEAD'), before = readFileSync(path);
      assert(git('ls-tree', head, '--', 'source.ts').startsWith(trackedMode + ' '));
      assert.equal(git('status', '--porcelain'), '');
      exactSource(root, head, PINS.baseline.commit);
      chmodSync(path, changedMode);
      assert.deepEqual(readFileSync(path), before); assert.equal(git('status', '--porcelain'), '');
      assert.throws(() => exactSource(root, head, PINS.baseline.commit), /Changed source executable mode: source\.ts/);
      chmodSync(path, physicalMode); exactSource(root, head, PINS.baseline.commit);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('both exact-arm output sets pass; every wrong-arm unique file and unknown file fails', () => {
  for (const name of ['baseline', 'candidate']) {
    const root = temporary();
    try {
      const arm = PINS[name], other = PINS[name === 'baseline' ? 'candidate' : 'baseline'];
      const generated = runtimeGeneratedPaths(arm.commit), opposite = [...runtimeGeneratedPaths(other.commit)].filter(p => !generated.has(p));
      assert(opposite.length > 0); assert.equal(generated.size, arm.wasm.length + arm.dist.length + 1);
      put(root, 'source.ts', 'frozen');
      for (const path of generated) put(root, path);
      verifyRuntimeInputs(root, ['source.ts'], arm.commit);
      for (const path of [...opposite, 'dist/unknown.js', 'unexpected.wasm', 'unexpected.ts']) {
        put(root, path, 'not permitted');
        assert.throws(() => verifyRuntimeInputs(root, ['source.ts'], arm.commit), /Unexpected .* input/);
        rmSync(join(root, path));
      }
      symlinkSync(join(root, 'source.ts'), join(root, 'alias.ts'));
      assert.throws(() => verifyRuntimeInputs(root, ['source.ts'], arm.commit), /symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  assert.throws(() => runtimeGeneratedPaths('0'.repeat(40)), /Unknown runtime/);
});

test('installed lock is a single exact exception, never arbitrary untracked data', () => {
  const root = temporary();
  try {
    put(root, 'bun.lock', readFileSync(new URL('./block-reuse.bun.lock', import.meta.url)));
    verifyRuntimeInputs(root, [], PINS.candidate.commit, { installedLock: true });
    assert.throws(() => verifyRuntimeInputs(root, [], PINS.candidate.commit), /Unexpected .* input/);
    put(root, 'bun.lock', 'changed');
    assert.throws(() => verifyRuntimeInputs(root, [], PINS.candidate.commit, { installedLock: true }), /Changed installed lock/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('creation-push attempt one binds exact head, runtime parent and reviewed tree', () => {
  const head = 'a'.repeat(40), tree = 'b'.repeat(40);
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/' + BRANCH,
    GITHUB_RUN_ATTEMPT: '1', BLOCK_REUSE_ATTEMPT: '1', GITHUB_SHA: head };
  const event = { after: head, before: '0'.repeat(40), ref: env.GITHUB_REF, created: true, forced: false, deleted: false };
  const check = (e = env, push = event, parent = PINS.candidate.commit, message = 'Prepared\n\nReviewed-Tree: ' + tree) => verifyInvocation(e, push, head, tree, parent, message);
  assert.equal(check().tree, tree);
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '2', BLOCK_REUSE_ATTEMPT: '2', GITHUB_SHA: 'c'.repeat(40) })) assert.throws(() => check({ ...env, [key]: value }));
  for (const [key, value] of Object.entries({ before: 'd'.repeat(40), created: false, forced: true, deleted: true, after: 'd'.repeat(40), ref: 'refs/heads/main' })) assert.throws(() => check(env, { ...event, [key]: value }));
  for (const parent of [PINS.baseline.commit, PINS.candidate.commit + ' ' + PINS.baseline.commit]) assert.throws(() => check(env, event, parent));
  for (const message of ['', 'Reviewed-Tree: ' + head, `Reviewed-Tree: ${tree}\nReviewed-Tree: ${tree}`]) assert.throws(() => check(env, event, PINS.candidate.commit, message));
});

test('cache config overrides only cacheDir and preserves original test object unchanged', () => {
  const base = Object.freeze({ cacheDir: 'node_modules/.vite', test: Object.freeze({ pool: 'threads', isolate: false, maxWorkers: 4 }) });
  const source = configSource('/frozen/root', '/evidence/cache');
  assert(source.startsWith('import base from "/frozen/root/vitest.config.ts";\n'));
  const configured = new Function('base', source.split('\n').slice(1).join('\n').replace('export default', 'return'))(base);
  assert.deepEqual(Object.keys(configured).sort(), Object.keys(base).sort());
  assert.equal(configured.test, base.test); assert.equal(configured.cacheDir, '/evidence/cache');
  assert.doesNotMatch(source, /runner|reporter|sequenc|timeout|include|exclude|root:/);
});

test('both cache states are empty and physically distinct, and cannot be resumed', () => {
  const root = temporary();
  try {
    const caches = prepareCaches({ baseline: '/baseline', candidate: '/candidate' }, root);
    assert.notEqual(caches.baseline.before.realpath, caches.candidate.before.realpath);
    assert.equal(caches.baseline.before.inventorySha256, caches.candidate.before.inventorySha256);
    assert.deepEqual(caches.baseline.before.files, []); assert.deepEqual(caches.candidate.before.files, []);
    put(caches.baseline.root, 'old-results.json', '{}');
    assert.notDeepEqual(cacheReceipt(caches.baseline.root), caches.baseline.before);
    assert.deepEqual(cacheReceipt(caches.candidate.root), caches.candidate.before);
    assert.throws(() => prepareCaches({ baseline: '/baseline', candidate: '/candidate' }, root), /No cache resume/);
    symlinkSync(caches.candidate.root, join(root, 'alias'));
    assert.throws(() => cacheReceipt(join(root, 'alias')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('complete default reports require every expected passing module and test', () => {
  for (const arm of ['baseline', 'candidate']) {
    const root = temporary();
    try {
      const count = arm === 'baseline' ? 774 : 784, modules = PINS[arm].testFiles.length;
      const stdout = `Test Files  ${modules} passed (${modules})\n Tests  ${count} passed (${count})\n`;
      const path = 'vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json';
      const result = { version: '4.1.11', results: PINS[arm].testFiles.map(f => [':' + f.path, { failed: false, duration: 1 }]) };
      const save = () => put(root, path, JSON.stringify(result)); save();
      assert.equal(validateStandardSuite(arm, stdout, root).tests, count);
      assert.throws(() => validateStandardSuite(arm, stdout.replace(`${count} passed`, '781 passed'), root), /test summary/);
      result.results[0][1].failed = true; save(); assert.throws(() => validateStandardSuite(arm, stdout, root), /Failed cached/);
      result.results.pop(); save(); assert.throws(() => validateStandardSuite(arm, stdout, root), /Missing\/extra/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('partial evidence seals exact raw bytes and includes its own inventory receipt', () => {
  const root = temporary();
  try {
    put(root, 'logs/partial.jsonl', '{"started":true}\n{"partial":'); sealArtifacts(root);
    const manifest = JSON.parse(readFileSync(join(root, 'artifacts.json'), 'utf8'));
    assert.deepEqual(manifest.files, [{ path: 'logs/partial.jsonl', ...digest(join(root, 'logs/partial.jsonl')) }]);
    const sums = readFileSync(join(root, 'SHA256SUMS'), 'utf8');
    assert(sums.includes(digest(join(root, 'artifacts.json')).sha256 + '  artifacts.json\n'));
    assert.equal(sums.trim().split('\n').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow bounds setup and retention outside the unchanged scientific budget', () => {
  const source = readFileSync(new URL('../.github/workflows/block-reuse-screen.yml', import.meta.url), 'utf8');
  const caps = [...source.matchAll(/timeout-minutes: (\d+)/g)].map(match => Number(match[1]));
  assert.deepEqual(caps, [100, 3, 3, 3, 5, 2, 65, 5, 5]);
  assert(caps.slice(1).reduce((a, b) => a + b, 0) <= caps[0] - 9);
  assert(source.includes('seal "$RUNNER_TEMP/block-reuse-timing-recovery-evidence"'));
  assert(!source.includes('workflow_dispatch'));
});
