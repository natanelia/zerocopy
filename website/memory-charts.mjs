/** Build-time charts. All values come from the retained, source-identified run. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { basePath } from './config.mjs';

export const chartData = JSON.parse(readFileSync(new URL('./memory-chart-data.json', import.meta.url), 'utf8'));
const recorded = JSON.parse(readFileSync(new URL('./recorded-memory.json', import.meta.url), 'utf8'));
const MIB = 1048576;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const labels = { shared: 'zerocopy', immutable: 'Immutable.js', native: 'Native replicas', centralized: 'One native owner' };
const colors = { shared: '#52731a', immutable: '#256580', native: '#766294', centralized: '#606b61' };
const kinds = Object.keys(labels);
const fixtures = ['repeated', 'unique', 'unicode'];
export const chartNames = ['retained', 'readers', 'rss'];
const median = values => [...values].sort((a,b) => a-b)[1];
export const formatMiB = bytes => (bytes / MIB).toFixed(2);

export function validateChartData(data, summary = recorded) {
  for (const key of ['schema','runtime','v8','platform','arch','cpu','measuredAt','trials','entries','runtimeSourceCommit','summarySHA256']) assert.equal(data[key], summary[key], `Chart source mismatch: ${key}`);
  assert.equal(data.trials, 3); assert.equal(data.entries, 100000);
  assert.match(data.summarySHA256, /^[a-f0-9]{64}$/);
  assert.match(data.runtimeSourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(data.groups.length, 30);
  const seen = new Set();
  for (const group of data.groups) {
    assert.ok(kinds.includes(group.kind) && fixtures.includes(group.fixture));
    assert.ok([0,2,4].includes(group.readers));
    assert.ok(group.kind !== 'centralized' || group.readers === 0);
    const id = `${group.kind}:${group.fixture}:${group.readers}`;
    assert.ok(!seen.has(id), `Duplicate case: ${id}`); seen.add(id);
    assert.deepEqual(group.samples.map(sample => sample.trial).sort(), [1,2,3]);
    for (const sample of group.samples) for (const field of ['retainedBytes','rssBytes']) assert.ok(Number.isSafeInteger(sample[field]) && sample[field] > 0, `Unresolved ${field}`);
  }
  for (const row of summary.rows) for (const kind of kinds) {
    const group = data.groups.find(group => group.kind === kind && group.fixture === row.fixture && group.readers === (kind === 'centralized' ? 0 : 2));
    assert.equal(median(group.samples.map(sample => sample.retainedBytes)), row[kind], 'Preserve the existing recorded numbers');
  }
  return data;
}
validateChartData(chartData);

function point(kind, fixture, readers, metric, data) {
  const group = data.groups.find(group => group.kind === kind && group.fixture === fixture && group.readers === readers);
  assert.ok(group, 'Missing measured case');
  const samples = group.samples.map(sample => sample[metric]);
  return { kind, label: labels[kind], fixture, readers, bytes: median(samples), min: Math.min(...samples), max: Math.max(...samples), samples };
}

export function chartModel(name, data = chartData) {
  assert.ok(chartNames.includes(name), `Unknown memory chart: ${name}`);
  const metric = name === 'rss' ? 'rssBytes' : 'retainedBytes';
  const definitions = {
    retained: { title: 'Less data memory across two readers', caption: 'Unique messages · 100,000 events · after queries', limit: 50,
      note: 'Shared WASM capacity is counted once. Includes caches and spare capacity; excludes the empty-worker baseline.' },
    readers: { title: 'More readers, little extra shared data memory', caption: 'Unique messages · 100,000 events · retained data memory', limit: 80,
      note: 'Only 0, 2 and 4 reader workers were measured. The owner handles both calculations when there are no readers.' },
    rss: { title: 'The whole process tells a different story', caption: 'Unique messages · 100,000 events · after queries', limit: 200,
      note: 'Absolute resident set size (RSS), including workers and runtime overhead. One native owner uses the least RSS in this run.' },
  };
  const definition = definitions[name];
  const groups = name === 'readers'
    ? [0,2,4].map(readers => ({ label: `${readers} reader workers`, points: kinds.filter(kind => kind !== 'centralized').map(kind => point(kind,'unique',readers,metric,data)) }))
    : [{ label: name === 'rss' ? 'Total process RAM (RSS)' : 'Retained data memory', points: kinds.map(kind => point(kind,'unique',kind === 'centralized' ? 0 : 2,metric,data)) }];
  for (const group of groups) for (const p of group.points) assert.ok(p.max <= definition.limit * MIB, 'Revise the zero-based scale; never clip a measurement');
  return { name, ...definition, metric, groups };
}

/** The width uses full-precision bytes; only the printed label is rounded. */
function bar(point, maximum) {
  return `<div class="memory-bar" role="listitem" data-memory-kind="${point.kind}" data-memory-bytes="${point.bytes}">
    <div class="memory-bar-label"><span>${escape(point.label)}</span><strong>${formatMiB(point.bytes)} <small>MiB</small></strong></div>
    <div class="memory-track" aria-hidden="true"><span class="memory-fill memory-${point.kind}" style="width:${point.bytes/(maximum*MIB)*100}%"></span></div>
  </div>`;
}

