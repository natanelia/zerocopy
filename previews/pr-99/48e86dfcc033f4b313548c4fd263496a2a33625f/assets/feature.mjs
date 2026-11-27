import { checkCapability } from './capability.mjs';
import { KINDS, MAX_REVISION } from './catalog-core.mjs';
import { Peer } from './catalog-peer.mjs';
import { formatMilliseconds, compareElapsed } from './catalog-timings.mjs';
const $ = id => document.getElementById(id);
const kinds = document.querySelector('[data-feature-mode]').dataset.featureMode === 'compare' ? KINDS : ['shared'];
const timingPhases = { read: 'Latest read + validate', build: 'Build collection', handoff: 'Initial handoff', update: 'Replace + handoff' };
const timingSnapshots = new Map();
let timingSequence = 0;
let peers = new Map(), generation = 0, busy = false, stopping = false, ready = false, revision = 0;
checkCapability(() => { ready = true; controls(); });
function controls() {
  $('feature-load').disabled = !ready || busy || peers.size > 0;
  $('feature-count').disabled = busy || peers.size > 0;
  $('feature-phase').disabled = busy || peers.size === 0;
  $('feature-stop').disabled = stopping || (peers.size === 0 && !busy);
  for (const id of ['feature-id', 'feature-query', 'feature-view']) $(id).disabled = busy || peers.size === 0;
  $('feature-edit').disabled = busy || peers.size === 0 || revision >= MAX_REVISION;
}
function status(text, error = false) { $('feature-status').textContent = text; $('feature-status').classList.toggle('feature-error', error); }
function captureTiming(phase, values, key, context) {
  timingSnapshots.set(phase, { context, operation: ++timingSequence, values: new Map(values.map(([kind, value]) => [kind, value[key]])) });
  for (const [kind, value] of values) document.querySelector(`[data-feature-kind="${kind}"] [data-${phase}]`).textContent = formatMilliseconds(value[key]);
}
function captureRead(values, first = false) {
  const revisions = new Set(values.map(([, value]) => value.revision));
  if (revisions.size !== 1) throw new Error('Cannot compare reads from different revisions');
  const context = `${first ? 'First read' : 'Latest read'} · ${$('feature-view').value === 'initial' ? 'retained' : 'current'} revision ${values[0][1].revision} · 1,000 requested IDs · selected ${$('feature-id').value}`;
  captureTiming('read', values, 'ms', context);
}
function renderTiming() {
  const phase = $('feature-phase').value, snapshot = timingSnapshots.get(phase);
  const available = !busy && snapshot && kinds.every(kind => snapshot.values.has(kind));
  const context = busy ? 'Operation in progress. Comparisons will appear after verification.' : available ? snapshot.context : 'No measurement for this phase yet.';
  $('feature-timing-context').textContent = context;
  for (const kind of kinds) {
    const panel = document.querySelector(`[data-feature-kind="${kind}"]`), time = panel.querySelector('[data-timing]');
    panel.querySelector('[data-timing-label]').textContent = timingPhases[phase];
    panel.querySelector('[data-timing-context]').textContent = context;
    time.textContent = available ? formatMilliseconds(snapshot.values.get(kind)) : '—';
    delete time.dataset.elapsedMs; delete time.dataset.operation;
    let delta = busy ? 'Measuring…' : 'Run an operation to compare.';
    if (available) {
      const value = snapshot.values.get(kind), baseline = snapshot.values.get('native');
      if (Number.isFinite(value) && value >= 0) time.dataset.elapsedMs = String(value);
      time.dataset.operation = `${phase}:${snapshot.operation}`;
      const comparison = compareElapsed(value, baseline);
      delta = kind === 'native' ? 'Native baseline · this run' : comparison === '—' ? 'Relative comparison unavailable at this precision.' : `${comparison}. Native: ${formatMilliseconds(baseline)}.`;
    }
    panel.querySelector('[data-delta]').textContent = delta;
  }
}
function clearResults() {
  timingSnapshots.clear(); $('feature-phase').value = 'read';
  $('feature-revision').textContent = $('feature-view-label').textContent = '—';
  $('feature-detail').textContent = 'No product loaded.';
  $('feature-rows').replaceChildren(); $('feature-issues').replaceChildren();
  for (const panel of document.querySelectorAll('.feature-design')) {
    for (const field of ['found', 'invalid', 'unavailable', 'read', 'build', 'handoff', 'update']) panel.querySelector(`[data-${field}]`).textContent = '—';
    panel.querySelector('[data-checked]').textContent = 'No result yet';
    panel.querySelector('[data-fingerprint]').textContent = 'No fingerprint yet.';
    panel.querySelector('[data-read-context]').textContent = 'No completed read yet.';
  }
  renderTiming();
}
function render(values) {
  for (const [kind, result] of values) {
    const panel = document.querySelector(`[data-feature-kind="${kind}"]`), { lookup, validation } = result.answer;
    panel.querySelector('[data-found]').textContent = `${lookup.found} / ${lookup.requested}`;
    panel.querySelector('[data-invalid]').textContent = validation.invalid.toLocaleString();
    panel.querySelector('[data-unavailable]').textContent = validation.unavailable.toLocaleString();
    panel.querySelector('[data-checked]').textContent = `Latest read verified · ${result.verifiedReplies} worker replies`;
    panel.querySelector('[data-fingerprint]').textContent = `Fingerprint ${lookup.fingerprint.toString(16)}`;
    panel.querySelector('[data-read-context]').textContent = timingSnapshots.get('read').context;
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
  const token = generation; busy = true; controls(); renderTiming();
  try { await run(token); }
  catch (error) { if (token === generation) { status(`Operation failed: ${error.message}`, true); await stop(false); } }
  finally { if (token === generation) { busy = false; controls(); renderTiming(); } }
}
async function runQuery() {
  if (!peers.size) return;
  return operation(async token => { status('Reading and validating the selected snapshot…'); const values = await answers(); if (token !== generation) return; captureRead(values); $('feature-phase').value = 'read'; render(values); status('Complete. All requested fields and validation results match the reference.'); });
}
async function stop(showMessage = true) {
  if (stopping) return;
  const token = ++generation, old = peers; peers = new Map(); busy = true; stopping = true; revision = 0;
  const closing = [...old.values()].map(peer => peer.request('stop', {}, 1500).catch(() => {}).finally(() => peer.close()));
  clearResults(); controls();
  if (showMessage) status('Stopping owner and reader workers…');
  await Promise.all(closing);
  if (token === generation) {
    busy = false; stopping = false; controls(); renderTiming();
    if (showMessage) status('Stopped. Owner and reader workers are terminated. Load a new session to continue.');
  }
}
$('feature-load-form').addEventListener('submit', event => {
  event.preventDefault(); if (peers.size || !ready) return;
  void operation(async token => {
    status('Starting catalog owners and real reader workers…');
    for (const kind of kinds) peers.set(kind, new Peer(new URL('./feature-owner.mjs', import.meta.url)));
    controls();
    await Promise.all([...peers].map(([kind, peer]) => peer.request('prepare', { kind, readers: 2 })));
    const setups = await Promise.all([...peers].map(async ([kind, peer]) => [kind, await peer.request('load', { count: Number($('feature-count').value) })]));
    if (token !== generation) return;
    captureTiming('build', setups, 'constructionMs', `Initial load · ${Number($('feature-count').value).toLocaleString()} products · revision 0`);
    captureTiming('handoff', setups, 'publicationMs', 'Initial load · revision 0 · two reader workers');
    $('feature-view').value = 'current'; revision = 0;
    const values = await answers(); if (token !== generation) return;
    captureRead(values, true); $('feature-phase').value = 'read';
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
  if (updates.some(([, update]) => update.revision !== revision)) throw new Error('Cannot compare updates from different revisions');
  captureTiming('update', updates, 'updatePublicationMs', `Replaced 100 products · current revision ${revision} · two reader workers`);
  const values = await answers(); if (token !== generation) return;
  captureRead(values); $('feature-phase').value = 'update';
  render(values); status(`Revision ${revision} published and verified. Initial revision 0 remains available in every implementation.`);
}));
$('feature-phase').addEventListener('change', renderTiming);
$('feature-stop').addEventListener('click', () => void stop());
window.addEventListener('pagehide', () => { void stop(); });
