import { RPC, generateColumns, nativeView, sharedView, rowAt, appendNative, BATCH_SIZE } from './explorer-core.mjs';
import { buildShared, appendShared, sharedPayload } from './explorer-storage.mjs';
import { reference, verifyAnswer } from './explorer-reference.mjs';
import { Peer, reply, failure, status } from './explorer-peer.mjs';
import { summarize } from './bench-core.mjs';
const PATHS = ['shared', 'replicated', 'centralized'];
let peers = [], busy = false, cancelled = false;
function dispose() { for (const peer of peers) peer.close(); peers = []; }
self.onmessage = async ({ data }) => {
  if (data?.protocol !== RPC) return;
  if (data.type === 'cancel') { cancelled = true; dispose(); reply(data.id, true); return; }
  if (data.type !== 'run' || busy) return;
  busy = true;
  try {
    const entries = data.entries;
    if (![1000, 10000, 100000].includes(entries)) throw new RangeError('Choose 1,000, 10,000, or 100,000 events');
    if (!crossOriginIsolated) throw new Error('Shared memory is unavailable');
    status('Preparing identical data and loading workers…');
    let start = performance.now(); const base = generateColumns(0, entries); const nativeBuildMs = performance.now() - start;
    start = performance.now(); const sharedBase = await buildShared(entries, () => { if (cancelled) throw new Error('Cancelled'); });
    const sharedBuildMs = performance.now() - start;
    const delta = generateColumns(entries, BATCH_SIZE);
    const updatedReference = Object.fromEntries(Object.entries(base).map(([field, column]) => [field, column.concat(delta[field])]));
    const groups = {};
    for (const path of PATHS) {
      groups[path] = Array.from({ length: path === 'centralized' ? 1 : 2 }, () => new Peer(new URL('./explorer-reader.mjs', import.meta.url)));
      peers.push(...groups[path]);
    }
    await Promise.all(peers.map(peer => peer.request('ping')));
    const raw = [], samples = Object.fromEntries(PATHS.map(path => [path, { initial: [], query: [], update: [] }]));
    const samplesPerPath = 7, warmups = 2;
    for (let round = -warmups; round < samplesPerPath; round++) {
      const rotate = (round + warmups) % PATHS.length;
      const order = [...PATHS.slice(rotate), ...PATHS.slice(0, rotate)];
      const query = [{ term: 'timeout', level: 2 }, { service: 2 }, { term: 'request' }][(round + warmups) % 3];
      const expectedBase = reference(base, query), expectedUpdate = reference(updatedReference, query);
      for (const path of order) {
        if (cancelled) throw new Error('Cancelled');
        const group = groups[path], baseRevision = `base:${round}`, nextRevision = `next:${round}`;
        // Reset owner arrays outside the measured phase. This is input setup, not a delta update.
        const nativeOwner = path === 'replicated' ? Object.fromEntries(Object.entries(base).map(([field, column]) => [field, column.slice()])) : undefined;
        start = performance.now();
        if (path === 'shared') {
          const payload = sharedPayload(sharedBase);
          await Promise.all(group.map(peer => peer.request('attach', { payload, revision: baseRevision })));
        } else await Promise.all(group.map(peer => peer.request('native-init', { columns: base, revision: baseRevision })));
        const initialMs = performance.now() - start;
        async function calculate(revision, view) {
          if (path === 'centralized') {
            const result = await group[0].request('query', { role: 'both', revision, query, includeRows: true });
            return { search: result.search, summary: result.summary, rows: result.rows };
          }
          const [found, summary] = await Promise.all([
            group[0].request('query', { role: 'search', revision, query }),
            group[1].request('query', { role: 'summary', revision, query }),
          ]);
          return { search: found.search, summary: summary.summary, rows: found.search.indices.map(index => rowAt(view, index)) };
        }
        start = performance.now();
        const answer = await calculate(baseRevision, path === 'shared' ? sharedView(sharedBase) : path === 'replicated' ? nativeView(nativeOwner) : undefined);
        const queryMs = performance.now() - start;
        verifyAnswer(answer, expectedBase);
        start = performance.now();
        let next;
        if (path === 'shared') {
          next = appendShared(sharedBase, delta);
          const payload = sharedPayload(next);
          await Promise.all(group.map(peer => peer.request('attach', { payload, revision: nextRevision })));
        } else {
          if (nativeOwner) appendNative(nativeOwner, delta);
          await Promise.all(group.map(peer => peer.request('native-append', { columns: delta, revision: nextRevision })));
        }
        const updateAnswer = await calculate(nextRevision, next ? sharedView(next) : nativeOwner ? nativeView(nativeOwner) : undefined);
        const updateMs = performance.now() - start;
        verifyAnswer(updateAnswer, expectedUpdate);
        if (round >= 0) {
          samples[path].initial.push(initialMs); samples[path].query.push(queryMs); samples[path].update.push(updateMs);
          raw.push({ round, path, query, initialMs, queryMs, updateMs, initialMatches: answer.search.total, updatedMatches: updateAnswer.search.total, checks: 'full row page, total, checksum, all timeline buckets, services, errors, latency sum' });
        }
        status(round < 0 ? 'Warming all three paths. Checking complete outputs…' : `Sample ${round + 1} of 7 · ${path} · reference checks passed`);
      }
    }
    reply(data.id, {
      schema: 'zerocopy-investigation-benchmark/v1', sourceCommit: data.source, timestamp: new Date().toISOString(),
      config: { entries, updateEntries: BATCH_SIZE, samplesPerPath, warmups, queryResultLimit: 50 },
      environment: { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency },
      construction: { nativeBuildMs, sharedBuildMs, description: 'One deterministic input generation per representation. Shared cost includes persistent column construction and cooperative build yields; not an equal-operation speed comparison.' },
      summary: Object.fromEntries(PATHS.map(path => [path, Object.fromEntries(Object.entries(samples[path]).map(([phase, values]) => [phase, summarize(values)]))])),
      samples, raw,
      method: 'Initial: shared attachment to two workers vs native column clones to two replicas or one centralized worker. Query: search + summary replies + materialize first 50 rows, with no data publication. Update: append 2000 events + publish shared roots or clone only the native delta + query. Centralized replies include visible rows. Coordinator substitutes for UI; DOM paint and startup excluded. Same functions and deterministic columns; independent array oracle checks entire outputs outside timing. Paths rotate. Not a memory benchmark or general application speed claim. Native append-only snapshots can also be retained by length.'
    });
  } catch (error) { if (!cancelled) failure(data.id, error); }
  finally { dispose(); busy = false; }
};
