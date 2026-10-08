import * as api from '/library/shared.js';
import { createArenaWorkerProtocol } from './worker-arena-protocol.mjs';
let failureContext;
const handle = createArenaWorkerProtocol(api, stage => { failureContext = stage; });
self.onmessage = async event => {
  const { arenas, copy, generation } = event.data;
  failureContext = { arenas, copy, generation, phase: 'worker-validate' };
  try {
    if (!self.crossOriginIsolated || !(self instanceof DedicatedWorkerGlobalScope)) throw new Error('Expected an isolated dedicated worker');
    self.postMessage({ ...await handle(event.data), workerEnvironment: { isolated: self.crossOriginIsolated, dedicatedWorker: true } });
  } catch (error) {
    self.postMessage({ error: error.stack ?? String(error), failureContext });
  }
};
