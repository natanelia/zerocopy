/** Prefilled catalog timings, backed by a complete checked browser recording. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isolationNotice } from './templates.mjs';
import { queryIds } from './assets/catalog-core.mjs';
import { BENCHMARK_CASES, EDIT_PUBLICATION_PHASES, casesForPhase } from './assets/catalog-benchmark-core.mjs';
import { READ_CASES, READ_WORKLOAD_VERSION } from './assets/catalog-read-workloads.mjs';
import { WARMUPS, SAMPLES, READ_PHASES, summarizeCases } from './assets/catalog-benchmark-results.mjs';
import { BENCHMARK_PHASE_LABELS, benchmarkBars, benchmarkOrigin, benchmarkRecordingDetails } from './assets/benchmark-bars.mjs';

export const catalogRecording = JSON.parse(readFileSync(new URL('./assets/catalog-read-recording.json', import.meta.url), 'utf8'));
const legacyPhases = Object.keys(BENCHMARK_PHASE_LABELS);
const legacyCases = BENCHMARK_CASES.map(item => ({ ...item, measuredPhases: item.updateMode === 'full' ? EDIT_PUBLICATION_PHASES : legacyPhases }));
const rounds = Array.from({ length: WARMUPS + SAMPLES }, (_, index) => index + 1);
const queryPhases = { first: 'firstQueryMs', repeat: 'repeatQueryMs', updated: 'updatedQueryMs', retained: 'retainedQueryMs' };
const finiteTiming = value => assert.ok(Number.isFinite(value) && value >= 0, 'Invalid benchmark timing');

function validateCommon(value) {
  assert.match(value.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(value.measuredAt)));
  assert.equal(value.workload, 'product-catalog');
  assert.ok([1000, 10000, 100000].includes(value.config.entries));
  assert.equal(value.config.readers, 2);
  assert.equal(value.config.requestedIds, 1000);
  assert.equal(value.config.foundIds, 910);
  assert.equal(value.config.missingIds, 90);
  assert.equal(value.config.edits, 100);
  assert.equal(value.config.unicodeNameFraction, .2);
  assert.equal(value.config.samplesPerCase, SAMPLES);
  assert.equal(value.config.warmups, WARMUPS);
  assert.equal(typeof value.environment.userAgent, 'string');
  assert.ok(value.environment.userAgent.length > 0);
  assert.equal(value.environment.crossOriginIsolated, true);
  assert.ok(Number.isInteger(value.environment.hardwareConcurrency) && value.environment.hardwareConcurrency > 0);
  for (const dependency of ['immutable', 'immer']) assert.match(value.dependencies[dependency], /^\d+\.\d+\.\d+/);
}
function validateLegacy(value, scheduled = false) {
  assert.equal(value.schema, 'zerocopy-product-catalog-browser/v3');
  validateCommon(value);
  assert.deepEqual(value.config.retainedRevisions, [0, 1]);
  assert.deepEqual(value.cases, legacyCases);
  assert.equal(value.raw.length, legacyCases.length * rounds.length);
  assert.deepEqual(Object.keys(value.summary), legacyCases.map(item => item.id));
  assert.deepEqual(value.config.phaseCaseIds, Object.fromEntries(legacyPhases.map(phase => [phase, casesForPhase(phase).map(item => item.id)])));
  for (const definition of legacyCases) {
    const samples = value.raw.filter(sample => sample.caseId === definition.id);
    assert.deepEqual(samples.map(sample => sample.round).sort((a, b) => a - b), rounds);
    assert.deepEqual(Object.keys(value.summary[definition.id]), definition.measuredPhases);
    for (const sample of samples) {
      assert.equal(sample.warmup, sample.round <= WARMUPS);
      assert.equal(sample.kind, definition.kind);
      assert.equal(sample.updateMode, definition.updateMode);
      for (const phase of legacyPhases) {
        assert.equal(Object.hasOwn(sample, phase), definition.measuredPhases.includes(phase));
        if (Object.hasOwn(sample, phase)) finiteTiming(sample[phase]);
      }
      const queries = definition.updateMode === 'full' ? ['updated', 'initial'] : ['first', 'repeat', 'updated', 'initial'];
      assert.deepEqual(Object.keys(sample.verification), queries);
      for (const query of queries) {
        const check = sample.verification[query];
        assert.equal(check.verifiedReplies, 2);
        assert.equal(check.revision, query === 'updated' ? 1 : 0);
        assert.equal(check.answer.lookup.requested, 1000);
        assert.equal(check.answer.lookup.found, 910);
        assert.equal(check.answer.lookup.missing, 90);
        assert.equal(check.answer.validation.unavailable, query === 'updated' ? 100 : 0);
      }
      if (definition.updateMode !== 'full') assert.equal(sample.verification.first.answer.lookup.fingerprint, sample.verification.repeat.answer.lookup.fingerprint);
      const initial = sample.kind === 'shared' ? 0 : value.config.entries;
      const edited = sample.kind === 'shared' ? 0 : sample.updateMode === 'full' ? value.config.entries : 100;
      assert.deepEqual(sample.publication.initial, { recordsPerReader: initial, totalRecords: initial * 2 });
      assert.deepEqual(sample.publication.edit, { recordsPerReader: edited, totalRecords: edited * 2 });
    }
    if (!scheduled) for (const phase of definition.measuredPhases) {
      const measured = samples.filter(sample => !sample.warmup).map(sample => sample[phase]).sort((a, b) => a - b);
      assert.equal(measured.length, SAMPLES);
      // Retain the original v3 quantile calculation exactly for archived recordings.
      assert.deepEqual(value.summary[definition.id][phase], { median: measured[3], min: measured[0], max: measured[6], p25: (measured[1] + measured[2]) / 2, p75: (measured[4] + measured[5]) / 2 });
    }
  }
  if (scheduled) assert.deepEqual(value.summary, summarizeCases(value.raw, legacyCases, item => item.measuredPhases));
}

// Reject missing evidence, altered statistics and mixed workloads before publishing a prefill.
export function validateCatalogRecording(value) {
  if (value.schema === 'zerocopy-product-catalog-browser/v3') { validateLegacy(value); return value; }
  assert.equal(value.schema, 'zerocopy-product-catalog-browser/v4');
  assert.equal(value.status, 'complete');
  assert.equal(value.identityStatus, 'verified');
  validateCommon(value);
  assert.equal(value.workloadVersion, READ_WORKLOAD_VERSION);
  assert.deepEqual(value.cases, READ_CASES);
  assert.deepEqual(value.failures, []);
  assert.deepEqual(value.config.revisions, [0, 1]);
  assert.deepEqual(value.config.ids, queryIds(value.config.entries));
  assert.equal(value.config.uniqueIds, new Set(value.config.ids).size);
  assert.equal(value.sourceCommit, value.buildIdentity.sourceCommit);
  assert.equal(value.assetVerification.verified, true);
  assert.ok(Number.isFinite(Date.parse(value.assetVerification.checkedAt)));
  for (const name of ['libraryFilesSHA256', 'benchmarkFilesSHA256', 'vendorFilesSHA256']) {
    assert.deepEqual(value.assetVerification[name], value.buildIdentity[name]);
    assert.ok(Object.keys(value.buildIdentity[name]).length > 0);
    for (const [filename, hash] of Object.entries(value.buildIdentity[name])) {
      assert.match(filename, /^[a-zA-Z0-9_.-]+$/);
      assert.match(hash, /^[a-f0-9]{64}$/);
    }
  }
  assert.equal(value.buildIdentity.librarySHA256, value.buildIdentity.libraryFilesSHA256['shared.js']);
  assert.deepEqual(value.dependencies, value.buildIdentity.dependencies);
  assert.deepEqual(value.summary, summarizeCases(value.raw, READ_CASES, () => READ_PHASES));
  validateLegacy(value.legacy, true);
  assert.equal(value.legacy.sourceCommit, value.sourceCommit);
  assert.equal(value.legacy.measuredAt, value.measuredAt);
  assert.equal(value.legacy.config.entries, value.config.entries);
  assert.deepEqual(value.legacy.dependencies, value.dependencies);
  assert.deepEqual(value.legacy.environment, value.environment);
  const schedule = [...READ_CASES.map(item => ({ track: 'reads', caseId: item.id })), ...legacyCases.map(item => ({ track: 'legacy', caseId: item.id }))];
  assert.deepEqual(value.schedule, schedule);
  assert.equal(value.execution.length, schedule.length * rounds.length);
  const sampleBySequence = new Map();
  for (const [track, section] of [['reads', value], ['legacy', value.legacy]]) {
    for (const sample of section.raw) {
      assert.ok(!sampleBySequence.has(sample.sequence), 'Duplicate cross-track sample sequence');
      sampleBySequence.set(sample.sequence, { track, sample });
      if (track === 'legacy') continue;
      const definition = READ_CASES.find(item => item.id === sample.caseId);
      assert.equal(sample.status, 'passed');
      for (const key of ['kind', 'api', 'workload', 'freeze', 'collectionType', 'valueType']) assert.equal(sample[key], definition[key]);
      assert.equal(sample.workloadVersion, READ_WORKLOAD_VERSION);
      assert.equal(sample.constructionToFirstAnswerMs, sample.constructionMs + sample.publicationMs + sample.firstRoundTripMs);
      for (const [query, phase] of Object.entries(queryPhases)) {
        assert.equal(sample.readerTimings[query].length, 2);
        sample.readerTimings[query].forEach(finiteTiming);
        assert.equal(sample[phase], Math.max(...sample.readerTimings[query]));
        assert.equal(sample.verification[query].length, 2);
        for (const check of sample.verification[query]) {
          assert.equal(check.passed, true);
          assert.equal(check.requested, 1000);
          assert.equal(check.found, 910);
          assert.equal(check.missing, 90);
          assert.equal(check.idsFieldsCountsMissesAndOrder, true);
        }
      }
      assert.equal(sample.verification.contracts.length, 2);
      for (const reader of sample.verification.contracts) {
        assert.deepEqual(Object.keys(reader), Object.keys(queryPhases));
        for (const check of Object.values(reader)) {
          assert.equal(check.passed, true);
          assert.equal(check.contract, definition.workload === 'selective-fields' ? 'projected-values' : definition.freeze);
          assert.ok(Number.isInteger(check.checkedObjects) && check.checkedObjects >= 0);
        }
      }
    }
  }
  for (const [index, execution] of value.execution.entries()) {
    const round = Math.floor(index / schedule.length), expected = schedule[(index % schedule.length + round) % schedule.length];
    assert.deepEqual(execution, { round: round + 1, warmup: round < WARMUPS, sequence: index + 1, track: expected.track, caseId: expected.caseId, status: 'passed' });
    const stored = sampleBySequence.get(index + 1);
    assert.equal(stored?.track, execution.track);
    assert.equal(stored?.sample.caseId, execution.caseId);
    assert.equal(stored?.sample.round, execution.round);
    assert.equal(stored?.sample.warmup, execution.warmup);
  }
  return value;
}
validateCatalogRecording(catalogRecording);

export function benchmarkPerformancePanel(base) {
  return `<section id="performance" class="benchmark-performance" aria-labelledby="benchmark-performance-title">
    <div class="benchmark-section-heading"><div><span class="eyebrow">02 / PERFORMANCE</span><h2 id="benchmark-performance-title">Now try your device.</h2></div><span class="benchmark-unit">Real workers · checked results</span></div>
    <p class="benchmark-workload">2 readers <span>·</span> 1,000 requested IDs <span>·</span> 100 edits <span>·</span> 7 samples per case</p>
    <form id="feature-benchmark-form" class="benchmark-controls" data-benchmark-view="compact">
      <button id="feature-run" class="button primary" aria-label="Run performance benchmark on my device" disabled>Run on my device <span aria-hidden="true">→</span></button>
      <button id="feature-cancel" type="button" class="button secondary" hidden>Stop run</button>
      <button id="feature-export" type="button" class="button secondary" disabled hidden>Download my results</button>
      <a id="feature-recorded-export" href="${base}assets/catalog-read-recording.json" download>Download recorded JSON ↓</a>
      <details class="benchmark-run-options"><summary>Run options</summary><label for="feature-count">Products<select id="feature-count">${[1000, 10000, 100000].map(count => `<option value="${count}"${count === catalogRecording.config.entries ? ' selected' : ''}>${count.toLocaleString('en-US')}</option>`).join('')}</select></label></details>
    </form>
    ${isolationNotice()}
    <noscript><p class="benchmark-status">Enable JavaScript to run on your device. The recorded charts and downloads stay available.</p></noscript>
    <p id="feature-benchmark-status" class="benchmark-status" role="status">Run once to compare your device. Completed results stay visible while it runs.</p>
    <progress id="feature-benchmark-progress" value="0" max="162" hidden aria-label="Benchmark progress"></progress>
    <p id="feature-result-origin" class="benchmark-recorded" data-result-origin="recorded">${benchmarkOrigin(catalogRecording)}</p>
    <div id="feature-benchmark-results">${benchmarkBars(catalogRecording)}</div>
    <details id="sources" class="benchmark-method"><summary>Method, environment &amp; source data</summary><div>
      <p id="feature-build-identity" class="benchmark-identity" role="status">Checking the source build metadata…</p>
      <p>Median of seven measured samples after two warm-ups. Eleven read cases and seven original catalog cases rotate through fresh owner and two-reader workers. Every warm-up and measured sample is retained: 99 read samples and 63 catalog samples. These are timings, not memory measurements.</p>
      <h3>Full objects, selected fields and the first answer</h3>
      <p><strong>Full-object .get():</strong> complete, deeply frozen records. The cold query is the first access in a fresh reader; the cached query immediately repeats the same 1,000 IDs before any validation pass. All implementations receive the same 910 hits and 90 misses.</p>
      <p><strong>Selective query:</strong> find available books and return ID, name, price and revision. Native Map, Immutable.js, Immer, ZeroCopy .get() and ZeroCopy getView() return the same ordered projection. Selective queries do not compute a full-record fingerprint.</p>
      <p><strong>Construction through first answer:</strong> construction + initial publication + first full-object worker round-trip, added within each sample before the median. It includes both reader acknowledgements and full-result transport. Worker startup, module loading, input generation, reference checks and DOM paint are excluded. Worker startup is reported separately.</p>
      <p>Local read bars show the slower of two parallel reader durations; both individual durations remain in the export. The separate worker round-trip includes scheduling and complete response transport. After first and repeat queries finish, an independent reference checks every result value, count, miss and position. Current revision 1 and retained revision 0 are checked after replacing 100 records.</p>
      <p>Explicit getView().toObject() returns fresh mutable native values; getView().toObject({ freeze: true }) returns fresh deeply frozen values. These are separate materialization workloads, not standard .get() or its decoded-object cache.</p>
      <h3>The original catalog control</h3>
      <p>Legacy query timers include full-field fingerprints and worker reply transport; only the independent reference comparison is untimed. Full-copy bars appear only for publishing an edit and replacing + publishing 100 products, directly below SharedMap. Other legacy operations use the four baseline cases. Initial replica publication copies the complete catalog; incremental edits copy only 100 changed records.</p>
      <h3>Source identity and interrupted runs</h3>
      <p>Page setup reads build metadata without loading the library. Run rechecks the source commit and verifies fetched library, workload and dependency hashes before workers start. Fetched hashes do not attest already evaluated browser modules. Raw JSON includes build/browser identity, APIs, freeze contracts, timing boundaries, all samples and correctness checks.</p>
      <p>Stopping or failing a run keeps the previous completed charts. The interrupted attempt can be downloaded separately with its partial samples and failure details; incomplete medians never replace a complete result.</p>
      <p id="feature-recording-details">${benchmarkRecordingDetails(catalogRecording)}</p>
      <p>Original reports, including the complete historical tables and reproduction commands:</p>
      <ul class="benchmark-source-files"><li><a href="${base}assets/catalog-benchmark-recording.json" download>Earlier v3 catalog recording (.json)</a></li><li><a href="${base}markdown/memory-comparison.md" download>SharedMap memory report (.md)</a></li><li><a href="${base}markdown/benchmarks.md" download>Collection operation results (.md)</a></li><li><a href="${base}markdown/historical-sharedlist-memory.md" download>Earlier SharedList memory report (.md)</a></li></ul>
    </div></details>
  </section>`;
}
