import { RPC, generateColumns, nativeView, sharedView, rowAt, appendNative, BATCH_SIZE } from './explorer-core.mjs';
import { buildShared, appendShared, sharedPayload } from './explorer-storage.mjs';
import { fromColumns, appendImmutable, immutableView, transportColumns } from './immutable-storage.mjs';
import { immutableVersion } from '../vendor/version.mjs';
import { reference, verifyAnswer } from './explorer-reference.mjs';
import { Peer, reply, failure, status } from './explorer-peer.mjs';
import { summarize } from './bench-core.mjs';
import { INVESTIGATION_CASES } from './explorer-benchmark-cases.mjs';
const PATHS = INVESTIGATION_CASES.map(item => item.id);
let peers = [], busy = false, cancelled = false;
function dispose() { for (const peer of peers) peer.close(); peers = []; }
self.onmessage = async ({ data }) => {
  if (data?.protocol !== RPC) return;
  if (data.type === 'cancel') { cancelled = true; dispose(); reply(data.id, true); return; }
  if (data.type !== 'run' || busy) return;
  busy = true; cancelled = false;
  try {
    const entries = data.entries;
    if (![1000, 10000, 100000].includes(entries)) throw new RangeError('Choose 1,000, 10,000, or 100,000 events');
    if (!crossOriginIsolated) throw new Error('Shared memory is unavailable');
    status('Preparing identical data and loading workers…');
    let start = performance.now(); const base = generateColumns(0, entries); const nativeBuildMs = performance.now() - start;
    start = performance.now(); const immutableBase = fromColumns(base); const immutableBuildMs = performance.now() - start;
    start = performance.now(); const sharedBase = await buildShared(entries, () => { if (cancelled) throw new Error('Cancelled'); });
    const sharedBuildMs = performance.now() - start;
    const delta = generateColumns(entries, BATCH_SIZE);
    const updatedReference = Object.fromEntries(Object.entries(base).map(([field, column]) => [field, column.concat(delta[field])]));
    const groups = {};
    for (const { id: path, readers } of INVESTIGATION_CASES) {
      groups[path] = [];
      for (let i = 0; i < readers; i++) {
        const peer = new Peer(new URL('./explorer-reader.mjs', import.meta.url));
        groups[path].push(peer); peers.push(peer);
      }
    }
    await Promise.all(peers.map(peer => peer.request('ping')));
    await Promise.all([
      ...groups.shared.map(peer => peer.request('prepare-shared')),
      ...INVESTIGATION_CASES.filter(item => item.kind === 'immutable').flatMap(item => groups[item.id].map(peer => peer.request('prepare-immutable'))),
    ]);
    const raw = [], samples = Object.fromEntries(PATHS.map(path => [path, { initial: [], query: [], update: [] }]));
    const samplesPerPath = 7, warmups = 2;
    for (let round = -warmups; round < samplesPerPath; round++) {
      const rotate = (round + warmups) % PATHS.length;
      const order = [...INVESTIGATION_CASES.slice(rotate), ...INVESTIGATION_CASES.slice(0, rotate)];
      const query = [{ term: 'timeout', level: 2 }, { service: 2 }, { term: 'request' }][(round + warmups) % 3];
      const expectedBase = reference(base, query), expectedUpdate = reference(updatedReference, query);
      for (const { id: path, kind, updateMode, label } of order) {
        if (cancelled) throw new Error('Cancelled');
        const group = groups[path], baseRevision = `base:${round}`, nextRevision = `next:${round}`;
        // Reset owner arrays outside the measured phase. This is input setup, not a delta update.
        const nativeOwner = kind === 'native' ? Object.fromEntries(Object.entries(base).map(([field, column]) => [field, column.slice()])) : undefined;
        let initialReplies, updateReplies;
        start = performance.now();
        if (kind === 'shared') {
          const payload = sharedPayload(sharedBase);
          initialReplies = await Promise.all(group.map(peer => peer.request('attach', { payload, revision: baseRevision })));
        } else if (kind === 'immutable') {
          const wire = transportColumns(immutableBase);
          initialReplies = await Promise.all(group.map(peer => peer.request('immutable-init', { columns: wire, revision: baseRevision })));
        } else initialReplies = await Promise.all(group.map(peer => peer.request('native-init', { columns: base, revision: baseRevision })));
        const initialMs = performance.now() - start;
        if (initialReplies.some(answer => answer.count !== entries || answer.receivedEvents !== (kind === 'shared' ? 0 : entries))) throw new Error('Initial publication count mismatch');
        async function calculate(revision, view) {
          if (kind === 'centralized') {
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
        const answer = await calculate(baseRevision, kind === 'shared' ? sharedView(sharedBase) : kind === 'immutable' ? immutableView(immutableBase) : nativeOwner ? nativeView(nativeOwner) : undefined);
        const queryMs = performance.now() - start;
        verifyAnswer(answer, expectedBase);
        start = performance.now();
        let next;
        if (kind === 'shared') {
          next = appendShared(sharedBase, delta);
          const payload = sharedPayload(next);
          updateReplies = await Promise.all(group.map(peer => peer.request('attach', { payload, revision: nextRevision })));
        } else if (kind === 'immutable') {
          next = appendImmutable(immutableBase, delta);
          const wire = transportColumns(next, updateMode === 'full' ? 0 : entries);
          updateReplies = await Promise.all(group.map(peer => peer.request(updateMode === 'full' ? 'immutable-init' : 'immutable-append', { columns: wire, revision: nextRevision })));
        } else {
          if (nativeOwner) appendNative(nativeOwner, delta);
          updateReplies = await Promise.all(group.map(peer => peer.request(updateMode === 'full' ? 'native-init' : 'native-append', { columns: updateMode === 'full' ? nativeOwner : delta, revision: nextRevision })));
        }
        const updateAnswer = await calculate(nextRevision, next ? (kind === 'immutable' ? immutableView(next) : sharedView(next)) : nativeOwner ? nativeView(nativeOwner) : undefined);
        const updateMs = performance.now() - start;
        verifyAnswer(updateAnswer, expectedUpdate);
        const expectedCopiedEvents = kind === 'shared' ? 0 : updateMode === 'full' ? entries + BATCH_SIZE : BATCH_SIZE;
        if (updateReplies.some(answer => answer.count !== entries + BATCH_SIZE || answer.receivedEvents !== expectedCopiedEvents)) throw new Error('Update publication count mismatch');
        if (round >= 0) {
          samples[path].initial.push(initialMs); samples[path].query.push(queryMs); samples[path].update.push(updateMs);
          raw.push({ round, path, kind, updateMode, query, initialMs, queryMs, updateMs,
            publication: { initialEventsCopied: initialReplies.reduce((sum, answer) => sum + answer.receivedEvents, 0), updateEventsCopied: updateReplies.reduce((sum, answer) => sum + answer.receivedEvents, 0), readers: group.length },
            initialMatches: answer.search.total, updatedMatches: updateAnswer.search.total, checks: 'publication counts, full row page, total, checksum, all timeline buckets, services, errors, latency sum' });
        }
        status(round < 0 ? 'Warming all six cases. Checking complete outputs…' : `Sample ${round + 1} of 7 · ${label} · reference checks passed`);
      }
    }
    reply(data.id, {
      schema: 'zerocopy-investigation-benchmark/v3', sourceCommit: data.source, timestamp: new Date().toISOString(),
      dependencies: { immutable: immutableVersion },
      scheduling: { methodVersion: 3, checkpointEvents: 4096, strategy: typeof globalThis.scheduler?.yield === 'function' ? 'scheduler.yield' : 'MessageChannel', sharedAcrossPaths: true },
      config: { paths: PATHS, cases: INVESTIGATION_CASES, entries, updateEntries: BATCH_SIZE, samplesPerPath, warmups, queryResultLimit: 50 },
      environment: { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency },
      construction: { nativeBuildMs, immutableBuildMs, sharedBuildMs, description: 'Native: deterministic input generation. Immutable.js: List construction from that input. Shared: input generation, persistent column construction, cooperative build yields. Separate setup costs, not equal-operation speed claims.' },
      summary: Object.fromEntries(PATHS.map(path => [path, Object.fromEntries(Object.entries(samples[path]).map(([phase, values]) => [phase, summarize(values)]))])),
      samples, raw,
      method: 'All cases use the same task scheduler (scheduler.yield or MessageChannel) and yield every 4096 scanned indices. zerocopy uses its public pushMany API for batch appends. Immutable.js uses five real Lists, direct get queries, and withMutations batched appends. Native and Immutable.js each have incremental-copy and full-copy cases. Incremental copy sends only the 2000 appended events after initial load; full copy sends every event, including unchanged data, to each reader after every append. These modes describe cross-worker publication, not local collection updates. Initial publication includes complete column encoding, structured clone and reader construction. Updates time identical owner appends, suffix or full encoding, structured cloning, reader appends or full reconstruction, then the query. No toJS conversion during queries. Query: search + summary replies + materialize first 50 rows, without republishing data. Shared cases publish shared descriptors. A single native owner receives an initial copy and appended deltas, performs both scans, and returns visible rows. Publication counters count logical event deliveries, not bytes or memory. Coordinator substitutes for UI; DOM paint, worker startup and module loading excluded. Same functions and deterministic columns; independent array oracle checks entire outputs outside timing. Six cases rotate, with two warmups and seven measured samples each. Not a memory benchmark or general application speed claim. Native append-only snapshots can also be retained by length.'
    });
  } catch (error) { if (!cancelled) failure(data.id, error); }
  finally { dispose(); busy = false; }
};
