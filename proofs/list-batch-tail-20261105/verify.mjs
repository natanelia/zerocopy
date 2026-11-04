import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const names = ['number/1', 'number/4', 'number/8', 'number/16', 'number/31', 'number/32', 'number/33',
  'number/interleaved', 'number/large', 'boolean/8', 'string/repeated', 'string/unique', 'object/8', 'number/forks'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length & 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
function near(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-11 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}
const files = process.argv.slice(2); assert.ok(files.length, 'Pass one or more completed formal JSON or JSON.gz files');
for (const file of files) {
  const saved = readFileSync(file), bytes = file.endsWith('.gz') ? gunzipSync(saved) : saved, r = JSON.parse(bytes);
  assert.equal(r.status, 'complete'); assert.equal(r.schema, 'zerocopy-list-batch-tail-study/v1');
  assert.equal(r.source.before.commit, '09b1a385a7c2ac9b027a4055335ae2f9449abe6e');
  assert.equal(r.source.after.commit, 'df43219addee389992b2551074927fa680b5922f');
  assert.equal(r.source.driver, hash(readFileSync(new URL('./benchmark.mjs', import.meta.url))));
  assert.deepEqual(r.cases.map(spec => spec.name), names);
  assert.equal(r.method.pairs, 8); assert.equal(r.method.samples, 9);
  assert.equal(r.pilots.length, 14); assert.equal(r.pairs.length, 112); assert.equal(r.summary.length, 14);
  for (const source of [r.source.before, r.source.after]) {
    assert.ok(source.files['dist/shared.js']);
    assert.ok(Object.keys(source.files).some(name => /^dist\/chunk-.*\.js$/.test(name)), 'Imported chunks must be hashed');
  }
  for (const name of ['arena.ts', 'persistent-core.as.ts']) {
    assert.equal(r.source.after.files[name], hash(readFileSync(new URL(`../../${name}`, import.meta.url))));
  }
  const subjects = [];
  for (const spec of r.cases) {
    const pilot = r.pilots.find(row => row.name === spec.name); assert.ok(pilot);
    assert.equal(pilot.runtime, r.selectedRuntime);
    const pairs = r.pairs.filter(row => row.name === spec.name); assert.equal(pairs.length, 8);
    assert.deepEqual(pairs.map(row => row.round).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
    const chunks = Math.ceil(spec.size / spec.batch);
    const first = Math.min(spec.size, spec.batch), middle = Math.min(spec.size, ((chunks >>> 1) + 1) * spec.batch);
    const checkedPerOperation = spec.forks ? 31 + 1024 * 32
      : spec.size + (first === spec.size ? 0 : first) + (middle === spec.size ? 0 : middle) + (spec.interleaved ? chunks : 0);
    for (const pair of pairs) {
      assert.equal(pair.runtime, r.selectedRuntime);
      assert.deepEqual(pair.order, pair.round & 1 ? ['after', 'before'] : ['before', 'after']);
      for (const side of ['before', 'after']) {
        const subject = pair[side]; subjects.push(subject);
        assert.equal(subject.runtime, r.selectedRuntime); assert.equal(subject.name, spec.name);
        assert.equal(subject.repeat, pilot.repeat); assert.equal(subject.warmupBatches, pilot.warmupBatches);
        assert.equal(subject.warmup.length, pilot.warmupBatches); assert.equal(subject.samples.length, 9);
        for (const batch of [...subject.warmup, ...subject.samples]) {
          assert.equal(batch.repeat, pilot.repeat); near(batch.msPerOperation, batch.ms / batch.repeat);
          assert.equal(batch.checkedValues, checkedPerOperation * batch.repeat);
          assert.ok(Number.isSafeInteger(batch.allocatedBytes) && batch.allocatedBytes > 0);
          assert.equal(batch.backingBytes % 65536, 0);
          assert.ok(batch.backingBytes >= 65536 + (spec.forks ? 31 * 8 : 0) + batch.allocatedBytes);
        }
        near(subject.warmupTimedMs, subject.warmup.reduce((sum, row) => sum + row.ms, 0));
        near(subject.measuredTimedMs, subject.samples.reduce((sum, row) => sum + row.ms, 0));
        near(subject.medianMsPerOperation, median(subject.samples.map(row => row.ms / row.repeat)));
        near(subject.medianSharedBytesPerOperation, median(subject.samples.map(row => row.allocatedBytes / row.repeat)));
      }
    }
    const summary = r.summary.find(row => row.name === spec.name); assert.ok(summary); assert.equal(summary.pairs, 8);
    const ratios = pairs.map(pair => pair.after.medianMsPerOperation / pair.before.medianMsPerOperation);
    ratios.forEach((ratio, i) => near(summary.ratios[i], ratio));
    const logs = ratios.map(Math.log), mean = logs.reduce((sum, value) => sum + value, 0) / 8;
    const deviation = Math.sqrt(logs.map(value => (value - mean) ** 2).reduce((sum, value) => sum + value, 0) / 7);
    const margin = 2.36462425101 * deviation / Math.sqrt(8);
    near(summary.ratio, Math.exp(mean)); near(summary.ratioCI95[0], Math.exp(mean - margin)); near(summary.ratioCI95[1], Math.exp(mean + margin));
    near(summary.beforeMs, median(pairs.map(pair => pair.before.medianMsPerOperation)));
    near(summary.afterMs, median(pairs.map(pair => pair.after.medianMsPerOperation)));
    near(summary.beforeSharedBytes, median(pairs.map(pair => pair.before.medianSharedBytesPerOperation)));
    near(summary.afterSharedBytes, median(pairs.map(pair => pair.after.medianSharedBytesPerOperation)));
  }
  console.log(JSON.stringify({ file, sha256: hash(bytes), bytes: bytes.length, runtime: r.selectedRuntime,
    checkedPairs: r.pairs.length, checkedSubjects: subjects.length, checkedMeasuredBatches: subjects.length * 9,
    warmupTimedMsRange: [Math.min(...subjects.map(row => row.warmupTimedMs)), Math.max(...subjects.map(row => row.warmupTimedMs))],
    measuredBatchMsRange: [Math.min(...subjects.flatMap(row => row.samples.map(batch => batch.ms))), Math.max(...subjects.flatMap(row => row.samples.map(batch => batch.ms)))] }));
}
