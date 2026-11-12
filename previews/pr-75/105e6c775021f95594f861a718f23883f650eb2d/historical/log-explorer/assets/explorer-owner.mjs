import { createState } from '../library/state.js';
import { CHANNEL, RPC, MAX_EVENTS, BATCH_SIZE, validateSize, generateColumns } from './explorer-core.mjs';
import { appendShared, buildShared } from './explorer-storage.mjs';
import { reply, failure, status } from './explorer-peer.mjs';
let state, timer, busy = false;
function stopStream() { clearInterval(timer); timer = undefined; }
function append() {
  if (!state) throw new Error('Load the dataset first');
  const count = Math.min(BATCH_SIZE, MAX_EVENTS - state.current.time.size);
  if (!count) { stopStream(); status('Session limit reached. Reset to release this dataset.', { streaming: false, capped: true }); return state.current.time.size; }
  const delta = generateColumns(state.current.time.size, count);
  state.update(current => appendShared(current, delta));
  state.flush();
  if (state.current.time.size === MAX_EVENTS) { stopStream(); status('Session limit reached. Reset to release this dataset.', { streaming: false, capped: true }); }
  return state.current.time.size;
}
self.addEventListener('message', async ({ data }) => {
  if (data?.protocol !== RPC) return;
  try {
    if (data.type === 'load') {
      if (busy || state) throw new Error('This worker already owns a dataset');
      busy = true;
      const count = validateSize(data.entries), start = performance.now();
      const snapshot = await buildShared(count, loaded => status('Preparing shared columns…', { loaded, count }));
      state = createState(snapshot, { channel: CHANNEL, copy: false, timeoutMs: 60_000, onError: error => { stopStream(); status(error.message, { fatal: true }); } });
      await state.connect(self);
      busy = false; reply(data.id, { count, buildMs: performance.now() - start });
    } else if (data.type === 'append') { reply(data.id, { count: append() }); }
    else if (data.type === 'stream') {
      if (!state) throw new Error('Load the dataset first');
      stopStream();
      if (data.enabled && state.current.time.size < MAX_EVENTS) timer = setInterval(() => {
        try { append(); } catch (error) { stopStream(); status(error.message, { fatal: true }); }
      }, 1500);
      reply(data.id, { streaming: Boolean(timer) });
    } else if (data.type === 'ping') reply(data.id, true);
  } catch (error) { busy = false; failure(data.id, error); }
});
