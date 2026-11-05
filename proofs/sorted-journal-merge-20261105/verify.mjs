import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CONFIG } from './benchmark.mjs';
import { CASES } from './workloads.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const count = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);

function subject(record, measurement, plan) {
  assert.equal(record.status, 'complete');
  assert.equal(record.initialVerified, true);
  assert.equal(record.immutableBytesVerified, true);
  assert.ok(Number.isInteger(record.repeat) && record.repeat > 0 && record.repeat <= record.maxRepeat);
  assert.equal(record.capped, record.repeat === record.maxRepeat);
  assert.ok(record.warmup.length >= CONFIG.minWarmupBatches && record.warmup.length <= CONFIG.maxWarmupBatches);
  close(record.warmupMs, count(record.warmup, 'ms'));
  assert.equal(record.warmupCalls, count(record.warmup, 'repeat'));
  assert.ok(record.warmupMs >= measurement.warmupMs);
  assert.ok(record.warmupCalls * Math.max(1, record.outputElements) >= CONFIG.minWarmupElements);
  for (const row of [...record.warmup, ...record.calibration.flatMap(step => step.trials), ...record.samples]) {
    assert.ok(row.ms > 0 && Number.isInteger(row.repeat) && row.repeat > 0 && row.repeat <= record.maxRepeat);
    assert.equal(row.verifiedCalls, row.repeat);
    assert.equal(row.verifiedElements, row.repeat * record.outputElements);
  }
  const all = [...record.warmup, ...record.calibration.flatMap(step => step.trials), ...record.samples];
  assert.equal(record.checkedCalls, count(all, 'repeat'));
  assert.equal(record.checkedElements, record.checkedCalls * record.outputElements);
  if (record.phase === 'calibrate') {
    assert.equal(record.samples.length, 0);
    assert.ok(record.calibration.length > 0 && record.calibration.length <= CONFIG.maxCalibrationSteps);
    for (const step of record.calibration) {
      assert.equal(step.trials.length, 3);
      for (const row of step.trials) assert.equal(row.repeat, step.repeat);
    }
    assert.equal(record.calibration.at(-1).repeat, record.repeat);
    close(record.minMsPerCall, Math.min(...record.calibration.at(-1).trials.map(row => row.ms / row.repeat)));
  } else {
    assert.equal(record.phase, 'measure');
    assert.equal(record.calibration.length, 0);
    assert.equal(record.samples.length, measurement.samples);
    assert.equal(record.repeat, plan.repeat);
    for (const row of [...record.warmup, ...record.samples]) assert.equal(row.repeat, plan.repeat);
    close(record.medianMs, median(record.samples.map(row => row.ms / row.repeat)));
    close(record.minBatchMs, Math.min(...record.samples.map(row => row.ms)));
    assert.equal(record.belowTargetBatches, record.samples.filter(row => row.ms < CONFIG.targetBatchMs).length);
  }
  assert.equal(record.expectedDigest, plan.expectedDigest);
  assert.equal(record.arenaSha256, plan.arenaSha256);
}

