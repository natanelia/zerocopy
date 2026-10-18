import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PLAN, endpoints, interval, schedule, summarize } from './numeric-tree-process.mjs';
import { expectedCount, validatePhase, verifyEvidence } from './numeric-tree-gate.mjs';

function phase(kind = 'aa', ratio = 1) {
  const stats = interval(Array(PLAN.blocks).fill(Math.log(ratio)));
  return { kind, fullCoverage: true, error: null, pass: true,
    rows: endpoints().map(key => ({ ...key, ...stats,
      pairedRatios: Array(PLAN.blocks * 2).fill(ratio), blockRatios: Array(PLAN.blocks).fill(ratio),
      pointPass: true, confidencePass: true, pass: true })),
    cohorts: PLAN.sizes.map(size => ({ size, error: null, pass: true })) };
}
function fixture(run, kind = 'aa', ratio = 1) {
  const dir = mkdtempSync(resolve(tmpdir(), 'numeric-raw-gate-'));
  const save = (path, value) => writeFileSync(resolve(dir, path), JSON.stringify(value) + '\n');
  const inputSources = { baseline: { bundle: { wasm: 'base' } }, candidate: { bundle: { wasm: 'candidate' } } };
  const sources = { controller: 'controller', driver: 'driver' };
  const runtime = { node: 'test', bun: null, v8: 'test', arch: 'test', cpu: 'test' };
  const report = { kind, fullCoverage: true, error: null, rows: [], cohorts: [], inputSources,
    sources, runtime, runtimeFile: '/runtime', runtimeSha256: 'runtime-hash' };
  save('plan.json', { kind, numericalPlan: PLAN, inputSources, sources, runtime: report.runtimeFile, runtimeSha256: report.runtimeSha256 });
  for (const size of PLAN.sizes) {
    const folder = `size-${size}`; mkdirSync(resolve(dir, folder));
    save(`${folder}/plan.json`, { kind, plan: { ...PLAN, sizes: [size] }, schedule: schedule(),
      source: inputSources, driver: sources.driver, runtime: report.runtimeFile });
    const expected = new Map(endpoints([size]).map(({ name }) => [name, expectedCount(name, size)]));
    const children = schedule().map((assignment, index) => {
      const status = { assignment, status: 0, signal: null, error: null };
      const iterations = Math.min(1_000_000, Math.max(8, Math.ceil(PLAN.work / size)));
      const child = { plan: { ...PLAN, sizes: [size] }, driver: sources.driver, runtime,
        bundle: inputSources[kind === 'aa' || assignment.role === 'B' ? 'candidate' : 'baseline'].bundle,
        results: endpoints([size]).map(key => ({ ...key, iterations, expected: expected.get(key.name),
          warmup: Array(PLAN.warmup).fill(1), samples: Array(PLAN.samples).fill(assignment.role === 'A' ? ratio : 1) })) };
      const prefix = `${folder}/${String(index + 1).padStart(2, '0')}`;
      save(`${prefix}.status.json`, status); save(`${prefix}.json`, child);
      writeFileSync(resolve(dir, `${prefix}.json.samples.ndjson`), child.results.map(r => JSON.stringify(r)).join('\n') + '\n');
      return { ...status, report: child };
    });
    const rows = summarize(children, kind, [size]); const pass = rows.every(row => row.pass);
    save(`${folder}/summary.json`, { kind, complete: true, error: null, rows, pass });
    report.rows.push(...rows); report.cohorts.push({ size, error: null, pass });
  }
  report.pass = report.rows.every(row => row.pass); save('summary.json', report);
  try { run({ dir, report, save }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the gate rejects a false PASS flag below the unchanged regression floor', () => {
  assert.throws(() => validatePhase(phase('aa', 0.5), 'aa'), /False point-pass flag/);
  assert.throws(() => validatePhase(phase('ab', 1), 'ab'), /False point-pass flag/);
  assert.doesNotThrow(() => validatePhase(phase(), 'aa'));
  assert.doesNotThrow(() => validatePhase(phase('ab', 1.1), 'ab'));
});
test('invalid, inconsistent, missing and duplicate numeric evidence cannot pass', () => {
  for (const mutate of [
    r => r.rows[0].speedup = NaN,
    r => r.rows[0].lower = -1,
    r => r.rows[0].upper = Infinity,
    r => r.rows[0].pairedRatios.pop(),
    r => r.rows[0].pairedRatios[0] = 0,
    r => r.rows[0].blockRatios[0] = 2,
    r => r.rows[0].speedup = 1.1,
    r => r.cohorts[1].size = r.cohorts[0].size,
  ]) { const report = phase(); mutate(report); assert.throws(() => validatePhase(report, 'aa')); }
});
test('all raw children reproduce a valid identical-build phase', () => fixture(({ dir }) => {
  const report = verifyEvidence(dir, 'aa'); assert.equal(report.rows.length, 63); validatePhase(report, 'aa');
}));
test('raw evidence verification retains a genuine failed comparison', () => fixture(({ dir }) => {
  const report = verifyEvidence(dir, 'ab'); assert.equal(report.pass, false);
  assert.throws(() => validatePhase(report, 'ab'));
}, 'ab', 0.9));
test('changed status, builds, journals, plans, oracles and summaries fail closed', () => fixture(({ dir }) => {
  const changes = [
    ['size-1/01.status.json', r => r.status = 1],
    ['size-1/01.status.json', r => r.assignment.role = 'B'],
    ['size-1/01.json', r => r.bundle.wasm = 'other'],
    ['size-1/01.json', r => r.results[0].expected++],
    ['size-1/plan.json', r => r.source.candidate.bundle.wasm = 'other'],
    ['size-1/summary.json', r => r.rows[0].lower = 1.01],
    ['summary.json', r => r.rows[0].speedup = 2],
    ['summary.json', r => r.cohorts[1].size = 1],
    ['plan.json', r => r.numericalPlan.version--],
    ['plan.json', r => r.runtimeSha256 = 'different'],
  ];
  for (const [name, mutate] of changes) {
    const path = resolve(dir, name), bytes = readFileSync(path), value = JSON.parse(bytes);
    mutate(value); writeFileSync(path, JSON.stringify(value));
    assert.throws(() => verifyEvidence(dir, 'aa'), name); writeFileSync(path, bytes);
  }
  const path = resolve(dir, 'size-1/01.json.samples.ndjson'), bytes = readFileSync(path);
  writeFileSync(path, bytes.toString().replace('"expected":0', '"expected":1'));
  assert.throws(() => verifyEvidence(dir, 'aa'), /journal/); writeFileSync(path, bytes);
  // The oracle must also catch a false count when the child and journal
  // agree. Journal equality alone cannot reject this forged result.
  const childPath = resolve(dir, 'size-2/01.json');
  const rawPath = `${childPath}.samples.ndjson`;
  const oldChild = readFileSync(childPath), oldRaw = readFileSync(rawPath);
  const altered = JSON.parse(oldChild);
  const mixed = altered.results.find(row => row.name === 'point-public-mixed');
  assert.equal(mixed.expected, 1);
  mixed.expected = 2;
  writeFileSync(childPath, JSON.stringify(altered));
  writeFileSync(rawPath, altered.results.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.throws(() => verifyEvidence(dir, 'aa'), /Wrong fixture oracle result/);
  writeFileSync(childPath, oldChild); writeFileSync(rawPath, oldRaw);
  unlinkSync(path); assert.throws(() => verifyEvidence(dir, 'aa'), /ENOENT/); writeFileSync(path, bytes);
}));
test('editing both a child and its journal still requires matching raw estimates', () => fixture(({ dir }) => {
  const prefix = resolve(dir, 'size-1/01.json'); const child = JSON.parse(readFileSync(prefix));
  child.results[0].samples.fill(0.5);
  writeFileSync(prefix, JSON.stringify(child));
  writeFileSync(`${prefix}.samples.ndjson`, child.results.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.throws(() => verifyEvidence(dir, 'aa'), /summary differs from raw samples/);
}));


test('fixture oracles retain known all-miss, mixed-hit and range counts', () => {
  for (const [size, mixed] of [[2, 1], [32, 4], [1024, 108], [32768, 3408], [262144, 27269]]) {
    assert.equal(expectedCount('point-scalar-control', size), 0);
    assert.equal(expectedCount('point-public-mixed', size), mixed);
  }
  assert.equal(expectedCount('range-simd', 1), 0);
  assert.equal(expectedCount('range-scalar', 2), 0);
  assert.throws(() => expectedCount('nonexistent', 32));
});
