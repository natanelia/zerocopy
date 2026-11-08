// Independent audit of saved evidence; never runs or adjusts measurements.
// Usage: node audit-evidence.mjs complete-study.json[.gz] [...]
// CHECK_CONFIRMED_SOURCE=1 also binds the formal record to both current sources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const STUDY = 'map-foreach-early-identity-20261108';
const BASELINE = '0ac8a005268335a6116f025e75f670b5cee6843e';
const SOURCES = ['arena.ts', 'shared-map.ts'];
const CASES = [
  { name: 'number-4096', role: 'target', type: 'number', size: 4096, repetitions: 64 },
  { name: 'number-65536', role: 'target', type: 'number', size: 65536, repetitions: 8 },
  { name: 'number-overlay-4096', role: 'target', type: 'number', size: 4096, repetitions: 64, overlay: true },
  { name: 'number-64', role: 'small-map control', type: 'number', size: 64, repetitions: 2048 },
  { name: 'boolean-4096', role: 'type control', type: 'boolean', size: 4096, repetitions: 64 },
  { name: 'string-1024', role: 'type control', type: 'string', size: 1024, repetitions: 128 },
  { name: 'json-256', role: 'type control', type: 'object', size: 256, repetitions: 256 },
  { name: 'unicode-4096', role: 'key control', type: 'number', size: 4096, repetitions: 64, unicode: true },
  { name: 'entries-4096', role: 'unchanged-method control', type: 'number', size: 4096, repetitions: 64, operation: 'entries' },
  { name: 'get-4096', role: 'unchanged-method control', type: 'number', size: 4096, repetitions: 128, operation: 'get' },
];
const AA_NAMES = ['number-4096', 'string-1024', 'entries-4096', 'get-4096'];
const PAIRS = { formal: 6, aa: 4 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
};
function middle(values) {
  assert.ok(values.length > 0);
  const ordered = [...values].sort((a, b) => a - b);
  return (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2;
}
function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: finite values`);
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} != ${expected}`);
}
function changed(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(name => left[name] !== right[name]).sort();
}
function repository(file) {
  let directory = dirname(resolve(file));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    assert.notEqual(parent, directory, 'Repository package.json must exist');
    directory = parent;
  }
  return directory;
}
function recordedFile(root, record, expectedName) {
  assert.equal(typeof record.name, 'string'); assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const marker = record.name.lastIndexOf('/proofs/');
  const file = marker >= 0 ? join(root, record.name.slice(marker + 1)) : resolve(root, record.name);
  assert.equal(file, join(root, 'proofs', STUDY, expectedName), 'Use this study’s frozen proof source');
  assert.equal(sha(readFileSync(file)), record.sha256, `Recorded source changed: ${record.name}`);
  return file;
}
function manifest(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.ok(Object.keys(value).length > 0, `${label}: nonempty`);
  for (const [name, digest] of Object.entries(value)) {
    assert.ok(name && !name.startsWith('/') && !name.split('/').includes('..'), `${label}: relative file`);
    assert.match(digest, /^[a-f0-9]{64}$/, `${label}/${name}`);
  }
}
const baselineTrees = new Map(), baselineFiles = new Map();
function baselineNames(root) {
  if (!baselineTrees.has(root)) {
    baselineTrees.set(root, new Set(execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', BASELINE],
      { encoding: 'utf8' }).trim().split('\n')));
  }
  return baselineTrees.get(root);
}
function baselineFile(root, name) {
  assert.ok(baselineNames(root).has(name), `Source must exist in the pinned baseline: ${name}`);
  const key = `${root}\0${name}`;
  if (!baselineFiles.has(key)) {
    baselineFiles.set(key, execFileSync('git', ['-C', root, 'show', `${BASELINE}:${name}`]));
  }
  return baselineFiles.get(key);
}
function sourceProof(root, data) {
  assert.deepEqual(Object.keys(data.source).sort(), ['after', 'before']);
  const before = data.source.before, after = data.source.after;
  assert.equal(before.commit, BASELINE);
  for (const [variant, record] of Object.entries(data.source)) {
    assert.match(record.commit, /^[a-f0-9]{40}$/);
    assert.equal(typeof record.root, 'string');
    for (const key of ['sources', 'wasm', 'bundles']) manifest(record[key], `${variant}/${key}`);
  }
  const expectedSources = [...baselineNames(root)].filter(name => !name.includes('/') &&
    ((name.endsWith('.ts') && !name.endsWith('.test.ts')) || /^tsconfig.*\.json$/.test(name)));
  expectedSources.push('package.json', 'scripts/build-browser.ts', 'scripts/build-wasm.mjs');
  assert.deepEqual(Object.keys(before.sources).sort(), expectedSources.sort(), 'Complete baseline source manifest');
  assert.deepEqual(Object.keys(after.sources).sort(), Object.keys(before.sources).sort());
  assert.deepEqual(changed(before.sources, after.sources), data.mode === 'aa' ? [] : SOURCES);
  assert.deepEqual(before.wasm, after.wasm, 'Every recorded WASM binary remains unchanged');
  assert.ok(Object.hasOwn(before.wasm, 'persistent-core.wasm'));
  if (data.mode === 'aa') assert.deepEqual(before, after, 'A/A must use the identical baseline build');
  for (const [name, digest] of Object.entries(before.sources)) {
    assert.equal(sha(baselineFile(root, name)), digest, `Baseline commit mismatch: ${name}`);
  }
  assert.deepEqual(Object.keys(data.snapshots).sort(), SOURCES);
  for (const name of SOURCES) {
    assert.deepEqual(Object.keys(data.snapshots[name]).sort(), ['after', 'before']);
    for (const variant of ['before', 'after']) {
      const snapshot = data.snapshots[name][variant];
      assert.equal(typeof snapshot, 'string');
      assert.equal(sha(snapshot), data.source[variant].sources[name], `Snapshot mismatch: ${name}/${variant}`);
    }
    if (process.env.CHECK_CONFIRMED_SOURCE === '1' && data.mode === 'formal') {
      assert.equal(sha(readFileSync(join(root, name))), after.sources[name], `Current measured source changed: ${name}`);
    }
  }
}
function workerProof(root, data) {
  if (data.mode === 'aa') return null;
  const folder = join(root, 'proofs', STUDY), workerFile = 'node-worker-result.json';
  const worker = json(join(folder, workerFile));
  assert.deepEqual(worker.sources, Object.fromEntries(SOURCES.map(name => [name, data.source.after.sources[name]])));
  assert.deepEqual(worker.wasm, data.source.after.wasm);
  assert.deepEqual(worker.bundles, data.source.after.bundles);
  assert.equal(worker.driver, sha(readFileSync(join(folder, 'node-worker.mjs'))));
  assert.equal(worker.fixtures, sha(readFileSync(join(folder, 'worker-fixtures.mjs'))));
  assert.equal(typeof worker.runtime.node, 'string'); assert.equal(worker.runtime.bun, undefined);
  assert.equal(worker.timingMeasurements, false); date(worker.date, 'Worker completion');
  assert.deepEqual(worker.checks.map(check => check.transport), ['shared', 'copy']);
  for (const check of worker.checks) {
    assert.equal(check.first.type, 'scanned'); assert.equal(check.first.ok, true); assert.equal(check.first.count, 1067);
    assert.equal(check.second.type, 'complete'); assert.equal(check.second.ok, true);
    assert.deepEqual(check.second.checked, ['retained-snapshot', 'new-root-after-growth', 'read-only', 'all-value-types', 'published-bytes']);
  }
  assert.deepEqual(worker.writer.checks, ['callback-growth', 'forks', 'reentrancy', 'special-values', 'original-byte-immutability']);
  return { file: workerFile, sources: worker.sources,
    checked: 'Actual shared and copied Node workers bound to both measured sources, every WASM binary, every bundle and proof scripts' };
}
function date(value, label) {
  assert.equal(typeof value, 'string', label);
  const result = Date.parse(value); assert.ok(Number.isFinite(result), label); return result;
}

