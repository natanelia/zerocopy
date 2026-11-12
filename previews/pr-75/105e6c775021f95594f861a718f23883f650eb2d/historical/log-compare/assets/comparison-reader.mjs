import { RPC, nativeView, sharedView, appendNative, search, summarizeEvents } from './explorer-core.mjs';
import { reply, failure } from './explorer-peer.mjs';
let snapshot, columns, immutable, immer, retained, sharedAPI, immutableAPI, immerAPI, busy = false;
self.onmessage = async ({ data }) => {
  if (data?.protocol !== RPC) return;
  if (busy) { failure(data.id, new Error('A reader operation is already running')); return; }
  busy = true;
  try {
    if (data.type === 'prepare-shared') { sharedAPI = await import('../library/shared.js'); reply(data.id, true); return; }
    if (data.type === 'prepare-immutable') { immutableAPI = await import('./immutable-storage.mjs'); reply(data.id, true); return; }
    if (data.type === 'prepare-immer') { immerAPI = await import('./immer-storage.mjs'); reply(data.id, true); return; }
    if (data.type === 'ping') { reply(data.id, true); return; }
    if (data.type === 'shared') { sharedAPI ??= await import('../library/shared.js'); snapshot = await sharedAPI.initWorker(data.payload); columns = immutable = immer = retained = undefined; reply(data.id, true); return; }
    if (data.type === 'native') { nativeView(data.columns); columns = data.columns; snapshot = immutable = immer = retained = undefined; reply(data.id, true); return; }
    if (data.type === 'append') { appendNative(columns, data.columns); reply(data.id, true); return; }
    if (data.type === 'immutable-init') {
      immutableAPI ??= await import('./immutable-storage.mjs');
      immutable = immutableAPI.fromColumns(data.columns); snapshot = columns = immer = undefined;
      // Keep a frozen root even when full replication replaces the live root.
      reply(data.id, true); return;
    }
    if (data.type === 'immutable-append') { immutable = immutableAPI.appendImmutable(immutable, data.columns); reply(data.id, true); return; }
    if (data.type === 'immer-init') {
      immerAPI ??= await import('./immer-storage.mjs');
      immer = immerAPI.attachColumns(data.columns); snapshot = columns = immutable = undefined;
      // A full replacement must not discard a separately retained old root.
      reply(data.id, true); return;
    }
    if (data.type === 'immer-append') { immer = immerAPI.appendImmer(immer, data.columns); reply(data.id, true); return; }
    if (data.type === 'retain') {
      if (!(immutable || immer) || typeof data.enabled !== 'boolean') throw new TypeError('Expected an immutable replica and freeze flag');
      retained = data.enabled ? (retained ?? immutable ?? immer) : undefined;
      reply(data.id, true); return;
    }
    if (data.type !== 'query') throw new Error('Unknown comparison operation');
    const view = immutable ? immutableAPI.immutableView(retained ?? immutable) : immer ? immerAPI.immerView(retained ?? immer) : snapshot ? sharedView(snapshot) : nativeView(columns);
    if (!Number.isSafeInteger(data.count) || data.count < 0 || data.count > view.length) throw new RangeError('Invalid retained snapshot length');
    if ((immutable || immer) && data.count !== view.length) throw new Error('Immutable replica queries must use the retained root, not a native prefix');
    view.length = data.count;
    const start = performance.now();
    const answer = data.role === 'search' ? { search: await search(view, data.query) }
      : data.role === 'summary' ? { summary: await summarizeEvents(view, data.query) } : null;
    if (!answer) throw new Error('Invalid worker role');
    reply(data.id, { ...answer, elapsedMs: performance.now() - start });
  } catch (error) { failure(data.id, error); }
  finally { busy = false; }
};
