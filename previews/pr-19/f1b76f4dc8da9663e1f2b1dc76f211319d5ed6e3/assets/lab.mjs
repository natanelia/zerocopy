import { checkCapability } from './capability.mjs';
import { notify } from './main.mjs';
import { BENCHMARK_PATHS, BENCHMARK_LABELS } from './bench-core.mjs';
const runButton = document.querySelector('#run-benchmark'), cancelButton = document.querySelector('#cancel-benchmark');
const status = document.querySelector('#benchmark-status'), progress = document.querySelector('#benchmark-progress');
let worker, lastResult, watchdog;
checkCapability(() => { runButton.disabled = false; });
function finish() {
  clearTimeout(watchdog); worker?.terminate(); worker = undefined;
  runButton.disabled = false; cancelButton.hidden = true;
  document.querySelectorAll('#benchmark-form select').forEach(input => input.disabled = false);
}
function fail(message) { finish(); status.textContent = message; progress.hidden = true; document.querySelector('#benchmark-chart').textContent = 'No completed result for this run.'; }
function show(result) {
  lastResult = result;
  const chart = document.querySelector('#benchmark-chart'); chart.replaceChildren();
  const max = Math.max(...BENCHMARK_PATHS.map(path => result.summary[path].median), .001);
  const format = value => value.toFixed(2);
  for (const key of BENCHMARK_PATHS) {
    const summary = result.summary[key];
    const row = document.createElement('div'); row.className = `result-row ${key}`;
    const heading = document.createElement('div'), name = document.createElement('span'), time = document.createElement('strong');
    name.textContent = BENCHMARK_LABELS[key]; time.textContent = `${format(summary.median)} ms`; heading.append(name, time);
    const track = document.createElement('div'); track.className = 'result-track';
    const bar = document.createElement('div'); bar.className = 'result-bar'; bar.style.width = `${summary.median / max * 100}%`; track.append(bar);
    const range = document.createElement('p'); range.className = 'range'; range.textContent = `Middle 50%: ${format(summary.p25)}–${format(summary.p75)} ms · median of 7 samples`;
    row.append(heading, track, range); chart.append(row);
  }
  const summary = document.querySelector('#benchmark-summary'); summary.hidden = false;
  const ranked = [...BENCHMARK_PATHS].sort((a, b) => result.summary[a].median - result.summary[b].median);
  const fastest = result.summary[ranked[0]].median, next = result.summary[ranked[1]].median;
  summary.textContent = (next - fastest) / Math.max(next, .001) < .05 ? 'The two fastest medians are similar in this run. Do not treat a small difference as an established win.'
    : `${BENCHMARK_LABELS[ranked[0]]} finished sooner in this run. This is your workload sample, not a general speed claim.`;
  const detail = document.querySelector('#benchmark-detail'); detail.replaceChildren();
  const note = document.createElement('p'); note.textContent = `${result.config.entries.toLocaleString()} entries × ${result.config.readers} readers. All checksums passed. Lower times are better.`; detail.append(note);
  const builds = document.createElement('details'), caption = document.createElement('summary'); caption.textContent = 'One-time construction (excluded from bars)'; builds.append(caption);
  const text = document.createElement('p'); text.textContent = BENCHMARK_PATHS.map(path => `${BENCHMARK_LABELS[path]}: ${format(result.construction[path + 'Ms'])} ms`).join('. ') + '. Immutable.js and Immer use batch construction; zerocopy uses persistent sets. These are setup costs, not an equivalent immutable-update comparison.'; builds.append(text); detail.append(builds);
  status.textContent = 'Complete. All outputs match. Raw samples are available below.';
  document.querySelector('#export-results').disabled = false;
}
document.querySelector('#benchmark-form').addEventListener('submit', event => {
  event.preventDefault(); if (worker || runButton.disabled) return;
  lastResult = undefined; document.querySelector('#export-results').disabled = true;
  document.querySelector('#benchmark-chart').textContent = 'Measuring all three paths…';
  document.querySelector('#benchmark-summary').hidden = true; document.querySelector('#benchmark-detail').replaceChildren();
  runButton.disabled = true; cancelButton.hidden = false; progress.hidden = false; progress.value = 0;
  status.textContent = 'Starting a dedicated coordinator and readers…';
  document.querySelectorAll('#benchmark-form select').forEach(input => input.disabled = true);
  try {
    worker = new Worker(new URL('./bench-runner.mjs', import.meta.url), { type: 'module' });
    const currentWorker = worker;
    worker.onmessage = ({ data }) => {
      if (worker !== currentWorker) return;
      if (data.type === 'status') { status.textContent = data.message; progress.max = data.total ?? 27; progress.value = data.completed; }
      if (data.type === 'result') { finish(); show(data.result); progress.hidden = true; }
      if (data.type === 'error') fail(`Run failed: ${data.message}`);
    };
    worker.onerror = event => { if (worker === currentWorker) fail(`Worker failed: ${event.message ?? 'Unable to load the worker. Check isolation headers and worker script access.'}`); };
    worker.onmessageerror = () => { if (worker === currentWorker) fail('Worker returned an unreadable message.'); };
    watchdog = setTimeout(() => fail('Run exceeded the two-minute limit. Use fewer entries or readers.'), 120000);
    worker.postMessage({ type: 'run', config: { entries: Number(document.querySelector('#entries').value), readers: Number(document.querySelector('#readers').value) }, source: document.body.dataset.source });
  } catch (error) { fail(`Could not start: ${error.message}`); }
});
cancelButton.addEventListener('click', () => { worker?.postMessage({ type: 'cancel' }); fail('Stopped. No partial result is presented as a completed run.'); });
document.querySelector('#export-results').addEventListener('click', () => {
  if (!lastResult) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'zerocopy-browser-benchmark.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Raw results exported.');
});
window.addEventListener('pagehide', () => { clearTimeout(watchdog); worker?.terminate(); });
