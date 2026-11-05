import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const median = values => {
  const xs = [...values].sort((a, b) => a - b), middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : (xs[middle - 1] + xs[middle]) / 2;
};
const critical95 = { 2: 12.706204736, 4: 3.182446305, 6: 2.5705818366 };
export function summarize(study) {
  assert.equal(study.status, 'complete');
  assert.ok(critical95[study.pairs]);
  const result = [];
  for (const runtime of ['node', 'bun']) for (const name of study.cases) {
    const pairs = [];
    for (let pair = 0; pair < study.pairs; pair++) {
      const selected = study.subjects.filter(s => s.runtimeLabel === runtime && s.name === name && s.pair === pair);
      assert.equal(selected.length, 2);
      const before = selected.find(s => s.variant === 'before'), after = selected.find(s => s.variant === 'after');
      assert.ok(before && after);
      for (const subject of selected) {
        assert.equal(subject.validated, true);
        assert.equal(subject.samplesMs.length, 9);
        assert.ok(subject.samplesMs.every(x => Number.isFinite(x) && x > 0));
        assert.equal(median(subject.samplesMs), subject.medianMs);
        assert.ok(subject.warmupBatches >= 8 && subject.warmupMilliseconds >= 250);
      }
      assert.deepEqual(before.spec, after.spec);
      assert.equal(before.checksum, after.checksum); assert.equal(before.count, after.count);
      pairs.push({ before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    const logs = pairs.map(pair => Math.log(pair.ratio));
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const deviation = Math.sqrt(logs.reduce((total, value) => total + (value - mean) ** 2, 0) / (logs.length - 1));
    const half = critical95[study.pairs] * deviation / Math.sqrt(logs.length);
    result.push({ runtime, name, beforeUs: median(pairs.map(p => p.before)) * 1000, afterUs: median(pairs.map(p => p.after)) * 1000,
      pairedRatio: Math.exp(mean), confidence95: [Math.exp(mean - half), Math.exp(mean + half)],
      fasterPairs: pairs.filter(pair => pair.ratio < 1).length, totalPairs: study.pairs, pairs });
  }
  assert.equal(study.subjects.length, 2 * study.pairs * study.cases.length * 2);
  return result;
}

if (process.argv[1]?.endsWith('/summarize.mjs') && process.argv[2]) {
  const path = process.argv[2], bytes = readFileSync(path);
  const study = JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
  const rows = summarize(study);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('| Runtime | Case | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |');
    console.log('| --- | --- | ---: | ---: | --- | ---: |');
    for (const row of rows) console.log(`| ${row.runtime} | ${row.name} | ${row.beforeUs.toFixed(3)} | ${row.afterUs.toFixed(3)} | ${row.pairedRatio.toFixed(3)} (${row.confidence95.map(x => x.toFixed(3)).join('–')}) | ${row.fasterPairs}/${row.totalPairs} |`);
  }
}
