import { checkCapability } from './capability.mjs';
import { KINDS, MAX_REVISION } from './catalog-core.mjs';
import { Peer } from './feature-peer.mjs';
const $ = id => document.getElementById(id);
const kinds = document.querySelector('[data-feature-mode]').dataset.featureMode === 'compare' ? KINDS : ['shared'];
let peers = new Map(), generation = 0, busy = false, stopping = false, ready = false, revision = 0;
checkCapability(() => { ready = true; controls(); });
function controls() {
  $('feature-load').disabled = !ready || busy || peers.size > 0;
  $('feature-count').disabled = busy || peers.size > 0;
  $('feature-stop').disabled = stopping || (peers.size === 0 && !busy);
  for (const id of ['feature-id', 'feature-query', 'feature-view']) $(id).disabled = busy || peers.size === 0;
  $('feature-edit').disabled = busy || peers.size === 0 || revision >= MAX_REVISION;
}
function status(text, error = false) { $('feature-status').textContent = text; $('feature-status').classList.toggle('feature-error', error); }
function clearResults() {
  $('feature-revision').textContent = $('feature-view-label').textContent = '—';
  $('feature-detail').textContent = 'No product loaded.';
  $('feature-rows').replaceChildren(); $('feature-issues').replaceChildren();
  for (const panel of document.querySelectorAll('.feature-design')) {
    for (const field of ['found', 'invalid', 'unavailable', 'read']) panel.querySelector(`[data-${field}]`).textContent = '—';
    panel.querySelector('[data-checked]').textContent = 'No result yet';
    panel.querySelector('[data-cost]').textContent = 'Costs appear after real operations.';
  }
}
function render(values) {
  for (const [kind, result] of values) {
    const panel = document.querySelector(`[data-feature-kind="${kind}"]`), { lookup, validation } = result.answer;
    panel.querySelector('[data-found]').textContent = `${lookup.found} / ${lookup.requested}`;
    panel.querySelector('[data-invalid]').textContent = validation.invalid.toLocaleString();
    panel.querySelector('[data-unavailable]').textContent = validation.unavailable.toLocaleString();
    panel.querySelector('[data-read]').textContent = `${result.ms.toFixed(2)} ms`;
    panel.querySelector('[data-checked]').textContent = `${result.verifiedReplies} worker replies verified · fingerprint ${lookup.fingerprint.toString(16)}`;
  }
  const result = values[0][1], { lookup, validation } = result.answer;
  $('feature-revision').textContent = String(revision); $('feature-view-label').textContent = `${result.revision === 0 && $('feature-view').value === 'initial' ? 'Initial' : 'Current'} · revision ${result.revision}`;
  const selected = lookup.rows.find(row => row.id === $('feature-id').value);
  $('feature-detail').textContent = selected ? JSON.stringify({ id: selected.id, ...selected.value }, null, 2) : `No record for ${$('feature-id').value}`;
  $('feature-rows').replaceChildren(...lookup.rows.map(({ id, value }) => {
    const row = document.createElement('tr');
    const key = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.textContent = id;
    button.addEventListener('click', () => { if (!busy) { $('feature-id').value = id; void runQuery(); } }); key.append(button); row.append(key);
    for (const text of [value.name, value.status, value.attributes.priceCents, value.revision]) { const cell = document.createElement('td'); cell.textContent = String(text); row.append(cell); }
    return row;
  }));
  $('feature-issues').replaceChildren(...(validation.issues.length ? validation.issues.map(issue => `${issue.id}: ${issue.errors.join('; ')}`) : ['No invalid records in this selection.']).map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
}
async function answers() { return Promise.all([...peers].map(async ([kind, peer]) => [kind, await peer.request('query', { selected: $('feature-id').value, frozen: $('feature-view').value === 'initial' })])); }
async function operation(run) {
  if (busy) return;
  const token = generation; busy = true; controls();
  try { await run(token); }
  catch (error) { if (token === generation) { status(`Operation failed: ${error.message}`, true); await stop(false); } }
  finally { if (token === generation) { busy = false; controls(); } }
}
async function runQuery() {
  if (!peers.size) return;
  return operation(async token => { status('Reading and validating the selected snapshot…'); const values = await answers(); if (token !== generation) return; render(values); status('Complete. All requested fields and validation results match the reference.'); });
}
async function stop(showMessage = true) {
  if (stopping) return;
  const token = ++generation, old = peers; peers = new Map(); busy = true; stopping = true; revision = 0;
  const closing = [...old.values()].map(peer => peer.request('stop', {}, 1500).catch(() => {}).finally(() => peer.close()));
  clearResults(); controls();
  if (showMessage) status('Stopping owner and reader workers…');
  await Promise.all(closing);
  if (token === generation) {
    busy = false; stopping = false; controls();
    if (showMessage) status('Stopped. Owner and reader workers are terminated. Load a new session to continue.');
  }
}
$('feature-load-form').addEventListener('submit', event => {
  event.preventDefault(); if (peers.size || !ready) return;
  void operation(async token => {
    status('Starting map owners and real reader workers…');
    for (const kind of kinds) peers.set(kind, new Peer(new URL('./feature-owner.mjs', import.meta.url)));
    controls();
    await Promise.all([...peers].map(([kind, peer]) => peer.request('prepare', { kind, readers: 2 })));
    const setups = await Promise.all([...peers].map(async ([kind, peer]) => [kind, await peer.request('load', { count: Number($('feature-count').value) })]));
    if (token !== generation) return;
    for (const [kind, setup] of setups) document.querySelector(`[data-feature-kind="${kind}"] [data-cost]`).textContent = `Generate ${setup.generationMs.toFixed(2)} ms · construct ${setup.constructionMs.toFixed(2)} ms · publish ${setup.publicationMs.toFixed(2)} ms`;
    $('feature-view').value = 'current'; revision = 0;
    const values = await answers(); if (token !== generation) return;
    render(values); status('Loaded and verified. Replace 100 products, then switch to the retained initial revision.');
  });
});
$('feature-query-form').addEventListener('submit', event => { event.preventDefault(); void runQuery(); });
$('feature-view').addEventListener('change', () => void runQuery());
$('feature-edit').addEventListener('click', () => void operation(async token => {
  status('Replacing 100 product records and publishing the new revision…');
  const updates = await Promise.all([...peers].map(async ([kind, peer]) => [kind, await peer.request('edit')]));
  if (token !== generation) return;
  revision = updates[0][1].revision;
  for (const [kind, update] of updates) document.querySelector(`[data-feature-kind="${kind}"] [data-cost]`).textContent = `Edit ${update.updateMs.toFixed(2)} ms · publish ${update.publicationMs.toFixed(2)} ms · 100 replacements`;
  const values = await answers(); if (token !== generation) return;
  render(values); status(`Revision ${revision} published and verified. Initial revision 0 remains available in every map.`);
}));
$('feature-stop').addEventListener('click', () => void stop());
window.addEventListener('pagehide', () => { void stop(); });
