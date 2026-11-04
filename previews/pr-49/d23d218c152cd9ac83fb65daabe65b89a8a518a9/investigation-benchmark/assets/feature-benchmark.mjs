import { checkCapability } from './capability.mjs';
import { BENCHMARK_CASES } from './catalog-benchmark-core.mjs';
import { Peer } from './catalog-peer.mjs';
import { immutableVersion, immerVersion } from '../vendor/version.mjs';
const $ = id => document.getElementById(id);
const WARMUPS = 2, SAMPLES = 7;
const PHASES = { generationMs: 'Generate the catalog', constructionMs: 'Construct the map', publicationMs: 'Publish the initial map', firstQueryMs: 'First query on fresh readers', repeatQueryMs: 'Repeat the same query', updateMs: 'Replace 100 product objects', editPublicationMs: 'Publish the edited revision', updatePublicationMs: 'Replace and publish 100 products', updatedQueryMs: 'Query the edited revision' };
let current, generation = 0, result, ready = false, running = false;
checkCapability(() => { ready = true; controls(); });
function controls() { $('feature-run').disabled = !ready || running; $('feature-count').disabled = running; $('feature-cancel').hidden = !running; $('feature-export').disabled = !result || running; }
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[3], min: sorted[0], max: sorted[6], p25: (sorted[1] + sorted[2]) / 2, p75: (sorted[4] + sorted[5]) / 2 };
}
function clearPreview(message = 'Not measured on this device yet.') {
  for (const row of document.querySelectorAll('[data-preview-case]')) {
    row.querySelector('[data-preview-ms]').textContent = '—';
    row.querySelector('.feature-timing-fill').style.width = '0%';
  }
  $('feature-preview-status').textContent = message;
}
function render(value) {
  const maxUpdate = Math.max(.001, ...BENCHMARK_CASES.map(({ id }) => value.summary[id].updatePublicationMs.median));
  for (const { id } of BENCHMARK_CASES) {
    const row = document.querySelector(`[data-preview-case="${id}"]`);
    const median = value.summary[id].updatePublicationMs.median;
    row.querySelector('[data-preview-ms]').textContent = `${median.toFixed(2)} ms`;
    row.querySelector('.feature-timing-fill').style.width = `${median / maxUpdate * 100}%`;
  }
  $('feature-preview-status').textContent = 'Measured in this browser: median replace + publication time, seven samples per case.';
  const fragment = document.createDocumentFragment();
  for (const [phase, label] of Object.entries(PHASES)) {
    const section = document.createElement('section'); section.className = 'feature-timing-group'; section.dataset.phase = phase;
    const heading = document.createElement('h2'); heading.textContent = label; section.append(heading);
    const maximum = Math.max(.001, ...BENCHMARK_CASES.map(({ id }) => value.summary[id][phase].max));
    for (const { id, label } of BENCHMARK_CASES) {
      const stats = value.summary[id][phase], row = document.createElement('div'); row.className = 'feature-timing-row'; row.dataset.case = id;
      const name = document.createElement('span'); name.textContent = label;
      const track = document.createElement('div'); track.className = 'feature-timing-track';
      const fill = document.createElement('div'); fill.className = 'feature-timing-fill'; fill.style.width = `${stats.median / maximum * 100}%`; track.append(fill);
      const time = document.createElement('strong'); time.className = 'feature-timing-value'; time.textContent = `${stats.median.toFixed(2)} ms`;
      row.append(name, track, time); section.append(row);
      const detail = document.createElement('p'); detail.className = 'lab-small'; detail.textContent = `${label} range: ${stats.min.toFixed(2)}–${stats.max.toFixed(2)} ms. Median of all seven measured samples.`; section.append(detail);
    }
    fragment.append(section);
  }
  $('feature-benchmark-results').replaceChildren(fragment);
}
async function sample({ id, kind, updateMode }, count, token) {
  const peer = current = new Peer(new URL('./feature-owner.mjs', import.meta.url));
  try {
    await peer.request('prepare', { kind, readers: 2, updateMode: updateMode === 'shared' ? 'incremental' : updateMode });
    const setup = await peer.request('load', { count });
    if (token !== generation) throw new Error('Cancelled');
    const first = await peer.request('query'), repeat = await peer.request('query');
    const edit = await peer.request('edit');
    const updated = await peer.request('query'), initial = await peer.request('query', { frozen: true });
    await peer.request('stop');
    return { caseId: id, kind, updateMode, generationMs: setup.generationMs, constructionMs: setup.constructionMs, publicationMs: setup.publicationMs,
      firstQueryMs: first.ms, repeatQueryMs: repeat.ms, editGenerationMs: edit.generationMs, updateMs: edit.updateMs,
      editPublicationMs: edit.publicationMs, updatePublicationMs: edit.updatePublicationMs, updatedQueryMs: updated.ms,
      publication: { initial: setup.publication, edit: edit.publication }, verification: { first, repeat, updated, initial } };
  } finally { peer.close(); if (current === peer) current = undefined; }
}
$('feature-benchmark-form').addEventListener('submit', async event => {
  event.preventDefault(); if (running || !ready) return;
  const token = ++generation, count = Number($('feature-count').value), raw = [];
  result = undefined; running = true; controls(); $('feature-benchmark-results').replaceChildren(); clearPreview('Measuring seven cases; timings appear only after the full run passes.');
  try {
    for (let round = 0; round < WARMUPS + SAMPLES; round++) {
      for (let offset = 0; offset < BENCHMARK_CASES.length; offset++) {
        const benchmarkCase = BENCHMARK_CASES[(offset + round) % BENCHMARK_CASES.length];
        $('feature-benchmark-status').textContent = `${round < WARMUPS ? 'Warm-up' : 'Measured sample'} ${round < WARMUPS ? round + 1 : round - WARMUPS + 1}/${round < WARMUPS ? WARMUPS : SAMPLES} · ${benchmarkCase.label} · fresh workers`;
        const record = await sample(benchmarkCase, count, token);
        if (token !== generation) return;
        raw.push({ round: round + 1, warmup: round < WARMUPS, ...record });
      }
    }
    const measured = raw.filter(record => !record.warmup);
    result = { schema: 'zerocopy-product-catalog-browser/v2', workload: 'product-catalog', measuredAt: new Date().toISOString(), sourceCommit: document.body.dataset.source,
      dependencies: { immutable: immutableVersion, immer: immerVersion }, environment: { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency },
      config: { entries: count, readers: 2, requestedIds: 1000, foundIds: 910, missingIds: 90, edits: 100, unicodeNameFraction: 0.2, warmups: WARMUPS, samplesPerCase: SAMPLES, retainedRevisions: [0, 1] },
      cases: BENCHMARK_CASES,
      method: 'Synthetic product catalog with product/ IDs, names, categories, metadata, availability, revisions, prices in cents, stock, and currency. Fresh owner and two reader workers per sample. Worker/module startup excluded. Generation and construction separated. Initial publication includes encoding, delivery and attachment of the full map for every replica case. First query accesses fresh reader attachments; repeated query uses the same IDs and may use local JSON caches. Each edit replaces 100 product objects in the owner. Native Map, Immutable.js and Immer each have separate incremental-copy and full-copy cases: incremental publication clones only the 100 changed pairs; full publication clones the entire current dataset into each reader after every edit, including encoding, reconstruction and freezing. SharedMap publishes shared descriptors. Owner updates are identical between copy modes; Native copies its index once to retain the initial revision. Reader replacement preserves the initial root. Publication counts are logical product deliveries, not bytes or local copy counts. Timers end before full-field fingerprints, visible records, and validation outputs are checked against the independent catalog reference. Cases rotate; all warmups and samples retained. No DOM paint or memory measurement.',
      summary: Object.fromEntries(BENCHMARK_CASES.map(({ id }) => [id, Object.fromEntries(Object.keys(PHASES).map(phase => [phase, summarize(measured.filter(record => record.caseId === id).map(record => record[phase]))]))])), raw };
    render(result); $('feature-benchmark-status').textContent = `Complete. All ${SAMPLES * BENCHMARK_CASES.length} measured samples and ${WARMUPS * BENCHMARK_CASES.length} warm-ups passed current and retained-revision checks.`;
  } catch (error) { if (token === generation) { clearPreview('No completed benchmark results.'); $('feature-benchmark-status').textContent = `Run failed: ${error.message}`; } }
  finally { if (token === generation) { running = false; controls(); } }
});
$('feature-cancel').addEventListener('click', () => {
  generation++; current?.close(); current = undefined; running = false; result = undefined; controls();
  clearPreview('Stopped. No partial results are shown.');
  $('feature-benchmark-status').textContent = 'Stopped. No partial run is shown as a completed benchmark.';
});
$('feature-export').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'zerocopy-product-catalog-benchmark.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => {
  generation++; current?.close(); current = undefined; running = false; result = undefined; controls();
  clearPreview('Session released; run the benchmark again for fresh timings.');
  $('feature-benchmark-status').textContent = 'Session released after navigation. Run a new benchmark to continue.';
  $('feature-benchmark-results').replaceChildren();
});
