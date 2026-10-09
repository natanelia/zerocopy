/** Immutable push-event/commit-message activation gate. No clocks or runtime imports. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const BASELINE_COMMIT = 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad';
export const RUNTIME_COMMIT = '3efaa3bb110f1d4e979d279aec12f52e2b37731b';
export const RUNTIME_TREE = 'b4e060c8517a619f53a958e3ab9bdb091ba83e15';
export const REPOSITORY = 'natanelia/zerocopy';
export const REF = 'refs/heads/proof/scalar-text-screen-20261009';
export function validateActivation({ environment, event, head, parent, tree, message, runtimeTree, runtimeParent }) {
  assert.equal(environment.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.equal(environment.GITHUB_EVENT_NAME, 'push', 'Only the dedicated push event may activate');
  assert.equal(environment.GITHUB_REPOSITORY, REPOSITORY, 'Exact repository required');
  assert.equal(environment.GITHUB_REF, REF, 'Exact proof branch required');
  assert.match(environment.GITHUB_RUN_ID, /^[1-9][0-9]*$/, 'Run identity is required');
  assert.equal(environment.GITHUB_RUN_ATTEMPT, '1', 'Workflow reruns cannot activate another screen');
  assert.equal(event.repository?.full_name, REPOSITORY, 'Push payload repository must match');
  assert.equal(event.ref, REF, 'Push payload ref must match');
  assert.equal(event.created, false, 'Branch creation must not activate');
  assert.equal(event.deleted, false, 'Branch deletion must not activate');
  assert.equal(event.forced, false, 'Forced pushes must not activate');
  assert.equal(event.before, RUNTIME_COMMIT, 'Branch must advance once from the pinned published runtime');
  assert.equal(parent, RUNTIME_COMMIT, 'Proof commit must directly descend from the published runtime');
  assert.equal(runtimeParent, BASELINE_COMMIT, 'Published runtime must directly descend from the pinned baseline');
  assert.equal(runtimeTree, RUNTIME_TREE, 'Published runtime source tree must match the reviewed prototype');
  assert.match(head, /^[0-9a-f]{40}$/); assert.match(tree, /^[0-9a-f]{40}$/);
  assert.notEqual(head, RUNTIME_COMMIT, 'The runtime branch creation is not a proof activation');
  assert.equal(event.after, head, 'Push after must be the checked-out commit');
  assert.equal(environment.GITHUB_SHA, head, 'GitHub SHA must be the checked-out commit');
  assert.equal(event.head_commit?.id, head, 'Head commit payload must identify the checkout');
  assert.equal(event.head_commit?.message?.trimEnd(), message.trimEnd(), 'Push message must match the immutable commit message');
  const markers = message.match(/^Reviewed-Tree:.*$/gm) ?? [];
  assert.equal(markers.length, 1, 'Exactly one reviewed-tree trailer is required');
  assert.match(markers[0], /^Reviewed-Tree: [0-9a-f]{40}$/, 'Exact reviewed-tree trailer syntax required');
  assert.equal(message.trimEnd().split('\n').at(-1), markers[0], 'Reviewed-tree trailer must be the final nonempty line');
  const reviewedTree = markers[0].slice('Reviewed-Tree: '.length);
  assert.equal(reviewedTree, tree, 'Immutable reviewed-tree trailer must match the complete checked-out source tree');
  return { schema: 'zerocopy-scalar-text-screen-activation/v1', repository: REPOSITORY, ref: REF,
    runtimeCommit: RUNTIME_COMMIT, runtimeTree: RUNTIME_TREE, before: event.before, head, parent,
    reviewedTree, runId: environment.GITHUB_RUN_ID, runAttempt: 1, event: 'push' };
}
export function verifyGitHubActivation(root, environment = process.env) {
  assert(environment.GITHUB_EVENT_PATH, 'GitHub event file required');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
  const parents = git('show', '-s', '--format=%P', 'HEAD').split(' ');
  assert.equal(parents.length, 1, 'Merge commits cannot activate this screen');
  return validateActivation({ environment, event: JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8')),
    head: git('rev-parse', 'HEAD'), parent: parents[0], tree: git('rev-parse', 'HEAD^{tree}'),
    message: git('show', '-s', '--format=%B', 'HEAD'), runtimeTree: git('rev-parse', `${RUNTIME_COMMIT}^{tree}`), runtimeParent: git('show', '-s', '--format=%P', RUNTIME_COMMIT) });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv[2], 'Exclusive activation receipt path required');
  const receipt = verifyGitHubActivation(resolve(import.meta.dirname, '..'));
  writeFileSync(resolve(process.argv[2]), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(receipt.reviewedTree + '\n');
}
