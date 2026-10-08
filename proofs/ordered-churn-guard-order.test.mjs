import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { sha256, bundleManifest } from './ordered-churn-source.mjs';
import { CASES, CONFIG, MODES, makeSchedule, summarize, prepareSubject } from './ordered-churn-guard-order.mjs';

test('six ordinary controls and the unchanged fixed work/statistics settings', () => {
  assert.deepEqual(CASES.map(c => [c.size, c.kind]), [[1, 'ordered'], [1, 'replaced'], [32, 'ordered'], [32, 'replaced'], [4096, 'ordered'], [4096, 'replaced']]);
  for (const c of CASES) { assert.equal(c.history, c.size); assert.equal(c.operation, 'entries'); assert.equal(c.type, 'number'); }
  assert.equal(CONFIG.blocks, 4); assert.equal(CONFIG.samples, 21); assert.equal(CONFIG.targetBatchMs, 10); assert.equal(CONFIG.nonInferiorityMargin, 1.02); assert.equal(CONFIG.confidenceLevel, 0.95);
});
test('every comparison and identical-build A/A has four balanced quartets', () => {
  let seed = 20261008; const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  const plan = makeSchedule(random); assert.equal(plan.length, 24);
  for (const [mode, left, right] of MODES) {
    const group = plan.filter(p => p.mode === mode); assert.deepEqual(group.map(p => p.block), [0, 1, 2, 3]);
    assert.equal(group.filter(p => p.roles[0] === 'left').length, 2);
    assert.equal(group.filter(p => p.roles[0] === 'right').length, 2);
    for (const p of group) { assert.equal(p.left, left); assert.equal(p.right, right); assert.deepEqual([...p.roles].sort(), ['left', 'left', 'right', 'right']); assert.notEqual(p.roles[0], p.roles[1]); assert.notEqual(p.roles[2], p.roles[3]); assert.equal(p.roles[0], p.roles[3]); }
  }
});
test('interval direction and independent sample count survive three-build comparisons', () => {
  const times = { main: 10, original: 10.6, reordered: 10.01 };
  const row = { blocks: makeSchedule(() => 0.25).map(p => ({ ...p, subjects: p.roles.map(role => ({ role, build: p[role], repeat: 1, samples: Array(21).fill(times[p[role]]), belowTargetBatches: 0, warmup: { capped: false }, warmupTimeShort: false, warmupWorkShort: false })) })) };
  const result = summarize(row);
  for (const [mode, left, right] of MODES) {
    const r = result[mode]; assert.equal(r.pairs.length, 8); assert.equal(r.interval.quartets, 4); assert.equal(r.ratioDirection, `${right}/${left}`);
    assert(Math.abs(r.interval.geometricMean - times[right] / times[left]) < 1e-12);
    assert.equal(r.interval.classification, mode === 'main-original' ? 'detected material loss' : 'evidence within margin');
    assert.equal(r.leftMedianMs, times[left]); assert.equal(r.rightMedianMs, times[right]);
  }
});
test('incomplete quartets never become independent replicates', () => {
  const result = summarize({ blocks: [{ mode: 'main-original', subjects: [{ role: 'left' }, { role: 'right' }] }] });
  assert.equal(result['main-original'].pairs.length, 0); assert.equal(result['main-original'].interval.quartets, 0); assert.equal(result['main-original'].interval.classification, 'inconclusive');
});

test('balanced orientation preserves the old mode order and subsequent random stream', () => {
  const rng = () => { let seed = 20261008; return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }; };
  const before = rng(), after = rng(), expected = [];
  for (let block = 0; block < 4; block++) {
    const modes = [...MODES];
    for (let i = modes.length - 1; i > 0; i--) { const j = Math.floor(before() * (i + 1)); [modes[i], modes[j]] = [modes[j], modes[i]]; }
    for (const [mode, left, right] of modes) { before(); expected.push({ block, mode, left, right }); }
  }
  assert.deepEqual(makeSchedule(after).map(({ roles, ...rest }) => rest), expected);
  assert.equal(after(), before());
});
test('neutral copies preserve exact package bytes, dist layout and bundle hashes', () => {
  const temp = mkdtempSync(join(os.tmpdir(), 'ordered-guard-package-test-'));
  try {
    const sourceRoot = join(temp, 'source'), neutral = join(temp, 'subject'); mkdirSync(join(sourceRoot, 'dist'), { recursive: true });
    const packageBytes = '{\n  "name": "fixture-package", "type": "module", "exports": "./dist/shared.js", "version": "1.2.3"\n}\n';
    writeFileSync(join(sourceRoot, 'package.json'), packageBytes);
    const source = join(sourceRoot, 'dist', 'shared.js'); writeFileSync(source, 'export const value = 1;\n');
    const manifest = bundleManifest(source), digest = sha256(packageBytes), entry = prepareSubject(source, neutral, manifest, digest);
    assert.equal(entry, join(neutral, 'dist', 'shared.js')); assert.equal(readFileSync(join(neutral, 'package.json'), 'utf8'), packageBytes);
    assert.deepEqual(bundleManifest(entry), manifest);
    writeFileSync(join(neutral, 'dist', 'stale.js'), 'stale'); prepareSubject(source, neutral, manifest, digest); assert.equal(existsSync(join(neutral, 'dist', 'stale.js')), false);
    assert.throws(() => prepareSubject(source, neutral, manifest, 'incorrect'), /Source package context changed/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
