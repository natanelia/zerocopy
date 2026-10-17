import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAN, endpoints, interval, median, schedule, summarize, runCohort } from './numeric-tree-process.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(ratio = 1) {
  return schedule().map(assignment => ({ assignment, status: 0, error: null, signal: null,
    report: { plan: { ...PLAN }, runtime: { node: 'test', bun: null, arch: 'test', cpu: 'test' }, driver: 'same-driver',
      results: endpoints().map(({ name, size }) => ({ name, size, iterations: Math.min(1_000_000, Math.max(8, Math.ceil(PLAN.work / size))), warmup: Array(PLAN.warmup).fill(1), samples: Array(PLAN.samples).fill(assignment.role === 'A' ? ratio : 1) })) } }));
}
test('balanced ABBA/BAAB schedule has eight pairs with equal role positions', () => {
  const jobs = schedule(); assert.equal(jobs.length, 16);
  for (const position of [0, 1, 2, 3]) assert.equal(jobs.filter(j => j.position === position && j.role === 'A').length, 2);
  assert.equal(jobs.filter(j => j.role === 'A').length, 8);
});
test('full fixed cohort retains all 48 endpoints and all old thresholds', () => {
  assert.equal(endpoints().length, 48); assert.equal(PLAN.regressionFloor, .95);
  assert.equal(PLAN.improvementFloor, 1.05); assert.equal(PLAN.aaCeiling, 1 / .95);
});
test('median rejects invalid observations without dropping them', () => {
  assert.equal(median([4, 1, 2, 3]), 2.5);
  for (const values of [[], [1, NaN], [0, 1], [-1, 2], [Infinity, 1]]) assert.throws(() => median(values));
});
test('identical stable builds pass equivalence', () => {
  assert.ok(summarize(fixture(), 'aa').every(r => r.pass));
});
test('stable regressions fail without adjusting thresholds', () => {
  assert.ok(summarize(fixture(.94), 'ab').every(r => !r.pass));
  assert.ok(summarize(fixture(1.06), 'aa').every(r => !r.pass));
});
test('large target requires more than five percent improvement', () => {
  assert.ok(summarize(fixture(1), 'ab').filter(r => r.size >= 1024 && ['range-simd', 'range-public'].includes(r.name)).every(r => !r.pass));
  assert.ok(summarize(fixture(1.1), 'ab').every(r => r.pass));
});
test('log-linear time drift cancels within balanced four-child blocks', () => {
  const rows = fixture(); rows.forEach((child, i) => child.report.results.forEach(r => r.samples.fill(Math.exp(i * .01))));
  assert.ok(summarize(rows, 'aa').every(r => Math.abs(r.speedup - 1) < 1e-12));
});
test('process dispersion widens the interval and can prevent clearance', () => {
  const stats = interval([-.1, .1, -.1, .1]); assert.ok(stats.lower < .95 && stats.upper > 1 / .95);
});
test('failed or missing children cannot produce acceptance', () => {
  const failed = fixture(); failed[3].status = 1; assert.throws(() => summarize(failed, 'aa'));
  assert.throws(() => summarize(fixture().slice(1), 'aa'));
});
test('missing, extra, reordered and invalid raw samples fail closed', () => {
  for (const mutate of [
    a => a[0].report.results.pop(),
    a => a[0].report.results.push(a[0].report.results[0]),
    a => a.reverse(),
    a => a[0].report.results[0].samples.pop(),
    a => a[0].report.results[0].samples.push(1),
    a => a[0].report.results[0].samples[0] = NaN,
    a => a[0].report.results[0].iterations++,
    a => a[0].report.driver = 'different',
    a => a[0].report.runtime.node = 'different',
  ]) { const a = fixture(); mutate(a); assert.throws(() => summarize(a, 'aa')); }
});
test('existing output is never overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'numeric-process-test-'));
  try { writeFileSync(join(dir, 'keep'), 'evidence'); assert.throws(() => runCohort({ outDir: dir, kind: 'aa' }), /overwrite/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test('an unavailable runtime retains every planned failed child and exits without clearance', async () => {
  const { mkdirSync, readdirSync, readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'numeric-process-failure-'));
  try {
    const source = join(dir, 'source'); mkdirSync(join(source, 'dist'), { recursive: true });
    for (const file of ['package.json', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'dist/shared.js', 'dist/numeric.js']) writeFileSync(join(source, file), '{}');
    execFileSync('git', ['init', '-q'], { cwd: source }); execFileSync('git', ['add', '.'], { cwd: source });
    const output = join(dir, 'output');
    const result = runCohort({ baseDir: source, candidateDir: source, outDir: output, runtime: join(dir, 'absent-runtime'), kind: 'aa' });
    assert.equal(result.pass, false); assert.equal(result.complete, true);
    assert.equal(readdirSync(output).filter(n => n.endsWith('.status.json')).length, 16);
    assert.equal(JSON.parse(readFileSync(join(output, 'plan.json'))).schedule.length, 16);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
