import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { publish, previewPath, collect, changes } = require('../ci/preview.cjs');
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

// These workflow expressions use only property access, string comparisons, and
// &&/||. Those operations have the same result in JS for these event fixtures.
// Evaluate the checked-in group, rather than a second copy of its selection logic.
const workflow = readFileSync(new URL('../../.github/workflows/docs-website.yml', import.meta.url), 'utf8');
const concurrency = workflow.match(/^concurrency:\n((?:[ \t].*\n)+)/m)[1];
const groupTemplate = concurrency.match(/^  group: (.+)$/m)[1];
function group(github, template = groupTemplate) {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => String(runInNewContext(expression, { github })));
}
function pullRequest(action, number = 28, merged = false) {
  return {
    event_name: 'pull_request',
    ref: action === 'closed' && merged ? 'refs/heads/main' : `refs/pull/${number}/merge`,
    event: { action, pull_request: { number, merged } },
  };
}
const push = { event_name: 'push', ref: 'refs/heads/main', event: {} };

test('merged PR cleanup, PR previews, and main publication cannot cancel each other', () => {
  const close = pullRequest('closed', 28, true);
  // Regression: merged PR-close and main-push events have the same github.ref.
  const oldGroup = 'docs-site-${{ github.ref }}';
  assert.equal(group(close, oldGroup), group(push, oldGroup));
  assert.equal(group(push), 'docs-site-production-refs/heads/main-build');
  assert.equal(group(pullRequest('synchronize')), 'docs-site-pr-28-build');
  assert.equal(group(close), 'docs-site-pr-28-cleanup');
  assert.equal(new Set([group(push), group(close), group(pullRequest('synchronize'))]).size, 3);
});

test('new runs still cancel older work of the same kind for the same PR', () => {
  assert.match(concurrency, /^  cancel-in-progress: true$/m);
  for (const action of ['opened', 'synchronize', 'reopened']) {
    assert.equal(group(pullRequest(action)), group(pullRequest('opened')));
    assert.notEqual(group(pullRequest(action, 28)), group(pullRequest(action, 29)));
  }
  assert.equal(group(pullRequest('closed', 28, false)), group(pullRequest('closed', 28, true)));
  assert.notEqual(group(pullRequest('closed', 28, true)), group(pullRequest('closed', 29, true)));
});

test('pushes and manual runs share cancellation only for the same production branch', () => {
  const manual = { ...push, event_name: 'workflow_dispatch' };
  assert.equal(group(manual), group(push));
  assert.notEqual(group(manual), group({ ...manual, ref: 'refs/heads/other' }));
});

test('a delayed cleanup keeps the preview when its PR has reopened', async () => {
  const messages = [];
  await publish({
    github: { rest: { pulls: { get: async () => ({ data: { state: 'open', head: { sha, repo: { full_name: 'natanelia/zerocopy' } } } }) } } },
    context: { repo: { owner: 'natanelia', repo: 'zerocopy' }, payload: { action: 'closed', pull_request: { number: 28 } } },
    core: { info: message => messages.push(message) },
  });
  assert.deepEqual(messages, ['PR reopened; retaining its preview.']);
});

test('a delayed preview build cannot publish after its PR closes', async () => {
  const messages = [];
  await publish({
    github: { rest: { pulls: { get: async () => ({ data: { state: 'closed', head: { sha, repo: { full_name: 'natanelia/zerocopy' } } } }) } } },
    context: { repo: { owner: 'natanelia', repo: 'zerocopy' }, payload: { action: 'synchronize', pull_request: { number: 28, head: { sha } } } },
    core: { info: message => messages.push(message) },
  });
  assert.deepEqual(messages, ['Discarding a stale or closed PR build.']);
});