async function audit(file) {
  const data = json(file), root = repository(file);
  assert.equal(data.schema, 'zerocopy-paired-public-operation/v1'); assert.equal(data.status, 'complete');
  assert.equal(data.study.id, STUDY); assert.equal(data.study.baseline, BASELINE);
  assert.ok(Object.hasOwn(PAIRS, data.mode), 'Only formal and A/A studies were declared');
  assert.equal(Object.hasOwn(data, 'failure'), false); assert.equal(Object.hasOwn(data, 'error'), false);
  assert.deepEqual(data.study.changedSources, SOURCES); assert.deepEqual(data.study.changedWasm, []);
  assert.deepEqual(data.study.cases, CASES); assert.deepEqual(data.study.aaCases, AA_NAMES);
  assert.deepEqual(data.study.pilotCases, []);
  sourceProof(root, data);
  recordedFile(root, data.driver, 'paired-benchmark.mjs');
  const workloadFile = recordedFile(root, data.workload, 'workloads.mjs');
  const { study } = await import(pathToFileURL(workloadFile));
  assert.deepEqual(data.study, study, 'Recorded study must match its frozen workload');
  for (const support of study.supportFiles ?? []) {
    assert.equal(support.name, basename(support.name));
    assert.equal(sha(readFileSync(join(dirname(workloadFile), support.name))), support.sha256);
  }
  const pairs = data.method.pairs, cases = data.method.cases;
  assert.deepEqual(cases, data.mode === 'aa' ? CASES.filter(spec => AA_NAMES.includes(spec.name)) : CASES);
  assert.equal(pairs, PAIRS[data.mode]); assert.equal(data.method.samples, 9);
  assert.equal(data.method.minimumWarmupBatches, 8); assert.equal(data.method.minimumWarmupMs, 500);
  assert.equal(data.method.lock, '/tmp/zerocopy-perf-20261108.lock');
  assert.deepEqual(Object.keys(data.method.runtimes), ['node', 'bun']);
  assert.equal(data.host.affinity, '2', 'The declared study is pinned to CPU 2');
  const started = date(data.startedAt, 'Study start'), completed = date(data.completedAt, 'Study end');
  assert.ok(completed >= started);

  const scheduled = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const runtime of pair % 2 ? ['bun', 'node'] : ['node', 'bun']) {
      for (const spec of pair % 2 ? [...cases].reverse() : cases) {
        for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
          scheduled.push({ pair, runtime, caseName: spec.name, variant });
        }
      }
    }
  }
  assert.equal(data.runs.length, scheduled.length);
  let verifiedOutputs = 0, measuredOutputs = 0, measuredBatches = 0, warmupBatches = 0;
  let shortMeasuredBatches = 0, previousEnd = started;
  const lookup = new Map(), runtimeIdentities = new Map(), fixtures = new Map();
  for (let index = 0; index < data.runs.length; index++) {
    const run = data.runs[index], expected = scheduled[index];
    for (const [field, value] of Object.entries(expected)) assert.equal(run[field], value, `Run order ${index}/${field}`);
    const spec = cases.find(item => item.name === run.caseName);
    assert.deepEqual(run.spec, spec); assert.equal(run.affinity, data.host.affinity);
    assert.match(run.expectedDigest, /^[a-f0-9]{64}$/);
    assert.equal(Boolean(run.versions.bun), run.runtime === 'bun');
    assert.equal(typeof run.versions.node, 'string'); assert.equal(typeof run.executable, 'string');
    const identity = { versions: run.versions, executable: run.executable };
    if (runtimeIdentities.has(run.runtime)) assert.deepEqual(identity, runtimeIdentities.get(run.runtime));
    else runtimeIdentities.set(run.runtime, identity);
    const fixture = { fixture: run.fixture, expectedDigest: run.expectedDigest };
    if (fixtures.has(spec.name)) assert.deepEqual(fixture, fixtures.get(spec.name));
    else fixtures.set(spec.name, fixture);
    assert.deepEqual(run.fixture, { size: spec.size, type: spec.type, operation: spec.operation ?? 'forEach',
      overlay: Boolean(spec.overlay), unicode: Boolean(spec.unicode) });
    const runStart = date(run.startedAt, `Run ${index} start`), runEnd = date(run.completedAt, `Run ${index} end`);
    assert.ok(runStart >= previousEnd && runEnd >= runStart && runEnd <= completed, `Run ${index} chronology`);
    previousEnd = runEnd;
    assert.equal(run.sampleBatchMs.length, 9); assert.ok(run.warmupBatchMs.length >= 8);
    const times = [...run.warmupBatchMs, ...run.sampleBatchMs];
    assert.ok(times.every(value => Number.isFinite(value) && value > 0));
    assert.ok(run.warmupBatchMs.reduce((sum, value) => sum + value, 0) >= 500);
    const medianMs = middle(run.sampleBatchMs) / spec.repetitions;
    near(run.medianMs, medianMs, `Median ${index}`);
    assert.equal(run.verifiedOutputs, (run.warmupBatchMs.length + 9) * spec.repetitions);
    near(run.batchTiming.minimumObservedMs, Math.min(...times), `Minimum ${index}`);
    near(run.batchTiming.minimumMeasuredMs, Math.min(...run.sampleBatchMs), `Measured minimum ${index}`);
    assert.equal(run.batchTiming.measuredBelow2ms, run.sampleBatchMs.filter(time => time < 2).length);
    assert.equal(run.batchTiming.warmupBelow2ms, run.warmupBatchMs.filter(time => time < 2).length);
    verifiedOutputs += run.verifiedOutputs; measuredOutputs += 9 * spec.repetitions;
    measuredBatches += 9; warmupBatches += run.warmupBatchMs.length;
    shortMeasuredBatches += run.batchTiming.measuredBelow2ms;
    const key = `${run.runtime}/${run.caseName}/${run.pair}/${run.variant}`;
    assert.ok(!lookup.has(key)); lookup.set(key, { run, medianMs });
  }

  const summary = [];
  assert.equal(new Set(data.summary.map(row => `${row.runtime}/${row.name}`)).size, data.summary.length);
  for (const runtime of ['node', 'bun']) for (const spec of cases) {
    const points = [];
    for (let pair = 0; pair < pairs; pair++) {
      const before = lookup.get(`${runtime}/${spec.name}/${pair}/before`), after = lookup.get(`${runtime}/${spec.name}/${pair}/after`);
      assert.equal(before.run.expectedDigest, after.run.expectedDigest); assert.deepEqual(before.run.fixture, after.run.fixture);
      assert.deepEqual(before.run.versions, after.run.versions); assert.equal(before.run.affinity, after.run.affinity);
      points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    const logs = points.map(point => Math.log(point.ratio)), average = logs.reduce((sum, value) => sum + value, 0) / pairs;
    const critical = pairs === 6 ? 2.5705818356363155 : 3.182446305284263;
    const variance = logs.reduce((sum, value) => sum + (value - average) ** 2, 0) / (pairs - 1);
    const uncertainty = critical * Math.sqrt(variance / pairs);
    const interval95 = [Math.exp(average - uncertainty), Math.exp(average + uncertainty)];
    const calculated = { runtime, name: spec.name, role: spec.role,
      beforeMs: middle(points.map(point => point.before)), afterMs: middle(points.map(point => point.after)),
      pairedRatio: Math.exp(average), interval95, fasterPairs: points.filter(point => point.ratio < 1).length, points };
    const saved = data.summary.find(row => row.runtime === runtime && row.name === spec.name);
    assert.ok(saved); assert.equal(saved.role, calculated.role); assert.equal(saved.fasterPairs, calculated.fasterPairs);
    for (const field of ['beforeMs', 'afterMs', 'pairedRatio']) near(saved[field], calculated[field], `${runtime}/${spec.name}/${field}`);
    assert.equal(saved.interval95.length, 2);
    interval95.forEach((value, index) => near(saved.interval95[index], value, `${runtime}/${spec.name}/CI${index}`));
    assert.equal(saved.points.length, points.length);
    for (let index = 0; index < points.length; index++) {
      assert.equal(saved.points[index].pair, index);
      for (const key of ['before', 'after', 'ratio']) near(saved.points[index][key], points[index][key], `${runtime}/${spec.name}/point${index}/${key}`);
    }
    summary.push(calculated);
  }
  assert.equal(data.summary.length, summary.length);
  return { file: basename(file), study: STUDY, mode: data.mode, status: 'independently verified',
    currentSourcesChecked: process.env.CHECK_CONFIRMED_SOURCE === '1' && data.mode === 'formal',
    sourceScope: 'Both arena.ts and shared-map.ts snapshots are bound to the measured build; all baseline sources match the pinned Git commit',
    comparison: data.mode === 'aa' ? 'Baseline repeated against itself; not subtracted from or pooled with A/B' :
      'Complete public Map operations on the frozen baseline and corrected candidate',
    verificationScope: 'Every timed return value and complete key/value/order plus published-byte invariants after every batch',
    processes: data.runs.length, measuredBatches, warmupBatches, shortMeasuredBatches,
    measuredOutputCount: measuredOutputs, verifiedOutputCount: verifiedOutputs,
    workerProof: workerProof(root, data), summary };
}

assert.ok(process.argv.length > 2, 'Supply one or more complete recorded study JSON or JSON.gz files');
for (const file of process.argv.slice(2)) console.log(JSON.stringify(await audit(resolve(file)), null, 2));
