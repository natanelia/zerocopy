import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { summarize, median } from './summarize.mjs';

const root = new URL('.', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(new URL(name, root));
const metadata = JSON.parse(read('evidence.json'));
const studies = {};
for (const [name, expected] of Object.entries(metadata.results)) {
  const compressed = read(`results/${name}.json.gz`);
  assert.equal(sha(compressed), expected.compressedSha256, `${name}: compressed digest`);
  const raw = gunzipSync(compressed);
  assert.equal(sha(raw), expected.rawSha256, `${name}: original digest`);
  assert.equal(raw.length, expected.rawBytes, `${name}: original length`);
  studies[name] = JSON.parse(raw.toString('utf8'));
}
const pilotManifest = JSON.parse(read('pilot-manifest.json'));
for (const [name, expected] of Object.entries(pilotManifest.artifactSha256)) assert.equal(sha(read(`archive/${name}`)), expected);
const baselineSha = sha(read('archive/baseline-shared-sorted-map.ts.txt'));
const candidateSha = sha(read('archive/candidate-shared-sorted-map.ts.txt'));
const candidateV2Sha = sha(read('archive/candidate-v2-shared-sorted-map.ts.txt'));
const pilot = studies['pilot-v1'];
assert.equal(pilot.source.before, baselineSha); assert.equal(pilot.source.after, candidateSha);
assert.equal(pilot.subjects.length, 64);
assert.ok(pilot.finished);
for (const subject of pilot.subjects) {
  assert.equal(subject.validated, true);
  assert.equal(subject.samplesMs.length, 9);
  assert.equal(median(subject.samplesMs), subject.medianMs);
  assert.ok(subject.warmupMilliseconds >= 250 && subject.warmupBatches >= 8);
}
for (const name of ['confirm-v1', 'aa-v1', 'confirm-v2']) {
  const study = studies[name];
  assert.equal(study.harnessSha256, sha(read('benchmark.mjs')));
  assert.equal(study.source.before.sources['shared-sorted-map.ts'], baselineSha);
  assert.equal(study.source.after.sources['shared-sorted-map.ts'], name === 'aa-v1' ? baselineSha : name === 'confirm-v2' ? candidateV2Sha : candidateSha);
  const sourceNames = [...new Set([...Object.keys(study.source.before.sources), ...Object.keys(study.source.after.sources)])];
  assert.deepEqual(sourceNames.filter(name => study.source.before.sources[name] !== study.source.after.sources[name]),
    name === 'aa-v1' ? [] : ['shared-sorted-map.ts']);
  assert.deepEqual(study.source.before.wasm, study.source.after.wasm);
  const rows = summarize(study);
  assert.deepEqual(rows, metadata.summaries[name]);
}
const validation = JSON.parse(read('validation-v2.json'));
assert.equal(validation.status, 'passed');
assert.equal(validation.sourceSha256, candidateV2Sha);
assert.ok(validation.steps.every(step => step.exitCode === 0));
assert.equal(sha(read('validation-v2.txt')), validation.logSha256);
console.log('Sorted forEach evidence: lossless raw samples, source/harness hashes and all paired calculations verified');
