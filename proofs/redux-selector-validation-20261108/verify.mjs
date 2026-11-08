import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const baseline = '0ac8a005268335a6116f025e75f670b5cee6843e';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return n % 2 ? sorted[n >>> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
const original = execFileSync('git', ['show', `${baseline}:redux.ts`], { cwd: root });
const driver = readFileSync(join(directory, '../redux-sequence-reads-20261105/paired-benchmark.mjs'));
const files = readdirSync(directory).filter(name => /^(pilot(?:-v[23])?|formal-v3|aa-v3)\.json(?:\.gz)?$/.test(name));
assert.ok(files.length > 0, 'No recorded measurements found');
let processes = 0, measuredBatches = 0;
for (const name of files) {
  const bytes = readFileSync(join(directory, name));
  const data = JSON.parse((name.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
  assert.equal(data.schema, 'zerocopy-paired-public-operation/v1');
  assert.equal(data.status, 'complete'); assert.equal(data.study.baseline, baseline);
  assert.equal(data.source.before.commit, baseline);
  assert.equal(data.snapshots['redux.ts'].before, original.toString('utf8'));
  assert.equal(sha256(original), data.source.before.sources['redux.ts']);
  assert.equal(sha256(data.snapshots['redux.ts'].after), data.source.after.sources['redux.ts']);
  assert.equal(sha256(driver), data.driver.sha256);
  assert.deepEqual(data.source.before.wasm, data.source.after.wasm);
  const changed = [...new Set([...Object.keys(data.source.before.sources), ...Object.keys(data.source.after.sources)])]
    .filter(file => data.source.before.sources[file] !== data.source.after.sources[file]).sort();
  assert.deepEqual(changed, data.mode === 'aa' ? [] : ['redux.ts']);
  const version = /^pilot\.json/.test(name) ? 1 : /^pilot-v2\./.test(name) ? 2 : 3;
  const workload = version < 3 ? `workloads-v${version}.mjs` : 'workloads.mjs';
  assert.equal(sha256(readFileSync(join(directory, workload))), data.workload.sha256);
  if (data.mode !== 'aa') {
    const archived = readFileSync(join(directory, `candidate-v${version}/redux.ts.txt`));
    assert.equal(sha256(archived), data.source.after.sources['redux.ts']);
    if (data.mode === 'formal') assert.equal(sha256(readFileSync(join(root, 'redux.ts'))), sha256(archived));
  } else assert.deepEqual(data.source.before.bundles, data.source.after.bundles);
  const { cases, pairs, samples, minimumWarmupMs, minimumWarmupBatches } = data.method;
  assert.ok(['pilot', 'formal', 'aa'].includes(data.mode));
  assert.equal(samples, 9);
  assert.equal(minimumWarmupBatches, 8);
  assert.equal(pairs, data.mode === 'formal' ? 6 : data.mode === 'aa' ? 4 : 2);
  assert.equal(minimumWarmupMs, data.mode === 'pilot' ? 150 : 500);
  const filter = data.mode === 'aa' ? data.study.aaCases : data.mode === 'pilot' ? data.study.pilotCases : null;
  assert.deepEqual(cases, filter ? data.study.cases.filter(spec => filter.includes(spec.name)) : data.study.cases);
  assert.equal(data.runs.length, cases.length * pairs * 4);
  const expectedOrder = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const runtime of pair % 2 ? ['bun', 'node'] : ['node', 'bun']) {
      for (const spec of pair % 2 ? [...cases].reverse() : cases) {
        for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) expectedOrder.push([runtime, spec.name, pair, variant]);
      }
    }
  }
  assert.deepEqual(data.runs.map(run => [run.runtime, run.caseName, run.pair, run.variant]), expectedOrder);
  const seen = new Set();
  for (const run of data.runs) {
    const key = JSON.stringify([run.runtime, run.caseName, run.pair, run.variant]);
    assert.ok(!seen.has(key)); seen.add(key);
    assert.ok(['node', 'bun'].includes(run.runtime)); assert.ok(['before', 'after'].includes(run.variant));
    assert.ok(Number.isInteger(run.pair) && run.pair >= 0 && run.pair < pairs);
    assert.deepEqual(run.spec, cases.find(spec => spec.name === run.caseName));
    assert.equal(run.sampleBatchMs.length, samples);
    assert.ok(run.warmupBatchMs.length >= minimumWarmupBatches);
    assert.ok(run.warmupBatchMs.reduce((sum, n) => sum + n, 0) >= minimumWarmupMs);
    assert.ok([...run.sampleBatchMs, ...run.warmupBatchMs].every(n => Number.isFinite(n) && n > 0));
    assert.equal(run.verifiedOutputs, (samples + run.warmupBatchMs.length) * run.spec.repetitions);
    assert.equal(run.affinity, data.host.affinity); assert.match(run.affinity, /^\d+$/);
    close(run.medianMs, median(run.sampleBatchMs) / run.spec.repetitions);
  }
  assert.equal(data.summary.length, cases.length * 2);
  for (const runtime of ['node', 'bun']) for (const spec of cases) {
    const points = [];
    for (let pair = 0; pair < pairs; pair++) {
      const before = data.runs.find(run => run.runtime === runtime && run.caseName === spec.name && run.pair === pair && run.variant === 'before');
      const after = data.runs.find(run => run.runtime === runtime && run.caseName === spec.name && run.pair === pair && run.variant === 'after');
      assert.deepEqual(before.versions, after.versions); assert.deepEqual(before.fixture, after.fixture);
      assert.equal(before.expectedDigest, after.expectedDigest);
      points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    const row = data.summary.find(row => row.runtime === runtime && row.name === spec.name);
    assert.deepEqual(row.points, points);
    close(row.beforeMs, median(points.map(p => p.before))); close(row.afterMs, median(points.map(p => p.after)));
    const logs = points.map(p => Math.log(p.ratio)), mean = logs.reduce((sum, n) => sum + n, 0) / pairs;
    close(row.pairedRatio, Math.exp(mean));
    assert.equal(row.fasterPairs, points.filter(p => p.ratio < 1).length);
    const critical = { 4: 3.182446305284263, 6: 2.5705818356363155 }[pairs];
    if (critical) {
      const se = Math.sqrt(logs.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (pairs - 1) / pairs);
      close(row.interval95[0], Math.exp(mean - critical * se)); close(row.interval95[1], Math.exp(mean + critical * se));
    } else assert.equal(row.interval95, null);
  }
  processes += data.runs.length; measuredBatches += data.runs.length * samples;
  console.log(`Verified ${name}: ${data.runs.length} processes, ${data.summary.length} recomputed case/runtime estimates`);
}
console.log(`Verified ${files.length} studies, ${processes} processes and ${measuredBatches} measured batches; no retiming`);
