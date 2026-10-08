import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, sha256 } from './trie-view-source.mjs';
import { diagnosticIdentity, KNOWN_WORKER_DIAGNOSTICS, parseWorkerDiagnostics, REQUIRED_CHECKS, runCheck, validatePrerequisites, workerSourceOutcome } from './trie-view-prerequisites.mjs';

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
    return { build, name, log, sha256: sha256('pass'), status: 0, outcome: 'pass', signal: null, error: null, finished: '2026-10-08T00:00:00.000Z' };
  });
  const data = { status: 'completed', baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT, checks };
  const save = () => writeFileSync(join(root, 'prerequisites.json'), JSON.stringify(data)); save();
  assert.equal(validatePrerequisites(root).checks.length, 42);
  for (let index = 0; index < checks.length; index++) {
    data.checks = checks.filter((_, i) => i !== index); save(); assert.throws(() => validatePrerequisites(root), /prerequisites/);
  }
  data.checks = [...checks, checks[0]]; save(); assert.throws(() => validatePrerequisites(root), /prerequisites/);
  data.checks = checks; const scoped = checks.find(c => c.name === 'unit-node-compatible');
  scoped.name = 'unit-node'; save(); assert.throws(() => validatePrerequisites(root), /prerequisites/);
  scoped.name = 'unit-node-compatible';
  data.checks = checks; const worker = checks.find(c => c.name === 'worker-types');
  worker.status = 2; worker.outcome = 'known-diagnostic-parity'; save(); assert.throws(() => validatePrerequisites(root), /Failed prerequisite/);
  worker.status = 0; worker.outcome = 'pass'; data.status = 'partial'; save(); assert.throws(() => validatePrerequisites(root));
  data.status = 'completed'; save(); writeFileSync(join(root, checks[0].log), 'changed'); assert.throws(() => validatePrerequisites(root), /log changed/);
});
test('failed prerequisite commands preserve raw output, exit status, and partial receipts without retry', t => {
  const root = mkdtempSync(join(tmpdir(), 'trie-prerequisite-failure-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'prerequisites.json'), JSON.stringify({ status: 'partial', checks: [] }));
  const args = ['-e', "process.stdout.write('partial-out'); process.stderr.write('diagnostic'); process.exit(3)"];
  assert.equal(runCheck(root, 'gate', 'runtime', root, process.execPath, args), false);
  const receipt = JSON.parse(readFileSync(join(root, 'prerequisites.json'))), check = receipt.checks[0];
  assert.equal(receipt.status, 'partial'); assert.equal(check.status, 3); assert.equal(check.outcome, 'failed');
  assert.match(readFileSync(join(root, check.log), 'utf8'), /partial-outdiagnostic/);
  assert.equal(sha256(readFileSync(join(root, check.log))), check.sha256);
  assert.throws(() => runCheck(root, 'gate', 'runtime', root, process.execPath, args), /retried or overwritten/);
});
