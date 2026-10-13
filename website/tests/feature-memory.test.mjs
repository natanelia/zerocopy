import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { featureMemoryData as data, featureMemoryEightData as eight, validateFeatureMemory, validateEightReaderMemory, featureChartModel, featureMemoryFigure, featureMemorySVG, featureMemoryHighlights, featureMemory } from '../feature-memory-charts.mjs';
test('publication charts require the complete fresh SharedMap recording and raw source digest', () => {
  assert.ok(data, 'Import a verified full feature-map recording before publishing this site');
  validateFeatureMemory(data); assert.equal(data.summary.length, 60);
  const raw = readFileSync(new URL('../../' + data.sourceSummary, import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), data.summarySHA256);
  const { sourceSummary, summarySHA256, sourceTerminal, terminalSHA256, ...record } = data;
  assert.deepEqual(record, JSON.parse(raw));
  const terminal = readFileSync(new URL('../../' + sourceTerminal, import.meta.url));
  assert.equal(createHash('sha256').update(terminal).digest('hex'), terminalSHA256);
  assert.equal(JSON.parse(terminal).cleanup.empty, true);
});
test('diagnostic, incomplete, duplicate or redefined memory records cannot render', () => {
  assert.ok(data);
  for (const mutate of [record => record.chartEligible = false, record => record.recordingType = 'diagnostic', record => record.summary.pop(),
    record => record.summary[1] = record.summary[0], record => record.summary[0].entries = 1000,
    record => record.summary[0].samples.pop(), record => record.summary[0].samples[0].retainedBytes++, record => record.summary[0].medians.rssBytes++]) {
    const record = structuredClone(data); mutate(record); assert.throws(() => validateFeatureMemory(record));
  }
});
test('reader-only RSS chart uses exact whole-process bytes and every measured map', () => {
  for (const name of ['rss', 'rss-eight']) {
    const model = featureChartModel(name), html = featureMemoryFigure(name, '/zerocopy/');
    const widths = [...html.matchAll(/width:([\d.]+)%/g)].map(match => Number(match[1]));
    assert.deepEqual(widths, model.groups.flatMap(group => group.points.map(point => point.bytes / (model.maximum * 1048576) * 100)));
    assert.ok(widths.every(width => width > 0 && width <= 100));
    for (const text of ['Recorded Node.js', 'Not browser RAM', 'not confidence intervals', 'SharedMap', 'Native Map', 'Immutable.js Map', 'Immer Map']) assert.ok(html.includes(text), text);
    assert.ok(html.includes(name === 'rss-eight' ? '/zerocopy/assets/feature-memory-eight-data.json' : '/zerocopy/assets/feature-memory-data.json'));
    assert.equal(readFileSync(new URL(`../../docs/assets/feature-memory-${name}.svg`, import.meta.url), 'utf8'), featureMemorySVG(name));
  }
  const model = featureChartModel('rss');
  assert.equal(model.field, 'rssBytes');
  assert.deepEqual(model.groups.map(group => group.points[0].readers), [2, 4]);
  for (const group of model.groups) {
    const shared = data.summary.find(row => row.kind === 'shared' && row.readers === group.points[0].readers && row.stage === 'edited-retained');
    const native = data.summary.find(row => row.kind === 'native' && row.readers === group.points[0].readers && row.stage === 'edited-retained');
    assert.equal(group.sharedBytes, shared.medians.rssBytes);
    assert.equal(group.nativeBaselineBytes, native.medians.rssBytes);
    assert.equal(group.percentLower, (native.medians.rssBytes - shared.medians.rssBytes) / native.medians.rssBytes * 100);
  }
  for (const name of ['retained', 'readers']) assert.throws(() => featureChartModel(name));
  const html = featureMemoryFigure('rss');
  for (const text of ['absolute endpoint RSS', 'not peak or high-water RSS', 'No startup baseline is subtracted', 'Zero-reader controls are excluded']) assert.ok(html.includes(text), text);
});
test('retained headline is scoped to two readers and directly paired with that case’s RSS', () => {
  const html = featureMemoryHighlights();
  for (const text of ['84.7% less retained data with two reader workers', '22.27 MiB', '145.39 MiB', '46.7% lower process RSS in the same two-reader case', '186.40 MiB', '349.68 MiB', 'different accounting', '100,000 synthetic records', '100 replacements']) assert.ok(html.includes(text), text);
});
test('eight readers retain a separate complete cohort, source binding and native comparison', () => {
  assert.ok(eight, 'Import the separately verified eight-reader cohort before publishing');
  validateEightReaderMemory(eight);
  assert.equal(eight.runCount, 12); assert.equal(eight.summary.length, 20);
  assert.equal(eight.referenceRecording.sourceCommit, data.sourceCommit);
  assert.notEqual(eight.sourceCommit, data.sourceCommit);
  assert.notEqual(eight.cpu, data.cpu, 'These recorded cohorts must expose their different hosts');
  const source = readFileSync(new URL('../../' + eight.sourceSummary, import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), eight.summarySHA256);
  const { sourceSummary, summarySHA256, sourceTerminal, terminalSHA256, ...record } = eight;
  assert.deepEqual(record, JSON.parse(source));
  const terminal = readFileSync(new URL('../../' + sourceTerminal, import.meta.url));
  assert.equal(createHash('sha256').update(terminal).digest('hex'), terminalSHA256);
  assert.equal(JSON.parse(terminal).verifiedRuns, 12);
  const model = featureChartModel('rss-eight');
  assert.deepEqual(model.groups.map(group => group.points[0].readers), [8]);
  assert.equal(model.groups[0].nativeBaselineBytes, 1008033792);
  assert.equal(model.groups[0].sharedBytes, 294838272);
  const html = featureMemoryFigure('rss-eight');
  assert.ok(html.includes('Separate 8-reader run · AMD EPYC 7763'));
  assert.ok(html.includes('70.75% lower median RSS'));
  const section = featureMemory('/zerocopy/');
  for (const note of ['Recorded runtime baselines: 8ad5788', 'f140ebe', 'predate the later main-branch optimizations, including PR30', 'do not measure the current live example build', 'earlier synthetic-record fixture, not the current product catalog']) assert.ok(section.includes(note), note);
  for (const mutate of [value => value.recordingType = 'full-matrix', value => value.runCount = 36, value => value.summary.pop(), value => value.summary[0].readers = 4, value => value.referenceRecording.summarySHA256 = '0'.repeat(64), value => value.hashes['library/shared.js'] = '0'.repeat(64)]) {
    const value = structuredClone(eight); mutate(value); assert.throws(() => validateEightReaderMemory(value));
  }
});