export function memoryFigure(name, base = '/', { id = `memory-${name}`, data = chartData } = {}) {
  basePath(base); assert.match(id, /^[a-z][a-z0-9-]*$/);
  const model = chartModel(name,data);
  const groups = model.groups.map(group => `<div class="memory-group"><p class="memory-group-title">${escape(group.label)}</p><div role="list" aria-label="${escape(group.label)} in MiB">${group.points.map(point => bar(point,model.limit)).join('')}</div><div class="memory-scale" aria-hidden="true"><span>0</span><span>${model.limit/2}</span><span>${model.limit} MiB</span></div></div>`).join('');
  const trialRows = model.groups.flatMap(group => group.points.map(point => `<tr><th scope="row">${escape(point.label)} · ${point.readers} readers</th><td>${formatMiB(point.bytes)}</td><td>${formatMiB(point.min)}–${formatMiB(point.max)}</td></tr>`)).join('');
  return `<figure class="memory-figure" id="${id}" data-memory-chart="${name}" data-memory-maximum="${model.limit*MIB}" aria-labelledby="${id}-title">
    <figcaption><strong class="memory-chart-title" id="${id}-title">${escape(model.title)}</strong><span class="memory-caption">${escape(model.caption)}</span><span class="memory-scope">Recorded Node.js · MiB · lower is better</span></figcaption>
    <div class="memory-groups ${name === 'readers' ? 'memory-reader-groups' : ''}">${groups}</div>
    <p class="memory-note">${escape(model.note)}${name === 'readers' ? '' : ' Replicated paths: one owner + two readers. One native owner: no reader replicas.'}</p>
    <details class="memory-values"><summary>Exact values and trial range</summary><p>Median and observed min–max of three fresh processes. These ranges are not confidence intervals.</p><div class="table-scroll" tabindex="0" role="region" aria-label="${escape(model.title)} data"><table><thead><tr><th scope="col">Design · readers</th><th scope="col">Median (MiB)</th><th scope="col">Trial range (MiB)</th></tr></thead><tbody>${trialRows}</tbody></table></div></details>
    <p class="memory-source">29 September 2026 · Node ${escape(data.runtime)} · Linux x64 · 3 trials per case. Not browser RAM.<br><a href="${base}assets/memory-${name}.svg">Open SVG</a> · <a href="${base}assets/memory-chart-data.json" download>Download chart data</a></p>
  </figure>`;
}

