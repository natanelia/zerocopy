import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = import.meta.dirname;
const BASE = '09b1a385a7c2ac9b027a4055335ae2f9449abe6e';
const CANDIDATE = 'fb3accc651323a85079a27d2c5dc4b953aa67db3';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const archives = JSON.parse(readFileSync(resolve(directory, 'archive-manifest.json'), 'utf8'));
assert.equal(archives.schema, 'zerocopy-block-callback-archives/v1');
assert.equal(archives.files.length, 4);
assert.equal(sha(readFileSync(import.meta.filename)), archives.verifierSha256);

let firstSource, firstPatch, formalPairs = 0, screenPairs = 0, measuredBatches = 0;
for (const archive of archives.files) {
  const compressed = readFileSync(resolve(directory, archive.path));
  assert.equal(compressed.length, archive.bytes); assert.equal(sha(compressed), archive.sha256);
  const plain = gunzipSync(compressed);
  assert.equal(plain.length, archive.originalBytes); assert.equal(sha(plain), archive.originalSha256);
  const record = JSON.parse(plain.toString('utf8'));
  const formal = record.schema === 'zerocopy-block-callback-study/v1';
  assert.ok(formal || record.schema === 'zerocopy-block-callback-screen/v1');
  const pairs = formal ? 6 : 2, samples = formal ? 9 : 7;
  assert.equal(record.status, 'complete'); assert.equal(record.method.pairs, pairs); assert.equal(record.method.samples, samples);
  assert.equal(record.cases.length, 10); assert.equal(record.summary.length, 10);
  assert.equal(record.pairs.length, 10 * pairs); assert.equal(record.calibrations.length, 20);
  assert.equal(record.hardware.affinity, 'Cpus_allowed_list:\t2');
  assert.equal(record.source.before.commit, BASE);
  assert.equal(record.source.after.commit, formal ? CANDIDATE : BASE);
  assert.equal(record.source.driver, sha(readFileSync(resolve(directory, formal ? 'benchmark.mjs' : 'screen.mjs'))));
  assert.deepEqual(Object.keys(record.source.before.files).filter(name => !name.startsWith('dist/')),
    Object.keys(record.source.after.files).filter(name => !name.startsWith('dist/')));
  for (const [name, hash] of Object.entries(record.source.before.files)) {
    if (name.startsWith('dist/') || ['arena.ts', 'shared-linked-list.ts', 'shared-doubly-linked-list.ts'].includes(name)) continue;
    assert.equal(record.source.after.files[name], hash, `Unrelated input changed: ${name}`);
  }
  if (firstSource) {
    assert.deepEqual(record.source.before.files, firstSource.before.files);
    assert.deepEqual(record.source.after.files, firstSource.after.files);
    assert.equal(record.candidatePatch, firstPatch);
  } else { firstSource = record.source; firstPatch = record.candidatePatch; }

  function checkSubject(subject, spec) {
    assert.equal(subject.name, spec.name); assert.equal(subject.runtime, record.selectedRuntime);
    assert.equal(subject.arch, 'x64'); assert.equal(subject.warmup.length, subject.warmupBatches);
    if (subject.runtime === 'node') assert.equal(subject.versions.node, '24.22.1');
    else assert.equal(subject.versions.bun, '1.4.2');
    near(subject.warmupTimedMs, subject.warmup.reduce((sum, row) => sum + row.ms, 0));
    near(subject.measuredTimedMs, subject.samples.reduce((sum, row) => sum + row.ms, 0));
    const allRows = [...subject.warmup, ...subject.samples, ...subject.calibration.flatMap(stage => stage.trials)];
    for (const row of allRows) {
      assert.ok(Number.isInteger(row.repeat) && row.repeat > 0 && row.repeat <= subject.cap);
      assert.ok(row.ms >= 0); near(row.msPerOperation, row.ms / row.repeat);
      assert.equal(row.checkedValues, row.repeat * spec.size);
      assert.equal(row.checkedIndices, ['forEach', 'forEachReverse'].includes(spec.operation) ? row.repeat * spec.size : 0);
      assert.equal(row.sharedAllocatedBytes, 0);
    }
    const trials = subject.mode === 'measure' ? subject.samples : subject.calibration.at(-1).trials;
    near(subject.medianMsPerOperation, median(trials.map(row => row.msPerOperation)));
    if (subject.mode === 'measure') {
      assert.equal(subject.samples.length, samples);
      for (const row of [...subject.warmup, ...subject.samples]) assert.equal(row.repeat, subject.repeat);
      if (formal) {
        assert.ok(subject.warmupBatches >= 8);
        assert.equal(subject.warmupTargetMet, subject.warmupTimedMs >= 500);
        assert.equal(subject.emptyWarmupCapHit, !spec.size && subject.warmupBatches === 256 && subject.warmupTimedMs < 500);
        if (spec.size) assert.ok(subject.warmupTargetMet);
        else assert.ok(subject.warmupBatches <= 256);
      }
    }
  }
  for (const calibration of record.calibrations) {
    const spec = record.cases.find(row => row.name === calibration.name); assert.ok(spec);
    for (const side of ['before', 'after']) {
      assert.equal(calibration[side].mode, calibration.stage);
      checkSubject(calibration[side], spec);
    }
    assert.equal(calibration.before.outputHash, calibration.after.outputHash);
    assert.equal(calibration.before.fixtureUsed, calibration.after.fixtureUsed);
  }
  for (const spec of record.cases) {
    const rows = record.pairs.filter(pair => pair.name === spec.name);
    assert.equal(rows.length, pairs); assert.deepEqual(rows.map(row => row.round), Array.from({ length: pairs }, (_, i) => i));
    const summary = record.summary.find(row => row.name === spec.name); assert.ok(summary);
    assert.equal(new Set(rows.map(pair => pair.before.repeat)).size, 1);
    const ratios = [];
    for (const pair of rows) {
      assert.deepEqual(pair.order, pair.round % 2 ? ['after', 'before'] : ['before', 'after']);
      assert.equal(pair.before.repeat, pair.after.repeat);
      assert.equal(pair.before.outputHash, pair.after.outputHash);
      assert.equal(pair.before.fixtureUsed, pair.after.fixtureUsed);
      for (const side of ['before', 'after']) { assert.equal(pair[side].mode, 'measure'); checkSubject(pair[side], spec); }
      ratios.push(pair.after.medianMsPerOperation / pair.before.medianMsPerOperation);
    }
    const logs = ratios.map(Math.log), mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    assert.deepEqual(summary.ratios, ratios); assert.deepEqual(summary.ratioRange, [Math.min(...ratios), Math.max(...ratios)]);
    near(summary.ratio, Math.exp(mean));
    near(summary.beforeMs, median(rows.map(row => row.before.medianMsPerOperation)));
    near(summary.afterMs, median(rows.map(row => row.after.medianMsPerOperation)));
    if (formal) {
      const se = Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pairs - 1) / pairs);
      const margin = 2.57058183564 * se;
      near(summary.ratioCI95[0], Math.exp(mean - margin)); near(summary.ratioCI95[1], Math.exp(mean + margin));
    }
  }
  if (formal) formalPairs += record.pairs.length; else screenPairs += record.pairs.length;
  measuredBatches += record.pairs.length * 2 * samples;
  console.log(`${archive.path}: archive hashes, all subjects, pairing, medians and summary estimates verified`);
}

// Optional: also compare every recorded source/bundle hash to existing builds.
const [beforeRoot, afterRoot] = process.argv.slice(2);
assert.ok((beforeRoot && afterRoot) || (!beforeRoot && !afterRoot), 'Provide both BEFORE and AFTER paths, or neither');
if (beforeRoot) for (const [side, root] of [['before', beforeRoot], ['after', afterRoot]]) {
  for (const [name, hash] of Object.entries(firstSource[side].files)) {
    assert.equal(sha(readFileSync(resolve(root, name))), hash, `${side} file differs: ${name}`);
  }
  console.log(`${side}: all ${Object.keys(firstSource[side].files).length} recorded source/bundle hashes match`);
}
console.log(JSON.stringify({ formalPairs, screenPairs, measuredBatches, allArchiveRoundTripsVerified: true }));
