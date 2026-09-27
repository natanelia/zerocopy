import { checkCapability } from './capability.mjs';
import { Peer } from './explorer-peer.mjs';
const $ = id => document.getElementById(id);
let peer, result, generation = 0;
checkCapability(() => { $('run-investigation-bench').disabled = false; });
function finish() { peer?.close(); peer = undefined; $('run-investigation-bench').disabled = false; $('stop-investigation-bench').hidden = true; $('investigation-size').disabled = false; }
function show(value) {
  result = value; $('investigation-bench-results').replaceChildren();
  for (const [phase, heading] of [['initial', 'Initial sharing'], ['query', 'Query the attached dataset'], ['update', 'Append + publish + query']]) {
    const section = document.createElement('section'); section.className = 'architecture-result';
    const title = document.createElement('h2'); title.textContent = heading; section.append(title);
    const max = Math.max(.001, ...Object.values(value.summary).map(path => path[phase].median));
    for (const [path, label] of [['shared', 'zerocopy · shared snapshots'], ['replicated', 'Native arrays · incremental replicas'], ['centralized', 'Native arrays · one owner']]) {
      const row = document.createElement('div'); row.className = 'result-row'; const summary = value.summary[path][phase];
      const header = document.createElement('div'), name = document.createElement('span'), time = document.createElement('strong');
      name.textContent = label; time.textContent = `${summary.median.toFixed(2)} ms`; header.append(name, time);
      const track = document.createElement('div'); track.className = 'result-track';
      const bar = document.createElement('div'); bar.className = 'result-bar'; bar.style.width = `${summary.median / max * 100}%`; track.append(bar);
      const range = document.createElement('p'); range.className = 'range'; range.textContent = `Middle 50%: ${summary.p25.toFixed(2)}–${summary.p75.toFixed(2)} ms · all 7 samples retained`;
      row.append(header, track, range); section.append(row);
    }
    $('investigation-bench-results').append(section);
  }
  const construction = document.createElement('p'); construction.textContent = `Separate input setup: native ${value.construction.nativeBuildMs.toFixed(2)} ms; shared ${value.construction.sharedBuildMs.toFixed(2)} ms (persistent construction and cooperative yields). Not included in the bars. Lower phase times are better; results apply only to this workload.`;
  $('investigation-bench-results').append(construction);
  $('investigation-bench-status').textContent = 'Complete. All rows, counts, timelines, and summaries match the reference.';
  $('export-investigation-bench').disabled = false;
}
$('investigation-bench-form').addEventListener('submit', async event => {
  event.preventDefault(); if (peer || $('run-investigation-bench').disabled) return;
  const current = ++generation; result = undefined; $('export-investigation-bench').disabled = true;
  $('investigation-bench-results').replaceChildren(); $('run-investigation-bench').disabled = true; $('stop-investigation-bench').hidden = false; $('investigation-size').disabled = true;
  $('investigation-bench-status').textContent = 'Preparing workers…';
  try {
    peer = new Peer(new URL('./explorer-bench-runner.mjs', import.meta.url), data => { if (current === generation) $('investigation-bench-status').textContent = data.message; });
    const value = await peer.request('run', { entries: Number($('investigation-size').value), source: document.body.dataset.source }, 180_000);
    if (current !== generation) return;
    finish(); show(value);
  } catch (error) { if (current === generation) { finish(); $('investigation-bench-status').textContent = `Run failed: ${error.message}`; } }
});
$('stop-investigation-bench').addEventListener('click', async () => {
  generation++; const old = peer; peer = undefined; result = undefined;
  $('investigation-bench-status').textContent = 'Stopped. No partial result is presented as a completed run.';
  $('stop-investigation-bench').hidden = true;
  try { await old?.request('cancel', {}, 1500); } catch {} finally { old?.close(); finish(); }
});
$('export-investigation-bench').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'zerocopy-investigation-benchmark.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => { generation++; peer?.close(); });
