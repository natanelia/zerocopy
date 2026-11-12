/** Prefilled catalog timings, backed by a complete checked browser recording. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isolationNotice } from './templates.mjs';
import { BENCHMARK_CASES, casesForPhase } from './assets/catalog-benchmark-core.mjs';
import { BENCHMARK_PHASE_LABELS, benchmarkBars, benchmarkOrigin, benchmarkRecordingDetails } from './assets/benchmark-bars.mjs';

export const catalogRecording = JSON.parse(readFileSync(new URL('./assets/catalog-benchmark-recording.json', import.meta.url), 'utf8'));

// Reject a stale or hand-edited prefill instead of silently displaying it.
export function validateCatalogRecording(value) {
  assert.equal(value.schema, 'zerocopy-product-catalog-browser/v3');
  assert.equal(value.config.entries, 10000);
  assert.equal(value.config.readers, 2);
  assert.equal(value.config.edits, 100);
  assert.equal(value.config.samplesPerCase, 7);
  assert.equal(value.config.warmups, 2);
  assert.equal(value.raw.length, 63);
  assert.match(value.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(value.measuredAt)));
  for (const benchmarkCase of BENCHMARK_CASES) {
    const all = value.raw.filter(sample => sample.caseId === benchmarkCase.id);
    assert.equal(all.filter(sample => sample.warmup).length, 2);
    assert.equal(all.filter(sample => !sample.warmup).length, 7);
  }
  for (const phase of Object.keys(BENCHMARK_PHASE_LABELS)) {
    const cases = casesForPhase(phase);
    assert.deepEqual(value.config.phaseCaseIds[phase], cases.map(item => item.id));
    for (const { id } of cases) {
      const samples = value.raw.filter(sample => !sample.warmup && sample.caseId === id).map(sample => sample[phase]).sort((a, b) => a - b);
      assert.ok(samples.every(sample => Number.isFinite(sample) && sample >= 0));
      assert.deepEqual(value.summary[id][phase], { median: samples[3], min: samples[0], max: samples[6], p25: (samples[1] + samples[2]) / 2, p75: (samples[4] + samples[5]) / 2 });
    }
  }
  return value;
}
validateCatalogRecording(catalogRecording);

export function benchmarkPerformancePanel(base) {
  return `<section class="benchmark-performance" aria-labelledby="benchmark-performance-title">
    <div class="benchmark-section-heading"><div><span class="eyebrow">02 / PERFORMANCE</span><h2 id="benchmark-performance-title">Now try your device.</h2></div><span class="benchmark-unit">Real workers · checked results</span></div>
    <p class="benchmark-workload">10,000 products <span>·</span> 2 readers <span>·</span> 100 edits <span>·</span> 7 samples per case</p>
    <form id="feature-benchmark-form" class="benchmark-controls" data-benchmark-view="compact">
      <input id="feature-count" type="hidden" value="10000">
      <button id="feature-run" class="button primary" aria-label="Run performance benchmark on my device" disabled>Run on my device <span aria-hidden="true">→</span></button>
      <button id="feature-cancel" type="button" class="button secondary" hidden>Stop run</button>
      <button id="feature-export" type="button" class="button secondary" disabled hidden>Download my results</button>
      <a id="feature-recorded-export" href="${base}assets/catalog-benchmark-recording.json" download>Download recorded JSON ↓</a>
    </form>
    ${isolationNotice()}
    <noscript><p class="benchmark-status">Enable JavaScript to run on your device. The recorded charts and downloads stay available.</p></noscript>
    <p id="feature-benchmark-status" class="benchmark-status" role="status">Run once to replace the recorded sample with your result.</p>
    <p id="feature-result-origin" class="benchmark-recorded" data-result-origin="recorded">${benchmarkOrigin(catalogRecording)}</p>
    <div id="feature-benchmark-results">${benchmarkBars(catalogRecording)}</div>
    <details class="benchmark-method"><summary>Method and environment</summary><div>
      <p>Median of seven measured samples after two warm-ups. Cases rotate through fresh owner and reader workers. Startup is excluded; current and retained answers are checked after timing. These are timings, not memory measurements.</p>
      <p>Full-copy bars appear only for publishing an edit and replacing + publishing 100 products. Other operations use the four baseline cases. Raw JSON includes every sample and observed range.</p>
      <p id="feature-recording-details">${benchmarkRecordingDetails(catalogRecording)}</p>
      <p><a href="${base}investigation-benchmark/">Detailed benchmark and dataset options →</a></p>
    </div></details>
  </section>`;
}
