/** Pure activation validation fixtures. No GitHub calls, clocks, or timing. */
import assert from 'node:assert/strict';
import { validateActivation, BASELINE_COMMIT, RUNTIME_COMMIT, RUNTIME_TREE, REPOSITORY, REF } from './scalar-text-screen-activation.mjs';
const head = '1'.repeat(40), tree = '2'.repeat(40), message = `test: run reviewed scalar text screen\n\nReviewed-Tree: ${tree}\n`;
const valid = { environment: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REF: REF, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head, GITHUB_RUN_ID: '123456789' },
  event: { repository: { full_name: REPOSITORY }, ref: REF, created: false, deleted: false, forced: false,
    before: RUNTIME_COMMIT, after: head, head_commit: { id: head, message } },
  head, parent: RUNTIME_COMMIT, tree, message, runtimeTree: RUNTIME_TREE, runtimeParent: BASELINE_COMMIT };
assert.equal(validateActivation(valid).reviewedTree, tree);
let rejected = 0;
function rejects(change) { const input = structuredClone(valid); change(input); assert.throws(() => validateActivation(input)); rejected++; }
for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'another/zerocopy', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: undefined, GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: '3'.repeat(40) })) rejects(x => { x.environment[name] = value; });
for (const name of ['created', 'deleted', 'forced']) rejects(x => { x.event[name] = true; });
rejects(x => { delete x.event.created; });
rejects(x => { x.event.repository.full_name = 'another/zerocopy'; });
rejects(x => { x.event.ref = 'refs/heads/main'; });
rejects(x => { x.event.before = '0'.repeat(40); });
rejects(x => { x.parent = '3'.repeat(40); });
rejects(x => { x.runtimeTree = '4'.repeat(40); });
rejects(x => { x.runtimeParent = '4'.repeat(40); });
rejects(x => { x.event.after = '5'.repeat(40); });
rejects(x => { x.event.head_commit.id = '6'.repeat(40); });
rejects(x => { x.event.head_commit.message = message + 'changed'; });
rejects(x => { x.message = x.event.head_commit.message = 'No activation trailer'; });
rejects(x => { x.message = x.event.head_commit.message = message + `Reviewed-Tree: ${tree}`; });
rejects(x => { x.message = x.event.head_commit.message = message + '\nPost-trailer text'; });
rejects(x => { x.message = x.event.head_commit.message = `Reviewed-Tree: ${'f'.repeat(40)}`; });
rejects(x => { x.message = x.event.head_commit.message = `Reviewed-Tree: ${tree.toUpperCase()}!`; });
console.log(JSON.stringify({ passed: true, accepted: 1, rejected, syntheticOnly: true, timingsRun: false }));
