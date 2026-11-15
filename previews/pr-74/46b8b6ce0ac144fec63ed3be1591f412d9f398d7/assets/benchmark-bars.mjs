/** Shared presentation for recorded and live catalog measurements. No timing work. */
import { casesForPhase } from './catalog-benchmark-core.mjs';
import { READ_CASES } from './catalog-read-workloads.mjs';

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
const featuredLegacyPhases = ['updatePublicationMs', 'repeatQueryMs'];
const names = { shared: 'ZeroCopy', native: 'Native Map', immutable: 'Immutable.js', immer: 'Immer' };
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fullCases = READ_CASES.filter(item => item.workload === 'full-object-get');
const selectiveCases = READ_CASES.filter(item => item.workload === 'selective-fields');
const materializationCases = READ_CASES.filter(item => !['full-object-get', 'selective-fields'].includes(item.workload));
const localNote = 'Local query time in the slower of two parallel readers. Result messaging is excluded.';

function timing(value, id, phase) {
  const stats = value.summary?.[id]?.[phase];
  if (!stats || !['median', 'min', 'max'].every(key => Number.isFinite(stats[key]) && stats[key] >= 0) || stats.min > stats.median || stats.median > stats.max) {
    throw new Error(`Missing or invalid completed measurement: ${id}/${phase}`);
  }
  return stats;
}

function chart(value, { phase, cases, title, note = '', track = 'legacy', workload = 'catalog-fingerprint' }) {
  const maximum = Math.max(.01, ...cases.map(({ id }) => timing(value, id, phase).median));
  return `<figure class="benchmark-chart" data-track="${escape(track)}" data-workload="${escape(workload)}" data-phase="${escape(phase)}" data-timing-maximum="${maximum}">
    <figcaption><h3>${escape(title)}</h3><span class="benchmark-unit">Median · ms · lower is better</span>${note ? `<p class="benchmark-chart-note">${escape(note)}</p>` : ''}</figcaption>
    <div class="benchmark-bars">${cases.map(({ id, kind, updateMode, api }) => {
      const stats = timing(value, id, phase);
      const label = track === 'reads' ? names[kind] : `${names[kind]} · ${updateMode === 'shared' ? 'shared snapshot' : updateMode === 'full' ? 'full copy' : 'incremental copy'}`;
      return `<div class="benchmark-bar" data-case="${escape(id)}" data-kind="${escape(kind)}" data-median-ms="${stats.median}">
        <div class="benchmark-bar-label"><span>${escape(label)}${track === 'reads' ? `<code class="benchmark-api">${escape(api)}</code>` : ''}</span><strong class="benchmark-value" title="Range ${stats.min.toFixed(3)}–${stats.max.toFixed(3)} ms · ${escape(value.config.samplesPerCase)} measured samples">${stats.median.toFixed(2)} <small>ms</small></strong></div>
        <div class="benchmark-bar-track" aria-hidden="true"><span style="width:${stats.median / maximum * 100}%"></span></div>
      </div>`;
    }).join('')}</div>
    <div class="benchmark-scale" aria-hidden="true"><span>0</span><span>${maximum.toFixed(2)} ms</span></div>
  </figure>`;
}
function legacyChart(value, phase) {
  return chart(value, { phase, cases: casesForPhase(phase), title: BENCHMARK_PHASE_LABELS[phase] });
}
function readChart(value, cases, phase, title, note) {
  const workloads = [...new Set(cases.map(item => item.workload))];
  return chart(value, { phase, cases, title, note, track: 'reads', workload: workloads.length === 1 ? workloads[0] : 'explicit-materialization' });
}
function disclosure(title, content, note = '') {
  return `<details class="benchmark-method benchmark-other-phases"><summary>${escape(title)}</summary><div>${note ? `<p>${escape(note)}</p>` : ''}<div class="benchmark-results">${content}</div></div></details>`;
}

