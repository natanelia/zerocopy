import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const fourReadersOnly = process.argv[2] === '--readers=4';
const readerCounts = fourReadersOnly ? [4] : [1, 4, 8];
const inputs = process.argv.slice(fourReadersOnly ? 3 : 2);
const sharedOnly = inputs[0] === '--mode=shared';
if (sharedOnly) inputs.shift();
const modes = sharedOnly ? ['shared'] : ['copy', 'shared'];
if (!inputs.length) throw new Error('Supply benchmark reports for reader counts: ' + readerCounts.join(', '));
const reports = inputs.map(path => {
  const buffer = readFileSync(path);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(buffer) : buffer);
});
const first = reports[0];
for (const report of reports) {
  for (const key of ['bundleSHA256', 'config', 'chromium', 'hardware', 'platform']) {
    assert.deepEqual(report[key], first[key], 'Mixed benchmark inputs: ' + key);
  }
}
const cases = reports.flatMap(report => report.cases);
assert.equal(cases.length, 3 * modes.length * readerCounts.length, 'Three trials per mode and reader count are required');
function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
const summary = [];
for (const readers of readerCounts) {
  const row = { readers };
  for (const mode of modes) {
    const matching = cases.filter(c => c.mode === mode && c.readers === readers);
    assert.deepEqual(matching.map(c => c.trial).sort(), [0, 1, 2]);
    for (const c of matching) {
      assert.equal(c.samples.length, first.config.steps);
      for (const [index, s] of c.samples.entries()) {
        assert.equal(s.step, index + first.config.warmup);
        if (first.config.rebuild && s.step % 16 === 2) {
          assert(Number.isFinite(s.rebuildMs) && s.rebuildMs >= 0, 'Missing worker rebuild time');
        }
        for (const key of ['frameMs', 'validationMs', 'drawAndFinishMs', 'packMs', 'uploadBytes', 'uploadCallMs']) {
          assert(Number.isFinite(s[key]) && s[key] >= 0, 'Invalid ' + key);
        }
      }
      for (const [metric, key] of [['p95FrameMs', 'frameMs'], ['p95ValidationMs', 'validationMs']]) {
        const sorted = c.samples.map(s => s[key]).sort((a,b) => a-b);
        assert.equal(c[metric], sorted[Math.ceil(sorted.length * .95) - 1]);
      }
      assert(c.pss.length > 1 && c.pss.every(([, kib]) => kib > 0), 'Linux PSS samples required');
      assert.equal(c.peakSampledPssKiB, Math.max(...c.pss.map(s => s[1])));
    }
    row[mode] = {
      peakPssMiB: median(matching.map(c => c.peakSampledPssKiB)) / 1024,
      p95FrameMs: median(matching.map(c => c.p95FrameMs)),
      p95ValidationMs: median(matching.map(c => c.p95ValidationMs)),
    };
    if (first.config.rebuild) {
      const samples = matching.flatMap(c => c.samples);
      row[mode].medianRebuildMs = median(samples.filter(s => s.step % 16 === 2).map(s => s.rebuildMs));
      row[mode].medianValidationAtRebuildStartMs = median(samples.filter(s => s.step % 16 === 0).map(s => s.validationMs));
    }
  }
  if (row.copy) {
    row.memoryReduction = 1 - row.shared.peakPssMiB / row.copy.peakPssMiB;
    row.frameRatio = row.shared.p95FrameMs / row.copy.p95FrameMs;
  }
  summary.push(row);
}
const four = summary.find(row => row.readers === 4);
console.log(JSON.stringify({ summary, fourReaderTargets: sharedOnly ? undefined : {
  memory: four.memoryReduction >= .25, frame: four.frameRatio <= 1,
} }, null, 2));
