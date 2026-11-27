import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const inputs = process.argv.slice(2);
const readerCounts = inputs[0]?.startsWith('--readers=') ? [Number(inputs.shift().slice(10))] : [1, 4, 8];
if (readerCounts.some(n => ![1, 4, 8].includes(n))) throw new Error('Expected --readers=1|4|8');
const selectedMode = inputs[0]?.startsWith('--mode=') ? inputs.shift().slice(7) : undefined;
if (!inputs.length) throw new Error('Supply benchmark reports for reader counts: ' + readerCounts.join(', '));
const reports = inputs.map(path => {
  const buffer = readFileSync(path);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(buffer) : buffer);
});
const first = reports[0];
const fromArrow = first.config.source === 'geoarrow';
const allModes = fromArrow ? ['copy', 'shared', 'packed'] : ['copy', 'shared'];
if (selectedMode && !allModes.includes(selectedMode)) throw new Error('Unsupported mode: ' + selectedMode);
const modes = selectedMode ? [selectedMode] : allModes;
if (fromArrow) assert.match(first.tileSHA256, /^[a-f0-9]{64}$/, 'Missing IPC fixture digest');
for (const report of reports) {
  for (const key of ['bundleSHA256', 'tileSHA256', 'config', 'chromium', 'hardware', 'platform', 'frameTimingVersion', 'graphics']) {
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
const version = first.frameTimingVersion;
assert([undefined, 1, 2].includes(version), 'Unsupported frame timing version');
const beforeDraw = version === 2 ? ['waitForAnimationFrameMs', 'prepareScreenDrawMs'] : ['beforeScreenDrawMs'];
const framePhases = ['commandBeforePackMs', 'packMs', 'setPropsMs', ...beforeDraw, 'drawAndFinishMs'];
if (version === 2) {
  assert(['hardware', 'swiftshader'].includes(first.graphics?.mode) && first.graphics.renderer && first.graphics.vendor,
    'Missing measured WebGL renderer');
}
const hasPss = first.platform === 'linux';
for (const readers of readerCounts) {
  const row = { readers };
  for (const mode of modes) {
    const matching = cases.filter(c => c.mode === mode && c.readers === readers);
    assert.deepEqual(matching.map(c => c.trial).sort(), [0, 1, 2]);
    for (const c of matching) {
      assert.equal(c.samples.length, first.config.steps);
      if (fromArrow) {
        const { readyMs, initialIndexMs, loadPathsAndRowsMs, initialPathEntries } = c.startup;
        for (const ms of [readyMs, initialIndexMs, loadPathsAndRowsMs]) assert(Number.isFinite(ms) && ms >= 0);
        assert(readyMs + 1e-6 >= loadPathsAndRowsMs + initialIndexMs, 'Initialization phases exceed time to ready');
        assert.equal(initialPathEntries, mode === 'packed' ? 0 : first.config.count);
        if (mode === 'packed') assert(c.peakPathEntries > 0 && c.peakPathEntries <= 5, 'Only edited lanes should be materialized');
        else assert.equal(c.peakPathEntries, first.config.count);
      }
      for (const [index, s] of c.samples.entries()) {
        assert.equal(s.step, index + first.config.warmup);
        if (first.config.rebuild && s.step % 16 === 2) {
          assert(Number.isFinite(s.rebuildMs) && s.rebuildMs >= 0, 'Missing worker rebuild time');
        }
        for (const key of ['frameMs', 'validationMs', 'drawAndFinishMs', 'packMs', 'uploadBytes', 'uploadCallMs']) {
          assert(Number.isFinite(s[key]) && s[key] >= 0, 'Invalid ' + key);
        }
        if (first.config.uploads) {
          assert(Number.isSafeInteger(s.packedBytes) && s.packedBytes >= 0);
          if (first.config.uploads === 'range') {
            assert.equal(s.positionUploadBytes, s.packedBytes);
            assert(s.positionUploadBytes <= s.uploadBytes);
          }
        }
        if (version) {
          for (const key of framePhases) assert(Number.isFinite(s[key]) && s[key] >= 0, 'Invalid ' + key);
          const measured = framePhases.reduce((ms, key) => ms + s[key], 0);
          assert(measured <= s.frameMs + 1e-6, 'Frame phases overlap or exceed total latency');
        }
      }
      for (const [metric, key] of [['p95FrameMs', 'frameMs'], ['p95ValidationMs', 'validationMs']]) {
        const sorted = c.samples.map(s => s[key]).sort((a,b) => a-b);
        assert.equal(c[metric], sorted[Math.ceil(sorted.length * .95) - 1]);
      }
      if (hasPss) {
        assert(c.pss.length > 1 && c.pss.every(([, kib]) => kib > 0), 'Linux PSS samples required');
        assert.equal(c.peakSampledPssKiB, Math.max(...c.pss.map(s => s[1])));
      } else {
        assert.equal(c.pss.length, 0);
        assert.equal(c.peakSampledPssKiB, null);
      }
    }
    row[mode] = {
      peakPssMiB: hasPss ? median(matching.map(c => c.peakSampledPssKiB)) / 1024 : null,
      p95FrameMs: median(matching.map(c => c.p95FrameMs)),
      p95ValidationMs: median(matching.map(c => c.p95ValidationMs)),
    };
    if (fromArrow) {
      row[mode].readyMs = median(matching.map(c => c.startup.readyMs));
      row[mode].loadPathsAndRowsMs = median(matching.map(c => c.startup.loadPathsAndRowsMs));
      row[mode].initialIndexMs = median(matching.map(c => c.startup.initialIndexMs));
      row[mode].peakPathEntries = Math.max(...matching.map(c => c.peakPathEntries));
      row[mode].p95EditBeforePackMs = median(matching.map(c => {
        // Steps 1 and 6 only pan. Include attempted edits that roll back.
        const ms = c.samples.filter(s => ![1, 6].includes(s.step % 10))
          .map(s => s.commandBeforePackMs).sort((a, b) => a - b);
        assert(ms.length > 0);
        return ms[Math.ceil(ms.length * .95) - 1];
      }));
    }
    if (first.config.uploads) {
      const drags = matching.flatMap(c => c.samples.filter(s => [7, 8].includes(s.step % 10)));
      assert(drags.length > 0);
      row[mode].dragAndUndo = { count: drags.length, medianPackedBytes: median(drags.map(s => s.packedBytes)),
        medianAllUploadBytes: median(drags.map(s => s.uploadBytes)) };
      if (first.config.uploads === 'range') assert(drags.every(s => s.positionUploadBytes === 16));
    }
    if (version) {
      // Select whole commands by total frame latency before attributing their time.
      const slow = matching.flatMap(c => c.samples.toSorted((a, b) => b.frameMs - a.frameMs)
        .slice(0, Math.ceil(c.samples.length * 0.05)));
      const frameTotal = slow.reduce((ms, s) => ms + s.frameMs, 0);
      assert(frameTotal > 0, 'Expected positive frame time');
      const phaseShare = Object.fromEntries(framePhases.map(key =>
        [key, slow.reduce((ms, s) => ms + s[key], 0) / frameTotal]));
      row[mode].slowFrameTimeShare = { count: slow.length, ...phaseShare,
        afterDraw: 1 - Object.values(phaseShare).reduce((a, b) => a + b, 0) };
    }
    if (first.config.rebuild) {
      const samples = matching.flatMap(c => c.samples);
      row[mode].medianRebuildMs = median(samples.filter(s => s.step % 16 === 2).map(s => s.rebuildMs));
      row[mode].medianValidationAtRebuildStartMs = median(samples.filter(s => s.step % 16 === 0).map(s => s.validationMs));
    }
  }
  if (row.copy && row.shared) {
    row.memoryReduction = hasPss ? 1 - row.shared.peakPssMiB / row.copy.peakPssMiB : null;
    row.frameRatio = row.shared.p95FrameMs / row.copy.p95FrameMs;
  }
  if (row.copy && row.packed) {
    row.packedMemoryReduction = hasPss ? 1 - row.packed.peakPssMiB / row.copy.peakPssMiB : null;
    row.packedFrameRatio = row.packed.p95FrameMs / row.copy.p95FrameMs;
  }
  summary.push(row);
}
const four = summary.find(row => row.readers === 4);
console.log(JSON.stringify({ graphics: first.graphics, summary, fourReaderTargets: selectedMode || !four ? undefined : {
  memory: hasPss ? four.memoryReduction >= .25 : null, frame: four.frameRatio <= 1,
}, packedFourReaderTargets: selectedMode || !fromArrow || !four ? undefined : {
  memory: hasPss ? four.packedMemoryReduction >= .25 : null, frame: four.packedFrameRatio <= 1,
} }, null, 2));