export function benchmarkBars(value) {
  if (value.schema === 'zerocopy-product-catalog-browser/v3') {
    return `<p class="benchmark-recording-note">Historical catalog control. These timings include full-field fingerprints and worker replies; they do not measure the new cold or selective read workloads. Run on your device for the current build.</p>
      <div class="benchmark-results">${featuredLegacyPhases.map(phase => legacyChart(value, phase)).join('')}</div>
      ${disclosure('All 9 catalog operations', Object.keys(BENCHMARK_PHASE_LABELS).filter(phase => !featuredLegacyPhases.includes(phase)).map(phase => legacyChart(value, phase)).join(''))}`;
  }
  if (value.schema !== 'zerocopy-product-catalog-browser/v4' || value.status !== 'complete') {
    throw new Error('Only complete v3 or v4 benchmark results can be displayed');
  }
  const primary = [
    readChart(value, fullCases, 'firstQueryMs', 'Cold full-object .get()', `Complete deeply frozen records, first accessed in fresh readers. ${localNote}`),
    readChart(value, fullCases, 'repeatQueryMs', 'Cached full-object .get()', `The same 1,000 IDs repeated immediately, before validation. ${localNote}`),
    readChart(value, selectiveCases, 'firstQueryMs', 'Selective application query', `Available books → ID, name, price and revision. Every implementation produces the same answer. ${localNote}`),
    readChart(value, fullCases, 'constructionToFirstAnswerMs', 'Construction through first answer', 'Construction + initial publication + first full-object worker round-trip, added within each sample before the median. Excludes worker startup and input generation.'),
  ];
  const other = [
    readChart(value, fullCases, 'startupMs', 'Worker and module setup', 'Owner/reader creation and module loading. Measured separately from construction through first answer.'),
    readChart(value, fullCases, 'constructionMs', 'Construct the collection', 'Owner-side construction. Fixture generation is excluded.'),
    readChart(value, fullCases, 'publicationMs', 'Publish and attach', 'Encoding, delivery, replica reconstruction/freezing or shared attachment, and both reader acknowledgements.'),
    readChart(value, fullCases, 'firstRoundTripMs', 'First query including messages', 'Owner elapsed time through both complete replies. Includes scheduling and full-result transport.'),
    readChart(value, fullCases, 'repeatRoundTripMs', 'Repeated query including messages', 'The repeated full-object request/reply. Cached local read time is shown above.'),
    readChart(value, selectiveCases, 'repeatQueryMs', 'Repeated selective query', `Identical projection repeated before validation. ${localNote}`),
    readChart(value, fullCases, 'updateMs', 'Replace 100 complete records', 'Owner-side replacements. Input generation and publication are excluded.'),
    readChart(value, fullCases, 'editPublicationMs', 'Publish the edited records', 'Shared descriptors or 100 incremental replacements, including both reader acknowledgements.'),
    readChart(value, fullCases, 'updatedQueryMs', 'Read the updated revision', `Complete records after replacing 100 products. ${localNote}`),
    readChart(value, fullCases, 'retainedQueryMs', 'Read the retained revision', `Complete records from the unchanged initial snapshot. ${localNote}`),
  ];
  const materialization = [
    readChart(value, materializationCases, 'firstQueryMs', 'Create objects from views', localNote),
    readChart(value, materializationCases, 'repeatQueryMs', 'Repeat explicit materialization', 'Fresh native objects are created again. This is not a cached .get() read.'),
  ];
  return `<div class="benchmark-results">${primary.join('')}</div>
    ${disclosure('Setup, transport & retained revisions', other.join(''))}
    ${disclosure('Explicit view materialization · separate contracts', materialization.join(''), 'toObject() returns fresh mutable native values. toObject({ freeze: true }) returns fresh deeply frozen values. Neither row measures standard .get() or its decoded-object cache.')}
    ${disclosure('Legacy catalog control · all 9 operations', Object.keys(BENCHMARK_PHASE_LABELS).map(phase => legacyChart(value.legacy, phase)).join(''), 'The original workload includes full-field fingerprints inside the query timer and worker reply transport. Only the independent reference comparison is untimed. Full-copy rows appear only for edited publication and combined replacement/publication.')}`;
}

export function benchmarkEnvironment(value) {
  const ua = String(value.environment.userAgent);
  const browser = /Edg\/(\d+)/.exec(ua)?.[1] ? `Edge ${/Edg\/(\d+)/.exec(ua)[1]}`
    : /(?:HeadlessChrome|Chrome)\/(\d+)/.exec(ua)?.[1] ? `Chromium ${/(?:HeadlessChrome|Chrome)\/(\d+)/.exec(ua)[1]}`
    : /Firefox\/(\d+)/.exec(ua)?.[1] ? `Firefox ${/Firefox\/(\d+)/.exec(ua)[1]}`
    : /Version\/(\d+).*Safari/.exec(ua)?.[1] ? `Safari ${/Version\/(\d+).*Safari/.exec(ua)[1]}` : 'Browser';
  const platform = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /Macintosh/.test(ua) ? 'macOS' : '';
  return `${browser}${platform ? ` / ${platform}` : ''}`;
}

export function benchmarkOrigin(value, recorded = true) {
  const date = new Date(value.measuredAt).toISOString().slice(0, 10);
  const label = recorded ? value.schema === 'zerocopy-product-catalog-browser/v3' ? 'Historical recorded sample' : 'Recorded sample' : 'Your device';
  const dirty = value.buildIdentity?.sourceDirty ? ' · uncommitted build' : '';
  return `<strong>${label}</strong> · ${escape(benchmarkEnvironment(value))} · ${date} · ${escape(value.config.entries.toLocaleString('en-US'))} products · ${escape(value.config.readers)} readers${dirty}`;
}

export function benchmarkRecordingDetails(value) {
  const source = /^[a-f0-9]{40}$/.test(value.sourceCommit) ? `<a href="https://github.com/natanelia/zerocopy/commit/${value.sourceCommit}">${value.sourceCommit.slice(0, 7)}</a>` : escape(value.sourceCommit);
  const sourceState = value.buildIdentity?.sourceDirty === false ? 'committed build' : value.buildIdentity?.sourceDirty === true ? 'uncommitted build' : 'working-tree state unavailable';
  const identity = value.schema === 'zerocopy-product-catalog-browser/v4'
    ? ` · read workload v${escape(value.workloadVersion)} · ${sourceState}${value.assetVerification?.verified ? ' · fetched library, workload and dependency hashes verified' : ''}`
    : ' · historical v3 catalog workload';
  return `${escape(value.environment.userAgent)}<br>${escape(value.environment.hardwareConcurrency)} logical cores reported · source ${source} · Immutable.js ${escape(value.dependencies.immutable)} · Immer ${escape(value.dependencies.immer)} · ${escape(value.measuredAt)}${identity}`;
}
