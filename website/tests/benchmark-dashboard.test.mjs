import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { validateCatalogRecording } from '../benchmark-performance.mjs';
import { READ_CASES } from '../assets/catalog-read-workloads.mjs';
import { benchmarkMemory } from '../benchmarks-template.mjs';

const memory = JSON.parse(readFileSync(new URL('../feature-memory-data.json', import.meta.url)));
const recorded = JSON.parse(readFileSync(new URL('../assets/catalog-read-recording.json', import.meta.url)));
const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const html = readFileSync(new URL('../_site/benchmarks/index.html', import.meta.url), 'utf8');
const allPhases = ['generationMs', 'constructionMs', 'publicationMs', 'firstQueryMs', 'repeatQueryMs', 'updateMs', 'editPublicationMs', 'updatePublicationMs', 'updatedQueryMs'];
const editedPhases = ['editPublicationMs', 'updatePublicationMs'];
const baselineIds = ['shared', 'native-incremental', 'immutable-incremental', 'immer-incremental'];
const allIds = ['shared', 'native-full', 'immutable-full', 'immer-full', ...baselineIds.slice(1)];

test('dashboard memory bars preserve matched recorded medians and a common zero-based scale', () => {
  const content = benchmarkMemory('/test-prefix/');
  const figures = [...content.matchAll(/<figure\b[^>]*data-memory-readers="(\d+)"[^>]*data-memory-maximum="([\d.]+)"[^>]*>([\s\S]*?)<\/figure>/g)];
  assert.deepEqual(figures.map(match => Number(match[1])), [2, 4]);
  assert.equal(figures[0][2], figures[1][2]);
  for (const [, count, maximum, figure] of figures) {
    const rows = [...figure.matchAll(/data-memory-kind="([a-z]+)" data-memory-bytes="([\d.]+)"[\s\S]*?<strong>([\d.]+) <small>MiB<\/small><\/strong>[\s\S]*?style="width:([\d.]+)%"/g)];
    assert.deepEqual(rows.map(match => match[1]), ['shared', 'native', 'immutable', 'immer']);
    for (const [, kind, bytes, display, width] of rows) {
      const source = memory.summary.find(row => row.readers === Number(count) && row.kind === kind && row.stage === 'edited-retained');
      assert.equal(Number(bytes), source.medians.rssBytes);
      assert.equal(display, (source.medians.rssBytes / 1048576).toFixed(2));
      assert.equal(Number(width), source.medians.rssBytes / Number(maximum) * 100);
      assert.ok(Number(width) > 0 && Number(width) <= 100);
    }
  }
  assert.match(content, /owner-only control uses more RAM with ZeroCopy/);
  assert.ok(content.includes(memory.measuredAt.slice(0, 10)));
  assert.ok(content.includes(memory.runtimeSourceCommit));
  assert.ok(content.includes('/test-prefix/assets/feature-memory-data.json'));
});

test('prefilled performance values are backed by a complete checked browser export', () => {
  assert.ok(['zerocopy-product-catalog-browser/v3', 'zerocopy-product-catalog-browser/v4'].includes(recorded.schema));
  assert.match(recorded.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(recorded.measuredAt)));
  assert.match(recorded.environment.userAgent, /Chrome|Firefox|Safari/);
  assert.equal(recorded.environment.crossOriginIsolated, true);
  assert.equal(recorded.config.readers, 2);
  assert.equal(recorded.config.edits, 100);
  const legacy = recorded.legacy ?? recorded;
  assert.deepEqual(legacy.config.retainedRevisions, [0, 1]);
  assert.equal(recorded.config.samplesPerCase, 7);
  assert.equal(recorded.config.warmups, 2);
  if (recorded.schema.endsWith('/v4')) {
    assert.equal(recorded.buildIdentity.sourceDirty, false, 'Public prefills must identify a clean recorded build');
    assert.deepEqual(recorded.cases, READ_CASES);
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL('../../proofs/benchmark-integration-20261115/verify.mjs', import.meta.url)),
      fileURLToPath(new URL('../assets/catalog-read-recording.json', import.meta.url)),
    ], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).status, 'passed', 'Independent verifier reproduces read records, hashes, per-sample totals and execution order');
  }
  assert.equal(legacy.raw.length, 63);
  assert.equal(legacy.raw.filter(row => !row.warmup).length, 49);
  assert.deepEqual(legacy.cases.map(row => row.id), allIds);
  for (const phase of allPhases) {
    assert.deepEqual(legacy.config.phaseCaseIds[phase], editedPhases.includes(phase) ? allIds : baselineIds);
  }
  for (const item of legacy.cases) {
    const measuredPhases = item.updateMode === 'full' ? editedPhases : allPhases;
    assert.deepEqual(item.measuredPhases, measuredPhases);
    assert.deepEqual(Object.keys(legacy.summary[item.id]), measuredPhases);
    const samples = legacy.raw.filter(row => row.caseId === item.id);
    assert.equal(samples.length, 9);
    for (const phase of measuredPhases) {
      const values = samples.filter(row => !row.warmup).map(row => row[phase]).sort((a, b) => a - b);
      assert.equal(values.length, 7);
      assert.ok(values.every(value => Number.isFinite(value) && value >= 0));
      assert.deepEqual(legacy.summary[item.id][phase], {
        median: values[3], min: values[0], max: values[6],
        p25: (values[1] + values[2]) / 2, p75: (values[4] + values[5]) / 2,
      });
    }
    for (const sample of samples) {
      assert.equal(sample.verification.updated.answer.validation.unavailable, 100);
      assert.equal(sample.verification.initial.answer.validation.unavailable, 0);
      assert.equal(sample.verification.updated.answer.lookup.found, recorded.config.foundIds);
      for (const phase of allPhases) assert.equal(Object.hasOwn(sample, phase), measuredPhases.includes(phase));
    }
  }
});

