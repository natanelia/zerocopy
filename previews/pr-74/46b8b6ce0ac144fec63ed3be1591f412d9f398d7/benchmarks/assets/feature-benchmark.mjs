import { checkCapability } from './capability.mjs';
import { BENCHMARK_CASES, EDIT_PUBLICATION_PHASES, casesForPhase } from './catalog-benchmark-core.mjs';
import { READ_CASES, READ_WORKLOAD_VERSION } from './catalog-read-workloads.mjs';
import { sampleReadCase } from './read-benchmark-runner.mjs';
import { WARMUPS, SAMPLES, READ_PHASES, summarizeCases } from './catalog-benchmark-results.mjs';
import { benchmarkBars, benchmarkOrigin, benchmarkRecordingDetails } from './benchmark-bars.mjs';
import { queryIds } from './catalog-core.mjs';
import { Peer } from './catalog-peer.mjs';
import { immutableVersion, immerVersion } from '../vendor/version.mjs';

const $ = id => document.getElementById(id);
const LEGACY_PHASES = { generationMs: 'Generate the catalog', constructionMs: 'Construct the map', publicationMs: 'Publish the initial map', firstQueryMs: 'First query on fresh readers', repeatQueryMs: 'Repeat the same query', updateMs: 'Replace 100 product objects', editPublicationMs: 'Publish the edited revision', updatePublicationMs: 'Replace and publish 100 products', updatedQueryMs: 'Query the edited revision' };
const SCHEDULE = [...READ_CASES.map(definition => ({ track: 'reads', definition })), ...BENCHMARK_CASES.map(definition => ({ track: 'legacy', definition }))];
const TOTAL_SAMPLES = SCHEDULE.length * (WARMUPS + SAMPLES);
// Completed evidence stays visible while a new attempt runs. The export always
// belongs to the latest attempt, including its failure or cancellation details.
const recordedPresentation = {
  results: $('feature-benchmark-results').innerHTML,
  origin: $('feature-result-origin')?.innerHTML,
  details: $('feature-recording-details')?.innerHTML,
};
let current, controller, generation = 0, result, activeAttempt, ready = false, running = false, buildIdentity, assetVerification, browserDetails;
let identityGeneration = 0, identityController, identityLoading = false;

function controls() {
  $('feature-run').disabled = !ready || !buildIdentity || running || identityLoading;
  $('feature-count').disabled = running;
  $('feature-cancel').hidden = !running;
  $('feature-export').disabled = !result || running;
  $('feature-export').hidden = !result;
  $('feature-export').textContent = result?.status === 'cancelled' ? 'Download stopped run'
    : result?.status === 'failed' ? 'Download failed run' : 'Download my results';
}
checkCapability(() => { ready = true; controls(); });

