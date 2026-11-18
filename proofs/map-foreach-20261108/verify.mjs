import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const near = (actual, expected, name) => assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12,
  `${name}: ${actual} != ${expected}`);
const critical = { 4: 3.182446305284263, 6: 2.5705818356363155 };
const settings = { pilot: { pairs: 2, warmup: 150 }, formal: { pairs: 6, warmup: 500 }, aa: { pairs: 4, warmup: 500 } };
const standard = ['pilot-v1.json.gz', 'pilot-v2.json.gz', 'confirmation-v2.json.gz', 'aa-v2.json.gz'];
const files = process.argv.slice(2).length ? process.argv.slice(2) : standard.map(name => join(here, 'results', name));
let processes = 0, batches = 0;
for (const filename of files) {
  assert.ok(existsSync(filename), `Missing recorded study: ${filename}`);
  const stored = readFileSync(filename);
  const raw = filename.endsWith('.gz') ? gunzipSync(stored) : stored;
  const manifestFile = join(dirname(filename), 'manifest.json');
  if (existsSync(manifestFile)) {
    const record = JSON.parse(readFileSync(manifestFile, 'utf8'))[basename(filename)];
    if (record) {
      assert.equal(digest(stored), record.sha256);
      assert.equal(digest(raw), record.uncompressedSha256);
      assert.equal(raw.length, record.uncompressedBytes);
    }
  }
  const data = JSON.parse(raw.toString('utf8'));
  assert.equal(data.schema, 'zerocopy-paired-public-operation/v1');
  assert.equal(data.status, 'complete');
  assert.equal(data.study.id, 'map-foreach-20261108');
  assert.equal(data.study.baseline, '0ac8a005268335a6116f025e75f670b5cee6843e');
  assert.equal(data.source.before.commit, data.study.baseline);
  const config = settings[data.mode]; assert.ok(config);
  assert.equal(data.method.pairs, config.pairs);
  assert.equal(data.method.minimumWarmupMs, config.warmup);
  assert.equal(data.method.minimumWarmupBatches, 8);
  assert.equal(data.method.samples, 9);
  assert.deepEqual(data.study.changedSources, ['shared-map.ts']);
  const changed = [...new Set([...Object.keys(data.source.before.sources), ...Object.keys(data.source.after.sources)])]
    .filter(name => data.source.before.sources[name] !== data.source.after.sources[name]).sort();
  assert.deepEqual(changed, data.mode === 'aa' ? [] : ['shared-map.ts']);
  assert.deepEqual(data.source.before.wasm, data.source.after.wasm);
  for (const variant of ['before', 'after']) {
    assert.equal(digest(data.snapshots['shared-map.ts'][variant]), data.source[variant].sources['shared-map.ts']);
  }
  assert.equal(data.driver.sha256, digest(readFileSync(join(here, 'archive/paired-benchmark.mjs.txt'))));
  assert.equal(data.workload.sha256, digest(readFileSync(join(here, 'archive/workloads.mjs.txt'))));
  // Archive verification remains valid after later legitimate source changes.
  // Enable this extra check when reproducing the exact candidate in this PR.
  if (process.env.CHECK_CONFIRMED_SOURCE === '1' && data.mode === 'formal') assert.equal(data.source.after.sources['shared-map.ts'], digest(readFileSync(join(here, '../../shared-map.ts'))),
    'The confirmed production source must be the current source');
  const selected = data.mode === 'aa' ? data.study.aaCases : data.mode === 'pilot' ? data.study.pilotCases : null;
  const specs = selected ? data.study.cases.filter(spec => selected.includes(spec.name)) : data.study.cases;
  assert.deepEqual(data.method.cases, specs);
  const scheduled = [];
  for (let pair = 0; pair < config.pairs; pair++) {
    for (const runtime of pair % 2 ? ['bun', 'node'] : ['node', 'bun']) {
      for (const spec of pair % 2 ? [...specs].reverse() : specs) {
        for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
          scheduled.push({ pair, runtime, variant, caseName: spec.name });
        }
      }
    }
  }
  assert.equal(data.runs.length, scheduled.length);
  for (let i = 0; i < data.runs.length; i++) {
    const run = data.runs[i];
    assert.deepEqual({ pair: run.pair, runtime: run.runtime, variant: run.variant, caseName: run.caseName }, scheduled[i]);
    const spec = specs.find(spec => spec.name === run.caseName);
    assert.deepEqual(run.spec, spec);
    assert.equal(run.affinity, data.host.affinity);
    assert.equal(run.sampleBatchMs.length, 9);
    assert.ok(run.warmupBatchMs.length >= 8);
    assert.ok(run.warmupBatchMs.reduce((sum, value) => sum + value, 0) >= config.warmup);
    for (const elapsed of [...run.warmupBatchMs, ...run.sampleBatchMs]) assert.ok(Number.isFinite(elapsed) && elapsed > 0);
    near(run.medianMs, median(run.sampleBatchMs) / spec.repetitions, 'Process median');
    assert.equal(run.verifiedOutputs, (run.warmupBatchMs.length + 9) * spec.repetitions);
    assert.equal(run.batchTiming.measuredBelow2ms, run.sampleBatchMs.filter(value => value < 2).length);
    assert.equal(run.batchTiming.warmupBelow2ms, run.warmupBatchMs.filter(value => value < 2).length);
    near(run.batchTiming.minimumObservedMs, Math.min(...run.warmupBatchMs, ...run.sampleBatchMs), 'Shortest batch');
    near(run.batchTiming.minimumMeasuredMs, Math.min(...run.sampleBatchMs), 'Shortest measured batch');
    assert.match(run.expectedDigest, /^[a-f0-9]{64}$/);
  }
  assert.equal(data.summary.length, specs.length * 2);
  for (const runtime of ['node', 'bun']) for (const spec of specs) {
    const row = data.summary.find(row => row.runtime === runtime && row.name === spec.name);
    assert.ok(row);
    const points = [];
    for (let pair = 0; pair < config.pairs; pair++) {
      const matching = data.runs.filter(run => run.runtime === runtime && run.caseName === spec.name && run.pair === pair);
      const before = matching.find(run => run.variant === 'before'), after = matching.find(run => run.variant === 'after');
      assert.equal(matching.length, 2);
      assert.equal(before.expectedDigest, after.expectedDigest);
      assert.deepEqual(before.versions, after.versions);
      assert.deepEqual(before.fixture, after.fixture);
      points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    assert.deepEqual(row.points, points);
    assert.equal(row.fasterPairs, points.filter(point => point.ratio < 1).length);
    assert.equal(row.role, spec.role);
    near(row.beforeMs, median(points.map(point => point.before)), 'Before median');
    near(row.afterMs, median(points.map(point => point.after)), 'After median');
    const logs = points.map(point => Math.log(point.ratio)), mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    near(row.pairedRatio, Math.exp(mean), 'Paired geometric ratio');
    if (critical[points.length]) {
      const se = Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logs.length - 1) / logs.length);
      assert.equal(row.interval95.length, 2);
      near(row.interval95[0], Math.exp(mean - critical[points.length] * se), 'Lower interval');
      near(row.interval95[1], Math.exp(mean + critical[points.length] * se), 'Upper interval');
    } else assert.equal(row.interval95, null);
  }
  processes += data.runs.length; batches += data.runs.length * 9;
  console.log(`Verified ${filename}: ${data.runs.length} fresh processes, exact source snapshots, all batches and paired calculations`);
}
console.log(`Verified ${files.length} studies, ${processes} fresh processes and ${batches} measured batches; no timing samples removed or adjusted.`);
