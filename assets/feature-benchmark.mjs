import { checkCapability } from './capability.mjs';
import { KINDS, LABELS } from './catalog-core.mjs';
import { Peer } from './catalog-peer.mjs';
import { immutableVersion, immerVersion } from '../vendor/version.mjs';
const $ = id => document.getElementById(id);
const WARMUPS = 2, SAMPLES = 7;
const PHASES = { generationMs: 'Generate the catalog', constructionMs: 'Construct the map', publicationMs: 'Publish the initial map', firstQueryMs: 'First query on fresh readers', repeatQueryMs: 'Repeat the same query', updateMs: 'Replace 100 product objects', editPublicationMs: 'Publish the sparse edit', updatePublicationMs: 'Replace and publish 100 products', updatedQueryMs: 'Query the edited revision' };
let current, generation = 0, result, ready = false, running = false;
checkCapability(() => { ready = true; controls(); });
function controls() { $('feature-run').disabled = !ready || running; $('feature-count').disabled = running; $('feature-cancel').hidden = !running; $('feature-export').disabled = !result || running; }
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[3], min: sorted[0], max: sorted[6], p25: (sorted[1] + sorted[2]) / 2, p75: (sorted[4] + sorted[5]) / 2 };
}
function render(value) {
  const fragment = document.createDocumentFragment();
  for (const [phase, label] of Object.entries(PHASES)) {
    const section = document.createElement('section'); section.className = 'feature-timing-group';
    const heading = document.createElement('h2'); heading.textContent = label; section.append(heading);
    const maximum = Math.max(.001, ...KINDS.map(kind => value.summary[kind][phase].max));
    for (const kind of KINDS) {
      const stats = value.summary[kind][phase], row = document.createElement('div'); row.className = 'feature-timing-row';
      const name = document.createElement('span'); name.textContent = LABELS[kind];
      const track = document.createElement('div'); track.className = 'feature-timing-track';
      const fill = document.createElement('div'); fill.className = 'feature-timing-fill'; fill.style.width = `${stats.median / maximum * 100}%`; track.append(fill);
      const time = document.createElement('strong'); time.className = 'feature-timing-value'; time.textContent = `${stats.median.toFixed(2)} ms`;
      row.append(name, track, time); section.append(row);
      const detail = document.createElement('p'); detail.className = 'lab-small'; detail.textContent = `${LABELS[kind]} range: ${stats.min.toFixed(2)}–${stats.max.toFixed(2)} ms. Median of all seven measured samples.`; section.append(detail);
    }
    fragment.append(section);
  }
  $('feature-benchmark-results').replaceChildren(fragment);
}
async function sample(kind, count, token) {
  const peer = current = new Peer(new URL('./feature-owner.mjs', import.meta.url));
  try {
    await peer.request('prepare', { kind, readers: 2 });
    const setup = await peer.request('load', { count });
    if (token !== generation) throw new Error('Cancelled');
    const first = await peer.request('query'), repeat = await peer.request('query');
    const edit = await peer.request('edit');
    const updated = await peer.request('query'), initial = await peer.request('query', { frozen: true });
    await peer.request('stop');
    return { kind, generationMs: setup.generationMs, constructionMs: setup.constructionMs, publicationMs: setup.publicationMs,
      firstQueryMs: first.ms, repeatQueryMs: repeat.ms, editGenerationMs: edit.generationMs, updateMs: edit.updateMs,
      editPublicationMs: edit.publicationMs, updatePublicationMs: edit.updatePublicationMs, updatedQueryMs: updated.ms,
      verification: { first, repeat, updated, initial } };
  } finally { peer.close(); if (current === peer) current = undefined; }
}
$('feature-benchmark-form').addEventListener('submit', async event => {
  event.preventDefault(); if (running || !ready) return;
  const token = ++generation, count = Number($('feature-count').value), raw = [];
  result = undefined; running = true; controls(); $('feature-benchmark-results').replaceChildren();
  try {
    for (let round = 0; round < WARMUPS + SAMPLES; round++) {
      for (let offset = 0; offset < KINDS.length; offset++) {
        const kind = KINDS[(offset + round) % KINDS.length];
        $('feature-benchmark-status').textContent = `${round < WARMUPS ? 'Warm-up' : 'Measured sample'} ${round < WARMUPS ? round + 1 : round - WARMUPS + 1}/${round < WARMUPS ? WARMUPS : SAMPLES} · ${LABELS[kind]} · fresh workers`;
        const record = await sample(kind, count, token);
        if (token !== generation) return;
        raw.push({ round: round + 1, warmup: round < WARMUPS, ...record });
      }
    }
    const measured = raw.filter(record => !record.warmup);
    result = { schema: 'zerocopy-product-catalog-browser/v1', workload: 'product-catalog', measuredAt: new Date().toISOString(), sourceCommit: document.body.dataset.source,
      dependencies: { immutable: immutableVersion, immer: immerVersion }, environment: { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency },
      config: { entries: count, readers: 2, requestedIds: 1000, foundIds: 910, missingIds: 90, edits: 100, unicodeNameFraction: 0.2, warmups: WARMUPS, samplesPerKind: SAMPLES, retainedRevisions: [0, 1] },
      method: 'Synthetic product catalog with product/ IDs, names, categories, metadata, availability, revisions, prices in cents, stock, and currency. Fresh owner and two reader workers per sample. Worker/module startup excluded. Generation and construction separated. Initial publication includes encoding, delivery and attachment. First query accesses fresh reader attachments; repeated query uses the same IDs and may use local JSON caches. Edits replace 100 product objects; replica workers receive only changed pairs. Native copies its index once to retain initial revision. Timers end before full-field fingerprints, visible records, and validation outputs are checked against the independent catalog reference. Paths rotate; all warmups and samples retained. No DOM paint or memory measurement.',
      summary: Object.fromEntries(KINDS.map(kind => [kind, Object.fromEntries(Object.keys(PHASES).map(phase => [phase, summarize(measured.filter(record => record.kind === kind).map(record => record[phase]))]))])), raw };
    render(result); $('feature-benchmark-status').textContent = 'Complete. All 28 measured samples and 8 warm-ups passed current and retained-revision checks.';
  } catch (error) { if (token === generation) $('feature-benchmark-status').textContent = `Run failed: ${error.message}`; }
  finally { if (token === generation) { running = false; controls(); } }
});
$('feature-cancel').addEventListener('click', () => {
  generation++; current?.close(); current = undefined; running = false; result = undefined; controls();
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
  $('feature-benchmark-status').textContent = 'Session released after navigation. Run a new benchmark to continue.';
  $('feature-benchmark-results').replaceChildren();
});
