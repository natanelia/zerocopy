import { RPC, MAX_EVENTS, BATCH_SIZE, generateColumns, appendNative, sharedView, nativeView, rowAt, validateSize } from './explorer-core.mjs';
import { buildShared, appendShared, sharedPayload } from './explorer-storage.mjs';
import { Peer, reply, failure, status } from './explorer-peer.mjs';
import { reference, verifyAnswer } from './explorer-reference.mjs';
import { READER_COUNT, validateMode, transferCounts, prefixColumns, validateComparisonQuery } from './comparison-core.mjs';

let groups, columns, snapshot, frozen, mode, busy = false, operation = 0, revision = 0;
const totals = { shared: 0, native: 0 };
let construction;
function close() { for (const peers of Object.values(groups ?? {})) for (const peer of peers) peer.close(); groups = undefined; }
function count() { return columns?.time.length ?? 0; }
function shownCount() { return frozen?.count ?? count(); }
function laneStatus(path, phase, values = {}) { status(phase, { comparison: true, path, operation, phase, ...values }); }
async function publish(kind, delta) {
  const counts = transferCounts({ total: count(), appended: delta?.time.length ?? 0, initial: kind === 'load', mode, frozen: !!frozen });
  const measurements = {};
  await Promise.all(['shared', 'native'].map(async path => {
    const started = performance.now();
    laneStatus(path, 'Publishing');
    if (path === 'shared') {
      if (!frozen) {
        const payload = sharedPayload(snapshot);
        await Promise.all(groups.shared.map(peer => peer.request('shared', { payload })));
      }
    } else if (kind === 'load' || mode === 'full') {
      await Promise.all(groups.native.map(peer => peer.request('native', { columns })));
    } else if (delta) await Promise.all(groups.native.map(peer => peer.request('append', { columns: delta })));
    measurements[path] = performance.now() - started;
    totals[path] += counts[path].clonedEvents;
    laneStatus(path, 'Attached', { transfer: counts[path], cumulativeClonedEvents: totals[path], publishMs: measurements[path] });
  }));
  return { measurements, counts };
}
async function calculate(query, publication) {
  const input = validateComparisonQuery(query), viewCount = shownCount();
  const views = { shared: sharedView(frozen?.snapshot ?? snapshot), native: nativeView(columns) };
  views.native.length = viewCount;
  const results = {};
  await Promise.all(['shared', 'native'].map(async path => {
    laneStatus(path, 'Searching + summarizing');
    const start = performance.now();
    const [found, summary] = await Promise.all([
      groups[path][0].request('query', { role: 'search', query: input, count: viewCount }),
      groups[path][1].request('query', { role: 'summary', query: input, count: viewCount }),
    ]);
    const answer = { search: found.search, summary: summary.summary, rows: found.search.indices.map(index => rowAt(views[path], index)) };
    const queryMs = performance.now() - start;
    results[path] = { ...answer, queryMs, workers: { searchMs: found.elapsedMs, summaryMs: summary.elapsedMs },
      publishMs: publication?.measurements[path] ?? 0, transfer: publication?.counts[path] ?? { clonedEvents: 0, publishedSnapshots: 0 },
      cumulativeClonedEvents: totals[path] };
    laneStatus(path, 'Completed; checking outputs', { queryMs });
  }));
  // The oracle is deliberately outside the measured work and runs after both sides finish.
  const expected = reference(frozen ? prefixColumns(columns, viewCount) : columns, input);
  for (const path of ['shared', 'native']) verifyAnswer(results[path], expected);
  return { operation, revision, viewRevision: frozen?.revision ?? revision, liveCount: count(), viewCount,
    frozen: !!frozen, mode, query: input, construction, results, verified: true,
    method: 'Two real readers per path, identical generated columns, concurrent execution. Native defaults to incremental deltas. Logical event copies exclude metadata and result pages; they are not memory bytes. Durations are observations of this interaction, not controlled benchmark results. Native append-only snapshots retain a prefix length.' };
}
self.onmessage = async ({ data }) => {
  if (data?.protocol !== RPC) return;
  if (busy) { failure(data.id, new Error('Comparison already has an operation')); return; }
  busy = true; operation++;
  try {
    let publication;
    if (data.type === 'load') {
      if (groups) throw new Error('Stop before loading another dataset');
      validateSize(data.entries); mode = validateMode(data.mode); frozen = undefined; revision = 1;
      totals.shared = totals.native = 0;
      status('Building the two data representations. No timings shown yet.', { comparison: true, operation });
      let start = performance.now(); columns = generateColumns(0, data.entries); const nativeBuildMs = performance.now() - start;
      start = performance.now(); snapshot = await buildShared(data.entries, done => status(`Preparing shared columns: ${done.toLocaleString('en-US')} events`, { comparison: true, operation }));
      construction = { nativeBuildMs, sharedBuildMs: performance.now() - start };
      groups = Object.fromEntries(['shared', 'native'].map(path => [path, Array.from({ length: READER_COUNT }, () => new Peer(new URL('./comparison-reader.mjs', import.meta.url)))]));
      await Promise.all(Object.values(groups).flat().map(peer => peer.request('ping')));
      // Load the engine only in shared readers, before publication is timed.
      await Promise.all(groups.shared.map(peer => peer.request('prepare-shared')));
      publication = await publish('load');
    } else {
      if (!groups) throw new Error('Load the comparison first');
      if (data.type === 'append') {
        const length = Math.min(BATCH_SIZE, MAX_EVENTS - count());
        if (!length) throw new RangeError('Session limit reached. Stop and reload to start again.');
        const delta = generateColumns(count(), length);
        snapshot = appendShared(snapshot, delta); appendNative(columns, delta); revision++;
        publication = await publish('append', delta);
      } else if (data.type === 'freeze') {
        if (typeof data.enabled !== 'boolean') throw new TypeError('Expected a freeze flag');
        if (data.enabled && !frozen) frozen = { snapshot, count: count(), revision };
        if (!data.enabled && frozen) {
          frozen = undefined;
          const started = performance.now();
          const payload = sharedPayload(snapshot);
          await Promise.all(groups.shared.map(peer => peer.request('shared', { payload })));
          publication = { measurements: { shared: performance.now() - started, native: 0 }, counts: { shared: { clonedEvents: 0, publishedSnapshots: READER_COUNT }, native: { clonedEvents: 0, publishedSnapshots: 0 } } };
        }
      } else if (data.type !== 'query') throw new Error('Unknown comparison operation');
    }
    reply(data.id, await calculate(data.query, publication));
  } catch (error) { close(); failure(data.id, error); }
  finally { busy = false; }
};
