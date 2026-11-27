import { getWorkerData } from '../dist/shared.js';
import { connectSharedSession } from '../dist/worker.js';

let reader, initial, snapshots;
self.onmessage = async ({ data }) => {
  try {
    if (data.port) {
      reader = await connectSharedSession({ endpoint: data.port });
      initial = reader.current;
      snapshots = reader.snapshots({ emitCurrent: false });
      self.postMessage({ revision: initial.get('north').revision });
      return;
    }
    if (reader.version < data.version) {
      await new Promise(resolve => {
        const stop = reader.subscribe((_, version) => {
          if (version >= data.version) { stop(); resolve(undefined); }
        });
      });
    }
    // Pull once after several confirmations. Latest delivery coalesces the queue.
    const { value: rows } = await snapshots.next();
    const memory = map => getWorkerData({ map }, { copy: false }).arenas[0].memory;
    self.postMessage({
      version: reader.version, latest: rows === reader.current, sameMemory: memory(rows) === memory(initial),
      changes: [...rows.changesSince(initial)], original: initial.get('north'),
    });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
