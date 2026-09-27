import { initWorker } from '../library/shared.js';
import { RPC, nativeView, sharedView, appendNative, search, summarizeEvents } from './explorer-core.mjs';
import { reply, failure } from './explorer-peer.mjs';
let snapshot, columns, busy = false;
self.onmessage = async ({ data }) => {
  if (data?.protocol !== RPC) return;
  if (busy) { failure(data.id, new Error('A reader operation is already running')); return; }
  busy = true;
  try {
    if (data.type === 'ping') { reply(data.id, true); return; }
    if (data.type === 'shared') { snapshot = await initWorker(data.payload); columns = undefined; reply(data.id, true); return; }
    if (data.type === 'native') { nativeView(data.columns); columns = data.columns; snapshot = undefined; reply(data.id, true); return; }
    if (data.type === 'append') { appendNative(columns, data.columns); reply(data.id, true); return; }
    if (data.type !== 'query') throw new Error('Unknown comparison operation');
    const view = snapshot ? sharedView(snapshot) : nativeView(columns);
    if (!Number.isSafeInteger(data.count) || data.count < 0 || data.count > view.length) throw new RangeError('Invalid retained snapshot length');
    view.length = data.count;
    const start = performance.now();
    const answer = data.role === 'search' ? { search: await search(view, data.query) }
      : data.role === 'summary' ? { summary: await summarizeEvents(view, data.query) } : null;
    if (!answer) throw new Error('Invalid worker role');
    reply(data.id, { ...answer, elapsedMs: performance.now() - start });
  } catch (error) { failure(data.id, error); }
  finally { busy = false; }
};
