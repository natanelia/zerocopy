import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1e-11 * Math.max(1, Math.abs(a), Math.abs(b)), `${label}: ${a} != ${b}`);
const manifest = JSON.parse(readFileSync(resolve(here, 'evidence-manifest.json'), 'utf8'));
for (const [name, expected] of Object.entries(manifest.artifacts)) {
  const bytes = readFileSync(resolve(here, name));
  assert.equal(bytes.length, expected.bytes, `${name}: byte count`);
  assert.equal(sha(bytes), expected.sha256, `${name}: SHA-256`);
}
let subjects = 0, batches = 0, pairs = 0;
for (const name of ['rejected-v1', 'rejected-v2']) {
  const archive = JSON.parse(readFileSync(resolve(here, name, 'archive-manifest.json'), 'utf8'));
  for (const file of archive.files) {
    const bytes = readFileSync(resolve(here, name, file.archive));
    assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(blob, file.gitBlob, `${name}/${file.archive}: archived Git blob`);
  }
}
for (const archive of manifest.studies) {
  const compressed = readFileSync(resolve(here, archive.path)), bytes = gunzipSync(compressed);
  assert.equal(bytes.length, archive.originalBytes);
  assert.equal(sha(bytes), archive.originalSha256);
  const data = JSON.parse(bytes.toString('utf8'));
  assert.equal(data.schema, archive.schema);
  assert.equal(data.status, 'complete');
  assert.equal(data.before.head, '77599337867dbf785a5f0311d34637d0b36678fc');
  assert.equal(data.mode, archive.mode);
  assert.equal(data.driver, sha(readFileSync(resolve(here, archive.driver))));
  const count = data.mode === 'formal' ? 6 : 2, cases = data.method.cases;
  assert.equal(data.method.pairs, count); assert.equal(cases.length, archive.caseCount);
  assert.equal(data.runs.length, 2 * count * cases.length * 2);
  assert.equal(data.summary.length, 2 * cases.length);
  assert.equal(data.method.samples, 9);
  assert.equal(data.method.minimumWarmupMs, 500);
  assert.equal(data.method.minimumWarmupBatches, 8);
  assert.ok(data.host.affinity.trim().endsWith('2'));
  assert.deepEqual(Object.keys(data.before.source), Object.keys(data.after.source));
  assert.deepEqual(Object.keys(data.before.source).filter(name => data.before.source[name] !== data.after.source[name]), ['compaction.ts']);
  // Verify archived measured code, not whatever unrelated future changes are
  // present in the working tree when this historical-evidence check runs.
  assert.equal(sha(readFileSync(resolve(here, archive.compactionSource))), data.after.source['compaction.ts']);
  for (const side of ['before', 'after']) for (const group of ['source', 'bundle']) {
    for (const hash of Object.values(data[side][group])) assert.match(hash, /^[0-9a-f]{64}$/);
  }
  let position = 0;
  for (const runtime of ['node', 'bun']) for (let pair = 0; pair < count; pair++) {
    for (const spec of pair % 2 ? [...cases].reverse() : cases) {
      for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        const run = data.runs[position++];
        assert.deepEqual([run.runtime, run.pair, run.variant, run.caseName], [runtime, pair, variant, spec.name]);
        assert.equal(run.records.length, 1);
        const record = run.records[0];
        for (const [key, value] of Object.entries(spec)) assert.deepEqual(record[key], value);
        assert.equal(record.sampleBatchMs.length, 9);
        assert.ok(record.warmupBatchMs.length >= 8);
        assert.ok(record.warmupBatchMs.reduce((a, b) => a + b, 0) >= 500);
        for (const ms of [...record.warmupBatchMs, ...record.sampleBatchMs]) assert.ok(Number.isFinite(ms) && ms > 0);
        assert.equal(record.verifiedOutputs, spec.repetitions * (record.warmupBatchMs.length + 9));
        near(record.medianMs, median(record.sampleBatchMs) / spec.repetitions, 'process median');
        assert.ok(Number.isSafeInteger(record.targetUsed) && record.targetUsed >= 65536);
        subjects++; batches += record.sampleBatchMs.length;
      }
    }
  }
  for (const runtime of ['node', 'bun']) for (const spec of cases) {
    const summary = data.summary.find(s => s.runtime === runtime && s.name === spec.name);
    assert.ok(summary); assert.equal(summary.points.length, count);
    const points = [];
    for (let pair = 0; pair < count; pair++) {
      const records = ['before', 'after'].map(variant => data.runs.find(r => r.runtime === runtime && r.pair === pair && r.variant === variant && r.caseName === spec.name).records[0]);
      const [before, after] = records;
      assert.equal(before.fixtureDigest, after.fixtureDigest);
      assert.equal(before.sourceBytes, after.sourceBytes);
      assert.equal(before.sourceUsed, after.sourceUsed);
      assert.equal(before.targetUsed, after.targetUsed);
      assert.equal(before.layoutDigest, after.layoutDigest);
      assert.equal(before.repetitions, after.repetitions);
      const point = { before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs };
      for (const name of Object.keys(point)) near(point[name], summary.points[pair][name], `pair ${name}`);
      points.push(point); pairs++;
    }
    near(summary.beforeMs, median(points.map(p => p.before)), 'before median');
    near(summary.afterMs, median(points.map(p => p.after)), 'after median');
    const logs = points.map(p => Math.log(p.ratio)), mean = logs.reduce((a, b) => a + b, 0) / count;
    near(summary.pairedRatio, Math.exp(mean), 'paired ratio');
    if (data.mode === 'formal') {
      const error = Math.sqrt(logs.reduce((n, x) => n + (x - mean) ** 2, 0) / (count - 1) / count);
      assert.equal(summary.interval95.length, 2);
      near(summary.interval95[0], Math.exp(mean - 2.570582 * error), 'lower interval');
      near(summary.interval95[1], Math.exp(mean + 2.570582 * error), 'upper interval');
    } else assert.equal(summary.interval95, null);
  }
}
console.log(JSON.stringify({ verified: true, studies: manifest.studies.length, subjects, pairs, measuredBatches: batches, artifacts: Object.keys(manifest.artifacts).length }));
