import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Verify saved evidence, never require future production files to keep the
// measured hashes. Exact measured sources are retained as inert .txt archives.
const root = import.meta.dirname;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(resolve(root, name));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const near = (actual, expected, label) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
  && Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-10), `${label}: ${actual} != ${expected}`);
const identity = (bytes, expected, label) => {
  assert.equal(bytes.length, expected.bytes, `${label} length`);
  assert.equal(sha(bytes), expected.sha256, `${label} SHA-256`);
};
const CASES = ['map-unicode-short', 'map-unicode-medium', 'map-unicode-one', 'map-unicode-replace',
  'ordered-unicode-short', 'sorted-unicode-short', 'map-ascii-control', 'map-long-fitting-control',
  'map-oversized-control', 'map-json-control'];
const COUNTS = [1024, 256, 1, 1024, 1024, 1024, 1024, 16, 8, 256];
function validateBatches(value, batches, config) {
  const count = COUNTS[CASES.indexOf(value.name)];
  assert.equal(value.writesPerOperation, count);
  assert.equal(value.maxRepeat, Math.min(65536, Math.floor(131072 / count), Math.max(1, Math.floor(16777216 / value.estimatedAllocationBytes))));
  for (const row of batches) {
    assert.ok(Number.isInteger(row.repeat) && row.repeat >= 1 && row.repeat <= value.maxRepeat);
    assert.equal(row.verifiedCalls, row.repeat);
    assert.equal(row.verifiedElements, row.repeat * value.outputElements);
    assert.equal(row.verifiedWrites, row.repeat * count);
    assert.equal(row.verifiedBaseElements, value.baseElements);
    assert.ok(row.ms > 0);
    const stored = value.storageByRepeat[row.repeat]; assert.ok(stored);
    assert.equal(row.payloadSha256, stored.payloadSha256);
    assert.equal(row.descriptorSha256, stored.descriptorSha256);
    assert.equal(row.allocatedBytes, stored.allocatedBytes);
    assert.equal(row.capacityAfter, stored.capacityAfter);
    assert.equal(stored.allocatedBytes, stored.usedAfter - stored.usedBefore);
    assert.ok(stored.usedAfter <= stored.capacityAfter && stored.capacityAfter >= stored.capacityBefore);
    assert.ok(row.allocatedBytes <= config.maxAllocatedBytes);
  }
  const calls = batches.reduce((sum, row) => sum + row.repeat, 0);
  assert.equal(value.checkedCalls, calls);
  assert.equal(value.checkedElements, calls * value.outputElements);
  assert.equal(value.checkedWrites, calls * count);
  assert.equal(value.checkedBaseElements, batches.length * value.baseElements);
  assert.deepEqual(value.storage, value.storageByRepeat[value.repeat]);
  assert.equal(value.capped, value.repeat === value.maxRepeat);
}
const ledger = JSON.parse(read('evidence-manifest.json'));
assert.equal(ledger.schema, 1);
for (const [name, expected] of Object.entries(ledger.files)) identity(read(name), expected, name);

