import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { CONFIG, MODES, CASES, makeSchedule, summarize, gateStatus, prepareSubject } from './block-traversal-performance.mjs';
import { sha256, bundleManifest } from './block-traversal-source.mjs';
import { PIN, OLD_PLANS, fixedStudy, assertFixedStudy, verifyHelpers, assertSummaryEqual, validateOriginalRecords, fullManifest, physicalReceipt, captureChildResult, writeJson, supplementStatus, verifyForBrowser, extractOriginal, run } from './block-traversal-empty-controls.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const rng = () => { let s = CONFIG.seed; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; };
function syntheticRow(workload, plan, schedule, ratio = 0.8, aa = 1) {
  let sequence = 0;
  const blocks = schedule.map(p => ({ ...p, subjects: p.roles.map(role => {
    const factor = role === 'left' ? 1 : p.mode === 'ab' ? (Array.isArray(ratio) ? ratio[p.block] : ratio) : aa;
    const batches = [], full = Math.floor(plan.warmupScans / plan.repeat), remainder = plan.warmupScans % plan.repeat;
    for (let i = 0; i < full; i++) batches.push({ repeat: plan.repeat, ms: 200 / (full + (remainder ? 1 : 0)) });
    if (remainder) batches.push({ repeat: remainder, ms: 200 / (full + 1) });
    return { sequence: sequence++, role, build: p[role], phase: 'measure', repeat: plan.repeat, prescribedWarmupScans: plan.warmupScans,
      digest: sha256('[]'), samples: Array(21).fill(25 * factor), explicitGcMs: Array(21).fill(0), belowTargetBatches: 0,
      warmup: { capped: false, scans: plan.warmupScans, batches, elapsedMs: batches.reduce((n, b) => n + b.ms, 0) }, warmupTimeShort: false, warmupWorkShort: false };
  }) }));
  const row = { ...workload, plan, schedule, blocks }; row.summary = summarize(row); return row;
}
function supplement(ratio = 0.8, aa = 1) {
  return { status: 'completed', rows: fixedStudy().rows.map(r => syntheticRow(r.workload, r.plan, r.schedule, ratio, aa)) };
}
function originalFixture() {
  const records = {};
  for (const runtime of ['node', 'bun']) {
    let uncertain = runtime === 'node' ? 8 : 3;
    const rows = CASES.map(c => {
      const old = fixedStudy().rows.find(r => r.workload.name === c.name), invalid = runtime === 'bun' && old;
      const ratio = !invalid && uncertain-- > 0 ? [0.8, 1, 1.2, 1.3] : 0.8;
      const row = syntheticRow(c, old?.originalPlan ?? { repeat: 10, warmupScans: 100, repeatCapped: false, pilotWarmupCapped: false }, makeSchedule(rng()), ratio);
      if (invalid) {
        const s = row.blocks.find(b => b.mode === 'ab').subjects.find(s => s.build === 'candidate');
        s.warmupTimeShort = true; s.warmup.elapsedMs = 140;
      }
      row.summary = summarize(row); return row;
    });
    const record = { runtime, status: 'completed', baselineCommit: PIN.baseline, candidateCommit: PIN.candidate, config: CONFIG, rows, harnessSha256: Object.fromEntries(Object.entries(PIN.helpers).slice(0, 3)) };
    record.gate = gateStatus(record); records[runtime] = record;
  }
  return records;
}
test('fixed study is exactly the checked-in three-cell protocol and twice both old common counts', () => {
  const study = fixedStudy(); assertFixedStudy(JSON.parse(readFileSync(join(here, 'block-traversal-empty-controls-plan.json'))));
  assert.equal(study.newPilots, 0); assert.equal(study.measuredSubjects, 96); assert.equal(study.timedBatches, 2016);
  assert.deepEqual(study.rows.map(r => [r.plan.repeat, r.plan.warmupScans]), [[772404, 9268848], [783762, 9405144], [690460, 8975980]]);
  assert.deepEqual(study.rows.map(r => r.workload.name), OLD_PLANS.map(p => p[0]));
  assert.equal(study.config.samples, 21); assert.equal(study.config.warmupMs, 150); assert.equal(study.config.targetBatchMs, 10);
  assert.equal(study.config.blocks, 4); assert.equal(study.config.nonInferiorityMargin, 1.02);
  for (const r of study.rows) {
    for (const [mode] of MODES) { const blocks = r.schedule.filter(b => b.mode === mode); assert.equal(blocks.length, 4); assert.equal(blocks.filter(b => b.roles[0] === 'left').length, 2); }
    for (const block of r.schedule) for (const role of block.roles) assert(['baseline', 'candidate'].includes(block[role]));
  }
  for (const mutate of [s => s.rows.pop(), s => s.rows[0].plan.repeat++, s => s.rows[1].plan.warmupScans++, s => s.rows[0].schedule.reverse(), s => s.config.targetBatchMs = 9, s => s.newPilots = 1]) {
    const changed = structuredClone(study); mutate(changed); assert.throws(() => assertFixedStudy(changed));
  }
});
test('original kernel, all helpers and browser fixtures are immutable before and after archiving', () => {
  verifyHelpers(); const directory = mkdtempSync(join(os.tmpdir(), 'empty-helper-test-'));
  try { for (const file of Object.keys(PIN.helpers)) cpSync(join(here, file), join(directory, file)); verifyHelpers(directory);
    const file = join(directory, 'block-traversal-performance.mjs'); writeFileSync(file, readFileSync(file, 'utf8') + '\n'); assert.throws(() => verifyHelpers(directory), /Original helper changed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('original gate stays flagged and eleven original statistical uncertainties are preserved', () => {
  const records = originalFixture(), before = JSON.stringify(records), assessment = validateOriginalRecords(records);
  assert.equal(assessment.originalGates.bun, 'flagged-inconclusive'); assert.equal(assessment.originalStatisticalInconclusiveCells.length, 11); assert.equal(JSON.stringify(records), before);
  assert.deepEqual(assessment.counts.node, { withinMargin: 32, statisticalInconclusive: 8, timingFlagged: 0 });
});
test('cross-engine last-bit math differences are tolerated only in derived summaries, with decisions exact', () => {
  assertSummaryEqual({ ratio: 0.8075855369590351, classification: 'inconclusive', flags: 0 }, { ratio: 0.807585536959035, classification: 'inconclusive', flags: 0 });
  assert.throws(() => assertSummaryEqual({ ratio: 0.8 }, { ratio: 0.800000001 }));
  assert.throws(() => assertSummaryEqual({ flags: 0 }, { flags: 1 }));
  assert.throws(() => assertSummaryEqual({ belowTargetBatches: 0 }, { belowTargetBatches: Number.EPSILON }));
  assert.throws(() => assertSummaryEqual({ classification: 'inconclusive' }, { classification: 'evidence within margin' }));
  assert.throws(() => assertSummaryEqual({ ratio: 0.8 }, { ratio: 0.8, extra: true }));
});
test('other old flags, material loss, control drift, altered old plans and source identity fail closed', () => {
  for (const mutate of [
    r => r.node.candidateCommit = '0'.repeat(40),
    r => r.bun.rows.find(x => x.name === OLD_PLANS[0][0]).plan.warmupScans++,
    r => { const row = r.node.rows[0]; row.plan.repeatCapped = true; row.summary = summarize(row); },
    r => { const row = r.node.rows[0]; row.blocks[0].subjects[0].belowTargetBatches = 1; row.summary = summarize(row); },
    r => { const row = r.node.rows[0]; for (const b of row.blocks.filter(b => b.mode === 'ab')) for (const s of b.subjects) s.samples.fill(25 * (s.role === 'left' ? 1 : 1.1)); row.summary = summarize(row); },
    r => { const row = r.node.rows[0]; for (const b of row.blocks.filter(b => b.mode === 'aa-baseline')) for (const s of b.subjects) s.samples.fill(25 * (s.role === 'left' ? 1 : 2)); row.summary = summarize(row); },
  ]) { const records = originalFixture(); mutate(records); assert.throws(() => validateOriginalRecords(records)); }
});
test('new A/B needs within-margin evidence; df3 uncertainty and both directions of A/A drift remain blocking', () => {
  assert.equal(supplementStatus(supplement()), 'eligible-for-later-correctness');
  assert.equal(supplementStatus(supplement(1.03)), 'detected-material-loss');
  assert.equal(supplementStatus(supplement([0.99, 1.02, 1.01, 1.04])), 'statistical-inconclusive');
  for (const aa of [2, 0.5]) assert.equal(supplementStatus(supplement(0.8, aa)), 'control-drift-inconclusive');
  const record = supplement(); record.status = 'failed'; assert.equal(supplementStatus(record), 'incomplete');
});
test('short measured batches or warmup, caps and missing warmup work cannot qualify', () => {
  for (const change of [
    s => { s.samples[0] = 9; s.belowTargetBatches = 1; },
    s => { for (const b of s.warmup.batches) b.ms = 5; s.warmup.elapsedMs = s.warmup.batches.reduce((n, b) => n + b.ms, 0); s.warmupTimeShort = true; },
    s => { s.warmup.capped = true; },
    s => { const b = s.warmup.batches.pop(); s.warmup.scans -= b.repeat; s.warmup.elapsedMs = s.warmup.batches.reduce((n, b) => n + b.ms, 0); s.warmupWorkShort = true; },
  ]) { const record = supplement(), row = record.rows[0]; change(row.blocks[0].subjects[0]); row.summary = summarize(row); assert.equal(supplementStatus(record), 'flagged-inconclusive'); }
});
test('missing samples, dishonest flags, role swaps and schedule/work edits are rejected', () => {
  for (const change of [
    s => s.samples.pop(), s => s.samples[0] = NaN, s => s.belowTargetBatches = 1,
    s => s.repeat++, s => s.prescribedWarmupScans++, s => s.phase = 'pilot', s => s.role = 'other', s => s.digest = 'wrong',
  ]) { const record = supplement(), row = record.rows[0]; change(row.blocks[0].subjects[0]); assert.throws(() => supplementStatus(record)); }
  const incomplete = supplement(); incomplete.rows[0].blocks.pop(); assert.throws(() => supplementStatus(incomplete));
  const reordered = supplement(); reordered.rows.reverse(); assert.throws(() => supplementStatus(reordered));
});
test('full emitted bundles and physical receipts cover non-JS files and original package bytes', () => {
  const temp = mkdtempSync(join(os.tmpdir(), 'empty-path-test-'));
  try {
    const source = join(temp, 'source'), neutral = join(temp, 'subject'); mkdirSync(join(source, 'dist'), { recursive: true });
    const packageBytes = '{"name":"fixture","type":"module"}\n'; writeFileSync(join(source, 'package.json'), packageBytes);
    writeFileSync(join(source, 'dist', 'shared.js'), 'export const n=1;'); writeFileSync(join(source, 'dist', 'shared.d.ts'), 'export declare const n: number;');
    const entry = join(source, 'dist', 'shared.js'); prepareSubject(entry, neutral, bundleManifest(entry), sha256(packageBytes));
    const before = physicalReceipt(neutral); assert.equal(before.physicalEntry, join(neutral, 'dist', 'shared.js')); assert.equal(before.physicalPackage, join(neutral, 'package.json'));
    assert.deepEqual(before.files, fullManifest(source)); assert(before.files['dist/shared.d.ts']);
    writeFileSync(join(neutral, 'dist', 'shared.d.ts'), 'changed'); assert.notDeepEqual(physicalReceipt(neutral), before);
    symlinkSync(entry, join(source, 'dist', 'alias.js')); assert.throws(() => fullManifest(source), /symlink/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('wrong ZIP is rejected before extraction; local timing is prohibited', () => {
  const temp = mkdtempSync(join(os.tmpdir(), 'empty-failure-test-'));
  try { const zip = join(temp, 'wrong.zip'); writeFileSync(zip, 'wrong'); assert.throws(() => extractOriginal(zip, join(temp, 'evidence')), /Wrong original artifact ZIP/);
    const saved = process.env.GITHUB_ACTIONS; delete process.env.GITHUB_ACTIONS;
    try { assert.throws(() => run(temp), /No local timings/); } finally { if (saved === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = saved; }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('failed children retain exit metadata, stdout and stderr when physical after-receipts fail', () => {
  const temp = mkdtempSync(join(os.tmpdir(), 'empty-child-failure-test-'));
  try {
    const attempt = { sequence: 0 }, child = { status: null, signal: 'SIGTERM', error: new Error('timeout'), stdout: 'partial output', stderr: 'failure details' };
    captureChildResult(attempt, child, temp, join(temp, 'missing-subject'));
    assert.equal(attempt.status, null); assert.equal(attempt.signal, 'SIGTERM'); assert.match(attempt.error, /timeout/); assert.equal(attempt.after, null); assert(attempt.receiptError);
    assert.equal(readFileSync(join(temp, 'child-output/0.stdout'), 'utf8'), 'partial output'); assert.equal(readFileSync(join(temp, 'child-output/0.stderr'), 'utf8'), 'failure details');
    const path = join(temp, 'result.json'); writeJson(path, { attempt, status: 'failed' }); assert.deepEqual(JSON.parse(readFileSync(path)), { attempt, status: 'failed' });
    const cyclic = {}; cyclic.self = cyclic; assert.throws(() => writeJson(path, cyclic)); assert.deepEqual(JSON.parse(readFileSync(path)), { attempt, status: 'failed' }, 'Failed replacement preserves last valid checkpoint');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('focused workflow cannot trigger the old 40-case study and browser jobs depend on qualification', () => {
  const workflow = readFileSync(join(here, '../.github/workflows/block-traversal-empty-controls.yml'), 'utf8');
  const old = readFileSync(join(here, '../.github/workflows/block-traversal.yml'), 'utf8');
  assert.match(old, /branches: \['perf\/block-traversal-\*'\]/); assert.match(workflow, /branches: \['proof\/block-traversal-empty-controls'\]/);
  assert.doesNotMatch(workflow, /run: (node|bun) proofs\/block-traversal-performance\.mjs/);
  assert.match(workflow, /needs: fixed-bun-controls/); assert.match(workflow, /needs\.fixed-bun-controls\.outputs\.eligible == 'true'/);
  assert.match(workflow, /runtime: \[chromium, firefox, webkit\]/); assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /github\.run_attempt == 1/); assert.match(workflow, /--verify-browser/);
  assert.match(workflow, /node proofs\/block-traversal-browser\.mjs \.proof-candidate\/dist\/shared\.js \.proof-baseline\/dist\/shared\.js/);
});
test('prepared archive browser verifier accepts complete synthetic receipts and rejects bundle tampering', { skip: !process.env.BLOCK_EMPTY_PREPARED_EVIDENCE }, () => {
  // All invented durations live in a throwaway copy outside the uploaded study. No workload runs.
  const temp = mkdtempSync(join(os.tmpdir(), 'empty-browser-verifier-synthetic-')), directory = join(temp, 'evidence');
  try {
    cpSync(process.env.BLOCK_EMPTY_PREPARED_EVIDENCE, directory, { recursive: true });
    const frozen = JSON.parse(readFileSync(join(directory, 'frozen-study.json'))), record = supplement();
    Object.assign(record, { runtime: 'bun', config: CONFIG, controller: { bun: '1.4.2', arch: 'x64' }, baselineCommit: PIN.baseline, candidateCommit: PIN.candidate,
      proofCommit: frozen.proofCommit, runId: frozen.runId, runAttempt: 1, frozenStudySha256: sha256(readFileSync(join(directory, 'frozen-study.json'))),
      originalAssessment: frozen.originalAssessment, neutralPath: '/tmp/synthetic-receipt-only/subject', attempts: [] });
    mkdirSync(join(directory, 'child-output'));
    for (const row of record.rows) for (const block of row.blocks) for (const subject of block.subjects) {
      subject.sequence = record.attempts.length;
      const before = { requestedEntry: join(record.neutralPath, 'dist/shared.js'), physicalRoot: record.neutralPath,
        physicalEntry: join(record.neutralPath, 'dist/shared.js'), physicalPackage: join(record.neutralPath, 'package.json'), files: frozen.bundleFiles[subject.build] };
      record.attempts.push({ sequence: subject.sequence, build: subject.build, role: subject.role, status: 0, signal: null, error: null, before, after: before });
      const { sequence, build, role, ...raw } = subject; writeJson(join(directory, 'child-output', `${sequence}.stdout`), raw); writeFileSync(join(directory, 'child-output', `${sequence}.stderr`), '');
    }
    record.gate = supplementStatus(record); writeJson(join(directory, 'supplement.json'), record);
    const eligibility = verifyForBrowser(directory, frozen.proofCommit); assert.equal(eligibility.eligibility, 'eligible-for-later-correctness'); assert.equal(eligibility.originalAssessment.originalGates.bun, 'flagged-inconclusive');
    writeFileSync(join(directory, 'bundles', 'candidate', 'dist', 'shared.js'), 'tampered'); assert.throws(() => verifyForBrowser(directory, frozen.proofCommit), /Archived complete bundle changed/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
