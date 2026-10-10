import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { CASES, CONFIG, MODES, makeSchedule, summarize, prepareSubject, logInterval, freezePlan, gateStatus, hasControlDrift } from './block-traversal-performance.mjs';
import { SCANS } from './block-traversal-workloads.mjs';
import { sha256, bundleManifest } from './block-traversal-source.mjs';
const rng = () => { let s = 20261008; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; };
function synthetic(ratio = 1, aa = 1, flags = {}) {
  return { plan: {}, blocks: makeSchedule(rng()).map(p => ({ ...p, subjects: p.roles.map(role => ({ role, build: p[role], repeat: 10,
    samples: Array(21).fill(10 * (role === 'left' ? 1 : p.mode === 'ab' ? ratio : aa)), belowTargetBatches: 0,
    warmup: { capped: false }, warmupTimeShort: false, warmupWorkShort: false, ...flags,
  })) })) };
}
test('fixed 40-case stratification covers every public tail scan and all value families', () => {
  assert.equal(CASES.length, 40); assert.equal(new Set(CASES.map(c => c.name)).size, 40);
  for (const size of [0, 1, 32]) for (const [kind, operation] of SCANS) assert.ok(CASES.some(c => c.size === size && c.kind === kind && c.operation === operation));
  for (const size of [33, 4097]) for (const type of ['number', 'boolean', 'string', 'object']) assert.ok(CASES.some(c => c.size === size && c.type === type && c.operation !== 'compact'));
  for (const type of ['number', 'boolean', 'string', 'object']) assert.ok(CASES.some(c => c.edited && c.type === type));
  assert.equal(CASES.filter(c => c.operation === 'compact').length, 8);
  assert.equal(CONFIG.samples, 21); assert.equal(CONFIG.blocks, 4); assert.equal(CONFIG.targetBatchMs, 10);
  assert.equal(CONFIG.compactWarmupCalls, 512); assert.equal(CONFIG.compactGcEvery, 32); assert.equal(CONFIG.nonInferiorityMargin, 1.02);
});
test('each mode has exactly two ABBA and two BAAB quartets, without random timing inputs', () => {
  assert.deepEqual(makeSchedule(rng()), makeSchedule(rng()));
  for (let i = 0; i < 20; i++) {
    const plan = makeSchedule(rng()); assert.equal(plan.length, 8);
    for (const [mode, left, right] of MODES) {
      const group = plan.filter(p => p.mode === mode); assert.deepEqual(group.map(p => p.block), [0, 1, 2, 3]);
      assert.equal(group.filter(p => p.roles[0] === 'left').length, 2); assert.equal(group.filter(p => p.roles[0] === 'right').length, 2);
      for (const p of group) { assert.equal(p.left, left); assert.equal(p.right, right); assert.deepEqual([...p.roles].sort(), ['left', 'left', 'right', 'right']); assert.equal(p.roles[0], p.roles[3]); assert.notEqual(p.roles[0], p.roles[1]); }
    }
  }
});
test('the independent unit is four quartets, and direct A/A never adjusts A/B', () => {
  const s = summarize(synthetic(1.03, 1.01));
  assert.equal(s.ab.pairs.length, 8); assert.equal(s.ab.interval.quartets, 4);
  assert.ok(Math.abs(s.ab.interval.geometricMean - 1.03) < 1e-12);
  assert.ok(Math.abs(s['aa-baseline'].interval.geometricMean - 1.01) < 1e-12);
  assert.equal(s.ab.conclusion, 'detected material loss');
  assert.equal(s.ab.leftMedianMs, 1); assert.equal(s.ab.rightMedianMs, 1.03);
});
test('2.0x and reciprocal A/A drift invalidate inference without adjusting or deleting A/B', () => {
  for (const aa of [2, 0.5]) {
    const row = synthetic(0.8, aa), before = structuredClone(row), result = summarize(row);
    assert.deepEqual(row, before, 'Raw subjects must remain unchanged');
    assert.ok(Math.abs(result.ab.interval.geometricMean - 0.8) < 1e-12);
    assert.ok(Math.abs(result['aa-baseline'].interval.geometricMean - aa) < 1e-12);
    assert.equal(result.ab.interval.classification, 'evidence within margin', 'Keep the unadjusted raw interval');
    assert.equal(result.ab.conclusion, 'control-drift-inconclusive');
    assert.equal(result.ab.inferenceUsable, false); assert.equal(result.ab.controlDrift, true);
    assert.equal(result.ab.pairs.length, 8); assert.equal(result.ab.quartetLogLatencyRatios.length, 4);
  }
});
test('control drift requires both a shift outside the symmetric band and an interval excluding 1', () => {
  const interval = (geometricMean, lower, upper) => ({ quartets: 4, geometricMean, lower, upper });
  assert.equal(hasControlDrift(interval(1.03, 1.01, 1.05)), true);
  assert.equal(hasControlDrift(interval(1 / 1.03, 0.96, 0.99)), true);
  assert.equal(hasControlDrift(interval(1.03, 0.99, 1.07)), false);
  assert.equal(hasControlDrift(interval(1.03, 1, 1.07)), false);
  assert.equal(hasControlDrift(interval(1.01, 1.005, 1.015)), false);
  assert.equal(hasControlDrift(interval(1.02, 1.01, 1.03)), false);
  assert.equal(hasControlDrift(interval(1 / 1.02, 0.97, 0.99)), false);
  assert.equal(hasControlDrift({ ...interval(2, 2, 2), quartets: 3 }), false);
});
test('df3 Student-t interval and 2% rule retain small losses and uncertainty', () => {
  assert.equal(logInterval(Array(4).fill(Math.log(1.01))).classification, 'evidence within margin');
  assert.equal(logInterval(Array(4).fill(Math.log(1.03))).classification, 'detected material loss');
  const values = [0.99, 1.02, 1.01, 1.04].map(Math.log), got = logInterval(values), mean = values.reduce((a, b) => a + b) / 4;
  const variance = values.reduce((n, x) => n + (x - mean) ** 2, 0) / 3;
  assert.ok(Math.abs(Math.log(got.upper) - mean - 3.1824463053 * Math.sqrt(variance / 4)) < 1e-12);
  assert.equal(got.classification, 'inconclusive'); assert.equal(logInterval([]).geometricMean, null);
});
test('incomplete quartets and validity flags cannot become positive evidence', () => {
  const incomplete = summarize({ blocks: [{ mode: 'ab', subjects: [{ role: 'left' }, { role: 'right' }] }] });
  assert.equal(incomplete.ab.interval.quartets, 0); assert.equal(incomplete.ab.inferenceUsable, false);
  for (const flags of [{ belowTargetBatches: 1 }, { warmup: { capped: true } }, { warmupTimeShort: true }, { warmupWorkShort: true }]) {
    assert.equal(summarize(synthetic(0.5, 1, flags)).ab.inferenceUsable, false);
  }
});
test('common work handles zero-size scans, caps, and fixed compaction warmup', () => {
  const pilots = [{ repeat: 64, minMsPerScan: 0.01, digest: 'same', warmup: {} }, { repeat: 128, minMsPerScan: 0.005, digest: 'same', warmup: {} }];
  const empty = freezePlan({ size: 0, operation: 'forEach' }, pilots);
  assert.equal(empty.repeat, 128); assert.ok(Number.isSafeInteger(empty.warmupScans)); assert.ok(empty.warmupScans >= CONFIG.warmupMinElements);
  const compact = freezePlan({ size: 33, operation: 'compact' }, pilots); assert.equal(compact.warmupScans, 512);
  assert.equal(freezePlan({ size: 33, operation: 'compact' }, pilots.map(p => ({ ...p, repeatCapped: true }))).repeatCapped, true);
  assert.throws(() => freezePlan({ size: 33, operation: 'forEach' }, [pilots[0], { ...pilots[1], digest: 'different' }]));
});
test('later-stage eligibility is separate from equivalence or adoption', () => {
  const record = { status: 'completed', rows: CASES.map(c => { const row = { ...synthetic(c.size > 32 ? 0.8 : 1), ...c }; return { ...row, summary: summarize(row) }; }) };
  assert.equal(gateStatus(record), 'eligible-for-later-correctness');
  record.rows[0] = { ...record.rows[0], summary: summarize(synthetic(0.8, 2)) }; assert.equal(gateStatus(record), 'control-drift-inconclusive');
  record.rows[0] = { ...record.rows[0], summary: summarize(synthetic(1.05)) }; assert.equal(gateStatus(record), 'detected-material-loss');
  record.rows[0] = { ...record.rows[0], summary: summarize(synthetic(1, 1, { belowTargetBatches: 1 })) }; assert.equal(gateStatus(record), 'flagged-inconclusive');
  assert.equal(gateStatus({ ...record, status: 'running' }), 'incomplete');
});
test('neutral copies preserve original package bytes, dist paths, and reject symlinks', () => {
  const temp = mkdtempSync(join(os.tmpdir(), 'block-neutral-test-'));
  try {
    const sourceRoot = join(temp, 'source'), neutral = join(temp, 'subject'); mkdirSync(join(sourceRoot, 'dist'), { recursive: true });
    const packageBytes = '{\n "name": "fixture", "type": "module", "exports": "./dist/shared.js", "version": "1.2.3"\n}\n';
    writeFileSync(join(sourceRoot, 'package.json'), packageBytes);
    const source = join(sourceRoot, 'dist', 'shared.js'); writeFileSync(source, 'export const value = 1;\n');
    const manifest = bundleManifest(source), digest = sha256(packageBytes), entry = prepareSubject(source, neutral, manifest, digest);
    assert.equal(entry, join(neutral, 'dist', 'shared.js')); assert.equal(readFileSync(join(neutral, 'package.json'), 'utf8'), packageBytes);
    assert.deepEqual(bundleManifest(entry), manifest);
    writeFileSync(join(neutral, 'dist', 'stale.js'), 'stale'); prepareSubject(source, neutral, manifest, digest); assert.equal(existsSync(join(neutral, 'dist', 'stale.js')), false);
    assert.throws(() => prepareSubject(source, neutral, manifest, 'incorrect'), /Source package context changed/);
    symlinkSync(source, join(sourceRoot, 'dist', 'alias.js')); assert.throws(() => bundleManifest(source), /symlink/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
