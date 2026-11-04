import { writeFileSync } from 'node:fs';
import { runScanChecks } from '../primitive-scan-checks.mjs';
import { checkWorker } from '../primitive-scan-worker-check.mjs';
import * as api from '../../dist/shared.js';

const checks = await runScanChecks(api);
let worker = 'not run: Bun uses the same-realm attachment checks';
if (!process.versions.bun) {
  const { Worker } = await import('node:worker_threads');
  worker = await checkWorker(api, new Worker(new URL('../primitive-scan-worker.mjs', import.meta.url)),
    new URL('../../dist/shared.js', import.meta.url).href, true);
}
const result = { runtime: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.version,
  checkedAt: new Date().toISOString(), checks, worker };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
