import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The historical record is split into ordinary JSON rounds for review.
// Restore its original format and verify every byte before optional export.
const directory = new URL('./results/', import.meta.url);
const { roundFiles, originalFileSHA256, ...metadata } = JSON.parse(
  readFileSync(new URL('local.json', directory), 'utf8'),
);
assert.equal(roundFiles.length, 9);
const rounds = roundFiles.map(path => {
  assert.match(path, /^local-rounds\/[0-9]{2}-[1-3]-(original|optimized|candidate)\.json$/);
  return JSON.parse(readFileSync(new URL(path, directory), 'utf8'));
});
const content = JSON.stringify({ ...metadata, rounds }) + '\n';
const sha256 = createHash('sha256').update(content).digest('hex');
assert.equal(sha256, originalFileSHA256, 'Historical raw evidence has changed');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let samples = 0;
for (const row of metadata.summary) {
  for (const [label, field] of [['original', 'originalMs'], ['optimized', 'optimizedMs'], ['candidate', 'candidateMs']]) {
    const times = rounds.filter(round => round.label === label)
      .flatMap(round => round.rows.find(item => item.name === row.name).samplesMs);
    assert.equal(times.length, 45);
    assert.equal(median(times), row[field]);
    samples += times.length;
  }
  assert.equal(row.originalMs / row.candidateMs, row.originalSpeedup);
  assert.equal(row.optimizedMs / row.candidateMs, row.optimizedSpeedup);
}
assert.equal(metadata.summary.length, 14);
if (process.argv[2]) writeFileSync(resolve(process.argv[2]), content, { flag: 'wx' });
console.log(JSON.stringify({ verified: true, rounds: rounds.length, workloads: metadata.summary.length, samples, originalFileSHA256: sha256 }));
