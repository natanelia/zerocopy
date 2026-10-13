/** New SharedMap recordings only. Historical SharedList charts remain unchanged. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LABELS, KINDS } from './assets/feature-core.mjs';
const path = new URL('./feature-memory-data.json', import.meta.url);
export const featureMemoryData = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
const eightPath = new URL('./feature-memory-eight-data.json', import.meta.url);
export const featureMemoryEightData = existsSync(eightPath) ? JSON.parse(readFileSync(eightPath, 'utf8')) : undefined;
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
export function validateEightReaderMemory(data) {
  assert.equal(data.schema, 'zerocopy-feature-map-memory/v1');
  assert.equal(data.status, 'verified'); assert.equal(data.recordingType, 'eight-reader-cohort'); assert.equal(data.chartEligible, true);
  assert.equal(data.entries, 100000); assert.equal(data.trials, 3); assert.equal(data.runCount, 12);
  assert.match(data.runtimeSourceCommit, /^[a-f0-9]{40}$/); assert.match(data.summarySHA256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(data.measuredAt)));
  const stages = ['loaded', 'queried', 'edited-retained', 'released', 'streamed'];
  const groups = data.summary;
  assert.equal(groups.length, 20);
  const seen = new Set();
  for (const group of groups) {
    assert.ok(KINDS.includes(group.kind)); assert.ok([8].includes(group.readers));
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
  assert.deepEqual(data.readerCounts, [8]);
  assert.equal(data.referenceRecording.sourceCommit, featureMemoryData.sourceCommit);
  assert.equal(data.referenceRecording.summarySHA256, featureMemoryData.summarySHA256);
  assert.equal(data.referenceRecording.terminalSHA256, featureMemoryData.terminalSHA256);
  assert.deepEqual(data.hashes, featureMemoryData.hashes);
  assert.deepEqual(data.dependencies, featureMemoryData.dependencies);
  assert.equal(data.runtime, featureMemoryData.runtime); assert.equal(data.v8, featureMemoryData.v8);
  assert.deepEqual(data.referenceRecording.hashes, featureMemoryData.hashes);
  return data;
}
function verifyImportedRecord(data, runs) {
  assert.match(data.sourceSummary, /^proofs\/results\/feature-map-memory\/[A-Za-z0-9_-]+\/summary\.json$/);
  const source = readFileSync(new URL('../' + data.sourceSummary, import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), data.summarySHA256, 'Raw source summary digest changed');
  const raw = JSON.parse(source);
  assert.equal(data.sourceTerminal, data.sourceSummary.replace('summary.json', 'controller/terminal.json'));
  const terminalSource = readFileSync(new URL('../' + data.sourceTerminal, import.meta.url));
  assert.equal(createHash('sha256').update(terminalSource).digest('hex'), data.terminalSHA256, 'External terminal receipt digest changed');
  const terminal = JSON.parse(terminalSource);
  assert.equal(terminal.status, 'verified'); assert.equal(terminal.chartEligible, true); assert.equal(terminal.verifiedRuns, runs);
  assert.equal(terminal.cleanup.empty, true); assert.deepEqual(terminal.cleanup.final, []); assert.equal(terminal.trigger, null);
  const { summarySHA256, sourceSummary, terminalSHA256, sourceTerminal, ...imported } = data;
  assert.deepEqual(imported, raw, 'Chart data must preserve the complete raw summary');
}
if (featureMemoryData) { validateFeatureMemory(featureMemoryData); verifyImportedRecord(featureMemoryData, 36); }
if (featureMemoryEightData) { validateEightReaderMemory(featureMemoryEightData); verifyImportedRecord(featureMemoryEightData, 12); }
export function featureChartModel(name, data = name === 'rss-eight' ? featureMemoryEightData : featureMemoryData) {
  assert.ok(['rss', 'rss-eight'].includes(name), 'Public memory charts use whole-process RSS with readers');
  (name === 'rss-eight' ? validateEightReaderMemory : validateFeatureMemory)(data);
  const field = 'rssBytes';
  const groups = (name === 'rss-eight' ? [8] : [2, 4]).map(count => {
    const points = KINDS.map(kind => {
      const group = data.summary.find(value => value.stage === MEMORY_CHART_STAGE && value.kind === kind && value.readers === count);
      const samples = group.samples.map(value => value[field]);
      return { kind, readers: count, bytes: group.medians[field], min: Math.min(...samples), max: Math.max(...samples) };
    });
    const native = points.find(point => point.kind === 'native'), shared = points.find(point => point.kind === 'shared');
    return { label: `${count} reader workers`, points, nativeBaselineBytes: native.bytes, sharedBytes: shared.bytes,
      differenceBytes: native.bytes - shared.bytes, percentLower: (native.bytes - shared.bytes) / native.bytes * 100 };
  });
  const maximum = Math.ceil(Math.max(...groups.flatMap(group => group.points.map(point => point.max))) / (10 * MIB)) * 10;
  return { name, field, groups, maximum, title: name === 'rss-eight' ? 'Eight readers: separate cohort' : 'Whole-process RAM: 2 / 4 readers' };
}
export function featureMemoryFigure(name, base = '/', data = name === 'rss-eight' ? featureMemoryEightData : featureMemoryData) {
  const model = featureChartModel(name, data);
  return `<figure class="memory-figure" data-feature-memory-chart="${name}" data-memory-maximum="${model.maximum * MIB}" aria-labelledby="feature-memory-${name}-title"><figcaption><strong class="memory-chart-title" id="feature-memory-${name}-title">${model.title}</strong><span class="memory-caption">${name === 'rss-eight' ? 'Separate 8-reader run' : 'Original 2/4-reader run'} · ${escape(data.cpu)}</span><span class="memory-caption">100,000 synthetic records · 100 replacements · initial + current retained</span><span class="memory-scope">Recorded Node.js · absolute endpoint RSS · MiB · zero-based scale</span></figcaption><div class="memory-groups memory-reader-groups">${model.groups.map(group => `<div class="memory-group"><p class="memory-group-title">${group.label}</p>${group.points.map(point => `<div class="memory-bar" data-memory-kind="${point.kind}" data-memory-bytes="${point.bytes}"><div class="memory-bar-label"><span>${LABELS[point.kind]}</span><strong>${mib(point.bytes)} <small>MiB</small></strong></div><div class="memory-track" aria-hidden="true"><span class="memory-fill" style="background:${colors[point.kind]};width:${point.bytes / (model.maximum * MIB) * 100}%"></span></div></div>`).join('')}<div class="memory-scale" aria-hidden="true"><span>0</span><span>${model.maximum / 2}</span><span>${model.maximum} MiB</span></div><p class="memory-note">SharedMap: ${mib(group.sharedBytes)} MiB; native Map baseline: ${mib(group.nativeBaselineBytes)} MiB. ${group.percentLower.toFixed(2)}% lower median RSS with the same reader count.</p></div>`).join('')}</div><p class="memory-note">Each result includes the complete Node process, owner, readers and runtime. These are post-GC endpoint samples after the first edit with revision 0 and revision 1 retained, not peak or high-water RSS. No startup baseline is subtracted. Zero-reader controls are excluded from this savings chart and remain in the method and raw data.</p><details class="memory-values"><summary>Exact values and trial ranges</summary><p>Median and observed min–max from three fresh processes per case. Ranges are not confidence intervals. Percentages compare matched medians, not paired trials.</p><div class="table-scroll" tabindex="0"><table><thead><tr><th>Design · readers</th><th>Median RSS (MiB)</th><th>Observed range (MiB)</th></tr></thead><tbody>${model.groups.flatMap(group => group.points.map(point => `<tr><th>${LABELS[point.kind]} · ${point.readers}</th><td>${mib(point.bytes)}</td><td>${mib(point.min)}–${mib(point.max)}</td></tr>`)).join('')}</tbody></table></div></details><p class="memory-source">${escape(data.measuredAt.slice(0, 10))} · Node ${escape(data.runtime)} · ${escape(data.platform)} ${escape(data.arch)} · source ${data.runtimeSourceCommit.slice(0, 7)} · ${escape(data.cpu)} · ${escape(data.osRelease)}. Not browser RAM.<br><a href="${base}assets/feature-memory-${name}.svg">Open SVG</a> · <a href="${base}assets/${name === 'rss-eight' ? 'feature-memory-eight-data.json' : 'feature-memory-data.json'}" download>Download measured data</a></p></figure>`;
}
export function featureMemoryHighlights(data = featureMemoryData) {
  validateFeatureMemory(data);
  const shared = data.summary.find(group => group.stage === MEMORY_CHART_STAGE && group.kind === 'shared' && group.readers === 2);
  const native = data.summary.find(group => group.stage === MEMORY_CHART_STAGE && group.kind === 'native' && group.readers === 2);
  const retainedSaving = (1 - shared.medians.retainedBytes / native.medians.retainedBytes) * 100;
  const rssSaving = (1 - shared.medians.rssBytes / native.medians.rssBytes) * 100;
  return `<p class="memory-caption">Two reader workers · 100,000 synthetic records · 100 replacements · initial + current retained · three fresh trials</p><div class="memory-overview"><section class="memory-group"><h3>${retainedSaving.toFixed(1)}% less retained data with two reader workers</h3><p>SharedMap ${mib(shared.medians.retainedBytes)} MiB · native Map ${mib(native.medians.retainedBytes)} MiB.</p><p>Signed post-GC heap and tracked-buffer changes plus unique shared backing capacity.</p></section><section class="memory-group"><h3>${rssSaving.toFixed(1)}% lower process RSS in the same two-reader case</h3><p>SharedMap ${mib(shared.medians.rssBytes)} MiB · native Map ${mib(native.medians.rssBytes)} MiB.</p><p>Absolute whole-process resident memory at the post-GC endpoint. No startup baseline is subtracted.</p></section></div><p>Both compare medians from three fresh trials with 100,000 synthetic records, 100 replacements and initial/current revisions retained. Retained data and RSS use different accounting; they cannot be added or subtracted to explain the rest of the process. These are endpoint measurements, not peak memory.</p>`;
}
export function featureMemory(base) {
  if (!featureMemoryData) return `<section class="section prose"><h2>SharedMap memory recording</h2><p>The new feature-map measurements are being prepared. <a href="${base}docs/historical-sharedlist-memory/">The historical SharedList report</a> measures a different workload.</p></section>`;
  const rows = KINDS.map(kind => featureMemoryData.summary.find(group => group.kind === kind && group.readers === 2 && group.stage === MEMORY_CHART_STAGE));
  const controls = KINDS.map(kind => featureMemoryData.summary.find(group => group.kind === kind && group.readers === 0 && group.stage === MEMORY_CHART_STAGE));
  return `<section class="section recorded-memory prose" aria-labelledby="feature-memory-heading"><span class="eyebrow">HISTORICAL MEMORY · SYNTHETIC RECORDS</span><h2 id="feature-memory-heading">Compare memory with reader workers.</h2><p>The fixed recording uses 100,000 synthetic objects, 1,000 requested IDs, 100 replacements, and the same retained initial revision in every owner and reader. Each comparison below uses the same number of readers. These recordings use an earlier synthetic-record fixture, not the current product catalog. The live size selector does not change this chart.</p><p class="memory-note">Recorded runtime baselines: 8ad5788 (two/four readers) and f140ebe (eight readers), with matching library bytes. These figures predate the later main-branch optimizations, including PR30; they do not measure the current live example build.</p>${featureMemoryHighlights()}${featureMemoryFigure('rss', base)}<section class="memory-cohort" aria-label="Separate eight-reader recording"><h3>Eight readers, recorded separately</h3><p>The eight-reader run used ${escape(featureMemoryEightData.cpu)}; the original two/four-reader run used ${escape(featureMemoryData.cpu)}. Runtime and adapter bytes match, but these are separate cohorts. Compare libraries within each cohort; these panels do not form a controlled same-host scaling curve.</p>${featureMemoryFigure('rss-eight', base)}</section><details><summary>Method control: the owner without readers</summary><p>Zero-reader cases remain in the recording to expose owner-only costs. They are excluded from the savings chart. The owner performs both lookup and validation.</p><div class="table-scroll" tabindex="0"><table><thead><tr><th>Design · zero readers</th><th>Endpoint RSS</th></tr></thead><tbody>${controls.map(row => `<tr><th>${LABELS[row.kind]}</th><td>${mib(row.medians.rssBytes)} MiB</td></tr>`).join('')}</tbody></table></div><p>SharedMap has higher owner-only RSS than native Map in these samples. This recording does not isolate the cause.</p></details><details><summary>Secondary accounting: heap, buffers and shared backing</summary><p>These components describe retained-data accounting. The RSS chart uses absolute process samples separately.</p><div class="table-scroll" tabindex="0"><table><thead><tr><th>Design · two readers</th><th>JS heap change</th><th>Tracked buffers</th><th>Unique backing capacity</th><th>Arena used</th></tr></thead><tbody>${rows.map(row => `<tr><th>${LABELS[row.kind]}</th>${['heapDelta', 'arrayBufferDelta', 'wasmCapacityBytes', 'arenaUsedBytes'].map(field => `<td>${mib(row.medians[field])} MiB</td>`).join('')}</tr>`).join('')}</tbody></table></div><p>Component medians need not add to a median total. Arena-used is diagnostic and is not added again to capacity. Signed heap and buffer changes are preserved. Releasing old roots does not reclaim individual arena allocations.</p></details><p>These are Node.js results for one workload, not measurements of this device or browser. The recorded source commits and raw evidence remain fixed.</p><a class="text-link" href="${base}docs/memory-comparison/">Read the method, controls and measurement limits →</a></section>`;
}
export function featureMemorySVG(name, data = name === 'rss-eight' ? featureMemoryEightData : featureMemoryData) {
  const model = featureChartModel(name, data), height = 190 + model.groups.length * 280;
  let y = 118;
  const rows = model.groups.map(group => {
    let body = `<text x="20" y="${y}" font-size="15" font-weight="600">${group.label}</text>`; y += 30;
    for (const point of group.points) { body += `<text x="20" y="${y}" font-size="15">${LABELS[point.kind]}</text><text x="420" y="${y}" text-anchor="end" font-size="15">${mib(point.bytes)} MiB</text><rect x="20" y="${y + 10}" width="400" height="12" fill="#e2e8d8"/><rect x="20" y="${y + 10}" width="${point.bytes / (model.maximum * MIB) * 400}" height="12" fill="${colors[point.kind]}"/>`; y += 50; }
    body += `<text x="20" y="${y}" font-size="12">0</text><text x="420" y="${y}" text-anchor="end" font-size="12">${model.maximum} MiB</text>`; y += 50; return body;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="${height}" viewBox="0 0 440 ${height}" role="img" aria-labelledby="title desc"><title id="title">${model.title}</title><desc id="desc">Absolute whole-process endpoint RSS for ${name === 'rss-eight' ? 'eight-reader cases from a separate cohort' : 'matched two-reader and four-reader cases from the original cohort'} on ${escape(data.cpu)}. 100,000 synthetic records, 100 replacements, initial and current retained. Median of three fresh Node processes. Startup baseline is not subtracted. Zero-reader controls are excluded. This is not peak RSS or browser RAM.</desc><rect width="440" height="${height}" fill="#f7f8f2"/><g font-family="system-ui,sans-serif" fill="#17251e"><text x="20" y="32" font-size="21" font-weight="650">${model.title}</text><text x="20" y="60" font-size="13">Absolute endpoint RSS · retained revision 0 + 1</text><text x="20" y="82" font-size="12">${data.measuredAt.slice(0, 10)} · Node ${data.runtime} · source ${data.runtimeSourceCommit.slice(0, 7)}</text>${rows}<text x="20" y="${height - 40}" font-size="12">${name === 'rss-eight' ? 'Separate 8-reader run' : 'Original 2/4-reader run'} · ${escape(data.cpu.replace(' 64-Core Processor', ''))}</text><text x="20" y="${height - 20}" font-size="12">Post-GC endpoint, not peak RSS. Not browser RAM.</text></g></svg>\n`;
}
export function writeFeatureMemoryAssets(destination) {
  if (!featureMemoryData) return;
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'feature-memory-data.json'), JSON.stringify(featureMemoryData, null, 2) + '\n');
  writeFileSync(join(destination, 'feature-memory-rss.svg'), featureMemorySVG('rss'));
  if (featureMemoryEightData) {
    writeFileSync(join(destination, 'feature-memory-eight-data.json'), JSON.stringify(featureMemoryEightData, null, 2) + '\n');
    writeFileSync(join(destination, 'feature-memory-rss-eight.svg'), featureMemorySVG('rss-eight'));
  }
}
export function injectFeatureMemoryCharts(html, base) {
  return html.replace(/<!-- feature-memory:highlights:start -->[\s\S]*?<!-- feature-memory:highlights:end -->/g, () => featureMemoryData ? featureMemoryHighlights() : '<p>Recording pending.</p>').replace(/<!-- feature-memory:(rss(?:-eight)?) -->\s*(?:<p><img src="assets\/feature-memory-\1\.svg" alt="[^"]*"\s*\/?><\/p>\s*)?/g, (_, name) => featureMemoryData ? featureMemoryFigure(name, base) : '<p>Recording pending.</p>');
}