async function fetchJSON(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Could not read build identity (${response.status})`);
  return response.json();
}
async function verifyFiles(hashes, baseURL, signal) {
  if (!hashes || !Object.keys(hashes).length) throw new Error('Build identity is missing file hashes');
  const entries = await Promise.all(Object.entries(hashes).map(async ([filename, expected]) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid build file identity');
    const response = await fetch(new URL(filename, baseURL), { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`Could not verify ${filename} (${response.status})`);
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error(`Build mismatch for ${filename}; reload this page before running`);
    return [filename, actual];
  }));
  return Object.fromEntries(entries);
}
async function loadIdentity(runToken = generation, verifyAssets = false) {
  const check = ++identityGeneration;
  identityController?.abort();
  const request = identityController = new AbortController();
  identityLoading = true; buildIdentity = assetVerification = undefined;
  $('feature-build-identity').textContent = verifyAssets ? 'Checking the current source build and fetched files…' : 'Checking the source build metadata…';
  $('feature-build-identity').classList.remove('feature-error'); controls();
  const isCurrent = () => check === identityGeneration && runToken === generation;
  try {
    const value = await fetchJSON(new URL('../../build.json', import.meta.url), request.signal);
    if (!/^[a-f0-9]{40}$/.test(value.sourceCommit) || value.sourceCommit !== document.body.dataset.source) throw new Error('The page and build metadata have different commits; reload this page');
    if (!/^[a-f0-9]{64}$/.test(value.librarySHA256)) throw new Error('Build identity is missing the library hash');
    // Passive setup must not load library/Wasm bytes. The run action repeats
    // metadata checks and verifies every asset before it creates any workers.
    if (!verifyAssets) {
      if (!isCurrent()) return false;
      buildIdentity = value;
      $('feature-build-identity').textContent = `Source ${value.sourceCommit.slice(0, 12)}${value.sourceDirty ? ' · uncommitted build' : ''} · metadata checked · files verified when you run`;
      $('feature-build-identity').title = value.sourceCommit;
      return true;
    }
    const [libraryFilesSHA256, benchmarkFilesSHA256, vendorFilesSHA256] = await Promise.all([
      verifyFiles(value.libraryFilesSHA256, new URL('../library/', import.meta.url), request.signal),
      verifyFiles(value.benchmarkFilesSHA256, new URL('./', import.meta.url), request.signal),
      verifyFiles(value.vendorFilesSHA256, new URL('../vendor/', import.meta.url), request.signal),
    ]);
    const serviceWorker = { policy: 'The shipped isolation service worker forwards to the network and stores no asset cache.' };
    try {
      const container = navigator.serviceWorker;
      const registrations = container ? await container.getRegistrations() : [];
      Object.assign(serviceWorker, { available: !!container, controller: container?.controller?.scriptURL ?? null,
        registrations: registrations.map(item => ({ scope: item.scope, active: item.active?.scriptURL ?? null, state: item.active?.state ?? null })) });
    } catch (error) { Object.assign(serviceWorker, { available: false, inspectionError: error.message }); }
    const environment = { userAgent: navigator.userAgent, platform: navigator.platform, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, language: navigator.language };
    if (navigator.userAgentData?.getHighEntropyValues) {
      try { environment.userAgentData = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList']); }
      catch { environment.userAgentData = { unavailable: true }; }
    }
    if (!isCurrent()) return false;
    assetVerification = { verified: true, checkedAt: new Date().toISOString(), scope: 'Fetched library, dependency and benchmark bytes; already evaluated browser modules are not attested', libraryFilesSHA256, benchmarkFilesSHA256, vendorFilesSHA256, serviceWorker };
    browserDetails = environment; buildIdentity = value;
    $('feature-build-identity').textContent = `Source ${value.sourceCommit.slice(0, 12)}${value.sourceDirty ? ' · uncommitted build' : ''} · fetched library and workload hashes verified · browser versions in export`;
    $('feature-build-identity').title = value.sourceCommit;
    return true;
  } catch (error) {
    if (isCurrent()) {
      buildIdentity = assetVerification = undefined;
      $('feature-build-identity').textContent = `Build verification failed: ${error.message}`;
      $('feature-build-identity').classList.add('feature-error');
      $('feature-benchmark-status').textContent = 'Reload after the build files are available. No measurements have started.';
    }
    return false;
  } finally {
    if (check === identityGeneration) { identityLoading = false; identityController = undefined; controls(); }
  }
}
void loadIdentity();

function render(value) {
  // Create every fragment before publishing any of it, so a rendering failure
  // cannot mix the old source label with new or incomplete charts.
  const bars = benchmarkBars(value), origin = benchmarkOrigin(value, false);
  const details = benchmarkRecordingDetails(value);
  $('feature-benchmark-results').innerHTML = bars;
  if ($('feature-result-origin')) {
    $('feature-result-origin').innerHTML = origin;
    $('feature-result-origin').dataset.resultOrigin = 'device';
  }
  if ($('feature-recording-details')) $('feature-recording-details').innerHTML = details;
  if ($('feature-recorded-export')) $('feature-recorded-export').hidden = true;
}
function restoreRecordedPresentation() {
  $('feature-benchmark-results').innerHTML = recordedPresentation.results;
  if ($('feature-result-origin')) {
    $('feature-result-origin').innerHTML = recordedPresentation.origin;
    $('feature-result-origin').dataset.resultOrigin = 'recorded';
  }
  if ($('feature-recording-details')) $('feature-recording-details').innerHTML = recordedPresentation.details;
  if ($('feature-recorded-export')) $('feature-recorded-export').hidden = false;
}

// Original catalog sampler: measurement boundaries and fingerprints stay intact.
async function sampleLegacy({ id, kind, updateMode }, count, token) {
  const peer = current = new Peer(new URL('./feature-owner.mjs', import.meta.url));
  try {
    await peer.request('prepare', { kind, readers: 2, updateMode: updateMode === 'shared' ? 'incremental' : updateMode });
    const setup = await peer.request('load', { count });
    if (token !== generation) throw new Error('Cancelled');
    const fullCopy = updateMode === 'full';
    const first = fullCopy ? undefined : await peer.request('query');
    const repeat = fullCopy ? undefined : await peer.request('query');
    const edit = await peer.request('edit');
    const updated = await peer.request('query'), initial = await peer.request('query', { frozen: true });
    await peer.request('stop');
    return { caseId: id, kind, updateMode,
      ...(fullCopy ? {} : { generationMs: setup.generationMs, constructionMs: setup.constructionMs, publicationMs: setup.publicationMs,
        firstQueryMs: first.ms, repeatQueryMs: repeat.ms, editGenerationMs: edit.generationMs, updateMs: edit.updateMs, updatedQueryMs: updated.ms }),
      editPublicationMs: edit.publicationMs, updatePublicationMs: edit.updatePublicationMs,
      publication: { initial: setup.publication, edit: edit.publication }, verification: fullCopy ? { updated, initial } : { first, repeat, updated, initial } };
  } finally { peer.close(); if (current === peer) current = undefined; }
}

function createResult(count) {
  const ids = queryIds(count);
  const cases = BENCHMARK_CASES.map(item => ({ ...item, measuredPhases: item.updateMode === 'full' ? EDIT_PUBLICATION_PHASES : Object.keys(LEGACY_PHASES) }));
  const config = { entries: count, readers: 2, requestedIds: ids.length, uniqueIds: new Set(ids).size, foundIds: 910, missingIds: 90, ids,
    edits: 100, revisions: [0, 1], unicodeNameFraction: .2, warmups: WARMUPS, samplesPerCase: SAMPLES,
    cold: 'First query on fresh reader instances; no decoding verification pass before it.',
    warm: 'Immediate repeat of the same IDs on those instances, before correctness checks.' };
  return { schema: 'zerocopy-product-catalog-browser/v4', workload: 'product-catalog', workloadVersion: READ_WORKLOAD_VERSION, status: 'running',
    startedAt: new Date().toISOString(), sourceCommit: document.body.dataset.source, buildIdentity, assetVerification,
    dependencies: { immutable: immutableVersion, immer: immerVersion }, environment: browserDetails, config,
    cases: READ_CASES, schedule: SCHEDULE.map(item => ({ track: item.track, caseId: item.definition.id })), ordering: 'For round r, case offset o uses (o + r) modulo schedule length. Samples run sequentially.',
    timerBoundaries: { localQueries: 'Reader performance.now around runReadQuery, including requested .get/getView/toObject calls, predicates and result capture; excluding response transport and correctness checks. Report max of two parallel local durations; all individual durations retained.',
      roundTrips: 'Owner performance.now through both complete worker replies, including request scheduling and full output transport.',
      constructionToFirstAnswer: 'Each sample: constructionMs + publicationMs + firstRoundTripMs. Excludes worker/module startup, fixture generation, validation, inter-phase RPC and DOM.',
      startup: 'Separately recorded setup elapsed time. Not included in construction-through-first-answer.',
      verification: 'Independent expected output is checked after both first and repeat queries. All rows/fields/counts/misses/order and current/retained revisions are checked.' },
    raw: [], failures: [], execution: [], summary: null,
    legacy: { schema: 'zerocopy-product-catalog-browser/v3', workload: 'product-catalog', sourceCommit: document.body.dataset.source,
      dependencies: { immutable: immutableVersion, immer: immerVersion }, environment: browserDetails,
      config: { ...config, warm: 'Same IDs repeated after the independent owner reference check; no extra reader decoding or validation pass.', retainedRevisions: [0, 1], phaseCaseIds: Object.fromEntries(Object.keys(LEGACY_PHASES).map(phase => [phase, casesForPhase(phase).map(item => item.id)])) }, cases,
      method: 'Unchanged catalog fixture and query workload. Fresh owner and two readers. Worker/module startup excluded. Full-field fingerprint generation occurs INSIDE the query timer; the independent owner reference check occurs AFTER the timer. Query elapsed time includes request/reply messaging and result transport. Four baseline cases measure all nine phases; full-copy variants only measure edited publication and combined edit/publication. Initial replicas clone the full catalog; incremental edits clone 100 pairs, full edits clone the current catalog, SharedMap sends shared descriptors. Full-copy cases still verify current and retained revisions. No DOM or memory measurement.',
      raw: [], summary: null } };
}
$('feature-benchmark-form').addEventListener('submit', async event => {
  event.preventDefault(); if (running || !ready || !buildIdentity || identityLoading) return;
  const token = ++generation, count = Number($('feature-count').value);
  const run = result = createResult(count); controller = new AbortController();
  run.buildIdentity = run.assetVerification = null; run.identityStatus = 'checking'; activeAttempt = { phase: 'build-verification' };
  running = true; controls();
  $('feature-benchmark-progress').max = TOTAL_SAMPLES; $('feature-benchmark-progress').value = 0; $('feature-benchmark-progress').hidden = false;
  let attempt;
  try {
    const verified = await loadIdentity(token, true);
    if (token !== generation) return;
    if (!verified) throw new Error($('feature-build-identity').textContent);
    run.buildIdentity = buildIdentity; run.assetVerification = assetVerification; run.environment = browserDetails;
    run.legacy.environment = browserDetails; run.identityStatus = 'verified';
    for (let round = 0; round < WARMUPS + SAMPLES; round++) {
      for (let offset = 0; offset < SCHEDULE.length; offset++) {
        const { track, definition } = SCHEDULE[(offset + round) % SCHEDULE.length];
        attempt = activeAttempt = { round: round + 1, warmup: round < WARMUPS, sequence: run.execution.length + 1, track, caseId: definition.id };
        $('feature-benchmark-status').textContent = `${round < WARMUPS ? 'Warm-up' : 'Measured sample'} ${round < WARMUPS ? round + 1 : round - WARMUPS + 1}/${round < WARMUPS ? WARMUPS : SAMPLES} · ${definition.label} · ${track === 'legacy' ? 'legacy control' : definition.api} · fresh workers`;
        const record = track === 'legacy' ? await sampleLegacy(definition, count, token) : await sampleReadCase(definition, count, { signal: controller.signal });
        if (token !== generation) return;
        const { track: _, ...sampleOrder } = attempt;
        (track === 'legacy' ? run.legacy.raw : run.raw).push({ ...sampleOrder, ...record });
        run.execution.push({ ...attempt, status: 'passed' });
        $('feature-benchmark-progress').value = run.execution.length;
      }
    }
    run.summary = summarizeCases(run.raw, READ_CASES, () => READ_PHASES);
    run.legacy.summary = summarizeCases(run.legacy.raw, run.legacy.cases, item => item.measuredPhases);
    run.status = 'complete'; run.measuredAt = new Date().toISOString(); run.legacy.measuredAt = run.measuredAt;
    render(run);
    $('feature-benchmark-status').textContent = `Complete. ${SAMPLES * SCHEDULE.length} measured samples and ${WARMUPS * SCHEDULE.length} warm-ups passed current and retained-revision checks. Source ${run.sourceCommit.slice(0, 12)}.`;
  } catch (error) {
    if (token === generation) {
      run.status = 'failed'; run.finishedAt = new Date().toISOString();
      if (run.identityStatus === 'checking') run.identityStatus = 'failed';
      run.summary = run.legacy.summary = null;
      run.failures.push({ ...(attempt ?? activeAttempt), message: error.message, partialSample: error.sample ?? null });
      run.execution.push({ ...(attempt ?? activeAttempt), status: 'failed' });
      $('feature-benchmark-status').textContent = `Run failed: ${error.message}. Export keeps ${run.raw.length + run.legacy.raw.length} completed samples and the failure. The previous completed charts are unchanged.`;
    }
  } finally {
    if (token === generation) { running = false; controller = undefined; activeAttempt = undefined; $('feature-benchmark-progress').hidden = true; controls(); }
  }
});
$('feature-cancel').addEventListener('click', () => {
  if (!running) return;
  if (result) { result.status = 'cancelled'; result.finishedAt = new Date().toISOString(); if (result.identityStatus === 'checking') result.identityStatus = 'cancelled'; result.failures.push({ ...activeAttempt, message: 'Stopped by the user', nextSequence: result.execution.length + 1 }); }
  generation++; identityGeneration++; identityController?.abort(); identityController = undefined; identityLoading = false;
  controller?.abort(); controller = undefined; current?.close(); current = undefined; activeAttempt = undefined; running = false;
  $('feature-benchmark-progress').hidden = true; controls();
  $('feature-benchmark-status').textContent = 'Stopped. The previous completed charts are unchanged. Download the stopped run for partial samples and cancellation details.';
  if (!buildIdentity) void loadIdentity();
});
$('feature-export').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `zerocopy-product-catalog-${result.status}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => {
  generation++; identityGeneration++; identityController?.abort(); identityController = undefined; identityLoading = false; buildIdentity = assetVerification = undefined;
  controller?.abort(); controller = undefined; current?.close(); current = undefined; activeAttempt = undefined; running = false; result = undefined; controls();
  $('feature-benchmark-status').textContent = 'Session released after navigation. Run a new benchmark to continue.';
  $('feature-benchmark-progress').hidden = true; restoreRecordedPresentation();
});

window.addEventListener('pageshow', event => { if (event.persisted) void loadIdentity(); });
