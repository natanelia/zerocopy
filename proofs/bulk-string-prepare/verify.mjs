import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Verify preserved bytes and recompute screening summaries. This checks the
// evidence's integrity; it does not rerun the runtime correctness assertions.
const root = import.meta.dirname;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const geometric = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
const equalNumber = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const packing = json('results/packing-manifest.json');
let processCount = 0, summaryCount = 0;
const tables = []; let workloads;

for (const [variant, cases] of [['v1', 15], ['v2', 16], ['v3', 17]]) {
  const folder = `results/${variant}`, name = `${folder}/raw.json.gz`;
  const packed = readFileSync(join(root, name)), bytes = gunzipSync(packed), metadata = packing.files[name];
  assert.equal(packed.length, metadata.gzipBytes); assert.equal(sha(packed), metadata.gzipSha256);
  assert.equal(bytes.length, metadata.uncompressedBytes); assert.equal(sha(bytes), metadata.uncompressedSha256);
  const archive = json(`${folder}/manifest.json`);
  for (const [file, expected] of Object.entries(archive.files)) {
    const contents = file === 'raw.json' ? bytes : readFileSync(join(root, folder, file));
    assert.equal(contents.length, expected.bytes, `${variant}/${file} byte count`);
    assert.equal(sha(contents), expected.sha256, `${variant}/${file} digest`);
  }
  const data = JSON.parse(bytes);
  tables.push(new Map(data.summary.map(row => [`${row.name}/${row.runtime}`, row.ratio])));
  workloads = data.cases;
  assert.equal(data.status, 'complete'); assert.equal(data.cases.length, cases);
  assert.equal(data.config.rounds, 2); assert.equal(data.config.samples, 9);
  assert.equal(data.runs.length, cases * 4); assert.equal(data.summary.length, cases * 2);
  assert.equal(data.source.baseline.commit, '09b1a385a7c2ac9b027a4055335ae2f9449abe6e');
  assert.equal(sha(readFileSync(join(root, folder, 'arena.ts'))), data.source.candidate.sources['arena.ts']);
  assert.equal(sha(readFileSync(join(root, folder, 'pilot.mjs'))), data.source.driver);
  assert.deepEqual(data.source.baseline.wasm, data.source.candidate.wasm);
  assert.deepEqual(Object.keys(data.source.baseline.sources).filter(file => data.source.baseline.sources[file] !== data.source.candidate.sources[file]), ['arena.ts']);
  if (archive.candidateCommit) assert.equal(archive.candidateCommit, data.source.candidate.commit);
  if (variant === 'v3') assert.deepEqual(data.source.baseline.support, data.source.candidate.support);

  for (const runtime of ['node', 'bun']) for (const workload of data.cases) {
    const runs = data.runs.filter(run => run.runtime === runtime && run.name === workload.name);
    assert.deepEqual(runs.map(run => run.phase), [0, 1]);
    for (const run of runs) {
      assert.equal(run.samples.length, 9);
      for (const [index, sample] of run.samples.entries()) {
        assert.equal(sample.repeat, run.repeat); assert.equal(sample.count, workload.size);
        assert.equal(sample.order, (index + run.phase) % 2 ? 'BA' : 'AB');
        assert.ok(sample.baselineMs > 0 && sample.candidateMs > 0);
        assert.match(sample.bytesSha256, /^[0-9a-f]{64}$/);
      }
      equalNumber(run.pairedRatio, geometric(run.samples.map(sample => sample.candidateMs / sample.baselineMs)));
      equalNumber(run.baselineMs, median(run.samples.map(sample => sample.baselineMs / run.repeat)));
      equalNumber(run.candidateMs, median(run.samples.map(sample => sample.candidateMs / run.repeat)));
      processCount++;
    }
    const rows = data.summary.filter(row => row.runtime === runtime && row.name === workload.name);
    assert.equal(rows.length, 1);
    const row = rows[0], ratios = runs.map(run => run.pairedRatio);
    assert.equal(row.processes, 2); assert.deepEqual(row.processRatios, ratios);
    equalNumber(row.ratio, geometric(ratios));
    equalNumber(row.minRatio, Math.min(...ratios)); equalNumber(row.maxRatio, Math.max(...ratios));
    equalNumber(row.baselineMs, median(runs.map(run => run.baselineMs)));
    equalNumber(row.candidateMs, median(runs.map(run => run.candidateMs)));
    equalNumber(row.minBatchMs, Math.min(...runs.flatMap(run => run.samples.flatMap(sample => [sample.baselineMs, sample.candidateMs]))));
    assert.equal(row.cappedProcesses, runs.filter(run => run.capped).length);
    summaryCount++;
  }
}
assert.equal(processCount, 192); assert.equal(summaryCount, 96);
const readme = readFileSync(join(root, 'README.md'), 'utf8').split('\n');
for (const workload of workloads) {
  const rows = readme.filter(line => line.startsWith(`| ${workload.name} |`));
  assert.equal(rows.length, 1);
  const expected = tables.flatMap(table => ['node', 'bun'].map(runtime => {
    const ratio = table.get(`${workload.name}/${runtime}`); return ratio === undefined ? '—' : `${ratio.toFixed(3)}×`;
  }));
  assert.deepEqual(rows[0].split('|').slice(2, -1).map(cell => cell.trim()), expected);
}
console.log(`Verified 3 lossless archives, ${processCount} paired processes, ${summaryCount} recomputed summaries, and the report table; source and driver digests match.`);