function study(data) {
  assert.equal(data.schema, 1); assert.equal(data.status, 'complete');
  assert.ok(data.phase === 'pilot' || data.phase === 'formal');
  assert.equal(data.source.baseline.commit, '77599337867dbf785a5f0311d34637d0b36678fc');
  assert.equal(data.hardware.affinity, '2');
  assert.deepEqual(data.config, CONFIG); assert.deepEqual(data.cases, CASES);
  assert.deepEqual(data.source.baseline.support, data.source.candidate.support);
  assert.deepEqual(data.source.baseline.wasm, data.source.candidate.wasm);
  assert.deepEqual(Object.keys(data.source.baseline.production).filter(name => data.source.baseline.production[name] !== data.source.candidate.production[name]), ['arena.ts']);
  for (const [name, hash] of Object.entries(data.source.driver)) {
    assert.equal(sha(readFileSync(new URL(name, import.meta.url))), hash, `Driver differs: ${name}`);
  }
  const settings = CONFIG[data.phase], formal = data.phase === 'formal';
  assert.equal(data.plans.length, CASES.length * 2);
  assert.equal(data.pairs.length, CASES.length * 2 * settings.pairs + (formal ? CONFIG.aaCases.length * 2 * CONFIG.aaPairs : 0));
  assert.equal(data.summary.length, CASES.length * 2 + (formal ? CONFIG.aaCases.length * 2 : 0));
  const measured = data.pairs.flatMap(pair => pair.order.map(side => pair[side]));
  const sequences = [...measured, ...(formal ? [] : data.plans.flatMap(plan => Object.values(plan.calibration)))].map(row => row.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, i) => i));
  let checkedCalls = 0, checkedElements = 0;
  for (const runtime of ['node', 'bun']) for (const workload of CASES) {
    const plans = data.plans.filter(row => row.runtime === runtime && row.name === workload.name);
    assert.equal(plans.length, 1); const plan = plans[0];
    assert.deepEqual([...plan.order].sort(), ['baseline', 'candidate']);
    const shape = record => {
      assert.equal(record.shape.kind, workload.kind ?? 'sorted');
      assert.equal(record.shape.keyPrefixUtf8Bytes, workload.longPrefix ? 336 : 0);
      if (workload.kind !== 'map') {
        assert.equal(record.shape.pending, workload.pending);
        assert.equal(record.shape.rootTag === 0xffffffff, workload.pending > 0);
        assert.notEqual(record.shape.baseTag, 0xffffffff);
      }
      assert.equal(record.shape.size, workload.baseSize + (workload.changes === 'mixed' ? 2 : ['tail', 'front'].includes(workload.changes) ? 1 : 0));
    };
    for (const build of ['baseline', 'candidate']) {
      subject(plan.calibration[build], CONFIG.pilot, plan);
      shape(plan.calibration[build]);
      assert.equal(plan.calibration[build].runtime, runtime);
      assert.equal(plan.calibration[build].name, workload.name);
    }
    assert.equal(plan.repeat, Math.max(plan.calibration.baseline.repeat, plan.calibration.candidate.repeat));
    for (const mode of ['ab', 'aa-baseline']) {
      const pairs = data.pairs.filter(row => row.runtime === runtime && row.name === workload.name && row.mode === mode);
      const expected = mode === 'ab' ? settings.pairs : formal && CONFIG.aaCases.includes(workload.name) ? CONFIG.aaPairs : 0;
      assert.equal(pairs.length, expected);
      if (!expected) continue;
      assert.deepEqual(pairs.map(row => row.pair).sort((a, b) => a - b), Array.from({ length: expected }, (_, i) => i));
      for (const pair of pairs) {
        assert.deepEqual(pair.order, pair.pair % 2 ? ['after', 'before'] : ['before', 'after']);
        assert.equal(pair[pair.order[1]].sequence, pair[pair.order[0]].sequence + 1);
        for (const side of ['before', 'after']) {
          subject(pair[side], settings, plan);
          shape(pair[side]);
          assert.equal(pair[side].runtime, runtime); assert.equal(pair[side].name, workload.name);
          checkedCalls += pair[side].checkedCalls; checkedElements += pair[side].checkedElements;
        }
      }
      const summaries = data.summary.filter(row => row.runtime === runtime && row.name === workload.name && row.mode === mode);
      assert.equal(summaries.length, 1); const summary = summaries[0];
      const ratios = pairs.map(pair => pair.after.medianMs / pair.before.medianMs), logs = ratios.map(Math.log);
      const mean = logs.reduce((sum, x) => sum + x, 0) / logs.length;
      assert.equal(summary.pairs, expected);
      close(summary.beforeMedianMs, median(pairs.map(pair => pair.before.medianMs)));
      close(summary.afterMedianMs, median(pairs.map(pair => pair.after.medianMs)));
      close(summary.ratio, Math.exp(mean));
      assert.equal(summary.pairRatios.length, expected); ratios.forEach((ratio, i) => close(summary.pairRatios[i], ratio));
      close(summary.minRatio, Math.min(...ratios)); close(summary.maxRatio, Math.max(...ratios));
      if (formal) {
        const t = expected === 6 ? 2.570581835636314 : 3.182446305284263;
        const variance = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (expected - 1);
        const margin = t * Math.sqrt(variance / expected);
        assert.equal(summary.degreesOfFreedom, expected - 1);
        close(summary.lower95, Math.exp(mean - margin)); close(summary.upper95, Math.exp(mean + margin));
      }
    }
  }
  return { phase: data.phase, pairs: data.pairs.length, summaries: data.summary.length, checkedCalls, checkedElements };
}

