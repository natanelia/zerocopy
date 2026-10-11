import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { chartData, chartNames, chartModel, formatMiB, validateChartData, memoryFigure, memorySVG, injectMemoryCharts } from '../memory-charts.mjs';

const clone = () => structuredClone(chartData);
test('charted samples retain the recorded source, workload, and exact byte medians', () => {
  assert.equal(validateChartData(chartData), chartData);
  assert.equal(chartData.groups.length, 30);
  assert.deepEqual(chartModel('retained').groups[0].points.map(p=>p.bytes), [9539456,46616648,34976584,14726792]);
  assert.deepEqual(chartModel('rss').groups[0].points.map(p=>p.bytes), [127991808,223334400,172146688,121851904]);
  assert.equal(formatMiB(9482568), '9.04');
});
test('source labels follow the recorded date and runtime', () => {
  const data = clone(); data.measuredAt = '2030-01-02T00:00:00.000Z'; data.runtime = 'v99.0.0';
  assert.ok(memoryFigure('retained', '/', { data }).includes('2 January 2030 · Node v99.0.0'));
  assert.ok(memorySVG('retained').includes('10 Oct 2026 · Node v22.23.3'));
});
test('reader scaling includes only measured counts on one common zero-based scale', () => {
  const model=chartModel('readers'); assert.equal(model.limit,80);
  assert.deepEqual(model.groups.map(group=>group.points[0].readers),[0,2,4]);
  for (const group of model.groups) assert.deepEqual(group.points.map(p=>p.kind),['shared','immutable','native']);
  assert.deepEqual(model.groups[2].points.map(p=>p.bytes),[9868408,74573136,56914152]);
});
test('missing, repeated, invalid, or altered-source samples cannot silently render', () => {
  for (const mutate of [d=>d.groups.pop(), d=>d.groups[1]=d.groups[0], d=>d.groups[0].samples.pop(), d=>d.groups[0].samples[0].retainedBytes=NaN, d=>d.groups[0].samples[0].rssBytes=-1, d=>d.runtime='different', d=>d.summarySHA256='wrong']) {
    const data=clone();mutate(data);assert.throws(()=>validateChartData(data));
  }
  const data=clone();const row=data.groups.find(g=>g.kind==='shared'&&g.fixture==='unique'&&g.readers===2);
  row.samples.forEach(s=>s.retainedBytes+=1048576);assert.throws(()=>validateChartData(data),/Preserve/);
});
test('bar lengths use unrounded source bytes, not rounded labels or minimum bar widths', () => {
  for(const name of chartNames){
    const model=chartModel(name),html=memoryFigure(name);
    const widths=[...html.matchAll(/style="width:([\d.]+)%"/g)].map(m=>+m[1]);
    assert.deepEqual(widths,model.groups.flatMap(g=>g.points.map(p=>p.bytes/(model.limit*1048576)*100)));
    assert.ok(widths.every(width=>width>0&&width<=100));
    assert.ok(html.includes(`<span>0</span>`));
  }
  const data=clone();data.groups.find(g=>g.kind==='shared'&&g.fixture==='unique'&&g.readers===2).samples[0].rssBytes=1e10;
  assert.throws(()=>chartModel('rss',data),/never clip/);
});
test('figures keep units, independent RAM definitions, ranges, and inspectable sources', () => {
  for(const name of chartNames){
    const model=chartModel(name),html=memoryFigure(name,'/zerocopy/previews/pr-13/test/');
    for(const text of ['Recorded Node.js','MiB','not confidence intervals','Not browser RAM','3 trials','Exact values and trial range','Download chart data','aria-labelledby'])assert.ok(html.includes(text),text);
    assert.ok(!html.includes('<script'));assert.ok(!html.includes('<canvas'));
    assert.ok(html.includes('/zerocopy/previews/pr-13/test/assets/memory-chart-data.json'));
    for(const p of model.groups.flatMap(g=>g.points))assert.ok(html.includes(`${formatMiB(p.min)}–${formatMiB(p.max)}`));
  }
  assert.ok(memoryFigure('rss').includes('One native owner uses the least RSS'));
  assert.ok(memoryFigure('retained').includes('counted once'));
  assert.throws(()=>memoryFigure('bad'));assert.throws(()=>memoryFigure('rss','//bad/'));assert.throws(()=>memoryFigure('rss','/',{id:'"bad'}));
});
test('checked-in SVGs match the HTML chart model and disclose source context', () => {
  for(const name of chartNames){
    const svg=memorySVG(name);
    assert.equal(readFileSync(new URL(`../../docs/assets/memory-${name}.svg`,import.meta.url),'utf8'),svg,'Run node website/memory-charts.mjs --write');
    for(const p of chartModel(name).groups.flatMap(g=>g.points))assert.ok(svg.includes(`>${formatMiB(p.bytes)}</text>`));
    assert.ok(svg.includes('<title'));assert.ok(svg.includes('<desc'));assert.ok(!svg.includes('<script'));
  }
});
test('documentation markers replace only their declared images and preserve the tables', () => {
  const source=chartNames.map(name=>`<!-- memory-chart:${name} -->\n<p><img src="assets/memory-${name}.svg" alt="Memory data"></p>\n<!-- /memory-chart -->`).join('\n')+'\n<table>Keep original data</table>';
  const html=injectMemoryCharts(source,'/zerocopy/');
  assert.equal((html.match(/data-memory-chart=/g)||[]).length,3);
  assert.ok(html.endsWith('<table>Keep original data</table>'));
  assert.throws(()=>injectMemoryCharts(source.replace('memory-chart:rss','memory-chart:bad'),'/'),/all three/);
});
