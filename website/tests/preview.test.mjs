import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
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

// Read only the small YAML sections used by these scenarios; no workflow logic
// is copied into the tests. The expression operators and fromJSON/format calls
// below have the same results in JS for these strings, numbers, and status values.
function workflowJob(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n((?:\\n| {4}[^\\n]*\\n)+)`, 'm'));
  assert.ok(match, `Missing workflow job: ${name}`);
  return match[1];
}
function workflowValue(source, name, indent) {
  const match = source.match(new RegExp(`^${' '.repeat(indent)}${name}: ([^\\n]+)(?:\\n((?:${' '.repeat(indent + 2)}[^\\n]*\\n)*))?`, 'm'));
  assert.ok(match, `Missing workflow field: ${name}`);
  return match[1] === '>-' ? match[2].trim().replace(/\n\s*/g, ' ') : match[1];
}
function evaluate(source, context) {
  const expression = source.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return runInNewContext(expression, {
    fromJSON: JSON.parse,
    format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index]),
    always: () => true,
    cancelled: () => false,
    vars: {},
    ...context,
  });
}
const siteJob = workflowJob('site'), buildJob = workflowJob('build'), publishJob = workflowJob('publish');
const publishableStep = siteJob.match(/^      - name: Retain publishable output\n((?:\n| {8}[^\n]*\n)+)/m)[1];
const repository = 'natanelia/zerocopy';
function siteEvent(event, fork = false) {
  return { ...event, repository, event: { ...event.event, ...(event.event_name === 'pull_request' ? {
    pull_request: { ...event.event.pull_request, head: { sha, repo: { full_name: fork ? 'contributor/zerocopy' : repository } } },
  } : {}) } };
}
function buildResult(github, result, cancelled = false) {
  const context = { github, needs: { site: { result } }, cancelled: () => cancelled };
  if (!evaluate(workflowValue(buildJob, 'if', 4), context)) return 'skipped';
  // Run the actual final gate, so changing it to accept a failed/skipped host
  // cannot leave the publication tests green.
  const gate = spawnSync('sh', ['-e', '-c', workflowValue(buildJob, 'run', 8)], {
    env: { SITE_RESULT: String(evaluate(workflowValue(buildJob, 'SITE_RESULT', 10), context)) },
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(gate.error);
  return gate.status === 0 ? 'success' : 'failure';
}
function canPublish(github, result, cancelled = false) {
  return evaluate(workflowValue(publishJob, 'if', 4), {
    github, needs: { build: { result } }, cancelled: () => cancelled,
  });
}
const hostingScenarios = [
  ['main push', siteEvent(push), ['root', 'pages'], 'pages', true],
  ['manual main build', siteEvent({ ...push, event_name: 'workflow_dispatch' }), ['root', 'pages'], 'pages', true],
  ['same-repository PR', siteEvent(pullRequest('synchronize')), ['root', 'pages', 'preview'], 'preview', true],
  ['fork PR', siteEvent(pullRequest('synchronize'), true), ['root', 'pages', 'preview'], 'preview', false],
];
for (const [label, github, expectedHosts, producer, publishAllowed] of hostingScenarios) {
  test(`hosting matrix selects one correct artifact for ${label}`, () => {
    assert.equal(evaluate(workflowValue(siteJob, 'if', 4), { github }), true);
    const hosts = evaluate(workflowValue(siteJob, 'host', 8), { github });
    assert.deepEqual(hosts, expectedHosts);
    const artifacts = [];
    for (const host of hosts) {
      const context = { github, matrix: { host } };
      const values = Object.fromEntries(['SITE_BASE', 'SITE_ORIGIN', 'SITE_PREVIEW_PR', 'SITE_HEAD_COMMIT']
        .map(name => [name, evaluate(workflowValue(siteJob, name, 6), context)]));
      const expectedBase = host === 'root' ? '/' : host === 'pages' ? '/zerocopy/' : `/zerocopy/previews/pr-28/${sha}/`;
      assert.equal(values.SITE_BASE, expectedBase);
      assert.equal(values.SITE_ORIGIN, host === 'root' ? '' : 'https://natanelia.github.io');
      assert.equal(values.SITE_PREVIEW_PR, host === 'preview' ? 28 : '');
      assert.equal(values.SITE_HEAD_COMMIT, host === 'preview' ? sha : '');
      if (evaluate(workflowValue(publishableStep, 'if', 8), context)) artifacts.push({ host, base: values.SITE_BASE });
    }
    assert.deepEqual(artifacts, [{ host: producer, base: producer === 'pages' ? '/zerocopy/' : `/zerocopy/previews/pr-28/${sha}/` }]);
    assert.equal(buildResult(github, 'success'), 'success');
    assert.equal(canPublish(github, 'success'), publishAllowed);
  });
}

test('failed, cancelled, or skipped hosting checks cannot pass the build or publication gates', () => {
  for (const [label, github] of hostingScenarios) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const gate = buildResult(github, result);
      assert.equal(gate, 'failure', `${label}: ${result}`);
      assert.equal(canPublish(github, gate), false, `${label}: ${result}`);
    }
    assert.equal(buildResult(github, 'success', true), 'skipped');
    assert.equal(canPublish(github, 'success', true), false, `${label}: cancelled workflow`);
  }
});

test('closed PR cleanup needs no site build and remains unavailable to forks', () => {
  for (const merged of [false, true]) {
    for (const fork of [false, true]) {
      const github = siteEvent(pullRequest('closed', 28, merged), fork);
      assert.equal(evaluate(workflowValue(siteJob, 'if', 4), { github }), false);
      const gate = buildResult(github, 'skipped');
      assert.equal(gate, 'skipped');
      assert.equal(canPublish(github, gate), !fork);
      assert.equal(evaluate(workflowValue(publishJob, 'if', 8), { github }), false, 'Cleanup must not download a build artifact');
    }
  }
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
