import { checkCapability } from './capability.mjs';
import { Peer } from './explorer-peer.mjs';
import { SERVICES, LEVELS, PAGE_SIZE, MAX_EVENTS, BUCKETS } from './explorer-core.mjs';
const $ = id => document.getElementById(id);
const number = n => n.toLocaleString('en-US');
const ms = n => `${n.toFixed(1)} ms`;
let ready = false, peer, busy = false, loaded = false, generation = 0, intent = 0, queued, last, offset = 0, timeRange = {}, streaming = false, timer;
function query() { return { term: $('compare-term').value, service: Number($('compare-service').value), level: Number($('compare-level').value), offset, ...timeRange }; }
function controls() {
  $('compare-start').disabled = !ready || !!peer;
  $('compare-stop').disabled = !peer;
  for (const id of ['compare-size', 'compare-mode']) $(id).disabled = !!peer;
  for (const id of ['compare-term', 'compare-service', 'compare-level', 'compare-query']) $(id).disabled = !loaded;
  for (const id of ['compare-append', 'compare-stream', 'compare-freeze']) $(id).disabled = !loaded || busy || (id !== 'compare-freeze' && last?.liveCount >= MAX_EVENTS);
  $('compare-previous').disabled = !loaded || busy || offset === 0;
  $('compare-next').disabled = !loaded || busy || !last || offset + PAGE_SIZE >= last.results.shared.search.total;
  $('compare-export').disabled = busy || !last;
  $('comparison-workspace').setAttribute('aria-busy', String(busy));
}
function stop(message = 'Stopped. Workers terminated and snapshot references released.') {
  generation++; intent++; clearTimeout(timer); streaming = false; queued = undefined;
  peer?.close(); peer = undefined; last = undefined; loaded = false; busy = false; offset = 0; timeRange = {};
  $('compare-status').textContent = message; $('compare-stream').textContent = 'Start live events';
  $('compare-clear').hidden = true;
  $('compare-freeze').textContent = 'Freeze both views'; $('compare-view').textContent = 'Following live data';
  $('compare-parity').textContent = 'No active comparison.'; $('compare-parity').removeAttribute('data-verified');
  for (const id of ['compare-live', 'compare-count']) { $(id).textContent = '—'; $(id).dataset.count = '0'; }
  for (const path of ['shared', 'native']) {
    $(`lane-${path}`).setAttribute('aria-busy', 'false'); $(`phase-${path}`).textContent = 'Stopped';
    for (const field of ['matches', 'query', 'publish', 'copies']) $(`${field}-${path}`).textContent = '—';
    $(`rows-${path}`).replaceChildren(); $(`timeline-${path}`).replaceChildren(); $(`detail-${path}`).textContent = 'No retained result.';
  }
  controls();
}
function report(data) {
  if (!data.comparison || !data.path) { if (data.message) $('compare-status').textContent = data.message; return; }
  $(`phase-${data.path}`).textContent = data.phase;
  $(`lane-${data.path}`).setAttribute('aria-busy', String(!data.phase.startsWith('Completed') && data.phase !== 'Attached'));
}
function showLane(path, result) {
  $(`phase-${path}`).textContent = 'Complete · reference checked'; $(`lane-${path}`).setAttribute('aria-busy', 'false');
  $(`matches-${path}`).textContent = number(result.search.total); $(`query-${path}`).textContent = ms(result.queryMs);
  $(`publish-${path}`).textContent = ms(result.publishMs); $(`copies-${path}`).textContent = number(result.cumulativeClonedEvents);
  $(`flow-${path}`).textContent = path === 'shared' ? 'Shared roots →' : last.mode === 'incremental' ? 'Cloned deltas →' : 'Full copies →';
  $(`delivery-${path}`).textContent = `${number(result.transfer.clonedEvents)} event copies this action · ${result.transfer.publishedSnapshots} snapshot/delta deliveries. Counter excludes result pages and metadata.`;
  const body = $(`rows-${path}`); body.replaceChildren();
  for (const row of result.rows) {
    const tr = document.createElement('tr'); tr.dataset.index = String(row.index);
    const id = document.createElement('td'), select = document.createElement('button'); select.type = 'button'; select.textContent = String(row.index);
    select.addEventListener('click', () => inspect(row.index)); id.append(select); tr.append(id);
    for (const text of [SERVICES[row.service], row.message]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    body.append(tr);
  }
  if (!result.rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 3; td.textContent = 'No matching events.'; tr.append(td); body.append(tr); }
  const chart = $(`timeline-${path}`); chart.replaceChildren();
  const maximum = Math.max(1, ...result.summary.errors);
  result.summary.errors.forEach((count, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.style.setProperty('--height', `${Math.max(2, count / maximum * 100)}%`);
    const label = `Bucket ${index + 1}: ${number(count)} errors. Filter both views.`;
    button.title = label; button.setAttribute('aria-label', label);
    button.addEventListener('click', () => {
      const step = (result.summary.end - result.summary.begin) / BUCKETS;
      timeRange = { from: result.summary.begin + index * step, to: result.summary.begin + (index + 1) * step };
      offset = 0; $('compare-clear').hidden = false; enqueue('query');
    }); chart.append(button);
  });
}
function inspect(index) {
  for (const path of ['shared', 'native']) {
    const row = last?.results[path].rows.find(row => row.index === index);
    $(`detail-${path}`).textContent = row ? JSON.stringify({ ...row, service: SERVICES[row.service], level: LEVELS[row.level] }, null, 2) : 'No selected event.';
  }
}
function render(value) {
  last = value;
  for (const [id, count] of [['compare-live', value.liveCount], ['compare-count', value.viewCount]]) { $(id).textContent = number(count); $(id).dataset.count = String(count); }
  $('compare-view').textContent = value.frozen ? `Frozen at v${value.viewRevision}` : `Following live v${value.viewRevision}`;
  $('compare-freeze').textContent = value.frozen ? 'Return both to live' : 'Freeze both views';
  $('compare-parity').textContent = 'Same answer verified: result page, matches, errors, services, latency totals, and all timeline buckets.';
  $('compare-parity').dataset.verified = 'true';
  for (const path of ['shared', 'native']) showLane(path, value.results[path]);
  if (value.results.shared.rows.length) inspect(value.results.shared.rows[0].index);
  else for (const path of ['shared', 'native']) $(`detail-${path}`).textContent = 'No matching event.';
  $('compare-page').textContent = `${number(offset + (value.results.shared.rows.length ? 1 : 0))}–${number(offset + value.results.shared.rows.length)} of ${number(value.results.shared.search.total)} matches on both sides`;
  $('compare-construction').textContent = `Initial construction: shared ${ms(value.construction.sharedBuildMs)}; native ${ms(value.construction.nativeBuildMs)}. Shared includes cooperative build yields. These are not equal-operation timings.`;
}
function scheduleStream() {
  clearTimeout(timer);
  if (!streaming || !loaded) return;
  if (last?.liveCount >= MAX_EVENTS) { streaming = false; $('compare-stream').textContent = 'Session limit reached'; return; }
  timer = setTimeout(() => { if (!busy && !queued) enqueue('append'); else scheduleStream(); }, 1000);
}
function enqueue(type, extra = {}) {
  const job = { type, extra, query: query(), intent: ++intent };
  $('compare-parity').removeAttribute('data-verified'); $('compare-parity').textContent = 'Updating both views…';
  if (busy) { queued = job; return; }
  void execute(job);
}
async function execute(job) {
  if (!peer) return;
  busy = true; controls(); const current = generation;
  try {
    const answer = await peer.request(job.type, { ...job.extra, query: job.query });
    if (current !== generation) return;
    loaded = true;
    if (job.intent === intent) { render(answer); $('compare-status').textContent = 'Complete. Both paths ran real work; all outputs match.'; }
  } catch (error) { if (current === generation) stop(`Comparison stopped: ${error.message}`); }
  finally {
    if (current === generation) {
      busy = false; controls();
      if (queued) { const next = queued; queued = undefined; void execute(next); }
      else scheduleStream();
    }
  }
}
checkCapability(() => { ready = true; controls(); });
$('compare-start').addEventListener('click', () => {
  if (peer || !ready) return;
  const current = ++generation;
  try {
    peer = new Peer(new URL('./comparison-runner.mjs', import.meta.url), data => { if (current === generation) report(data); }, error => { if (current === generation) stop(error.message); });
    enqueue('load', { entries: Number($('compare-size').value), mode: $('compare-mode').value });
  } catch (error) { stop(error.message); }
});
$('compare-form').addEventListener('submit', event => { event.preventDefault(); offset = 0; enqueue('query'); });
for (const id of ['compare-service', 'compare-level']) $(id).addEventListener('change', () => { offset = 0; enqueue('query'); });
$('compare-clear').addEventListener('click', () => { timeRange = {}; offset = 0; $('compare-clear').hidden = true; enqueue('query'); });
$('compare-append').addEventListener('click', () => enqueue('append'));
$('compare-freeze').addEventListener('click', () => { offset = 0; enqueue('freeze', { enabled: !last?.frozen }); });
$('compare-stream').addEventListener('click', () => { streaming = !streaming; $('compare-stream').textContent = streaming ? 'Pause live events' : 'Start live events'; scheduleStream(); });
$('compare-previous').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); enqueue('query'); });
$('compare-next').addEventListener('click', () => { offset += PAGE_SIZE; enqueue('query'); });
$('compare-stop').addEventListener('click', () => stop());
$('compare-export').addEventListener('click', () => {
  if (!last) return;
  const result = { schema: 'zerocopy-live-comparison/v1', sourceCommit: document.body.dataset.source, timestamp: new Date().toISOString(), userAgent: navigator.userAgent, ...last };
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'zerocopy-live-comparison.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => stop());