const paths = process.argv.slice(2);
assert.ok(paths.length, 'Usage: node verify.mjs RAW.json[.gz] [...]');
const ledger = JSON.parse(readFileSync(new URL('evidence-manifest.json', import.meta.url)));
assert.equal(ledger.schema, 1);
for (const [path, identity] of Object.entries(ledger.files)) {
  const stored = readFileSync(new URL(path, import.meta.url));
  assert.equal(stored.byteLength, identity.bytes, `Stored byte count differs: ${path}`);
  assert.equal(sha(stored), identity.sha256, `Stored SHA-256 differs: ${path}`);
}
const archive = JSON.parse(readFileSync(new URL('archive-manifest.json', import.meta.url)));
assert.equal(archive.status, 'rejected');
for (const [path, identity] of Object.entries(archive.files)) {
  const content = readFileSync(new URL(path, import.meta.url));
  assert.equal(content.byteLength, identity.bytes);
  assert.equal(sha(content), identity.sha256);
}
const loaded = new Map();
for (const path of paths) {
  const stored = readFileSync(resolve(path)), raw = path.endsWith('.gz') ? gunzipSync(stored) : stored;
  const key = relative(import.meta.dirname, resolve(path)).split(sep).join('/');
  const identity = ledger.studies[key];
  assert.ok(identity, `Unrecorded study: ${key}`);
  assert.equal(stored.byteLength, identity.storedBytes);
  assert.equal(sha(stored), identity.storedSha256);
  assert.equal(raw.byteLength, identity.rawBytes);
  assert.equal(sha(raw), identity.rawSha256);
  const data = JSON.parse(raw);
  assert.equal(data.phase, identity.phase);
  assert.equal(data.source.candidate.commit, identity.candidateCommit);
  assert.equal(data.source.candidate.commit, archive.localMeasuredCommit);
  for (const identity of Object.values(archive.files)) {
    assert.equal(data.source.candidate[identity.manifestPart][identity.originalPath], identity.sha256);
  }
  assert.equal(data.pairs.length, identity.pairs);
  assert.equal(data.summary.length, identity.summaries);
  loaded.set(key, data);
  console.log(JSON.stringify({ path, rawBytes: raw.byteLength, rawSha256: sha(raw), ...study(data) }));
}
const pilot = loaded.get('results/pilot-01.json.gz'), formal = loaded.get('results/formal-01.json.gz');
if (pilot && formal) {
  assert.equal(formal.pilotFile.sha256, ledger.studies['results/pilot-01.json.gz'].rawSha256);
  assert.deepEqual(formal.plans, pilot.plans);
  assert.deepEqual(formal.source, pilot.source);
  console.log('Formal source identities and common repeat plans exactly match the recorded pilot.');
}
const focused = JSON.parse(readFileSync(new URL('results/focused-validation-01.json', import.meta.url)));
assert.equal(focused.status, 'passed');
assert.deepEqual(focused.tests, { files: 4, tests: 62, workerFiles: 1 });
assert.equal(sha(readFileSync(new URL(focused.log.path, import.meta.url))), focused.log.sha256);
for (const identity of Object.values(archive.files)) {
  if (Object.hasOwn(focused.files, identity.originalPath)) assert.equal(focused.files[identity.originalPath], identity.sha256);
}
console.log('Archived measured source and focused validation identities verified without pinning current runtime files.');
