import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, sha256 } from './trie-view-source.mjs';
import { diagnosticIdentity, KNOWN_WORKER_DIAGNOSTICS, parseWorkerDiagnostics, PREREQUISITE_TIMEOUT_MS, REQUIRED_CHECKS, runBoundedCommand, runCheck, validatePrerequisites, workerSourceOutcome } from './trie-view-prerequisites.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const original = readFileSync(new URL('./trie-view-worker-types.baseline.txt', import.meta.url), 'utf8');
const source = ref => file => execFileSync('git', ['show', `${ref}:${file}`], { cwd: repository, encoding: 'utf8' });
test('preserved original diagnostics have exact immutable baseline source anchors', () => {
  const parsed = parseWorkerDiagnostics(original, source(BASELINE_COMMIT));
  assert.deepEqual(parsed, KNOWN_WORKER_DIAGNOSTICS); assert.equal(parsed.length, 12);
  const result = workerSourceOutcome(2, original, source(BASELINE_COMMIT));
  assert.equal(result.outcome, 'known-diagnostic-parity'); assert.equal(result.compilerPass, false);
});
test('only numeric row shifts are ignored; file, code, column, message and source text must match', () => {
  const shifted = original.replace(/arena\.ts\((63[3-7]),/g, (_, n) => `arena.ts(${Number(n) + 2},`);
  const result = workerSourceOutcome(2, shifted, source(CANDIDATE_RUNTIME_COMMIT));
  assert.deepEqual(diagnosticIdentity(result.diagnostics), diagnosticIdentity(KNOWN_WORKER_DIAGNOSTICS));
  assert.notDeepEqual(result.diagnostics, KNOWN_WORKER_DIAGNOSTICS);
  for (const altered of [
    original.replace('TS2532', 'TS2533'), original.replace('(492,59)', '(492,60)'),
    original.replace("Object is possibly 'undefined'.", 'Different message.'), original.replace('arena.ts', 'other.ts'),
    original.split('\n').slice(1).join('\n'), original + original.split('\n')[0] + '\n',
    original + 'Unexpected compiler footer\n',
  ]) assert.throws(() => workerSourceOutcome(2, altered, source(BASELINE_COMMIT)));
  assert.throws(() => workerSourceOutcome(2, original, file => source(BASELINE_COMMIT)(file).replaceAll('this.reads.root(slot)', 'this.reads.root(otherSlot)')));
  assert.throws(() => workerSourceOutcome(0, '', source(BASELINE_COMMIT)), /exit 2/);
  assert.throws(() => workerSourceOutcome(1, original, source(BASELINE_COMMIT)), /exit 2/);
});
test('all required prerequisite receipts must pass, including built worker consumers', t => {
  const root = mkdtempSync(join(tmpdir(), 'trie-prerequisite-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checks = REQUIRED_CHECKS.map(key => {
    const [build, name] = key.split('/'), log = `${build}-${name}.log`;
    writeFileSync(join(root, log), 'pass');
    return { build, name, log, sha256: sha256('pass'), status: 0, outcome: 'pass', signal: null, error: null, finished: '2026-10-08T00:00:00.000Z', timeoutMs: PREREQUISITE_TIMEOUT_MS, timedOut: false, interrupted: null, cleanup: { status: 'verified-no-live-processes' } };
  });
  const data = { status: 'completed', baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT, checks };
  const save = () => writeFileSync(join(root, 'prerequisites.json'), JSON.stringify(data)); save();
  assert.equal(validatePrerequisites(root).checks.length, 40);
  for (let index = 0; index < checks.length; index++) {
    data.checks = checks.filter((_, i) => i !== index); save(); assert.throws(() => validatePrerequisites(root), /prerequisites/);
  }
  data.checks = [...checks, checks[0]]; save(); assert.throws(() => validatePrerequisites(root), /prerequisites/);
  assert.ok(!REQUIRED_CHECKS.some(name => name.includes('unit-node')));
  data.checks = [...checks, { ...checks[0], build: 'baseline', name: 'unit-node-compatible' }]; save();
  assert.throws(() => validatePrerequisites(root), /prerequisites/);
  data.checks = checks; const worker = checks.find(c => c.name === 'worker-types');
  worker.status = 2; worker.outcome = 'known-diagnostic-parity'; save(); assert.throws(() => validatePrerequisites(root), /Failed prerequisite/);
  worker.status = 0; worker.outcome = 'pass';
  for (const [field, invalid] of [['timedOut', true], ['interrupted', 'SIGTERM'], ['timeoutMs', PREREQUISITE_TIMEOUT_MS + 1]]) {
    const original = worker[field]; worker[field] = invalid; save(); assert.throws(() => validatePrerequisites(root)); worker[field] = original;
  }
  data.status = 'partial'; save(); assert.throws(() => validatePrerequisites(root));
  data.status = 'completed'; save(); writeFileSync(join(root, checks[0].log), 'changed'); assert.throws(() => validatePrerequisites(root), /log changed/);
});
test('failed prerequisite commands preserve raw output, exit status, and partial receipts without retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'trie-prerequisite-failure-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'prerequisites.json'), JSON.stringify({ status: 'partial', checks: [] }));
  const args = ['-e', "process.stdout.write('partial-out'); process.stderr.write('diagnostic'); process.exit(3)"];
  assert.equal(await runCheck(root, 'gate', 'runtime', root, process.execPath, args), false);
  const receipt = JSON.parse(readFileSync(join(root, 'prerequisites.json'))), check = receipt.checks[0];
  assert.equal(receipt.status, 'partial'); assert.equal(check.status, 3); assert.equal(check.outcome, 'failed');
  assert.match(readFileSync(join(root, check.log), 'utf8'), /partial-outdiagnostic/);
  assert.equal(sha256(readFileSync(join(root, check.log))), check.sha256);
  await assert.rejects(runCheck(root, 'gate', 'runtime', root, process.execPath, args), /retried or overwritten/);
});
test('fixed command deadline preserves output and terminates descendants that ignore TERM', async t => {
  const root = mkdtempSync(join(tmpdir(), 'trie-prerequisite-timeout-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'raw.log'), fd = openSync(log, 'wx');
  const parent = "trap '' TERM; (trap '' TERM; printf 'descendant-started\\n'; while :; do printf 'still-running\\n'; sleep 0.02; done) & wait";
  let result;
  try { result = await runBoundedCommand('/bin/sh', ['-c', parent], root, fd, 300); }
  finally { closeSync(fd); }
  assert.equal(result.timedOut, true); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.interrupted, null);
  assert.equal(result.cleanup.status, 'verified-no-live-processes'); assert.deepEqual(result.cleanup.survivors, []);
  const bytes = readFileSync(log); assert.match(bytes.toString(), /descendant-started/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(readFileSync(log), bytes, 'No descendant may append after receipt finalization');
});
test('parent termination retains a failed finalized receipt and the already-written start header', async t => {
  const root = mkdtempSync(join(tmpdir(), 'trie-prerequisite-interrupt-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'prerequisites.json'), JSON.stringify({ status: 'partial', checks: [] }));
  const runner = fileURLToPath(new URL('./trie-view-prerequisites.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, 'check', root, 'gate', 'runtime', root, process.execPath, '-e', "console.log('child-started');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const deadline = Date.now() + 5000;
  while (!output.includes('"timeoutMs":300000') || !existsSync(join(root, 'logs/gate-runtime.log')) || !/^child-started$/m.test(readFileSync(join(root, 'logs/gate-runtime.log'), 'utf8'))) {
    assert(Date.now() < deadline, 'Synthetic child did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(output, /"timeoutMs":300000/);
  child.kill('SIGTERM'); assert.deepEqual(await exited, { code: 1, signal: null });
  const receipt = JSON.parse(readFileSync(join(root, 'prerequisites.json'))), check = receipt.checks[0];
  assert.equal(receipt.status, 'partial'); assert.equal(check.outcome, 'failed'); assert.equal(check.interrupted, 'SIGTERM');
  assert.equal(check.signal, 'SIGKILL'); assert.equal(check.timedOut, false); assert.equal(typeof check.finished, 'string');
  assert.equal(check.cleanup.status, 'verified-no-live-processes'); assert.deepEqual(check.cleanup.survivors, []);
  assert.equal(check.sha256, sha256(readFileSync(join(root, check.log))));
});