test('dashboard renders memory and recorded timings before any interaction', () => {
  assert.ok(html.indexOf('id="memory-heading"') < html.indexOf('id="feature-benchmark-form"'));
  assert.match(html, /data-result-origin="recorded"/);
  assert.match(html, /data-benchmark-view="compact"/);
  assert.ok(html.includes(`href="${meta.base}assets/catalog-read-recording.json"`));
  for (const phase of allPhases) assert.ok(html.includes(`data-phase="${phase}"`), phase);
  const figures = [...html.matchAll(/<figure\b[^>]*data-track="(reads|legacy)"[^>]*data-workload="([^"]+)"[^>]*data-phase="([^"]+)"[^>]*>([\s\S]*?)<\/figure>/g)];
  const legacy = recorded.legacy ?? recorded;
  assert.equal(figures.filter(match => match[1] === 'legacy').length, 9);
  assert.equal(figures.filter(match => match[1] === 'reads').length, recorded.schema.endsWith('/v4') ? 16 : 0);
  for (const [, track, workload, phase, figure] of figures) {
    const expected = track === 'legacy' ? legacy.config.phaseCaseIds[phase]
      : READ_CASES.filter(item => workload === 'explicit-materialization'
        ? item.workload.startsWith('view-to-object-') : item.workload === workload).map(item => item.id);
    const rows = [...figure.matchAll(/data-case="([^"]+)"[^>]*data-median-ms="([^"]+)"/g)];
    assert.deepEqual(rows.map(row => row[1]), expected, `${track}/${workload}/${phase}: exact cases and order`);
    for (const [, id, median] of rows) {
      assert.equal(Number(median), (track === 'legacy' ? legacy : recorded).summary[id][phase].median);
    }
  }
  assert.match(html, /id="feature-build-identity"/);
  assert.match(html, /id="feature-benchmark-progress"/);
  if (recorded.schema.endsWith('/v3')) {
    assert.match(html, /Historical recorded sample/);
    assert.match(html, /do not measure the new cold or selective read workloads/);
  }
  const served = JSON.parse(readFileSync(new URL('../_site/assets/catalog-read-recording.json', import.meta.url)));
  assert.deepEqual(served, recorded);
});


const validationFixture = JSON.parse(gunzipSync(readFileSync(new URL(
  '../../proofs/benchmark-integration-20261115/evidence/firefox-validation.json.gz', import.meta.url,
))));
test('v4 prefill validation accepts independently captured complete evidence', () => {
  assert.equal(validateCatalogRecording(validationFixture), validationFixture);
});
const corruptions = [
  ['incomplete result', value => { value.status = 'cancelled'; }],
  ['missing sample', value => { value.raw.pop(); }],
  ['duplicate sample across tracks', value => { value.legacy.raw[0].sequence = value.raw[0].sequence; }],
  ['unreproduced median', value => { value.summary['full-shared-get'].firstQueryMs.median += 1; }],
  ['full-copy row in an unmeasured phase', value => { value.legacy.config.phaseCaseIds.firstQueryMs.push('native-full'); }],
  ['wrong executed API', value => { value.raw[0].api = 'getView'; }],
  ['wrong freeze contract', value => { value.raw[0].verification.contracts[0].first.contract = 'mutable-detached'; }],
  ['failed result verification', value => { value.raw[0].verification.first[0].passed = false; }],
  ['incorrect slower-reader duration', value => { value.raw[0].readerTimings.first = [value.raw[0].firstQueryMs + 1, value.raw[0].firstQueryMs + 2]; }],
  ['incorrect construction-through-first-answer sum', value => { value.raw[0].constructionToFirstAnswerMs += 1; }],
  ['wrong rotation order', value => { value.execution[0].caseId = value.execution[1].caseId; }],
  ['mismatched source commit', value => { value.buildIdentity.sourceCommit = 'f'.repeat(40); }],
  ['mismatched fetched library hash', value => { value.assetVerification.libraryFilesSHA256['shared.js'] = 'f'.repeat(64); }],
];
for (const [name, change] of corruptions) {
  test(`v4 prefill validation rejects ${name}`, () => {
    const value = structuredClone(validationFixture); change(value);
    assert.throws(() => validateCatalogRecording(value));
  });
}

test('the historical v3 recording stays separately downloadable', () => {
  const original = readFileSync(new URL('../assets/catalog-benchmark-recording.json', import.meta.url));
  const served = readFileSync(new URL('../_site/assets/catalog-benchmark-recording.json', import.meta.url));
  assert.deepEqual(served, original);
  assert.equal(JSON.parse(original).schema, 'zerocopy-product-catalog-browser/v3');
  assert.ok(html.includes(`href="${meta.base}assets/catalog-benchmark-recording.json"`));
});
