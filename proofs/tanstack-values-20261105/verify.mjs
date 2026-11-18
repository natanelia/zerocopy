import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [path, beforeRoot, afterRoot] = process.argv.slice(2);
assert.ok(path, 'Usage: node verify.mjs RECORD.json[.gz] [BEFORE_ROOT AFTER_ROOT]');
const bytes = readFileSync(path), raw = path.endsWith('.gz') ? gunzipSync(bytes) : bytes;
const data = JSON.parse(raw), hash = value => createHash('sha256').update(value).digest('hex');
const close = (a, b, label) => assert.ok(Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b)), `${label}: ${a} != ${b}`);
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = sorted.length / 2; return Number.isInteger(middle) ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.floor(middle)]; };
assert.equal(data.status, 'complete');
assert.equal(data.schema, 'zerocopy-tanstack-values-study/v1');
assert.equal(data.source.before.commit, '09b1a385a7c2ac9b027a4055335ae2f9449abe6e');
assert.equal(data.settings.samples, 9);
assert.equal(data.settings.pairs, data.mode === 'formal' ? 6 : 2);
assert.equal(data.pairs.length, data.settings.pairs * data.cases.length * 2);
assert.equal(data.calibration.length, data.cases.length * 2);
assert.equal(data.summary.length, data.cases.length * 2);
assert.equal(hash(readFileSync(new URL('./benchmark.mjs', import.meta.url))), data.source.driver);
assert.equal(hash(readFileSync(new URL('./fixtures.mjs', import.meta.url))), data.source.fixtures);
const seen = new Set(), warmupTotals = [], measuredBatches = [];
for (const pair of data.pairs) {
  const id = `${pair.runtime}/${pair.name}/${pair.round}`; assert.ok(!seen.has(id)); seen.add(id);
  assert.ok(['node', 'bun'].includes(pair.runtime));
  assert.ok(Number.isInteger(pair.round) && pair.round >= 0 && pair.round < data.settings.pairs);
  assert.deepEqual(pair.order, pair.round % 2 ? ['after', 'before'] : ['before', 'after']);
  const spec = data.cases.find(value => value.name === pair.name); assert.ok(spec);
  assert.equal(pair.before.keysHash, pair.after.keysHash); assert.equal(pair.before.oracleHash, pair.after.oracleHash);
  assert.equal(pair.before.sharedUsed, pair.after.sharedUsed); assert.equal(pair.before.backingBytes, pair.after.backingBytes);
  for (const side of ['before', 'after']) {
    const subject = pair[side];
    assert.equal(subject.runtime, pair.runtime); assert.equal(subject.name, spec.name); assert.equal(subject.repeat, pair.repeat);
    assert.equal(subject.samples.length, 9); assert.ok(subject.warmup.length >= data.settings.minimumWarmupBatches);
    let warm = 0, measured = 0;
    for (const [phase, samples] of [['warmup', subject.warmup], ['samples', subject.samples]]) for (const sample of samples) {
      assert.ok(sample.ms > 0); assert.equal(sample.repeat, pair.repeat);
      close(sample.msPerOperation, sample.ms / pair.repeat, 'batch normalization');
      assert.equal(sample.checkedRows, pair.repeat * spec.size * (spec.op === 'both' ? 2 : 1));
      assert.equal(sample.checksum, pair.repeat * (spec.size > 0 ? spec.size * (spec.size - 1) / 2 : 0) * (spec.op === 'both' ? 2 : 1));
      if (phase === 'warmup') warm += sample.ms;
      else { measured += sample.ms; measuredBatches.push(sample.ms); }
    }
    assert.ok(warm >= data.settings.warmupTimedMs); warmupTotals.push(warm);
    close(warm, subject.warmupTimedMs, 'warm-up total'); close(measured, subject.measuredTimedMs, 'measured total');
    close(median(subject.samples.map(sample => sample.ms)) / pair.repeat, subject.medianMsPerOperation, 'subject median');
  }
}
for (const summary of data.summary) {
  const pairs = data.pairs.filter(pair => pair.runtime === summary.runtime && pair.name === summary.name);
  assert.equal(pairs.length, data.settings.pairs); assert.equal(summary.pairs, pairs.length);
  const ratios = pairs.map(pair => pair.after.medianMsPerOperation / pair.before.medianMsPerOperation);
  const logs = ratios.map(Math.log), mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logs.length - 1);
  const margin = (logs.length === 6 ? 2.57058183564 : 12.7062047364) * Math.sqrt(variance / logs.length);
  close(summary.ratio, Math.exp(mean), 'paired geometric ratio');
  for (let i = 0; i < ratios.length; i++) close(summary.ratios[i], ratios[i], 'individual pair ratio');
  close(summary.ratioCI95[0], Math.exp(mean - margin), 'lower paired interval');
  close(summary.ratioCI95[1], Math.exp(mean + margin), 'upper paired interval');
  close(summary.beforeMs, median(pairs.map(pair => pair.before.medianMsPerOperation)), 'before marginal median');
  close(summary.afterMs, median(pairs.map(pair => pair.after.medianMsPerOperation)), 'after marginal median');
}
if (beforeRoot || afterRoot) {
  assert.ok(beforeRoot && afterRoot);
  for (const [side, root] of [['before', resolve(beforeRoot)], ['after', resolve(afterRoot)]]) {
    for (const [name, expected] of Object.entries(data.source[side].files)) assert.equal(hash(readFileSync(join(root, name))), expected, `${side}/${name}`);
    for (const [name, expected] of Object.entries(data.source[side].optional)) assert.equal(existsSync(join(root, name)) ? hash(readFileSync(join(root, name))) : null, expected, `${side}/${name}`);
  }
}
console.log(JSON.stringify({ ok: true, mode: data.mode, pairs: data.pairs.length, subjects: data.pairs.length * 2,
  measuredBatches: measuredBatches.length, shortestMeasuredBatchMs: Math.min(...measuredBatches),
  warmupTimedMsRange: [Math.min(...warmupTotals), Math.max(...warmupTotals)], rawSha256: hash(raw),
  checkedSourceBuilds: Boolean(beforeRoot && afterRoot) }, null, 2));
