import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, sha256 } from './trie-view-source.mjs';
import { CLEANUP_TIMEOUT_MS, COMMON_CHECKS, PREREQUISITE_TIMEOUT_MS } from './trie-view-prerequisites.mjs';
import { BRANCH, OVERLAY_FILES, PRIOR_PROOF, PURPOSE, RECOVERY_CHANGES, recoveryPlan, stopsRecovery, validateReceipts, verifyInvocation, verifyRecoveryIdentity, verifyRuntimeTree } from './radix-correctness-recovery.mjs';
import { archiveEvidence } from './trie-view-archive.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(join(root, file));
function scratch(t) { const dir = mkdtempSync(join(tmpdir(), 'radix-recovery-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('the exact plan has one pristine full suite per runtime and only one extra baseline semantic suite', () => {
  const plan = recoveryPlan('/baseline', '/candidate', '/proof');
  assert.equal(plan.length, 46);
  for (const build of ['baseline', 'candidate']) {
    const checks = plan.filter(check => check.build === build);
    assert.deepEqual(checks.slice(0, COMMON_CHECKS.length).map(check => check.name), [...COMMON_CHECKS]);
    const unit = checks.filter(check => check.name === 'unit'); assert.equal(unit.length, 1);
    assert.deepEqual(unit[0].command, ['bun', 'run', 'test']); assert.equal(unit[0].cwd, `/${build}`);
    assert(plan.findIndex(check => check.build === build && check.name === 'build-types') < plan.findIndex(check => check.build === build && check.name === 'worker-types'));
  }
  const extra = plan.filter(check => check.build === 'baseline' && check.name === 'semantic-overlay');
  assert.equal(extra.length, 1); assert.deepEqual(extra[0].command, ['bun', 'run', 'test', 'trie-view-capture.test.ts']);
  assert.equal(plan.filter(check => check.build === 'candidate' && check.name === 'semantic-overlay').length, 0);
  assert(plan.indexOf(extra[0]) > plan.findIndex(check => check.build === 'candidate' && check.name === 'unit'));
  for (const check of plan) {
    assert.equal(check.timeoutMs, PREREQUISITE_TIMEOUT_MS);
    assert(!check.command.some(arg => /trie-view-(?:gate|subject|workloads|protocol)\./.test(arg)), check.command.join(' '));
  }
  assert.throws(() => recoveryPlan('/same', '/same', '/proof'), /distinct/);
});
test('only the first nonforced new recovery-branch push is admitted', () => {
  const head = 'a'.repeat(40), env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/heads/${BRANCH}`, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head };
  const event = { ref: env.GITHUB_REF, before: '0'.repeat(40), after: head, created: true, forced: false, deleted: false };
  assert.equal(verifyInvocation(env, event, head).runAttempt, 1);
  for (const [field, value] of [['GITHUB_ACTIONS', ''], ['GITHUB_EVENT_NAME', 'workflow_dispatch'], ['GITHUB_RUN_ATTEMPT', '2'], ['GITHUB_REF', 'refs/heads/main'], ['GITHUB_SHA', 'b'.repeat(40)]]) assert.throws(() => verifyInvocation({ ...env, [field]: value }, event, head));
  for (const [field, value] of [['before', PRIOR_PROOF], ['after', 'b'.repeat(40)], ['created', false], ['forced', true], ['deleted', true]]) assert.throws(() => verifyInvocation(env, { ...event, [field]: value }, head));
});
test('integrity failure or unresolved execution prevents dependent commands while ordinary test failures retain counterpart coverage', () => {
  const unit = { phase: 'validate', build: 'baseline', name: 'unit' }, result = { cleanup: { status: 'verified-no-live-processes' }, interrupted: null, timedOut: false };
  assert.equal(stopsRecovery(unit, result), false);
  assert.equal(stopsRecovery({ ...unit, build: 'gate', name: 'semantic-overlay' }, result), true);
  assert.equal(stopsRecovery({ ...unit, phase: 'setup' }, result), true);
  assert.equal(stopsRecovery(unit, { ...result, cleanup: { status: 'failed' } }), true);
  assert.equal(stopsRecovery(unit, { ...result, interrupted: 'SIGTERM' }), true);
  assert.equal(stopsRecovery(unit, { ...result, timedOut: true }), true);
});
test('receipt seal binds every command, order, raw log, timeout, and verified cleanup', t => {
  const dir = scratch(t), plan = recoveryPlan('/baseline', '/candidate', '/proof'); mkdirSync(join(dir, 'logs'));
  const checks = plan.map(({ phase, ...check }) => {
    const log = `logs/${check.build}-${check.name}.log`; writeFileSync(join(dir, log), 'synthetic-pass\n');
    return { ...check, log, sha256: sha256('synthetic-pass\n'), status: 0, outcome: 'pass', signal: null, error: null,
      timedOut: false, interrupted: null, started: '2026-10-09T00:00:00Z', finished: '2026-10-09T00:00:01Z', cleanup: { status: 'verified-no-live-processes', survivors: [], timeoutMs: CLEANUP_TIMEOUT_MS } };
  });
  const original = { purpose: PURPOSE, noTiming: true, status: 'partial', baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT, plan, planSha256: sha256(JSON.stringify(plan)), checks };
  const check = mutate => { const receipt = structuredClone(original); mutate?.(receipt); writeFileSync(join(dir, 'prerequisites.json'), JSON.stringify(receipt)); return () => validateReceipts(dir, plan); };
  assert.equal(check()().checks.length, 46);
  for (const mutate of [
    r => r.checks.pop(), r => r.checks.push(r.checks[0]), r => r.checks.reverse(),
    r => { r.checks[0].command = ['true']; }, r => { r.checks[0].cwd = '/other'; },
    r => { r.checks[0].timeoutMs++; }, r => { r.checks[0].timedOut = true; },
    r => { r.checks[0].interrupted = 'SIGTERM'; }, r => { r.checks[0].status = 1; },
    r => { r.checks[0].cleanup.status = 'failed'; }, r => { r.checks[0].cleanup.survivors = [{ pid: 123, state: 'S' }]; },
    r => { r.checks[0].log = '../different'; }, r => { r.checks[0].sha256 = '0'.repeat(64); },
    r => { r.noTiming = false; }, r => { r.plan[0].command = ['true']; },
  ]) assert.throws(check(mutate));
  check(); writeFileSync(join(dir, checks[0].log), 'changed'); assert.throws(() => validateReceipts(dir, plan));
});
test('runtime source and overlay guards reject changed assertions, additions, missing files, and symlinks', t => {
  const dir = scratch(t), git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); writeFileSync(join(dir, '.gitignore'), '.env\n'); writeFileSync(join(dir, 'vitest.config.ts'), 'testTimeout: 5000\n'); writeFileSync(join(dir, 'original.test.ts'), 'original assertion\n');
  git('add', '.'); git('-c', 'user.name=Recovery fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic immutable source');
  const ref = git('rev-parse', 'HEAD').toString().trim(); verifyRuntimeTree(dir, ref);
  writeFileSync(join(dir, '.env'), 'ALTERED_TEST_ENV=1\n'); assert.throws(() => verifyRuntimeTree(dir, ref), /additions/); rmSync(join(dir, '.env'));
  writeFileSync(join(dir, 'original.test.ts'), 'changed assertion\n'); assert.throws(() => verifyRuntimeTree(dir, ref), /Changed immutable/);
  writeFileSync(join(dir, 'original.test.ts'), 'original assertion\n'); writeFileSync(join(dir, 'extra.test.ts'), 'extra'); assert.throws(() => verifyRuntimeTree(dir, ref), /additions/); rmSync(join(dir, 'extra.test.ts'));
  mkdirSync(join(dir, 'proofs'));
  for (const file of OVERLAY_FILES) writeFileSync(join(dir, file), read(file));
  verifyRuntimeTree(dir, ref, true); assert.throws(() => verifyRuntimeTree(dir, ref), /additions/);
  const target = join(dir, OVERLAY_FILES[0]), saved = readFileSync(target);
  writeFileSync(target, Buffer.concat([saved, Buffer.from('\n')])); assert.throws(() => verifyRuntimeTree(dir, ref, true), /Changed semantic overlay/);
  rmSync(target); assert.throws(() => verifyRuntimeTree(dir, ref, true), /additions/);
  symlinkSync(join(root, OVERLAY_FILES[0]), target); assert.throws(() => verifyRuntimeTree(dir, ref, true), /regular file/);
});
test('recovery workflow cannot invoke performance entrypoints and preserves evidence after failure', () => {
  const workflow = read('.github/workflows/radix-correctness-recovery.yml').toString();
  assert(!/workflow_dispatch:|pull_request:|matrix:/.test(workflow));
  assert(!/trie-view-(gate|subject|workloads|protocol)\./.test(workflow));
  for (const mode of ['initialize', 'setup', 'validate', 'seal']) assert.equal(workflow.split(`radix-correctness-recovery.mjs ${mode} `).length - 1, 1);
  assert(workflow.includes('timeout-minutes: 30')); assert(workflow.includes('timeout-minutes: 45'));
  assert.equal(workflow.split('if: always()').length - 1, 3); assert(workflow.includes('persist-credentials: false'));
  assert.deepEqual(read('.github/workflows/radix-view-only.yml'), execFileSync('git', ['show', `${PRIOR_PROOF}:.github/workflows/radix-view-only.yml`], { cwd: root }));
  const implementation = read('proofs/radix-correctness-recovery.mjs').toString();
  assert(!/^import.*trie-view-(gate|subject|workloads|protocol)\./m.test(implementation));
});
test('partial evidence archive keeps failed logs and unfinished receipts exactly', t => {
  const dir = scratch(t), source = join(dir, 'source'), output = join(dir, 'archive'), extracted = join(dir, 'extracted');
  mkdirSync(source); mkdirSync(extracted);
  const log = Buffer.from('partial\0failed output\n'), receipt = Buffer.from('{"status":"partial","checks":[{"outcome":"pending"}]}\n');
  writeFileSync(join(source, 'failed:child.log'), log); writeFileSync(join(source, 'prerequisites.json'), receipt);
  const result = archiveEvidence(source, output);
  execFileSync('sha256sum', ['--check', 'radix-view.tar.gz.sha256'], { cwd: output });
  execFileSync('tar', ['-xzf', result.archive, '-C', extracted]);
  assert.deepEqual(readFileSync(join(extracted, 'failed:child.log')), log); assert.deepEqual(readFileSync(join(extracted, 'prerequisites.json')), receipt);
  assert.throws(() => archiveEvidence(source, output), /EEXIST/);
});
test('the committed recovery adds only its declared proof files on the original published gate', () => {
  const identity = verifyRecoveryIdentity(root);
  assert.equal(identity.parent, PRIOR_PROOF); assert.equal(Object.keys(RECOVERY_CHANGES).length, 7);
});
