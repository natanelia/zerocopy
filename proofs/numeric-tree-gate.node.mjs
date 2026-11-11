import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PLAN, endpoints, interval, schedule, summarize } from './numeric-tree-process.mjs';
import { validatePhase, verifyEvidence } from './numeric-tree-gate.mjs';

function phase(kind = 'aa', ratio = 1) {
  const stats = interval(Array(PLAN.blocks).fill(Math.log(ratio)));
  return { kind, fullCoverage: true, error: null, pass: true,
    rows: endpoints().map(key => ({ ...key, ...stats, pairedRatios: Array(PLAN.blocks * 2).fill(ratio),
      blockRatios: Array(PLAN.blocks).fill(ratio), pointPass: true, confidencePass: true, pass: true })),
    cohorts: PLAN.sizes.map(size => ({ size, error: null, pass: true })) };
}
test('reported pass flags cannot override measured confidence or thresholds', () => {
  assert.doesNotThrow(() => validatePhase(phase(), 'aa'));
  assert.doesNotThrow(() => validatePhase(phase('ab', 1.1), 'ab'));
  assert.throws(() => validatePhase(phase('ab'), 'ab'), /False point-pass/);
  assert.throws(() => validatePhase(phase('aa', 0.5), 'aa'), /False point-pass/);
  for (const edit of [r => r.rows[0].speedup = 1.2, r => r.rows[0].pairedRatios.pop(),
    r => r.rows[0].blockRatios[0] = 2, r => r.cohorts[1].size = r.cohorts[0].size,
    r => r.rows[0].lower = -1]) {
    const report = phase(); edit(report); assert.throws(() => validatePhase(report, 'aa'));
  }
});
test('all retained children rebuild the summary; tampering with a journal fails', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'numeric-gate-'));
  const save = (path, value) => writeFileSync(resolve(dir, path), JSON.stringify(value) + '\n');
  const inputSources = { baseline: { bundle: { wasm: 'A' } }, candidate: { bundle: { wasm: 'B' } } };
  const sources = { driver: 'driver', controller: 'controller' };
  const runtime = { node: 'node', bun: null, arch: 'x64', v8: 'test', cpu: 'test' };
  const report = { kind: 'aa', fullCoverage: true, error: null, pass: true, rows: [], cohorts: [],
    inputSources, sources, runtime, runtimeFile: '/runtime', runtimeSha256: 'runtime-sha' };
  try {
    save('plan.json', { kind: 'aa', numericalPlan: PLAN, inputSources, sources,
      runtime: report.runtimeFile, runtimeSha256: report.runtimeSha256 });
    for (const size of PLAN.sizes) {
      const folder = `size-${size}`; mkdirSync(resolve(dir, folder));
      save(`${folder}/plan.json`, { kind: 'aa', plan: { ...PLAN, sizes: [size] }, schedule: schedule(),
        source: inputSources, driver: sources.driver, runtime: report.runtimeFile });
      const children = schedule().map((assignment, index) => {
        const status = { assignment, status: 0, signal: null, error: null };
        const iterations = Math.min(1_000_000, Math.max(8, Math.ceil(PLAN.work / size)));
        const child = { plan: { ...PLAN, sizes: [size] }, driver: sources.driver, runtime,
          bundle: inputSources.candidate.bundle,
          results: endpoints([size]).map(key => ({ ...key, iterations, expected: 0,
            warmup: Array(PLAN.warmup).fill(1), samples: Array(PLAN.samples).fill(1) })) };
        const prefix = `${folder}/${String(index + 1).padStart(2, '0')}`;
        save(`${prefix}.status.json`, status); save(`${prefix}.json`, child);
        writeFileSync(resolve(dir, `${prefix}.json.samples.ndjson`), child.results.map(JSON.stringify).join('\n') + '\n');
        return { ...status, report: child };
      });
      const rows = summarize(children, 'aa', [size]);
      save(`${folder}/summary.json`, { kind: 'aa', complete: true, error: null, rows, pass: true });
      report.rows.push(...rows); report.cohorts.push({ size, error: null, pass: true });
    }
    save('summary.json', report);
    assert.deepEqual(verifyEvidence(dir, 'aa').rows, report.rows);
    const file = resolve(dir, 'size-1/01.json.samples.ndjson');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"expected":0', '"expected":1'));
    assert.throws(() => verifyEvidence(dir, 'aa'), /journal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
