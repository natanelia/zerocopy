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

// Read only the small YAML sections used by these scenarios; no deployment
// selection logic is copied into the tests. The expression operators and format
// calls have the same results in JS for these strings, numbers, and statuses.
function workflowJob(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n((?:\\n| {4}[^\\n]*\\n)+)`, 'm'));
  assert.ok(match, `Missing workflow job: ${name}`);
  return match[1];
}
function workflowValue(source, name, indent) {
  const match = source.match(new RegExp(`^${' '.repeat(indent)}${name}: ([^\\n]+)(?:\\n((?:${' '.repeat(indent + 2)}[^\\n]*\\n)*))?`, 'm'));
  assert.ok(match, `Missing workflow field: ${name}`);
  if (match[1] === '|') return match[2].trimEnd().split('\n').map(line => line.slice(indent + 2)).join('\n');
  return match[1] === '>-' ? match[2].trim().replace(/\n\s*/g, ' ') : match[1];
}
function evaluate(source, context) {
  const expression = source.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return runInNewContext(expression, {
    format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index]),
    always: () => true,
    cancelled: () => false,
    success: () => true,
    vars: {},
    ...context,
  });
}
const buildJob = workflowJob('build'), publishJob = workflowJob('publish');
const buildSteps = [...buildJob.matchAll(/^      - [^\n]+\n(?:\n| {8}[^\n]*\n)*/gm)].map(match => match[0]);
const hostingSteps = buildSteps.filter(step => /^          SITE_BASE:/m.test(step));
const deploymentStep = buildSteps.find(step => /^        id: deployment$/m.test(step));
const publishableSteps = buildSteps.filter(step => /^          name: docs-publishable$/m.test(step));
const repository = 'natanelia/zerocopy';
function siteEvent(event, fork = false) {
  return { ...event, repository, event: { ...event.event, ...(event.event_name === 'pull_request' ? {
    pull_request: { ...event.event.pull_request, head: { sha, repo: { full_name: fork ? 'contributor/zerocopy' : repository } } },
  } : {}) } };
}
function canPublish(github, result, cancelled = false) {
  return evaluate(workflowValue(publishJob, 'if', 4), {
    github, needs: { build: { result } }, cancelled: () => cancelled,
  });
}
const hostingScenarios = [
  ['main push', siteEvent(push), ['/', '/zerocopy/'], false, true],
  ['manual main build', siteEvent({ ...push, event_name: 'workflow_dispatch' }), ['/', '/zerocopy/'], false, true],
  ['same-repository PR', siteEvent(pullRequest('synchronize')), ['/', '/zerocopy/', `/zerocopy/previews/pr-28/${sha}/`], true, true],
  ['fork PR', siteEvent(pullRequest('synchronize'), true), ['/', '/zerocopy/', `/zerocopy/previews/pr-28/${sha}/`], true, false],
];
for (const [label, github, expectedPaths, preview, publishAllowed] of hostingScenarios) {
  test(`one build checks alternate paths before the deployment target for ${label}`, () => {
    assert.equal(evaluate(workflowValue(buildJob, 'if', 4), { github }), true);
    const steps = hostingSteps.filter(step => !/^        if:/m.test(step) || evaluate(workflowValue(step, 'if', 8), { github }));
    const environments = steps.map(step => Object.fromEntries([...step.matchAll(/^          (SITE_\w+|BROWSER_ARTIFACTS_DIR): (.+)$/gm)]
      .map(([, name, source]) => [name, source.startsWith('${{') ? evaluate(source, { github }) : source])));
    assert.deepEqual(environments.map(env => env.SITE_BASE), expectedPaths);
    assert.equal(steps.at(-1), deploymentStep, 'The final generated site must be the deployment target');
    assert.equal(new Set(environments.map(env => env.BROWSER_ARTIFACTS_DIR)).size, steps.length, 'Hosting evidence must not overwrite another path');
    const target = environments.at(-1);
    assert.equal(target.SITE_PREVIEW_PR, preview ? 28 : '');
    assert.equal(target.SITE_HEAD_COMMIT, preview ? sha : '');
    assert.equal(target.SITE_ORIGIN, 'https://natanelia.github.io');
    for (const env of environments.slice(0, -1)) {
      assert.equal(env.SITE_PREVIEW_PR, undefined);
      assert.equal(env.SITE_HEAD_COMMIT, undefined);
    }
    for (const step of steps) {
      const run = workflowValue(step, 'run', 8);
      const checks = [...run.matchAll(/^node website\/tests\/([\w-]+\.mjs)(.*)$/gm)].map(([, script, args]) => [script, args.trim()]);
      if (step === deploymentStep) {
        assert.deepEqual(checks, ['docs-browser', 'memory-charts-browser', 'feature-browser', 'isolation-browser', 'browser',
          'explorer-browser', 'comparison-browser', 'memory-browser'].map(name => [name + '.mjs', '']));
      } else {
        assert.deepEqual(checks, [['isolation-browser.mjs', '--hosting-only']]);
      }
      assert.match(run, /^node --test website\/tests\/\*\.test\.mjs$/m, 'Every prefix needs static/link checks');
    }
    assert.equal(publishableSteps.length, 1);
    assert.equal(evaluate(workflowValue(publishableSteps[0], 'if', 8), { github }), true);
    assert.equal(workflowValue(publishableSteps[0], 'path', 10), 'website/_site/');
    const targetIndex = buildSteps.indexOf(deploymentStep), artifactIndex = buildSteps.indexOf(publishableSteps[0]);
    assert.ok(artifactIndex > targetIndex);
    assert.ok(buildSteps.slice(targetIndex + 1).every(step => !step.includes('node website/build.mjs')), 'No build may replace the fully tested output');
    assert.equal(canPublish(github, 'success'), publishAllowed);
  });
}

test('website validation uses one build runner and a separate publication boundary', () => {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]), ['build', 'publish']);
  assert.doesNotMatch(buildJob, /^    strategy:/m);
  assert.equal(workflowValue(publishJob, 'needs', 4), 'build');
});

test('failed, cancelled, or skipped builds cannot supply publishable output or publish', () => {
  for (const [label, github] of hostingScenarios) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(evaluate(workflowValue(publishableSteps[0], 'if', 8), { github, success: () => false }), false);
      assert.equal(canPublish(github, result), false, `${label}: ${result}`);
    }
    assert.equal(canPublish(github, 'success', true), false, `${label}: cancelled workflow`);
  }
});

test('closed PR cleanup needs no site build and remains unavailable to forks', () => {
  for (const merged of [false, true]) {
    for (const fork of [false, true]) {
      const github = siteEvent(pullRequest('closed', 28, merged), fork);
      assert.equal(evaluate(workflowValue(buildJob, 'if', 4), { github }), false);
      assert.equal(canPublish(github, 'skipped'), !fork);
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
