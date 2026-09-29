import { initWorker } from '../dist/shared.js';
self.onmessage = async ({ data }) => {
  try {
    const { before, after } = await initWorker(data);
    self.postMessage({ before: before.get('路'), after: after.get('路'), replacement: after.get('alias'), large: after.get('large'), frozen: Object.isFrozen(after) });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
