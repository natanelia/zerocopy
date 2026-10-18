import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRetained, expectedSchedule } from './verify-retained.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const stage = resolve(process.env.EVIDENCE_STAGE ?? '/mnt/data/zerocopy-work/pairing');
const original = resolve(process.env.ORIGINAL_DRIVER ?? '/mnt/data/zerocopy-work/repo/proofs/numeric-tree-process.mjs');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const plan = read(resolve(stage, 'raw/plan.json'));
const reference = await verifyRetained(stage, original);
function prefix(root, i) { return resolve(root, 'raw', String(i + 1).padStart(3, '0')); }
function rows(root, match, edit) {
  plan.schedule.forEach((a, i) => {
    if (!match(a)) return;
    const file = prefix(root, i) + '.json', child = read(file); edit(child, a, i);
    writeFileSync(file, JSON.stringify(child) + '\n');
  });
}
function journal(root, i) {
  const file = prefix(root, i), child = read(file + '.json');
  const separate = plan.schedule[i].mode === 'separate-aa';
  const records = separate ? child.results : child.rows.flatMap(r => [...r.warmup, ...r.samples]);
  writeFileSync(file + (separate ? '.json.samples.ndjson' : '.json.ndjson'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}
async function fixture(callback) {
  const root = mkdtempSync(resolve(tmpdir(), 'numeric-retained-test-'));
  for (const name of ['raw', 'paired.mjs', 'run.py']) cpSync(resolve(stage, name), resolve(root, name), { recursive: true });
  writeFileSync(resolve(root, 'reference.json'), JSON.stringify(reference));
  try { return await callback(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
async function rejectBoth(change, pattern) {
  await fixture(async root => {
    change(root);
    await assert.rejects(verifyRetained(root, original), pattern);
    const py = spawnSync('python3', [resolve(here, 'verify-retained.py'), root, resolve(root, 'reference.json'), resolve(root, 'unexpected-pass.json')], { encoding: 'utf8' });
    assert.equal(py.error, undefined); assert.notEqual(py.status, 0, 'Python accepted a substituted record');
  });
}

test('sealed schedules contain every original diagnostic process once', () => {
  assert.deepEqual(expectedSchedule(1), plan.schedule);
  assert.equal(expectedSchedule(1).length, 76); assert.equal(expectedSchedule(4).length, 12);
  assert.throws(() => expectedSchedule(2));
});
test('unmodified retained results preserve both successes and failures', () => {
  const before = read(resolve(stage, 'audit.json'));
  assert.equal(reference.processes, before.processes);
  assert.equal(reference.measuredBatches, before.measuredBatches);
  assert.equal(reference.warmupBatches, before.warmupBatches);
  reference.results.forEach((cohort, i) => {
    assert.deepEqual([cohort.mode, cohort.size, cohort.pointPass, cohort.confidencePass, cohort.pass],
      [before.results[i].mode, before.results[i].size, before.results[i].pointPass, before.results[i].confidencePass, before.results[i].pass]);
    cohort.rows.forEach((row, j) => {
      for (const k of ['speedup', 'lower', 'upper']) assert.ok(Math.abs(row[k] - before.results[i].rows[j][k]) < 1e-12);
    });
  });
  assert.equal(reference.evidenceVerified, true);
  assert.equal(reference.results.find(r => r.mode === 'slow-control').pass, false);
});
test('replay cannot invent missing per-child binary attestations', () => {
  assert.equal(reference.separateProcessesWithoutPerChildBinaryAttestation, 48);
  assert.match(reference.binaryBindingLimit, /no per-child binary attestation/);
});
for (const mode of ['paired-aa', 'paired-ab']) test(`reject coordinated cross-size ${mode} report and journal substitution`, () => rejectBoth(root => {
  for (let block = 0; block < 4; block++) {
    const source = plan.schedule.findIndex(a => a.mode === mode && a.size === 2 && a.block === block);
    const target = plan.schedule.findIndex(a => a.mode === mode && a.size === 1024 && a.block === block);
    for (const suffix of ['.json', '.json.ndjson']) cpSync(prefix(root, source) + suffix, prefix(root, target) + suffix);
  }
}, /Scheduled size mismatch/));
test('reject scheduled kind substitution', () => rejectBoth(root => rows(root,
  a => a.mode === 'paired-aa' && a.size === 1024, c => { c.kind = 'ab'; }), /Scheduled kind mismatch/));
test('reject scheduled block substitution', () => rejectBoth(root => rows(root,
  a => a.mode === 'paired-ab' && a.size === 1024 && a.block === 0, c => { c.block = 1; }), /Scheduled block mismatch/));
for (const [field, value] of [['node', 'v20.19.0'], ['bun', '1.4.2'], ['arch', 'arm64'], ['v8', 'different-engine']])
  test(`reject whole separate-process cohort with substituted ${field}`, () => rejectBoth(root => rows(root,
    a => a.mode === 'separate-aa' && a.size === 1024, c => { c.runtime[field] = value; }), /Separate-process runtime/));
test('reject paired architecture substitution across a whole cohort', () => rejectBoth(root => rows(root,
  a => a.mode === 'paired-aa' && a.size === 1024, c => { c.runtime.arch = 'arm64'; }), /Paired runtime differs/));
test('reject a paired binary hash that differs from the controller plan', () => rejectBoth(root => rows(root,
  a => a.mode === 'paired-aa' && a.size === 2, c => { c.runtime.binarySha256 = '0'.repeat(64); }), /Wrong planned runtime binary/));
test('reject an altered declared schedule', () => rejectBoth(root => {
  const p = read(resolve(root, 'raw/plan.json')); p.schedule[0].size = 1024;
  writeFileSync(resolve(root, 'raw/plan.json'), JSON.stringify(p));
}, /Stored schedule changed/));
test('reject removal of a warm-up from both report and journal', () => rejectBoth(root => {
  const i = plan.schedule.findIndex(a => a.mode === 'paired-aa');
  rows(root, (a, unused) => a.mode === 'paired-aa' && a.size === 2 && a.block === 0, c => { c.rows[0].warmup.pop(); });
  journal(root, i);
}, /AssertionError/));
test('reject a missing child instead of excluding it', () => rejectBoth(root => unlinkSync(prefix(root, 0) + '.json'), /ENOENT/));
test('reject a failed child even when its complete report exists', () => rejectBoth(root => {
  const file = prefix(root, 0) + '.status.json', s = read(file); s.exitCode = 1; writeFileSync(file, JSON.stringify(s));
}, /Failed child/));

test('reject matching false build identities in plan and child reports', () => rejectBoth(root => {
  const file = resolve(root, 'raw/plan.json'), p = read(file);
  p.inputs.candidate['numeric-kernels-simd.wasm'] = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(p));
  rows(root, () => true, c => {
    if (c.bundle) c.bundle['numeric-kernels-simd.wasm'] = '0'.repeat(64);
    else {
      c.source.B['numeric-kernels-simd.wasm'] = '0'.repeat(64);
      if (c.kind !== 'ab') c.source.A['numeric-kernels-simd.wasm'] = '0'.repeat(64);
    }
  });
}, /Frozen build manifests changed/));
