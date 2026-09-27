import { initWorker } from '../library/shared.js';
import { RPC, sharedView, nativeView, appendNative, search, summarizeEvents, rowAt } from './explorer-core.mjs';
import { reply, failure } from './explorer-peer.mjs';
let snapshot, revision, native, busy = false;
self.onmessage = async ({ data }) => {
  if (data?.protocol !== RPC) return;
  if (busy) { failure(data.id, new Error('Reader already has an operation')); return; }
  busy = true;
  try {
    if (data.type === 'ping') { reply(data.id, true); return; }
    if (data.type === 'native-init') { nativeView(data.columns); native = data.columns; snapshot = undefined; revision = data.revision; reply(data.id, true); return; }
    if (data.type === 'native-append') { appendNative(native, data.columns); revision = data.revision; reply(data.id, true); return; }
    if (data.payload) {
      snapshot = await initWorker(data.payload); sharedView(snapshot);
      revision = data.revision; native = undefined;
    }
    if (data.revision !== revision || (!snapshot && !native)) throw new Error('The requested snapshot is not attached');
    if (data.type === 'attach') { reply(data.id, { count: snapshot.time.size }); return; }
    if (data.type !== 'query') throw new Error('Unknown operation');
    const view = snapshot ? sharedView(snapshot) : nativeView(native), started = performance.now();
    const value = {};
    if (data.role === 'search' || data.role === 'both') value.search = await search(view, data.query);
    if (data.role === 'summary' || data.role === 'both') value.summary = await summarizeEvents(view, data.query);
    if (!value.search && !value.summary) throw new Error('Unknown reader role');
    if (data.includeRows && value.search) value.rows = value.search.indices.map(index => rowAt(view, index));
    reply(data.id, { ...value, revision, count: view.length, elapsedMs: performance.now() - started });
  } catch (error) { failure(data.id, error); }
  finally { busy = false; }
};
