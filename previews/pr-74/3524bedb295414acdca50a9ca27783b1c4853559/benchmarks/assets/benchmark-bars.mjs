/** Shared presentation for recorded and live catalog measurements. No timing work. */
import { casesForPhase } from './catalog-benchmark-core.mjs';

export const BENCHMARK_PHASE_LABELS = {
  generationMs: 'Generate the catalog',
  constructionMs: 'Construct the map',
  publicationMs: 'Publish the initial map',
  firstQueryMs: 'First query on fresh readers',
  repeatQueryMs: 'Repeat the same query',
  updateMs: 'Replace 100 product objects',
  editPublicationMs: 'Publish the edited revision',
  updatePublicationMs: 'Replace and publish 100 products',
  updatedQueryMs: 'Query the edited revision',
};
const featuredPhases = ['updatePublicationMs', 'repeatQueryMs'];
const names = { shared: 'ZeroCopy', native: 'Native Map', immutable: 'Immutable.js', immer: 'Immer' };
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function chart(value, phase) {
  const cases = casesForPhase(phase);
  const maximum = Math.max(.01, ...cases.map(({ id }) => value.summary[id][phase].median));
  return `<figure class="benchmark-chart" data-phase="${phase}" data-timing-maximum="${maximum}">
    <figcaption><h3>${BENCHMARK_PHASE_LABELS[phase]}</h3><span class="benchmark-unit">Median · ms · lower is better</span></figcaption>
    <div class="benchmark-bars">${cases.map(({ id, kind, updateMode }) => {
      const stats = value.summary[id][phase];
      const label = `${names[kind]} · ${updateMode === 'shared' ? 'shared snapshot' : updateMode === 'full' ? 'full copy' : 'incremental copy'}`;
      return `<div class="benchmark-bar" data-case="${id}" data-kind="${kind}" data-median-ms="${stats.median}">
        <div class="benchmark-bar-label"><span>${escape(label)}</span><strong class="benchmark-value">${stats.median.toFixed(2)} <small>ms</small></strong></div>
        <div class="benchmark-bar-track" aria-hidden="true"><span style="width:${stats.median / maximum * 100}%"></span></div>
      </div>`;
    }).join('')}</div>
    <div class="benchmark-scale" aria-hidden="true"><span>0</span><span>${maximum.toFixed(2)} ms</span></div>
  </figure>`;
}

export function benchmarkBars(value) {
  return `<div class="benchmark-results">${featuredPhases.map(phase => chart(value, phase)).join('')}</div>
    <details class="benchmark-method benchmark-other-phases"><summary>All 9 operations</summary>
      <div class="benchmark-results">${Object.keys(BENCHMARK_PHASE_LABELS).filter(phase => !featuredPhases.includes(phase)).map(phase => chart(value, phase)).join('')}</div>
    </details>`;
}

export function benchmarkEnvironment(value) {
  const ua = value.environment.userAgent;
  const browser = /Edg\/([\d.]+)/.exec(ua)?.[1] ? `Edge ${/Edg\/(\d+)/.exec(ua)[1]}`
    : /(?:HeadlessChrome|Chrome)\/(\d+)/.exec(ua)?.[1] ? `Chromium ${/(?:HeadlessChrome|Chrome)\/(\d+)/.exec(ua)[1]}`
    : /Firefox\/(\d+)/.exec(ua)?.[1] ? `Firefox ${/Firefox\/(\d+)/.exec(ua)[1]}`
    : /Version\/(\d+).*Safari/.exec(ua)?.[1] ? `Safari ${/Version\/(\d+)/.exec(ua)[1]}` : 'Browser';
  const platform = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /Macintosh/.test(ua) ? 'macOS' : '';
  return `${browser}${platform ? ` / ${platform}` : ''}`;
}

export function benchmarkOrigin(value, recorded = true) {
  const date = new Date(value.measuredAt).toISOString().slice(0, 10);
  return `<strong>${recorded ? 'Recorded sample' : 'Your device'}</strong> · ${escape(benchmarkEnvironment(value))} · ${date} · ${value.config.entries.toLocaleString('en-US')} products · ${value.config.readers} readers`;
}

export function benchmarkRecordingDetails(value) {
  const source = /^[a-f0-9]{40}$/.test(value.sourceCommit) ? `<a href="https://github.com/natanelia/zerocopy/commit/${value.sourceCommit}">${value.sourceCommit.slice(0, 7)}</a>` : escape(value.sourceCommit);
  return `${escape(value.environment.userAgent)}<br>${value.environment.hardwareConcurrency} logical cores reported · source ${source} · Immutable.js ${escape(value.dependencies.immutable)} · Immer ${escape(value.dependencies.immer)} · ${escape(value.measuredAt)}`;
}
