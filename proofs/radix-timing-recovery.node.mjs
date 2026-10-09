// Deterministic/synthetic checks only. Real pilots are never run by this file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CASES } from './trie-view-workloads.mjs';
import { CONFIG, studyFor } from './trie-view-protocol.mjs';
import { validateExecutionOrder } from './trie-view-gate.mjs';
import { runBoundedCommand } from './trie-view-prerequisites.mjs';
import { INPUT, BRANCH, SOURCE_ARCHIVES, validateInput, verifyMetadata, verifyTimingIdentity, verifyTimingInvocation } from './radix-timing-input.mjs';
import { CONTROLLER_TIMEOUT_MS, capturedChild, executeStudy, requireChildSuccess } from './radix-timing-recovery.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const scratch = t => { const dir = mkdtempSync(join(tmpdir(), 'radix-timing-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
function metadata() {
  return { run: { id: INPUT.run, head_sha: INPUT.commit, head_commit: { tree_id: INPUT.tree }, path: '.github/workflows/radix-correctness-recovery.yml', run_attempt: 1, status: 'completed', conclusion: 'success', repository: { full_name: 'natanelia/zerocopy' } },
    jobs: { total_count: 1, jobs: [{ id: INPUT.job, run_id: INPUT.run, head_sha: INPUT.commit, run_attempt: 1, status: 'completed', conclusion: 'success', steps: ['Run both original suites once and the matched baseline semantic overlay', 'Seal only complete passing correctness evidence', 'Upload portable correctness-only evidence'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] },
    artifacts: { artifacts: [{ id: INPUT.artifact, name: `radix-correctness-recovery-${INPUT.commit}`, workflow_run: { id: INPUT.run, head_sha: INPUT.commit }, digest: `sha256:${INPUT.zipSha256}`, expired: false }] } };
}
test('input admission requires the exact successful run, complete job, artifact and source identities', () => {
  const original = metadata(); assert.equal(verifyMetadata(original.run, original.jobs, original.artifacts).artifact, INPUT.artifact);
  for (const mutate of [r => { r.run.conclusion = 'failure'; }, r => { r.run.run_attempt = 2; }, r => { r.run.head_commit.tree_id = 'wrong'; }, r => { r.jobs.total_count = 2; }, r => { r.jobs.jobs[0].conclusion = 'cancelled'; }, r => { r.jobs.jobs[0].steps[1].conclusion = 'skipped'; }, r => { r.artifacts.artifacts[0].digest = 'wrong'; }, r => { r.artifacts.artifacts[0].expired = true; }]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => verifyMetadata(changed.run, changed.jobs, changed.artifacts));
  }
  assert.equal(Object.keys(SOURCE_ARCHIVES).length, 4);
});
test('real sealed artifact reproduces all exact prerequisites and both original complete builds', () => {
  assert(process.env.RADIX_TIMING_INPUT, 'This check requires the pinned correctness artifact');
  const input = validateInput(process.env.RADIX_TIMING_INPUT);
  assert.equal(input.checks.status, 'completed'); assert.equal(input.checks.checks.length, 46);
  assert.equal(input.checks.checks.filter(check => check.name === 'unit').length, 2);
  assert.equal(input.zipSha256, INPUT.zipSha256); assert.equal(input.tarSha256, INPUT.tarSha256);
});
test('only a first nonforced new timing branch on the correctness commit may run', () => {
  const identity = { head: 'a'.repeat(40), parent: INPUT.commit }, event = { ref: `refs/heads/${BRANCH}`, before: '0'.repeat(40), after: 'a'.repeat(40), created: true, forced: false, deleted: false };
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: event.ref, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: identity.head };
  verifyTimingInvocation(env, event, identity);
  for (const [key, value] of [['GITHUB_ACTIONS', ''], ['GITHUB_RUN_ATTEMPT', '2'], ['GITHUB_EVENT_NAME', 'workflow_dispatch'], ['GITHUB_REF', 'refs/heads/main']]) assert.throws(() => verifyTimingInvocation({ ...env, [key]: value }, event, identity));
  for (const [key, value] of [['created', false], ['forced', true], ['deleted', true], ['before', INPUT.commit]]) assert.throws(() => verifyTimingInvocation(env, { ...event, [key]: value }, identity));
});
const pilot = () => ({ phase: 'pilot', status: 'completed', expectedDigest: 'synthetic', prewarm: { targetMs: 500, elapsedMs: 500, operations: 1024, capped: false }, probes: [{ repeat: 40, samples: [40, 44, 48] }], estimateMsPerOperation: 1, flags: [] });
test('adapter executes the identical 40-pilot then 640-subject seeded chronology without extra observations', async () => {
  const study = studyFor(CASES), record = { attempts: [], rows: [], plansFrozenBeforeMeasurement: false };
  let freezes = 0;
  await executeStudy(record, study, async (build, workload, phase, plan) => {
    assert.equal(record.plansFrozenBeforeMeasurement, phase === 'measure');
    const subject = { ...(phase === 'pilot' ? pilot() : { phase, repeat: plan.repeat }), sequence: record.attempts.length, build, workload: workload.name };
    record.attempts.push({ sequence: subject.sequence, build, workload: workload.name, phase }); return subject;
  }, () => {}, plans => { freezes++; assert.equal(plans.length, 20); assert.equal(record.attempts.length, 40); });
  assert.equal(freezes, 1); assert.equal(record.attempts.length, 680); validateExecutionOrder(record, study);
  assert.equal(CONFIG.subjectTimeoutMs, 180000); assert.equal(CONTROLLER_TIMEOUT_MS, 2700000);
});
test('invalid pilot plans retain every pilot and start no measured subject or repeat', async () => {
  const study = studyFor(CASES), record = { attempts: [], rows: [], plansFrozenBeforeMeasurement: false };
  await assert.rejects(executeStudy(record, study, async (build, workload, phase) => {
    assert.equal(phase, 'pilot'); const result = pilot(); result.prewarm.elapsedMs = 1;
    record.attempts.push({ build, phase }); return result;
  }, () => {}, () => {}), /Pilot floor\/cap/);
  assert.equal(record.attempts.length, 40); assert.equal(record.rows.length, 20); assert.equal(record.plansFrozenBeforeMeasurement, true);
});
test('subject failure stops the exact chronological stream without retry or favorable-cell selection', async () => {
  const study = studyFor(CASES), record = { attempts: [], rows: [], plansFrozenBeforeMeasurement: false }; let calls = 0;
  await assert.rejects(executeStudy(record, study, async (build, workload, phase) => {
    calls++; if (calls === 43) throw new Error('synthetic subject failure'); return phase === 'pilot' ? pilot() : { phase };
  }, () => {}, () => {}), /synthetic subject failure/);
  assert.equal(calls, 43);
});
test('bounded children keep stdout JSON separate from stderr and use the explicit environment', async t => {
  const directory = scratch(t), prefix = join(directory, 'subject');
  const child = await capturedChild('/bin/sh', ['-c', 'printf "{\\"value\\":\\"%s\\"}\\n" "$RADIX_TEST_VALUE"; printf "diagnostic\\n" >&2'], directory, prefix, { env: { ...process.env, RADIX_TEST_VALUE: 'fixed' } });
  requireChildSuccess(child); assert.deepEqual(JSON.parse(child.stdout), { value: 'fixed' }); assert.equal(child.stderr.toString(), 'diagnostic\n');
  assert.deepEqual(readFileSync(prefix + '.stdout'), child.stdout); assert.deepEqual(readFileSync(prefix + '.stderr'), child.stderr);
  await assert.rejects(capturedChild('/bin/sh', ['-c', 'true'], directory, prefix), /EEXIST/);
});
test('controller cancellation preserves partial raw output and verifies cleanup before returning', async t => {
  const directory = scratch(t), prefix = join(directory, 'partial'), abort = new AbortController();
  const timer = setTimeout(() => abort.abort('synthetic controller deadline'), 100);
  const result = await capturedChild('/bin/sh', ['-c', "trap '' TERM; printf 'partial'; printf 'diagnostic' >&2; while :; do sleep 1; done"], directory, prefix, { signal: abort.signal });
  clearTimeout(timer); assert.equal(result.interrupted, 'synthetic controller deadline'); assert.equal(result.cleanup.status, 'verified-no-live-processes');
  assert.deepEqual(result.cleanup.survivors, []); assert.equal(result.stdout.toString(), 'partial'); assert.equal(result.stderr.toString(), 'diagnostic');
  assert.throws(() => requireChildSuccess(result));
});
test('whole-command deadline remains fail-closed with separate durable streams', async t => {
  const directory = scratch(t), out = openSync(join(directory, 'stdout'), 'wx'), err = openSync(join(directory, 'stderr'), 'wx');
  let result; try { result = await runBoundedCommand('/bin/sh', ['-c', 'printf out; printf err >&2; while :; do sleep 1; done'], directory, out, 100, { stderrFd: err }); }
  finally { closeSync(out); closeSync(err); }
  assert.equal(result.timedOut, true); assert.equal(result.cleanup.status, 'verified-no-live-processes'); assert.throws(() => requireChildSuccess(result));
  assert.equal(readFileSync(join(directory, 'stdout'), 'utf8'), 'out'); assert.equal(readFileSync(join(directory, 'stderr'), 'utf8'), 'err');
});
test('local and retry execution are rejected before opening any real subject', () => {
  const file = join(repository, 'proofs/radix-timing-recovery.mjs');
  for (const [env, expected] of [[{ GITHUB_ACTIONS: '', GITHUB_RUN_ATTEMPT: '1' }, /No local latency measurements/], [{ GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '2' }, /separate review/]]) {
    const child = spawnSync(process.execPath, [file, 'run', '/does-not-exist'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.notEqual(child.status, 0); assert.match(child.stderr, expected);
  }
});
test('exact proof scope preserves original subject, workload, protocol and old controller bytes', () => {
  verifyTimingIdentity();
  for (const name of ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs', 'trie-view-gate.mjs']) assert.deepEqual(readFileSync(join(repository, 'proofs', name)), execFileSync('git', ['show', `${INPUT.commit}:proofs/${name}`], { cwd: repository }));
  const yaml = readFileSync(join(repository, '.github/workflows/radix-timing-recovery.yml'), 'utf8');
  assert(!yaml.includes('bun run test')); assert(!yaml.includes('build:wasm')); assert(!yaml.includes('build:browser'));
  assert(!yaml.includes('workflow_dispatch:')); assert(yaml.includes('fail-fast: false')); assert(yaml.includes('runtime: [node, bun]'));
  assert.equal(yaml.split('if: always()').length - 1, 3);
});
