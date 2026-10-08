import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ARENA_COUNTS, createArenaWorkerProtocol, runArenaScenario } from './worker-arena-protocol.mjs';

const library = isMainThread ? pathToFileURL(resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/shared.js', import.meta.url)))).href : workerData.library;
const api = await import(library);
if (!isMainThread) {
  const handle = createArenaWorkerProtocol(api);
  parentPort.on('message', async message => {
    try { parentPort.postMessage(await handle(message)); }
    catch (error) { parentPort.postMessage({ error: error.stack ?? String(error) }); }
  });
} else {
  const results = [];
  for (const arenas of ARENA_COUNTS) for (const copy of [false, true]) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { library } });
    const timer = setTimeout(() => { console.error('Worker arena correctness proof timed out'); process.exit(1); }, 30000);
    try {
      const exchange = async message => {
        const received = once(worker, 'message'); worker.postMessage(message);
        const [reply] = await received; return reply;
      };
      results.push(await runArenaScenario(api, exchange, arenas, copy));
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
  console.log(JSON.stringify({ passed: true, runtime: process.version, library, results }));
}