let totalSubjects = 0, totalBatches = 0, totalPairs = 0;
const studies = new Map();
for (const entry of ledger.studies) {
  const stored = read(entry.path), raw = entry.path.endsWith('.gz') ? gunzipSync(stored) : stored;
  identity(stored, entry.stored, entry.path); identity(raw, entry.raw, `${entry.path} raw`);
  const study = JSON.parse(raw);
  assert.equal(study.schema, 1); assert.equal(study.status, 'complete'); assert.equal(study.phase, entry.phase);
  assert.equal(study.source.baseline.commit, '77599337867dbf785a5f0311d34637d0b36678fc');
  const baselineBuild = JSON.parse(read('validation/baseline-build.json'));
  assert.equal(baselineBuild.base, study.source.baseline.commit);
  assert.deepEqual(baselineBuild.source, study.source.baseline.production);
  for (const [name, hash] of Object.entries(study.source.baseline.bundles)) assert.equal(baselineBuild.files[name], hash);
  assert.equal(study.source.candidate.commit, entry.measuredCommit);
  assert.equal(study.hardware.affinity, '2');
  assert.deepEqual(study.cases.map(row => row.name), CASES);
  assert.deepEqual(study.cases.map(row => row.count), COUNTS);
  assert.deepEqual(Object.keys(study.source.baseline.production), Object.keys(study.source.candidate.production));
  assert.deepEqual(study.source.baseline.support, study.source.candidate.support);
  assert.deepEqual(study.source.baseline.wasm, study.source.candidate.wasm);
  const changed = Object.keys(study.source.baseline.production)
    .filter(name => study.source.baseline.production[name] !== study.source.candidate.production[name]).sort();
  assert.deepEqual(changed, entry.changedProduction);
  for (const [name, path] of Object.entries(entry.sources)) {
    const category = name.endsWith('.test.ts') ? 'tests' : 'production';
    assert.equal(sha(read(path)), study.source.candidate[category][name], `Archived measured source: ${path}`);
  }
  for (const [name, path] of Object.entries(entry.drivers)) {
    assert.equal(sha(read(path)), study.source.driver[name], `Archived measured driver: ${path}`);
  }
  assert.deepEqual(Object.keys(entry.drivers).sort(), Object.keys(study.source.driver).sort());
  const config = study.config[study.phase], formal = study.phase === 'formal';
  assert.equal(config.pairs, formal ? 6 : 2); assert.equal(config.samples, formal ? 11 : 7);
  assert.equal(config.warmupMs, formal ? 500 : 150);
  assert.equal(study.config.minWarmupBatches, 8); assert.equal(study.config.maxAllocatedBytes, 16777216);
  assert.equal(study.config.maxRepeat, 65536); assert.equal(study.config.maxWrites, 131072);
  assert.equal(study.config.maxWarmupBatches, 1024);
  assert.equal(study.pairs.length, 2 * CASES.length * config.pairs);
  assert.equal(study.summary.length, 2 * CASES.length);
  assert.equal(study.plans.length, 2 * CASES.length);
  const expectedOrder = ['node', 'bun'].flatMap(runtime => Array.from({ length: config.pairs }, (_, pair) =>
    [...CASES.slice(pair % CASES.length), ...CASES.slice(0, pair % CASES.length)]
      .map(name => `${runtime}/${name}/${pair}`)).flat());
  assert.deepEqual(study.pairs.map(row => `${row.runtime}/${row.name}/${row.pair}`), expectedOrder);
  const subjects = [], sequences = new Set(), pairKeys = new Set();
  for (const pair of study.pairs) {
    const key = `${pair.runtime}/${pair.name}/${pair.pair}`;
    assert.ok(!pairKeys.has(key), `Duplicate pair ${key}`); pairKeys.add(key);
    assert.equal(pair.mode, 'ab'); assert.ok(['node', 'bun'].includes(pair.runtime));
    assert.ok(CASES.includes(pair.name)); assert.ok(pair.pair >= 0 && pair.pair < config.pairs);
    assert.deepEqual(pair.order, pair.pair % 2 ? ['after', 'before'] : ['before', 'after']);
    const plan = study.plans.find(row => row.runtime === pair.runtime && row.name === pair.name);
    assert.ok(plan);
    for (const side of ['before', 'after']) {
      const value = pair[side]; subjects.push(value);
      assert.ok(!sequences.has(value.sequence)); sequences.add(value.sequence);
      assert.equal(value.status, 'complete'); assert.equal(value.phase, 'measure');
      assert.equal(value.runtime, pair.runtime); assert.equal(value.name, pair.name);
      assert.equal(value.versions.node, pair.runtime === 'node' ? '24.22.1' : value.versions.node);
      if (pair.runtime === 'bun') assert.equal(value.versions.bun, '1.4.2');
      assert.equal(value.initialVerified, true); assert.equal(value.publishedBytesVerified, true);
      assert.equal(value.repeat, plan.repeat); assert.equal(value.expectedDigest, plan.expectedDigest);
      assert.deepEqual(value.initialStorage, plan.initialStorage);
      assert.ok(value.repeat >= 1 && value.repeat <= value.maxRepeat);
      assert.equal(value.samples.length, config.samples);
      assert.ok(value.warmup.length >= 8 && value.warmup.length <= 1024);
      const warmupMs = value.warmup.reduce((sum, row) => sum + row.ms, 0);
      const warmupCalls = value.warmup.reduce((sum, row) => sum + row.repeat, 0);
      near(warmupMs, value.warmupMs, `${key} warm-up duration`);
      assert.ok(warmupMs >= config.warmupMs); assert.equal(warmupCalls, value.warmupCalls);
      assert.deepEqual(value.storage, plan.storage);
      const batches = [...value.warmup, ...value.samples];
      for (const row of batches) {
        assert.equal(row.repeat, value.repeat); assert.equal(row.verifiedCalls, row.repeat);
        assert.equal(row.verifiedElements, row.repeat * value.outputElements); assert.ok(row.ms > 0);
      }
      validateBatches(value, batches, study.config);
      near(median(value.samples.map(row => row.ms / row.repeat)), value.medianMs, `${key} ${side} median`);
      near(Math.min(...value.samples.map(row => row.ms)), value.minBatchMs, `${key} minimum batch`);
      assert.equal(value.belowTargetBatches, value.samples.filter(row => row.ms < study.config.targetBatchMs).length);
      totalBatches += value.samples.length;
    }
    assert.equal(pair.before.repeat, pair.after.repeat);
    assert.deepEqual(pair.before.versions, pair.after.versions);
    assert.equal(pair[pair.order[1]].sequence, pair[pair.order[0]].sequence + 1);
    assert.equal(pair.before.expectedDigest, pair.after.expectedDigest);
    assert.deepEqual(pair.before.storage, pair.after.storage);
    assert.deepEqual(pair.before.initialStorage, pair.after.initialStorage);
  }
  for (const plan of study.plans) {
    assert.ok(['node', 'bun'].includes(plan.runtime) && CASES.includes(plan.name));
    assert.deepEqual(plan.order, CASES.indexOf(plan.name) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']);
    assert.deepEqual(Object.keys(plan.calibration), plan.order);
    for (const value of Object.values(plan.calibration)) {
      assert.ok(value.calibration.length >= 1 && value.calibration.length <= 12);
      for (const step of value.calibration) {
        assert.equal(step.trials.length, 3);
        for (const trial of step.trials) assert.equal(trial.repeat, step.repeat);
      }
      assert.equal(value.status, 'complete'); assert.equal(value.phase, 'calibrate');
      assert.equal(value.runtime, plan.runtime); assert.equal(value.name, plan.name);
      assert.equal(value.initialVerified, true); assert.equal(value.publishedBytesVerified, true);
      assert.equal(value.expectedDigest, plan.expectedDigest); assert.deepEqual(value.initialStorage, plan.initialStorage);
      assert.ok(value.warmupMs >= 150 && value.warmup.length >= 8 && value.warmup.length <= 1024);
      const batches = [...value.warmup, ...value.calibration.flatMap(row => row.trials)];
      for (const row of batches) {
        assert.equal(row.verifiedCalls, row.repeat); assert.equal(row.verifiedElements, row.repeat * value.outputElements);
        assert.ok(row.ms > 0);
      }
      validateBatches(value, batches, study.config);
      assert.equal(value.calibration.at(-1).repeat, value.repeat);
    }
    assert.equal(plan.repeat, Math.max(...Object.values(plan.calibration).map(row => row.repeat)));
    assert.deepEqual(plan.storage, Object.values(plan.calibration).find(row => row.repeat === plan.repeat).storage);
    for (const value of Object.values(plan.calibration)) {
      near(value.warmupMs, value.warmup.reduce((sum, row) => sum + row.ms, 0), 'Calibration warm-up');
      assert.equal(value.warmupCalls, value.warmup.reduce((sum, row) => sum + row.repeat, 0));
      near(value.minMsPerCall, Math.min(...value.calibration.at(-1).trials.map(row => row.ms / row.repeat)), 'Calibration final timing');
    }
  }
  for (const runtime of ['node', 'bun']) for (const name of CASES) {
    const pairs = study.pairs.filter(row => row.runtime === runtime && row.name === name);
    assert.equal(pairs.length, config.pairs);
    const summaries = study.summary.filter(row => row.runtime === runtime && row.name === name);
    assert.equal(summaries.length, 1); const summary = summaries[0];
    assert.equal(summary.pairs, config.pairs); assert.equal(summary.mode, 'ab');
    const ratios = pairs.map(pair => pair.after.medianMs / pair.before.medianMs), logs = ratios.map(Math.log);
    const mean = logs.reduce((sum, x) => sum + x, 0) / logs.length;
    near(summary.ratio, Math.exp(mean), `${runtime}/${name} paired ratio`);
    assert.equal(summary.pairRatios.length, config.pairs);
    ratios.forEach((ratio, index) => near(summary.pairRatios[index], ratio, `${runtime}/${name} pair ${index}`));
    near(summary.minRatio, Math.min(...ratios), `${name} min ratio`);
    near(summary.maxRatio, Math.max(...ratios), `${name} max ratio`);
    near(summary.beforeMedianMs, median(pairs.map(row => row.before.medianMs)), `${name} baseline median`);
    near(summary.afterMedianMs, median(pairs.map(row => row.after.medianMs)), `${name} candidate median`);
    if (formal) {
      const variance = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 5;
      const half = 2.570581835636314 * Math.sqrt(variance / 6);
      near(summary.lower95, Math.exp(mean - half), `${name} lower CI`);
      near(summary.upper95, Math.exp(mean + half), `${name} upper CI`);
      assert.equal(summary.degreesOfFreedom, 5);
    } else { assert.equal(summary.lower95, undefined); assert.equal(summary.upper95, undefined); }
  }
  studies.set(entry.id, study); totalSubjects += subjects.length; totalPairs += study.pairs.length;
  console.log(`${entry.id}: ${study.pairs.length} pairs, ${subjects.length} processes, ${study.summary.length} summary rows verified`);
}
for (const entry of ledger.studies.filter(row => row.phase === 'formal')) {
  const formal = studies.get(entry.id), pilot = studies.get(entry.pilot);
  assert.ok(pilot); assert.deepEqual(formal.source.driver, pilot.source.driver);
  for (const side of ['baseline', 'candidate']) for (const category of ['production', 'support', 'wasm', 'bundles']) {
    assert.deepEqual(formal.source[side][category], pilot.source[side][category]);
  }
  assert.deepEqual(formal.plans, pilot.plans); assert.deepEqual(formal.cases, pilot.cases);
  assert.deepEqual(formal.config, pilot.config);
  const pilotEntry = ledger.studies.find(row => row.id === entry.pilot);
  assert.equal(formal.pilotFile.sha256, pilotEntry.raw.sha256);
}
console.log(JSON.stringify({ status: 'passed', artifactFiles: Object.keys(ledger.files).length,
  studies: ledger.studies.length, processPairs: totalPairs, subjects: totalSubjects, measuredBatches: totalBatches }));
