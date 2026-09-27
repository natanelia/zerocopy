import { RPC, MAX_EVENTS, BATCH_SIZE, generateColumns, appendNative, sharedView, nativeView, rowAt, validateSize } from './explorer-core.mjs';
import { buildShared, appendShared, sharedPayload } from './explorer-storage.mjs';
import { fromColumns, appendImmutable, immutableView, transportColumns } from './immutable-storage.mjs';
import { immutableVersion } from '../vendor/version.mjs';
import { Peer, reply, failure, status } from './explorer-peer.mjs';
import { reference, verifyAnswer } from './explorer-reference.mjs';
import { PATHS, READER_COUNT, validateMode, transferCounts, prefixColumns, validateComparisonQuery } from './comparison-core.mjs';

let groups, columns, snapshot, immutable, frozen, mode, busy = false, operation = 0, revision = 0;
const totals = Object.fromEntries(PATHS.map(path => [path, 0]));
let construction;
function close() { for (const peers of Object.values(groups ?? {})) for (const peer of peers) peer.close(); groups = undefined; }
function count() { return columns?.time.length ?? 0; }
function shownCount() { return frozen?.count ?? count(); }
function laneStatus(path, phase, values = {}) { status(phase, { comparison: true, path, operation, phase, ...values }); }
async function publish(kind, delta) {
  const counts = transferCounts({ total: count(), appended: delta?.time.length ?? 0, initial: kind === 'load', mode, frozen: !!frozen });
  const measurements = {};
  await Promise.all(PATHS.map(async path => {
    const started = performance.now();
    laneStatus(path, 'Publishing');
    if (path === 'shared') {
      if (!frozen) {
        const payload = sharedPayload(snapshot);
        await Promise.all(groups.shared.map(peer => peer.request('shared', { payload })));
      }
    } else if (path === 'immutable') {
      const full = kind === 'load' || mode === 'full';
      // Encoding and receiver List construction belong to publication timing.
      const wire = transportColumns(immutable, full ? 0 : count() - delta.time.length);
      await Promise.all(groups.immutable.map(peer => peer.request(full ? 'immutable-init' : 'immutable-append', { columns: wire })));
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
  const views = { shared: sharedView(frozen?.snapshot ?? snapshot), immutable: immutableView(frozen?.immutable ?? immutable), native: nativeView(columns) };
  views.native.length = viewCount;
  const results = {};
  await Promise.all(PATHS.map(async path => {
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
  // The oracle runs after all paths finish, outside every measured interval.
  const expected = reference(frozen ? prefixColumns(columns, viewCount) : columns, input);
  for (const path of PATHS) verifyAnswer(results[path], expected);
  return { operation, revision, viewRevision: frozen?.revision ?? revision, liveCount: count(), viewCount,
    frozen: !!frozen, mode, query: input, construction, results, verified: true, dependencies: { immutable: immutableVersion },
    method: 'Two readers per path; identical five-column layout and query functions. Immutable.js uses real Lists, batched withMutations appends, and retained roots. Both replica paths default to incremental deltas; full replication is optional. Immutable.js publication includes suffix/full toArray encoding, structured clone, and List reconstruction. Queries read Lists directly. Logical event copies exclude metadata and result pages; they are not memory bytes. Concurrent durations are interaction observations, not controlled benchmark results. Native append-only snapshots retain a prefix length.' };
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
      for (const path of PATHS) totals[path] = 0;
      status('Building all three data representations. No timings shown yet.', { comparison: true, operation });
      let start = performance.now(); columns = generateColumns(0, data.entries); const nativeBuildMs = performance.now() - start;
      start = performance.now(); immutable = fromColumns(columns); const immutableBuildMs = performance.now() - start;
      start = performance.now(); snapshot = await buildShared(data.entries, done => status(`Preparing shared columns: ${done.toLocaleString('en-US')} events`, { comparison: true, operation }));
      construction = { nativeBuildMs, immutableBuildMs, sharedBuildMs: performance.now() - start };
      groups = Object.fromEntries(PATHS.map(path => [path, []]));
      for (const path of PATHS) for (let i = 0; i < READER_COUNT; i++) groups[path].push(new Peer(new URL('./comparison-reader.mjs', import.meta.url)));
      await Promise.all(Object.values(groups).flat().map(peer => peer.request('ping')));
      // Exclude module startup, but not encoding or receiver construction, from publication.
      await Promise.all([
        ...groups.shared.map(peer => peer.request('prepare-shared')),
        ...groups.immutable.map(peer => peer.request('prepare-immutable')),
      ]);
      publication = await publish('load');
    } else {
      if (!groups) throw new Error('Load the comparison first');
      if (data.type === 'append') {
        const length = Math.min(BATCH_SIZE, MAX_EVENTS - count());
        if (!length) throw new RangeError('Session limit reached. Stop and reload to start again.');
        const delta = generateColumns(count(), length);
        snapshot = appendShared(snapshot, delta); immutable = appendImmutable(immutable, delta); appendNative(columns, delta); revision++;
        publication = await publish('append', delta);
      } else if (data.type === 'freeze') {
        if (typeof data.enabled !== 'boolean') throw new TypeError('Expected a freeze flag');
        if (data.enabled && !frozen) {
          frozen = { snapshot, immutable, count: count(), revision };
          await Promise.all(groups.immutable.map(peer => peer.request('retain', { enabled: true })));
        }
        if (!data.enabled && frozen) {
          frozen = undefined;
          await Promise.all(groups.immutable.map(peer => peer.request('retain', { enabled: false })));
          const started = performance.now();
          const payload = sharedPayload(snapshot);
          await Promise.all(groups.shared.map(peer => peer.request('shared', { payload })));
          publication = { measurements: { shared: performance.now() - started, immutable: 0, native: 0 }, counts: Object.fromEntries(PATHS.map(path => [path, { clonedEvents: 0, publishedSnapshots: path === 'shared' ? READER_COUNT : 0 }])) };
        }
      } else if (data.type !== 'query') throw new Error('Unknown comparison operation');
    }
    reply(data.id, await calculate(data.query, publication));
  } catch (error) { close(); failure(data.id, error); }
  finally { busy = false; }
};
