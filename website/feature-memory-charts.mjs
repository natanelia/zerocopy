/** New SharedMap recordings only. Historical SharedList charts remain unchanged. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LABELS, KINDS } from './assets/feature-core.mjs';
const path = new URL('./feature-memory-data.json', import.meta.url);
export const featureMemoryData = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
const MIB = 1048576;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const mib = bytes => (bytes / MIB).toFixed(2);
export const MEMORY_CHART_STAGE = 'edited-retained';
const colors = { shared: '#52731a', native: '#766294', immutable: '#256580', immer: '#a7662a' };
export function validateFeatureMemory(data) {
  assert.equal(data.schema, 'zerocopy-feature-map-memory/v1');
  assert.equal(data.status, 'verified'); assert.equal(data.recordingType, 'full-matrix'); assert.equal(data.chartEligible, true);
  assert.equal(data.entries, 100000); assert.equal(data.trials, 3); assert.equal(data.runCount, 36);
  assert.match(data.runtimeSourceCommit, /^[a-f0-9]{40}$/); assert.match(data.summarySHA256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(data.measuredAt)));
  const stages = ['loaded', 'queried', 'edited-retained', 'released', 'streamed'];
  const groups = data.summary;
  assert.equal(groups.length, 60);
  const seen = new Set();
  for (const group of groups) {
    assert.ok(KINDS.includes(group.kind)); assert.ok([0, 2, 4].includes(group.readers));
    assert.ok(stages.includes(group.stage)); assert.equal(group.entries, 100000);
    const id = `${group.kind}:${group.readers}:${group.stage}`; assert.ok(!seen.has(id)); seen.add(id);
    assert.deepEqual(group.samples.map(sample => sample.trial).sort(), [1, 2, 3]);
    for (const field of ['retainedBytes', 'heapDelta', 'arrayBufferDelta', 'wasmCapacityBytes', 'arenaUsedBytes', 'rssBytes']) {
      const values = group.samples.map(sample => sample[field]); assert.ok(values.every(Number.isFinite));
      assert.equal(group.medians[field], [...values].sort((a, b) => a - b)[1]);
    }
    assert.ok(group.samples.every(sample => sample.retainedBytes > 0 && sample.rssBytes > 0));
    for (const sample of group.samples) {
      assert.equal(sample.retainedBytes, sample.heapDelta + sample.arrayBufferDelta + sample.wasmCapacityBytes);
      assert.ok(sample.arenaUsedBytes <= sample.wasmCapacityBytes);
      if (group.kind !== 'shared') assert.equal(sample.wasmCapacityBytes, 0);
    }
  }
  return data;
}
if (featureMemoryData) {
  validateFeatureMemory(featureMemoryData);
  assert.match(featureMemoryData.sourceSummary, /^proofs\/results\/feature-map-memory\/[A-Za-z0-9_-]+\/summary\.json$/);
  const source = readFileSync(new URL('../' + featureMemoryData.sourceSummary, import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), featureMemoryData.summarySHA256, 'Raw source summary digest changed');
  const raw = JSON.parse(source);
  assert.equal(featureMemoryData.sourceTerminal, featureMemoryData.sourceSummary.replace('summary.json', 'controller/terminal.json'));
  const terminalSource = readFileSync(new URL('../' + featureMemoryData.sourceTerminal, import.meta.url));
  assert.equal(createHash('sha256').update(terminalSource).digest('hex'), featureMemoryData.terminalSHA256, 'External terminal receipt digest changed');
  const terminal = JSON.parse(terminalSource);
  assert.equal(terminal.status, 'verified'); assert.equal(terminal.chartEligible, true); assert.equal(terminal.verifiedRuns, 36);
  assert.equal(terminal.cleanup.empty, true); assert.deepEqual(terminal.cleanup.final, []); assert.equal(terminal.trigger, null);
  const { summarySHA256, sourceSummary, terminalSHA256, sourceTerminal, ...imported } = featureMemoryData;
  assert.deepEqual(imported, raw, 'Chart data must preserve the complete raw summary');
}
export function featureChartModel(name, data = featureMemoryData) {
  validateFeatureMemory(data);
  assert.ok(['retained', 'readers', 'rss'].includes(name));
  const field = name === 'rss' ? 'rssBytes' : 'retainedBytes';
  const readers = name === 'readers' ? [0, 2, 4] : [2];
  const groups = readers.map(count => ({ label: `${count} reader workers`, points: KINDS.map(kind => {
    const group = data.summary.find(value => value.stage === MEMORY_CHART_STAGE && value.kind === kind && value.readers === count);
    const samples = group.samples.map(value => value[field]);
    return { kind, readers: count, bytes: group.medians[field], min: Math.min(...samples), max: Math.max(...samples) };
  }) }));
  const maximum = Math.ceil(Math.max(...groups.flatMap(group => group.points.map(point => point.max))) / (10 * MIB)) * 10;
  return { name, field, groups, maximum, title: name === 'readers' ? 'Retained data as reader count grows' : name === 'rss' ? 'Whole-process resident memory' : 'Retained feature-map data' };
}
export function featureMemoryFigure(name, base = '/', data = featureMemoryData) {
  const model = featureChartModel(name, data);
  return `<figure class="memory-figure" data-feature-memory-chart="${name}" data-memory-maximum="${model.maximum * MIB}" aria-labelledby="feature-memory-${name}-title"><figcaption><strong class="memory-chart-title" id="feature-memory-${name}-title">${model.title}</strong><span class="memory-caption">100,000 road features · 100 replacements · initial + current retained</span><span class="memory-scope">Recorded Node.js · MiB · zero-based scale</span></figcaption><div class="memory-groups ${name === 'readers' ? 'memory-reader-groups' : ''}">${model.groups.map(group => `<div class="memory-group"><p class="memory-group-title">${group.label}</p>${group.points.map(point => `<div class="memory-bar" data-memory-kind="${point.kind}" data-memory-bytes="${point.bytes}"><div class="memory-bar-label"><span>${LABELS[point.kind]}</span><strong>${mib(point.bytes)} <small>MiB</small></strong></div><div class="memory-track" aria-hidden="true"><span class="memory-fill" style="background:${colors[point.kind]};width:${point.bytes / (model.maximum * MIB) * 100}%"></span></div></div>`).join('')}<div class="memory-scale" aria-hidden="true"><span>0</span><span>${model.maximum / 2}</span><span>${model.maximum} MiB</span></div></div>`).join('')}</div><p class="memory-note">${name === 'rss' ? 'Absolute process RSS includes runtime and worker overhead. It is not the retained-data sum.' : 'Post-GC JavaScript and tracked-buffer changes plus unique shared backing capacity counted once. Includes decoded object caches and unreclaimed history.'} ${name === 'readers' ? 'Zero readers means the owner does both jobs; only 0, 2 and 4 readers were measured.' : 'Each design has one owner and two reader workers.'}</p><details class="memory-values"><summary>Exact values and trial ranges</summary><p>Median and observed min–max from three fresh processes per case. Ranges are not confidence intervals.</p><div class="table-scroll" tabindex="0"><table><thead><tr><th>Design · readers</th><th>Median (MiB)</th><th>Range (MiB)</th></tr></thead><tbody>${model.groups.flatMap(group => group.points.map(point => `<tr><th>${LABELS[point.kind]} · ${point.readers}</th><td>${mib(point.bytes)}</td><td>${mib(point.min)}–${mib(point.max)}</td></tr>`)).join('')}</tbody></table></div></details><p class="memory-source">${escape(data.measuredAt.slice(0, 10))} · Node ${escape(data.runtime)} · ${escape(data.platform)} ${escape(data.arch)} · source ${data.runtimeSourceCommit.slice(0, 7)}. Not browser RAM.<br><a href="${base}assets/feature-memory-${name}.svg">Open SVG</a> · <a href="${base}assets/feature-memory-data.json" download>Download measured data</a></p></figure>`;
}
export function featureMemory(base) {
  if (!featureMemoryData) return `<section class="section prose"><h2>SharedMap memory recording</h2><p>The new feature-map measurements are being prepared. <a href="${base}docs/historical-sharedlist-memory/">The historical SharedList report</a> measures a different workload.</p></section>`;
  const rows = KINDS.map(kind => featureMemoryData.summary.find(group => group.kind === kind && group.readers === 2 && group.stage === MEMORY_CHART_STAGE));
  return `<section class="section recorded-memory prose" aria-labelledby="feature-memory-heading"><span class="eyebrow">RECORDED MEMORY · FEATURE ATTRIBUTES BY ID</span><h2 id="feature-memory-heading">Count the map and its history.</h2><p>The fixed recording uses 100,000 feature objects, 1,000 requested IDs, 100 replacements, and the same retained initial revision in every owner and reader. The live size selector does not change these charts.</p><div class="memory-overview">${featureMemoryFigure('retained', base)}${featureMemoryFigure('rss', base)}</div><details><summary>Separate heap, backing capacity and arena use</summary><div class="table-scroll" tabindex="0"><table><thead><tr><th>Design · two readers</th><th>JS heap change</th><th>Tracked buffers</th><th>Unique backing capacity</th><th>Arena used</th></tr></thead><tbody>${rows.map(row => `<tr><th>${LABELS[row.kind]}</th>${['heapDelta', 'arrayBufferDelta', 'wasmCapacityBytes', 'arenaUsedBytes'].map(field => `<td>${mib(row.medians[field])} MiB</td>`).join('')}</tr>`).join('')}</tbody></table></div><p>Component medians need not add to the median total. Arena-used is diagnostic and is not added again to capacity. Signed heap and buffer changes are preserved.</p></details><p>These are Node.js results, not measurements of this device or browser. No candidate optimization is included. Releasing old roots does not reclaim individual arena allocations.</p><a class="text-link" href="${base}docs/memory-comparison/">Read reader scaling, all stages and the method →</a></section>`;
}
export function featureMemorySVG(name, data = featureMemoryData) {
  const model = featureChartModel(name, data), height = 160 + model.groups.length * 280;
  let y = 118;
  const rows = model.groups.map(group => {
    let body = `<text x="20" y="${y}" font-size="15" font-weight="600">${group.label}</text>`; y += 30;
    for (const point of group.points) { body += `<text x="20" y="${y}" font-size="15">${LABELS[point.kind]}</text><text x="420" y="${y}" text-anchor="end" font-size="15">${mib(point.bytes)} MiB</text><rect x="20" y="${y + 10}" width="400" height="12" fill="#e2e8d8"/><rect x="20" y="${y + 10}" width="${point.bytes / (model.maximum * MIB) * 400}" height="12" fill="${colors[point.kind]}"/>`; y += 50; }
    body += `<text x="20" y="${y}" font-size="12">0</text><text x="420" y="${y}" text-anchor="end" font-size="12">${model.maximum} MiB</text>`; y += 50; return body;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="${height}" viewBox="0 0 440 ${height}" role="img" aria-labelledby="title desc"><title id="title">${model.title}</title><desc id="desc">100,000 road features, 100 replacements, initial and current retained. Median of three fresh Node processes. Shared backing capacity counted once. Not browser RAM.</desc><rect width="440" height="${height}" fill="#f7f8f2"/><g font-family="system-ui,sans-serif" fill="#17251e"><text x="20" y="32" font-size="21" font-weight="650">${model.title}</text><text x="20" y="60" font-size="13">100,000 feature objects · retained revision 0 + 1</text><text x="20" y="82" font-size="12">${data.measuredAt.slice(0, 10)} · Node ${data.runtime} · source ${data.runtimeSourceCommit.slice(0, 7)}</text>${rows}<text x="20" y="${height - 20}" font-size="12">Recorded Node.js memory. Not browser RAM.</text></g></svg>\n`;
}
export function writeFeatureMemoryAssets(destination) {
  if (!featureMemoryData) return;
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'feature-memory-data.json'), JSON.stringify(featureMemoryData, null, 2) + '\n');
  for (const name of ['retained', 'readers', 'rss']) writeFileSync(join(destination, `feature-memory-${name}.svg`), featureMemorySVG(name));
}
export function injectFeatureMemoryCharts(html, base) {
  return html.replace(/<!-- feature-memory:(retained|readers|rss) -->\s*(?:<p><img src="assets\/feature-memory-\1\.svg" alt="[^"]*"\s*\/?><\/p>\s*)?/g, (_, name) => featureMemoryData ? featureMemoryFigure(name, base) : '<p>Recording pending.</p>');
}