/** Compact standalone SVG for the repository Markdown and image export. */
export function memorySVG(name) {
  const model = chartModel(name), height = 145 + model.groups.reduce((n,g) => n + 68 + g.points.length*53,0) + 58;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="420" height="${height}" viewBox="0 0 420 ${height}" role="img" aria-labelledby="title desc"><title id="title">${escape(model.title)}</title><desc id="desc">${escape(model.caption)}. ${escape(model.note)} Recorded Node.js measurements, not browser RAM. Each label is the median of three fresh processes.</desc><rect width="420" height="${height}" fill="#f7f8f2"/><g font-family="system-ui,-apple-system,Segoe UI,sans-serif" fill="#17251e"><text x="18" y="28" font-size="12">RECORDED NODE.JS · NOT BROWSER RAM</text>`];
  const title = name === 'retained' ? ['Retained data memory'] : name === 'readers' ? ['Memory as reader count grows'] : ['Total process RAM (RSS)'];
  parts.push(`<text x="18" y="60" font-size="23" font-weight="650">${title[0]}</text><text x="18" y="86" font-size="14">100,000 unique messages · after queries</text><text x="18" y="109" font-size="14">MiB · lower is better · zero-based scales</text>`);
  let y=145;
  for (const group of model.groups) {
    parts.push(`<text x="18" y="${y}" font-size="15" font-weight="650">${escape(group.label)}</text>`); y+=30;
    for (const p of group.points) {
      parts.push(`<text x="18" y="${y}" font-size="16">${escape(p.label)}</text><text x="402" y="${y}" text-anchor="end" font-size="16" font-weight="650">${formatMiB(p.bytes)}</text><rect x="18" y="${y+10}" width="384" height="13" fill="#e7ebdf"/><rect x="18" y="${y+10}" width="${p.bytes/(model.limit*MIB)*384}" height="13" fill="${colors[p.kind]}"/>`); y+=53;
    }
    parts.push(`<text x="18" y="${y}" font-size="12">0</text><text x="210" y="${y}" text-anchor="middle" font-size="12">${model.limit/2}</text><text x="402" y="${y}" text-anchor="end" font-size="12">${model.limit} MiB</text>`); y+=38;
  }
  const notes = name === 'readers' ? ['Only 0 / 2 / 4 readers measured; same scale.', '0 readers: owner runs both calculations.'] : ['Replicas: owner + 2 readers; native owner: 0.', name === 'rss' ? 'One native owner has the lowest process RSS.' : 'Shared buffer counted once; empty baseline excluded.'];
  notes.push('29 Sep 2026 · Node v22.16.0 · median of 3 trials');
  for (const line of notes) {parts.push(`<text x="18" y="${y}" font-size="12">${escape(line)}</text>`);y+=20;}
  parts.push('</g></svg>'); return parts.join('\n')+'\n';
}

/** Replace only explicit, reviewed image markers in the memory report. */
export function injectMemoryCharts(source, base) {
  const found=[];
  const output=source.replace(/<!-- memory-chart:(retained|readers|rss) -->\s*<p><img src="assets\/memory-\1\.svg" alt="[^"]*"\s*\/?><\/p>\s*<!-- \/memory-chart -->/g, (_match,name) => {found.push(name);return `\n${memoryFigure(name,base)}\n`;});
  assert.deepEqual(found.sort(), [...chartNames].sort(), 'The memory guide must contain all three chart markers exactly once');
  return output;
}
export function writeMemoryChartAssets(destination) {
  mkdirSync(destination,{recursive:true});
  for(const name of chartNames)writeFileSync(join(destination,`memory-${name}.svg`),memorySVG(name));
  writeFileSync(join(destination,'memory-chart-data.json'),JSON.stringify(chartData,null,2)+'\n');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2],'--write','Use --write to update the repository SVG exports');
  const destination=fileURLToPath(new URL('../docs/assets/',import.meta.url));
  mkdirSync(destination,{recursive:true});
  for(const name of chartNames)writeFileSync(join(destination,`memory-${name}.svg`),memorySVG(name));
}
