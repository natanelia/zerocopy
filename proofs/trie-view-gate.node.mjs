import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fullManifest, physicalReceipt, captureResult, prepareSubject, assertSummaryEqual, validateExecutionOrder, requiredResult } from './trie-view-gate.mjs';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, sha256 } from './trie-view-source.mjs';
const temporary = () => mkdtempSync(join(os.tmpdir(), 'trie-gate-unit-'));
function makeSubject(root) {
  mkdirSync(join(root, 'dist'), { recursive: true }); mkdirSync(join(root, 'proofs'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "name": "original" }\n');
  writeFileSync(join(root, 'dist/shared.js'), 'export const x = 1;\n'); writeFileSync(join(root, 'proofs/trie-view-subject.mjs'), '');
}
test('full file manifest includes hidden workflows, nested declarations and original package bytes', () => {
  const root = temporary(); try { makeSubject(root); mkdirSync(join(root, '.github/workflows'), { recursive: true }); writeFileSync(join(root, '.github/workflows/gate.yml'), 'frozen');
    mkdirSync(join(root, 'dist/types')); writeFileSync(join(root, 'dist/types/shared.d.ts'), 'export type X=1;'); const manifest = fullManifest(root);
    assert.equal(manifest['.github/workflows/gate.yml'], sha256('frozen')); assert(manifest['dist/types/shared.d.ts']);
    assert.equal(manifest['package.json'], sha256(readFileSync(join(root, 'package.json'))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('neutral preparation preserves exact bytes and detects hidden extras and symlinks', () => {
  const root = temporary(); try {
    const bundle = join(root, 'bundles/baseline'); makeSubject(bundle); rmSync(join(bundle, 'proofs'), { recursive: true });
    const proof = join(root, 'proof-source/proofs'); mkdirSync(proof, { recursive: true });
    for (const file of ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs']) writeFileSync(join(proof, file), file);
    const frozen = { bundleFiles: { baseline: fullManifest(bundle) }, proofFiles: fullManifest(join(root, 'proof-source')) };
    const neutral = join(root, 'neutral'), receipt = prepareSubject(root, 'baseline', neutral, frozen); assert.equal(receipt.physicalRoot, neutral);
    assert.equal(readFileSync(join(neutral, 'package.json'), 'utf8'), readFileSync(join(bundle, 'package.json'), 'utf8'));
    symlinkSync(join(neutral, 'package.json'), join(neutral, '.hidden-link')); assert.throws(() => physicalReceipt(neutral), /Symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('failed/malformed/partial child output and exit metadata survive missing after receipt', () => {
  const root = temporary(); try {
    const neutral = join(root, 'subject'); makeSubject(neutral); const attempt = { sequence: 3, before: physicalReceipt(neutral) };
    rmSync(join(neutral, 'dist/shared.js')); captureResult(attempt, { status: 1, signal: null, stdout: '{"status":"failed","partial":[1]', stderr: 'diagnostic', error: new Error('timeout') }, root, neutral);
    assert.equal(attempt.exitStatus, 1); assert.equal(attempt.after, null); assert.match(attempt.receiptError, /ENOENT/);
    assert.equal(readFileSync(join(root, attempt.stdout.path), 'utf8'), '{"status":"failed","partial":[1]'); assert.equal(attempt.stderr.sha256, sha256('diagnostic'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('derived arithmetic permits engine last-bit differences without changing decisions', () => {
  assertSummaryEqual({ ratio: 1, result: 'inconclusive' }, { ratio: 1 + Number.EPSILON, result: 'inconclusive' });
  assert.throws(() => assertSummaryEqual({ ratio: 1 }, { ratio: 1.001 }));
  assert.throws(() => assertSummaryEqual({ result: 'pass' }, { result: 'inconclusive' }));
});
test('controller refuses local run before touching bundle/output and refuses rerun', () => {
  const file = new URL('./trie-view-gate.mjs', import.meta.url).pathname;
  const child = spawnSync(process.execPath, [file, 'run', '/does-not-exist'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_RUN_ATTEMPT: '1' } });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /No local latency measurements/);
  const rerun = spawnSync(process.execPath, [file, 'run', '/does-not-exist'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '2' } });
  assert.notEqual(rerun.status, 0); assert.match(rerun.stderr, /separately reviewed/);
});

test('the archival verifier binds every subject to its exact frozen chronological slot', () => {
  const study = { rows: [{ workload: { name: 'fixed' }, pilotOrder: ['candidate', 'baseline'], schedule: [
    { left: 'baseline', right: 'baseline', roles: ['left', 'right', 'right', 'left'] },
    { left: 'baseline', right: 'baseline', roles: ['right', 'left', 'left', 'right'] },
  ] }] };
  const record = { attempts: [], rows: [{ pilots: {}, blocks: [] }] }, row = record.rows[0];
  const subject = (build, phase, role) => {
    const s = { sequence: record.attempts.length, build, phase, workload: 'fixed', ...(role ? { role } : {}) };
    record.attempts.push({ ...s }); return s;
  };
  for (const build of study.rows[0].pilotOrder) row.pilots[build] = subject(build, 'pilot');
  for (const block of study.rows[0].schedule) row.blocks.push({ subjects: block.roles.map(role => subject(block[role], 'measure', role)) });
  validateExecutionOrder(record, study);
  const adjacent = structuredClone(record);
  [adjacent.rows[0].blocks[0].subjects[1], adjacent.rows[0].blocks[0].subjects[2]] = [adjacent.rows[0].blocks[0].subjects[2], adjacent.rows[0].blocks[0].subjects[1]];
  assert.throws(() => validateExecutionOrder(adjacent, study), /frozen execution slot/);
  const quartets = structuredClone(record); quartets.rows[0].blocks.reverse();
  assert.throws(() => validateExecutionOrder(quartets, study), /frozen execution slot/);
  const pilots = structuredClone(record); pilots.rows[0].pilots.baseline.sequence = 0;
  assert.throws(() => validateExecutionOrder(pilots, study), /frozen execution slot/);
});

test('verification rejects absent or wrong-runtime results', () => {
  const root = temporary(); try {
    const frozen = { prerequisites: { runtime: 'node' } };
    assert.throws(() => requiredResult(root, frozen), /Missing required node result/);
    writeFileSync(join(root, 'bun.json'), JSON.stringify({ runtime: 'bun' }));
    assert.throws(() => requiredResult(root, frozen), /Missing required node result/);
    writeFileSync(join(root, 'node.json'), JSON.stringify({ runtime: 'bun' }));
    assert.throws(() => requiredResult(root, frozen), /Wrong runtime/);
    writeFileSync(join(root, 'node.json'), JSON.stringify({ runtime: 'node' }));
    assert.deepEqual(requiredResult(root, frozen), { runtime: 'node' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
