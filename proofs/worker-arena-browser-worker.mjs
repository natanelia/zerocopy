import * as api from '/library/shared.js';
import { createArenaWorkerProtocol } from './worker-arena-protocol.mjs';
const handle = createArenaWorkerProtocol(api);
self.onmessage = async event => {
  try {
    if (!self.crossOriginIsolated || !(self instanceof DedicatedWorkerGlobalScope)) throw new Error('Expected an isolated dedicated worker');
    self.postMessage({ ...await handle(event.data), workerEnvironment: { isolated: self.crossOriginIsolated, dedicatedWorker: true } });
  } catch (error) { self.postMessage({ error: error.stack ?? String(error) }); }
};
