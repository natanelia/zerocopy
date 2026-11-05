import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// This is a fixed diagnostic cohort, not a performance acceptance run.
// It retains all four runs, even when the first run detects method noise.
const source = resolve(process.env.SOURCE_DIR ?? '.');
const output = resolve(process.env.OUT_DIR ?? 'proofs/results/numeric-tree-20261017/stage3-aa');
const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-numeric-aa-'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = ['package.json', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', ...readdirSync(resolve(source, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => `dist/${name}`)];
const manifest = dir => Object.fromEntries(files.map(name => [name, digest(resolve(dir, name))]));
const expected = manifest(source);
const driver = digest(resolve(source, 'proofs/numeric-tree-benchmark.mjs'));
const controller = digest(new URL(import.meta.url));
for (const label of ['a', 'b']) {
  mkdirSync(resolve(temporary, label, 'dist'), { recursive: true });
  for (const name of files) copyFileSync(resolve(source, name), resolve(temporary, label, name));
  assert.deepEqual(manifest(resolve(temporary, label)), expected);
}
mkdirSync(output, { recursive: true });
const schedule = [
  { runtime: 'node', executable: process.env.NODE_BIN ?? 'node', left: 'a', right: 'b' },
  { runtime: 'bun', executable: process.env.BUN_BIN ?? 'bun', left: 'a', right: 'b' },
  { runtime: 'node', executable: process.env.NODE_BIN ?? 'node', left: 'b', right: 'a' },
  { runtime: 'bun', executable: process.env.BUN_BIN ?? 'bun', left: 'b', right: 'a' },
];
const rows = [];
for (const [index, entry] of schedule.entries()) {
  const name = `${index + 1}-${entry.runtime}-${entry.left}-${entry.right}`;
  const resultFile = resolve(output, `${name}.json`);
  const logFile = resolve(output, `${name}.txt`);
  const descriptor = openSync(logFile, 'w');
  let child;
  try {
    child = spawnSync(entry.executable, [resolve(source, 'proofs/numeric-tree-benchmark.mjs')], {
      cwd: source,
      env: {
        ...process.env, BASE_DIR: source, CANDIDATE_DIR: source,
        BASE_MODULE_DIR: resolve(temporary, entry.left), CANDIDATE_MODULE_DIR: resolve(temporary, entry.right),
        MODE: 'all', SIZES: '1,2,32,1024', WARMUP: '25', SAMPLES: '31', WORK: '8000000', PERF_GATE: '0', OUT_FILE: resultFile,
      },
      stdio: ['ignore', descriptor, descriptor],
    });
  } finally { closeSync(descriptor); }
  const row = { name, ...entry, status: child.status, error: child.error ? String(child.error) : undefined, failures: [] };
  if (!child.error && child.status === 0) {
    const measured = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.equal(measured.source.driver, driver);
    assert.deepEqual(measured.source.baseline.files, measured.source.candidate.files);
    assert.deepEqual(measured.source.baseline.dist, measured.source.candidate.dist);
    row.failures = measured.results.filter(result => result.speedup < 0.95 || result.speedup > 1 / 0.95).map(({ name, size, speedup, pairedMedian }) => ({ name, size, speedup, pairedMedian }));
  }
  rows.push(row);
  console.log('NUMERIC-TREE-AA', JSON.stringify(row));
  writeFileSync(resolve(output, 'cohort.json'), JSON.stringify({ date: new Date().toISOString(), source, bundles: temporary, manifest: expected, driver, controller, schedule, warmup: 25, samples: 31, work: 8000000, sizes: [1, 2, 32, 1024], method: 'Same stage-3 bundle in two clean neutral directories; swap the directory roles on the second run of each runtime. Any ratio outside [0.95, 1/0.95] detects a greater-than-5% A/A shift. This does not change the production acceptance gate.', rows }, null, 2) + '\n');
}
assert.deepEqual(manifest(source), expected, 'Source bundles changed during the fixed cohort');
assert.equal(digest(resolve(source, 'proofs/numeric-tree-benchmark.mjs')), driver, 'Driver changed during the fixed cohort');
assert.ok(rows.every(row => row.status === 0 && !row.error && row.failures.length === 0), 'The fixed A/A cohort detected a harness or runtime placement effect; do not use this method to accept an A/B change.');
