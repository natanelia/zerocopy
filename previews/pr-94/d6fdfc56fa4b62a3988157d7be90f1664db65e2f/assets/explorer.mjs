import { checkCapability } from './capability.mjs';
import { Peer } from './explorer-peer.mjs';
import { CHANNEL, SERVICES, LEVELS, MAX_EVENTS, PAGE_SIZE, BUCKETS, sharedView, rowAt, assertSameAnswer, normalizeQuery } from './explorer-core.mjs';
const $ = id => document.getElementById(id);
const number = value => value.toLocaleString('en-US');
const clock = value => new Date(value).toISOString().slice(11, 23);
let capability = false, session = 0, owner, searchPeer, summaryPeer, reader, connectionAbort;
let pinned, displayed, active, queued, offset = 0, intent = 0, timeRange = {}, streaming = false, debounce;
let getWorkerData, buildMs;
function say(message) { $('explorer-status').textContent = message; }
function log(message) {
  const item = document.createElement('li'); item.textContent = message; $('explorer-log').prepend(item);
  while ($('explorer-log').children.length > 20) $('explorer-log').lastElementChild.remove();
}
function stateLabel(id, text) { $(id).textContent = text; }
function toggleInputs(enabled) {
  for (const id of ['stream-logs', 'append-logs', 'freeze-logs', 'log-term', 'log-service', 'log-level', 'query-logs']) $(id).disabled = !enabled;
}
function release(message = 'Stopped. Workers terminated and snapshot references released. Garbage collection is not forced.') {
  session++; clearTimeout(debounce); connectionAbort?.abort(); connectionAbort = undefined;
  try { reader?.dispose(); } catch {} reader = undefined;
  owner?.close(); searchPeer?.close(); summaryPeer?.close(); owner = searchPeer = summaryPeer = undefined;
  pinned = displayed = active = queued = undefined; streaming = false; offset = 0; intent++; timeRange = {};
  for (const id of ['owner-state', 'search-state', 'summary-state', 'ui-state']) stateLabel(id, 'Idle');
  toggleInputs(false); $('load-logs').disabled = !capability; $('log-size').disabled = false; $('reset-logs').disabled = true;
  $('stream-logs').textContent = 'Start live events'; $('freeze-logs').textContent = 'Freeze investigation'; $('view-mode').textContent = 'No active investigation';
  $('investigation').setAttribute('aria-busy', 'false'); $('previous-logs').disabled = $('next-logs').disabled = true;
  $('event-detail').textContent = 'No event selected.'; $('log-rows').replaceChildren(); $('log-bars').replaceChildren(); $('service-counts').replaceChildren();
  for (const id of ['live-count', 'view-count']) { $(id).dataset.count = '0'; $(id).textContent = '—'; }
  for (const id of ['match-count', 'error-count', 'mean-latency', 'view-revision', 'query-timing', 'range-start', 'range-end']) $(id).textContent = '—';
  $('clear-time').hidden = true; $('time-selection').textContent = 'Full time range'; say(message);
}
function fail(error) { const message = error?.message ?? String(error); release(`Could not complete the operation: ${message}`); log(message); }
function showLive(snapshot) {
  const count = snapshot.time.size;
  $('live-count').textContent = number(count); $('live-count').dataset.count = String(count);
  $('append-logs').disabled = count >= MAX_EVENTS;
  if (count >= MAX_EVENTS) { streaming = false; $('stream-logs').disabled = true; $('stream-logs').textContent = 'Session limit reached'; stateLabel('owner-state', 'At capacity'); }
  if (!pinned) requestQuery(false);
}
function queryValue() {
  return normalizeQuery({ term: $('log-term').value, service: Number($('log-service').value), level: Number($('log-level').value), offset, ...timeRange });
}
function captureCurrent() { return pinned ?? { snapshot: reader.current, revision: reader.version }; }
function requestQuery(newIntent = true) {
  if (!reader || reader.closed) return;
  if (newIntent) intent++;
  queued = { ...captureCurrent(), query: queryValue(), intent, session };
  pump();
}
async function runOn(peer, role, job) {
  // Reuse one attached snapshot for repeated queries. A different revision needs attachment.
  const payload = peer.snapshotRevision === job.revision ? undefined : getWorkerData(job.snapshot, { copy: false });
  const answer = await peer.request('query', { role, query: job.query, revision: job.revision, payload });
  if (answer.revision !== job.revision || answer.count !== job.snapshot.time.size) throw new Error('Unexpected reader snapshot');
  peer.snapshotRevision = job.revision;
  return answer;
}
async function pump() {
  if (active || !queued || !reader) return;
  const job = active = queued; queued = undefined;
  const start = performance.now();
  stateLabel('search-state', `Reading v${job.revision}`); stateLabel('summary-state', `Reading v${job.revision}`);
  $('investigation').setAttribute('aria-busy', 'true');
  try {
    const [found, summary] = await Promise.all([runOn(searchPeer, 'search', job), runOn(summaryPeer, 'summary', job)]);
    if (job.session !== session) return;
    assertSameAnswer(found.search, summary.summary);
    // Snapshot updates can advance while we work. A changed user intent cannot.
    if (job.intent === intent) {
      displayed = { ...job, found: found.search, summary: summary.summary };
      render(displayed, performance.now() - start);
      log(`v${job.revision}: ${number(job.snapshot.time.size)} events; both readers agree on ${number(found.search.total)} matches.`);
      say(pinned ? 'Investigation frozen. The owner can continue ingesting new events.' : 'Ready. Select a timeline bucket or search for timeout.');
    }
    stateLabel('search-state', `Done v${job.revision}`); stateLabel('summary-state', `Done v${job.revision}`);
  } catch (error) { if (job.session === session) fail(error); }
  finally {
    if (job.session === session) { active = undefined; $('investigation').setAttribute('aria-busy', 'false'); pump(); }
  }
}
function cell(text, className) { const td = document.createElement('td'); td.textContent = text; if (className) td.className = className; return td; }
function inspect(index) {
  if (!displayed) return;
  const row = rowAt(sharedView(displayed.snapshot), index);
  $('event-detail').textContent = JSON.stringify({ event: row.index, time: new Date(row.time).toISOString(), service: SERVICES[row.service], level: LEVELS[row.level], latencyMs: row.latency, message: row.message, snapshot: displayed.revision }, null, 2);
  stateLabel('ui-state', `Local read #${index}`);
}
function render(job, elapsed) {
  const { found, summary, snapshot, revision } = job;
  $('view-count').textContent = `${number(snapshot.time.size)} events`; $('view-count').dataset.count = String(snapshot.time.size);
  $('view-revision').textContent = `v${revision}${pinned ? ' · frozen' : ''}`;
  $('match-count').textContent = number(found.total); $('error-count').textContent = number(summary.errorCount);
  $('mean-latency').textContent = `${found.total ? Math.round(summary.latencySum / found.total) : 0} ms`;
  $('query-timing').textContent = `${elapsed.toFixed(0)} ms · attach + readers + replies`;
  $('log-rows').replaceChildren();
  const view = sharedView(snapshot);
  for (const index of found.indices) {
    const row = rowAt(view, index), tr = document.createElement('tr'); tr.dataset.index = index;
    const messageCell = document.createElement('td'), select = document.createElement('button');
    select.textContent = row.message; select.setAttribute('aria-label', `Inspect event ${index}: ${row.message}`); select.addEventListener('click', () => inspect(index)); messageCell.append(select);
    tr.append(cell(clock(row.time)), cell(LEVELS[row.level], `level-${LEVELS[row.level]}`), cell(SERVICES[row.service]), messageCell, cell(row.latency));
    $('log-rows').append(tr);
  }
  if (!found.indices.length) { const tr = document.createElement('tr'), td = cell('No events match this selection.', 'log-empty'); td.colSpan = 5; tr.append(td); $('log-rows').append(tr); }
  $('page-label').textContent = found.total ? `${number(Math.min(job.query.offset + 1, found.total))}–${number(Math.min(job.query.offset + PAGE_SIZE, found.total))} of ${number(found.total)} matches` : 'No matching events';
  $('previous-logs').disabled = job.query.offset === 0; $('next-logs').disabled = job.query.offset + PAGE_SIZE >= found.total;
  $('event-detail').textContent = 'Select an event from this snapshot.';
  if (found.indices.length) inspect(found.indices[0]);
  const bars = $('log-bars'); bars.replaceChildren(); const maximum = Math.max(1, ...summary.counts);
  summary.counts.forEach((count, index) => {
    const button = document.createElement('button'); button.className = 'timeline-bucket';
    const from = summary.begin + (summary.end - summary.begin) * index / BUCKETS, to = summary.begin + (summary.end - summary.begin) * (index + 1) / BUCKETS;
    button.setAttribute('aria-label', `${clock(from)}: ${number(count)} events, ${number(summary.errors[index])} errors`);
    button.title = button.getAttribute('aria-label'); button.dataset.bucket = index;
    button.style.setProperty('--total', `${100 * count / maximum}%`); button.style.setProperty('--errors', `${100 * summary.errors[index] / maximum}%`);
    const all = document.createElement('i'), errors = document.createElement('i'); all.className = 'bar-all'; errors.className = 'bar-errors'; button.append(all, errors);
    button.addEventListener('click', () => { timeRange = { from, to }; offset = 0; $('clear-time').hidden = false; $('time-selection').textContent = `${clock(from)}–${clock(to)} UTC`; requestQuery(); });
    bars.append(button);
  });
  $('range-start').textContent = clock(summary.begin); $('range-end').textContent = clock(summary.end);
  $('service-counts').replaceChildren(); summary.services.forEach((count, index) => {
    const row = document.createElement('p'); const label = document.createElement('span'), total = document.createElement('strong');
    label.textContent = SERVICES[index]; total.textContent = number(count); row.append(label, total); $('service-counts').append(row);
  });
}
checkCapability(() => { capability = true; $('load-logs').disabled = false; });
$('load-logs').addEventListener('click', async () => {
  if (owner) return;
  const currentSession = ++session;
  $('load-logs').disabled = true; $('log-size').disabled = true; $('reset-logs').disabled = false;
  $('explorer-log').replaceChildren(); say('Preparing the dataset in its owning worker…');
  try {
    const [{ connectSharedSession }, shared] = await Promise.all([import('../library/worker.js'), import('../library/shared.js')]);
    if (currentSession !== session) return;
    getWorkerData = shared.getWorkerData;
    const fatal = error => { if (currentSession === session) fail(error); };
    owner = new Peer(new URL('./explorer-owner.mjs', import.meta.url), data => {
      if (currentSession !== session) return;
      if (data.fatal) { fail(new Error(data.message)); return; }
      if (data.loaded) { say(`Preparing ${number(data.loaded)} / ${number(data.count)} events in the owner…`); stateLabel('owner-state', 'Building'); }
      if (data.capped) { streaming = false; stateLabel('owner-state', 'At capacity'); say(data.message); }
    }, fatal);
    searchPeer = new Peer(new URL('./explorer-reader.mjs', import.meta.url), undefined, fatal);
    summaryPeer = new Peer(new URL('./explorer-reader.mjs', import.meta.url), undefined, fatal);
    connectionAbort = new AbortController();
    const connection = connectSharedSession({ endpoint: owner.worker, channel: CHANNEL, signal: connectionAbort.signal, timeoutMs: 60_000, onError: fatal });
    // Observe both promises immediately so Stop cannot cause an unhandled rejection.
    const [connected, prepared] = await Promise.all([connection, owner.request('load', { entries: Number($('log-size').value) }), searchPeer.request('ping'), summaryPeer.request('ping')]);
    if (currentSession !== session) { connected.dispose(); return; }
    reader = connected; buildMs = prepared.buildMs; reader.subscribe(snapshot => showLive(snapshot));
    toggleInputs(true); stateLabel('owner-state', 'Ready'); $('view-mode').textContent = 'Following live data';
    log(`Built ${number(prepared.count)} events in ${buildMs.toFixed(0)} ms. UI, search, and summary read shared storage.`);
    showLive(reader.current);
  } catch (error) { if (currentSession === session) fail(error); }
});
$('log-query').addEventListener('submit', event => { event.preventDefault(); clearTimeout(debounce); offset = 0; requestQuery(); });
$('log-term').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { offset = 0; requestQuery(); }, 180); });
for (const id of ['log-service', 'log-level']) $(id).addEventListener('change', () => { offset = 0; requestQuery(); });
$('clear-time').addEventListener('click', () => { timeRange = {}; offset = 0; $('clear-time').hidden = true; $('time-selection').textContent = 'Full time range'; requestQuery(); });
$('previous-logs').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); requestQuery(); });
$('next-logs').addEventListener('click', () => { offset += PAGE_SIZE; requestQuery(); });
$('freeze-logs').addEventListener('click', () => {
  if (!reader) return;
  if (pinned) { pinned = undefined; $('freeze-logs').textContent = 'Freeze investigation'; $('view-mode').textContent = 'Following live data'; }
  else { const source = displayed ?? captureCurrent(); pinned = { snapshot: source.snapshot, revision: source.revision }; $('freeze-logs').textContent = 'Return to live'; $('view-mode').textContent = `Frozen at v${pinned.revision} · ingestion continues`; }
  offset = 0; requestQuery();
});
$('append-logs').addEventListener('click', async () => {
  const currentSession = session; $('append-logs').disabled = true;
  try { await owner.request('append'); } catch (error) { if (currentSession === session) fail(error); }
  finally { if (currentSession === session && reader) $('append-logs').disabled = reader.current.time.size >= MAX_EVENTS; }
});
$('stream-logs').addEventListener('click', async () => {
  const currentSession = session; $('stream-logs').disabled = true;
  try {
    const answer = await owner.request('stream', { enabled: !streaming });
    if (currentSession !== session) return;
    streaming = answer.streaming; $('stream-logs').textContent = streaming ? 'Pause live events' : 'Start live events';
    stateLabel('owner-state', streaming ? 'Appending batches' : 'Paused');
  } catch (error) { if (currentSession === session) fail(error); }
  finally { if (currentSession === session && reader) $('stream-logs').disabled = reader.current.time.size >= MAX_EVENTS; }
});
$('reset-logs').addEventListener('click', () => release());
window.addEventListener('pagehide', () => release());
