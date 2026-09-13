import { initWorker } from '../dist/shared.js';
self.onmessage = async ({ data }) => {
  try {
    const { map } = await initWorker(data);
    let rejectsWrite = false;
    try { map.set('a', { value: -1 }); } catch { rejectsWrite = true; }
    const value = map.get('a');
    self.postMessage({ value: value.value, frozen: Object.isFrozen(value), rejectsWrite });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
