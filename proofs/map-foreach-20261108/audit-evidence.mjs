// Independent audit of saved evidence; never reruns or adjusts measurements.
// Usage: node audit-evidence.mjs [complete-study.json ...]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
};
const sorted = values => [...values].sort((a, b) => a - b);
const middle = values => {
  const ordered = sorted(values), low = Math.floor((ordered.length - 1) / 2), high = Math.floor(ordered.length / 2);
  return (ordered[low] + ordered[high]) / 2;
};
function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: finite values`);
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
}
function changed(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(name => left[name] !== right[name]).sort();
}
function repository(file) {
  let directory = dirname(resolve(file));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory); assert.notEqual(parent, directory, 'Repository package.json must exist');
    directory = parent;
  }
  return directory;
}
function recordedFile(root, record) {
  const marker = record.name.lastIndexOf('/proofs/');
  const file = marker >= 0 ? join(root, record.name.slice(marker + 1)) : record.name;
  assert.ok(existsSync(file), `Recorded source is missing: ${record.name}`);
  assert.equal(sha(readFileSync(file)), record.sha256, `Recorded source changed: ${record.name}`);
  return file;
}
function allocationProofs(root, data) {
  if (!['list-tree-set-20261108', 'list-tree-set-confirmation-20261108'].includes(data.study.id) || data.mode === 'aa') return null;
  const folder = join(root, 'proofs', 'list-tree-set-20261108');
  const rows = [];
  for (const runtime of ['node', 'bun']) for (const variant of ['before', 'after']) {
    const file = join(folder, `allocation-${variant}-${runtime}.json`);
    assert.ok(existsSync(file), `Allocation proof missing: ${file}`);
    const evidence = json(file);
    assert.equal(evidence.sourceSha256, data.source[variant].sources['persistent-core.as.ts']);
    assert.equal(Boolean(evidence.runtime.bun), runtime === 'bun');
    assert.equal(evidence.records.length, 4);
    const keys = new Set();
    for (const row of evidence.records) {
      assert.ok([1057, 65536].includes(row.count)); assert.equal(row.writes, 1024);
      assert.equal(typeof row.unchanged, 'boolean');
      const key = `${row.count}/${row.unchanged}`; assert.ok(!keys.has(key)); keys.add(key);
      let depth = 0, capacity = 32;
      const prefix = (row.count - 1) & ~31;
      while (prefix > capacity) { depth++; capacity *= 32; }
      const expectedPathBytes = 256 + 128 * depth;
      assert.equal(row.sourceDepth, depth); assert.equal(row.bytesPerChangedPath, expectedPathBytes);
      assert.equal(row.allocatedBytes, variant === 'after' && row.unchanged ? 0 : expectedPathBytes * 1024);
      assert.equal(row.sameRoot, variant === 'after' && row.unchanged);
      assert.equal(row.sameHandle, false);
      assert.equal(row.sourceAndCompleteResultValidated, true); assert.equal(row.allPublishedBytesPreserved, true);
      rows.push({ runtime, variant, count: row.count, unchanged: row.unchanged, allocatedBytes: row.allocatedBytes });
    }
  }
  const workerFile = join(folder, 'node-worker-result.json'), worker = json(workerFile);
  assert.equal(worker.source, data.source.after.sources['persistent-core.as.ts']);
  assert.equal(worker.wasm, data.source.after.wasm['persistent-core.wasm']);
  assert.deepEqual(worker.bundles, data.source.after.bundles);
  assert.equal(worker.driver, sha(readFileSync(join(folder, 'node-worker.mjs'))));
  assert.equal(worker.fixtures, sha(readFileSync(join(folder, 'worker-fixtures.mjs'))));
  assert.equal(worker.runtime.bun, undefined); assert.equal(worker.timingMeasurements, false);
  assert.deepEqual(worker.checks.map(check => check.transport), ['shared', 'copy']);
  for (const check of worker.checks) {
    assert.equal(check.first.ok, true); assert.equal(check.first.count, 32801); assert.equal(check.second.ok, true);
  }
  return { rows, nodeWorkers: 'shared and copied checks match the measured source and bundle hashes' };
}

function audit(file) {
  const data = json(file), root = repository(file);
  assert.equal(data.schema, 'zerocopy-paired-public-operation/v1'); assert.equal(data.status, 'complete');
  assert.match(data.study.baseline, /^[a-f0-9]{40}$/);
  const pairs = data.method.pairs, cases = data.method.cases;
  assert.equal(pairs, data.mode === 'formal' ? 6 : data.mode === 'aa' ? 4 : 2);
  assert.equal(data.method.samples, 9); assert.equal(data.method.minimumWarmupBatches, 8);
  assert.equal(data.method.minimumWarmupMs, data.mode === 'pilot' ? 150 : 500);
  assert.equal(new Set(cases.map(spec => spec.name)).size, cases.length);
  assert.deepEqual(Object.keys(data.method.runtimes), ['node', 'bun']);
  assert.equal(data.source.before.commit, data.study.baseline);
  assert.deepEqual(changed(data.source.before.sources, data.source.after.sources), data.mode === 'aa' ? [] : [...data.study.changedSources].sort());
  assert.deepEqual(changed(data.source.before.wasm, data.source.after.wasm), data.mode === 'aa' ? [] : [...(data.study.changedWasm ?? [])].sort());
  for (const variant of ['before', 'after']) for (const name of data.study.changedWasm ?? []) {
    assert.equal(data.source[variant].wasm[name], data.source[variant].wasm['persistent-core.wasm']);
  }
  assert.deepEqual(Object.keys(data.snapshots).sort(), [...data.study.changedSources].sort());
  for (const name of data.study.changedSources) {
    const baseline = execFileSync('git', ['-C', root, 'show', `${data.study.baseline}:${name}`]);
    assert.equal(sha(baseline), data.source.before.sources[name], `Baseline commit mismatch: ${name}`);
    for (const variant of ['before', 'after']) {
      assert.equal(sha(data.snapshots[name][variant]), data.source[variant].sources[name], `Snapshot mismatch: ${name}/${variant}`);
    }
  }
  recordedFile(root, data.driver);
  const workloadFile = recordedFile(root, data.workload);
  for (const support of data.study.supportFiles ?? []) {
    assert.equal(support.name, basename(support.name), 'Support filename must be local to the workload');
    assert.equal(sha(readFileSync(join(dirname(workloadFile), support.name))), support.sha256,
      `Pinned workload support changed: ${support.name}`);
  }

  // Verify the complete actual execution order, not just a before/after count.
  const expectedOrder = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const runtime of pair % 2 ? ['bun', 'node'] : ['node', 'bun']) {
      for (const spec of pair % 2 ? [...cases].reverse() : cases) {
        for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) expectedOrder.push({ pair, runtime, caseName: spec.name, variant });
      }
    }
  }
  assert.equal(data.runs.length, expectedOrder.length);
  let verifiedOutputs = 0, measuredBatches = 0, shortMeasuredBatches = 0;
  const lookup = new Map();
  for (let index = 0; index < data.runs.length; index++) {
    const run = data.runs[index], expected = expectedOrder[index];
    for (const [field, value] of Object.entries(expected)) assert.equal(run[field], value, `Run order ${index}/${field}`);
    const spec = cases.find(item => item.name === run.caseName);
    assert.deepEqual(run.spec, spec); assert.equal(run.affinity, data.host.affinity);
    assert.match(run.affinity, /^\d+$/); assert.match(run.expectedDigest, /^[a-f0-9]{64}$/);
    assert.equal(Boolean(run.versions.bun), run.runtime === 'bun');
    assert.equal(run.sampleBatchMs.length, 9); assert.ok(run.warmupBatchMs.length >= 8);
    const times = [...run.warmupBatchMs, ...run.sampleBatchMs];
    assert.ok(times.every(value => Number.isFinite(value) && value > 0));
    assert.ok(run.warmupBatchMs.reduce((sum, value) => sum + value, 0) >= data.method.minimumWarmupMs);
    near(run.medianMs, middle(run.sampleBatchMs) / spec.repetitions, `Median ${index}`);
    assert.equal(run.verifiedOutputs, (run.warmupBatchMs.length + 9) * spec.repetitions);
    near(run.batchTiming.minimumObservedMs, Math.min(...times), `Minimum ${index}`);
    near(run.batchTiming.minimumMeasuredMs, Math.min(...run.sampleBatchMs), `Measured minimum ${index}`);
    assert.equal(run.batchTiming.measuredBelow2ms, run.sampleBatchMs.filter(time => time < 2).length);
    assert.equal(run.batchTiming.warmupBelow2ms, run.warmupBatchMs.filter(time => time < 2).length);
    verifiedOutputs += run.verifiedOutputs; measuredBatches += 9; shortMeasuredBatches += run.batchTiming.measuredBelow2ms;
    const key = `${run.runtime}/${run.caseName}/${run.pair}/${run.variant}`;
    assert.ok(!lookup.has(key)); lookup.set(key, run);
  }

  const summary = [];
  for (const runtime of ['node', 'bun']) for (const spec of cases) {
    const points = [];
    for (let pair = 0; pair < pairs; pair++) {
      const before = lookup.get(`${runtime}/${spec.name}/${pair}/before`), after = lookup.get(`${runtime}/${spec.name}/${pair}/after`);
      assert.equal(before.expectedDigest, after.expectedDigest); assert.deepEqual(before.fixture, after.fixture);
      assert.deepEqual(before.versions, after.versions); assert.equal(before.affinity, after.affinity);
      points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    const logs = points.map(point => Math.log(point.ratio));
    const average = logs.reduce((sum, value) => sum + value, 0) / pairs;
    const pairedRatio = Math.exp(average);
    let interval95 = null;
    if (pairs > 2) {
      const critical = pairs === 6 ? 2.5705818356363155 : 3.182446305284263;
      const variance = logs.reduce((sum, value) => sum + (value - average) ** 2, 0) / (pairs - 1);
      const uncertainty = critical * Math.sqrt(variance / pairs);
      interval95 = [Math.exp(average - uncertainty), Math.exp(average + uncertainty)];
    }
    const calculated = { runtime, name: spec.name, role: spec.role,
      beforeMs: middle(points.map(point => point.before)), afterMs: middle(points.map(point => point.after)),
      pairedRatio, interval95, fasterPairs: points.filter(point => point.ratio < 1).length, points };
    const saved = data.summary.find(row => row.runtime === runtime && row.name === spec.name);
    assert.ok(saved); assert.equal(saved.role, calculated.role); assert.equal(saved.fasterPairs, calculated.fasterPairs);
    for (const field of ['beforeMs', 'afterMs', 'pairedRatio']) near(saved[field], calculated[field], `${runtime}/${spec.name}/${field}`);
    if (interval95) interval95.forEach((value, index) => near(saved.interval95[index], value, `${runtime}/${spec.name}/CI${index}`));
    else assert.equal(saved.interval95, null);
    assert.deepEqual(saved.points, points);
    summary.push(calculated);
  }
  assert.equal(data.summary.length, summary.length);
  return { file: basename(file), study: data.study.id, mode: data.mode, status: 'independently verified',
    processes: data.runs.length, measuredBatches, shortMeasuredBatches, verifiedOutputCount: verifiedOutputs,
    allocationAndWorkerProofs: allocationProofs(root, data), summary };
}

assert.ok(process.argv.length > 2, 'Supply one or more complete recorded study JSON files');
for (const file of process.argv.slice(2)) console.log(JSON.stringify(audit(resolve(file)), null, 2));
