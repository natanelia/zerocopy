import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { benchmarkMemory } from '../benchmarks-template.mjs';

const memory = JSON.parse(readFileSync(new URL('../feature-memory-data.json', import.meta.url)));
const recorded = JSON.parse(readFileSync(new URL('../assets/catalog-benchmark-recording.json', import.meta.url)));
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
  assert.equal(recorded.schema, 'zerocopy-product-catalog-browser/v3');
  assert.match(recorded.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(recorded.measuredAt)));
  assert.match(recorded.environment.userAgent, /Chrome|Firefox|Safari/);
  assert.equal(recorded.environment.crossOriginIsolated, true);
  assert.equal(recorded.config.readers, 2);
  assert.equal(recorded.config.edits, 100);
  assert.deepEqual(recorded.config.retainedRevisions, [0, 1]);
  assert.equal(recorded.config.samplesPerCase, 7);
  assert.equal(recorded.config.warmups, 2);
  assert.equal(recorded.raw.length, 63);
  assert.equal(recorded.raw.filter(row => !row.warmup).length, 49);
  assert.deepEqual(recorded.cases.map(row => row.id), allIds);
  for (const phase of allPhases) {
    assert.deepEqual(recorded.config.phaseCaseIds[phase], editedPhases.includes(phase) ? allIds : baselineIds);
  }
  for (const item of recorded.cases) {
    const measuredPhases = item.updateMode === 'full' ? editedPhases : allPhases;
    assert.deepEqual(item.measuredPhases, measuredPhases);
    assert.deepEqual(Object.keys(recorded.summary[item.id]), measuredPhases);
    const samples = recorded.raw.filter(row => row.caseId === item.id);
    assert.equal(samples.length, 9);
    for (const phase of measuredPhases) {
      const values = samples.filter(row => !row.warmup).map(row => row[phase]).sort((a, b) => a - b);
      assert.equal(values.length, 7);
      assert.ok(values.every(value => Number.isFinite(value) && value >= 0));
      assert.deepEqual(recorded.summary[item.id][phase], {
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
  assert.ok(html.includes(`href="${meta.base}assets/catalog-benchmark-recording.json"`));
  for (const phase of allPhases) assert.ok(html.includes(`data-phase="${phase}"`), phase);
  assert.equal((html.match(/data-case="/g) || []).length, 42);
  const served = JSON.parse(readFileSync(new URL('../_site/assets/catalog-benchmark-recording.json', import.meta.url)));
  assert.deepEqual(served, recorded);
});
