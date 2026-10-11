import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { featureMemoryData as data, validateFeatureMemory, featureChartModel, featureMemoryFigure, featureMemorySVG } from '../feature-memory-charts.mjs';
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
test('new chart scales use exact bytes, show every map, and distinguish RSS from retained data', () => {
  for (const name of ['retained', 'readers', 'rss']) {
    const model = featureChartModel(name), html = featureMemoryFigure(name, '/zerocopy/');
    const widths = [...html.matchAll(/width:([\d.]+)%/g)].map(match => Number(match[1]));
    assert.deepEqual(widths, model.groups.flatMap(group => group.points.map(point => point.bytes / (model.maximum * 1048576) * 100)));
    assert.ok(widths.every(width => width > 0 && width <= 100));
    for (const text of ['Recorded Node.js', 'Not browser RAM', 'not confidence intervals', 'SharedMap', 'Native Map', 'Immutable.js Map', 'Immer Map']) assert.ok(html.includes(text), text);
    assert.ok(html.includes('/zerocopy/assets/feature-memory-data.json'));
    assert.equal(readFileSync(new URL(`../../docs/assets/feature-memory-${name}.svg`, import.meta.url), 'utf8'), featureMemorySVG(name));
  }
  assert.deepEqual(featureChartModel('readers').groups.map(group => group.points[0].readers), [0, 2, 4]);
});
