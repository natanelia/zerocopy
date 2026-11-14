// Run after compressing completed node-codec.json and node-reader.json to .json.gz.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const read = name => JSON.parse(gunzipSync(readFileSync(new URL(`${name}.json.gz`, import.meta.url))));
const codec = read('node-codec'), reader = read('node-reader');
const median = list => { const a = [...list].sort((a, b) => a - b), middle = a.length >> 1; return a.length % 2 ? a[middle] : (a[middle - 1] + a[middle]) / 2; };
const mean = list => list.reduce((sum, x) => sum + x, 0) / list.length;
const hash = file => createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex');
for (const run of [codec, reader]) {
  assert.ok(run.completedAt && !run.error, 'incomplete run');
  assert.equal(run.pairs, 7);
  for (const [file, expected] of Object.entries(run.sources)) assert.equal(hash(file), expected, `Source changed: ${file}`);
  for (const row of run.rows) assert.equal(row.verified, true);
}
assert.equal(codec.rows.length, 140);
assert.equal(reader.rows.length, 21);

function compare(before, after) {
  assert.equal(before.length, 7); assert.equal(after.length, 7);
  assert.equal(new Set(before.map(x => x.pair)).size, 7);
  assert.equal(new Set(after.map(x => x.pair)).size, 7);
  const base = new Map(before.map(x => [x.pair, x.ms]));
  const ratios = after.map(row => row.ms / base.get(row.pair));
  assert.ok(ratios.every(x => Number.isFinite(x) && x > 0));
  const logs = ratios.map(Math.log), average = mean(logs);
  const deviation = Math.sqrt(logs.reduce((sum, x) => sum + (x - average) ** 2, 0) / 6);
  const half = 2.446911851 * deviation / Math.sqrt(7); // t critical, 6 degrees of freedom
  return { beforeMedianMs: median(before.map(x => x.ms)), afterMedianMs: median(after.map(x => x.ms)),
    ratioOfMedians: median(after.map(x => x.ms)) / median(before.map(x => x.ms)),
    pairedGeometricRatio: Math.exp(average), ci95: [Math.exp(average - half), Math.exp(average + half)],
    fasterPairs: ratios.filter(x => x < 1).length, pairs: 7 };
}

const codecs = [];
for (const kind of ['catalog', 'unicode', 'numeric', 'large-early', 'large-late']) {
  const rows = codec.rows.filter(x => x.kind === kind);
  assert.equal(rows.length, 28);
  assert.equal(new Set(rows.map(x => x.hash)).size, 1);
  assert.equal(new Set(rows.map(x => x.bytes)).size, 1);
  for (const [before, after] of [['native-a', 'native-b'], ['native-a', 'original'], ['native-a', 'guarded'], ['original', 'guarded']]) {
    codecs.push({ kind, count: rows[0].count, before, after, ...compare(rows.filter(x => x.method === before), rows.filter(x => x.method === after)) });
  }
}

for (const row of reader.rows) {
  const { times, verification } = row;
  for (const value of Object.values(times)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.equal(times.readyMs, times.constructionMs + times.publicationMs + times.firstQueryMs);
  assert.deepEqual(verification, { lookup: 2425954933, validation: 2425954933, found: 910, missing: 90 });
  assert.equal(row.arenaUsedBytes, 2715440); assert.equal(row.arenaCapacityBytes, 2752512);
}
const phases = [];
for (const phase of Object.keys(reader.rows[0].times)) {
  for (const after of ['native-b', 'guarded']) {
    const rows = method => reader.rows.filter(x => x.method === method).map(x => ({ pair: x.pair, ms: x.times[phase] }));
    phases.push({ phase, before: 'native-a', after, ...compare(rows('native-a'), rows(after)) });
  }
}
const result = {
  status: 'pass', baseline: codec.baseline, codecSamples: codec.rows.length, readerSamples: reader.rows.length,
  node: codec.node, v8: codec.v8, cpu: codec.cpu, affinity: 'CPUs 2,3', codecs, phases,
  limitations: 'Node only, shared host, seven pairs, exploratory unadjusted t intervals on log ratios. Same-build native-a/native-b control is reported, never used to normalize timings. Worker/module startup excluded. Memory consumption and Rust/Wasm performance unmeasured. All raw samples retained.',
};
writeFileSync(new URL('summary.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
