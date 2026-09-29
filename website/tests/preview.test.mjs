import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { previewPath, collect, changes } = require('../ci/preview.cjs');
const sha = 'a'.repeat(40);
test('preview URLs are isolated by PR and commit', () => {
  assert.equal(previewPath('natanelia/zerocopy', 10, sha), `/zerocopy/previews/pr-10/${sha}/`);
  for (const input of [['a/b', 0, sha], ['a/b', 10, '../bad'], ['a/b/c', 1, sha]]) assert.throws(() => previewPath(...input));
});
test('publication changes cannot remove another preview or the production site', () => {
  const old = [{ type: 'blob', path: 'index.html', sha }, { type: 'blob', path: 'previews/pr-9/index.html', sha }, { type: 'blob', path: 'previews/pr-10/old/index.html', sha }];
  const result = changes(old, [{ path: `previews/pr-10/${sha}/index.html`, content: 'new' }], 'previews/pr-10/');
  assert.deepEqual(result.map(file => file.path), ['previews/pr-10/old/index.html', `previews/pr-10/${sha}/index.html`]);
  assert.equal(changes(old, [], 'previews/pr-10/').length, 1);
  assert.throws(() => changes(old, [{ path: 'index.html' }], 'previews/pr-10/'));
  assert.throws(() => changes(old, [], '../'));
  assert.deepEqual(changes(old, [{ path: 'index.html', sha, content: 'old' }], ''), []);
});
test('artifact collection rejects symlinks and non-static output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-preview-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<h1>Preview</h1>'); writeFileSync(join(dir, 'build.json'), '{}');
    assert.equal(collect(dir).length, 2);
    symlinkSync('/etc/passwd', join(dir, 'leak.txt')); assert.throws(() => collect(dir), /Unsafe/); rmSync(join(dir, 'leak.txt'));
    writeFileSync(join(dir, 'publish.sh'), '#!'); assert.throws(() => collect(dir), /Unexpected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('workflow separates read-only builds and same-repository publication', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/docs-website.yml', import.meta.url), 'utf8');
  assert.match(workflow, /head.repo.full_name == github.repository/);
  assert.doesNotMatch(workflow, /\n  pull_request_target:/);
  assert.match(workflow, /pages: write/); assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
  assert.match(workflow, /comparison-browser.mjs/);
});
