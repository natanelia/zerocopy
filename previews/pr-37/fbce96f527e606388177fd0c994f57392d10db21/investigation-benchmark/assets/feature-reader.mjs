import { calculate } from './catalog-core.mjs';
import { createStorage } from './feature-storage.mjs';
import { listen } from './catalog-peer.mjs';
let storage, current, retained;
listen(async data => {
  if (data.type === 'prepare') { storage = await createStorage(data.kind); return true; }
  if (data.type === 'load') { current = await storage.attach(data.payload); retained = current; return current.size; }
  if (data.type === 'edit') { current = storage.kind === 'shared' ? await storage.attach(data.payload) : storage.update(current, data.changes, retained); return current.size; }
  if (data.type === 'release') { retained = undefined; return true; }
  if (data.type === 'query') {
    const map = data.frozen ? retained : current; if (!map) throw new Error('Snapshot is missing');
    return calculate(map, data.ids, data.task);
  }
  throw new Error('Unknown product catalog reader operation');
});
