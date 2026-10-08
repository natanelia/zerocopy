import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { runChurnChecks, runChurnMechanism } from './ordered-churn-checks.mjs';
import { checkChurnWorker } from './ordered-churn-worker-check.mjs';
const entry = pathToFileURL(resolve(process.argv[2] ?? 'dist/shared.js')).href;
const S = await import(entry), candidate = process.env.EXPECT_ADAPTIVE !== '0';
const checks = await runChurnChecks(S), mechanism = runChurnMechanism(S, candidate), workers = [];
for (const copy of [false, true]) workers.push(await checkChurnWorker(S, new Worker(new URL('./ordered-churn-worker.mjs', import.meta.url), { type: 'module' }), entry, copy, true));
const result = { date: new Date().toISOString(), entry, candidate, checks, mechanism, workers, runtime: process.version, bun: process.versions.bun ?? null };
if (process.argv[3]) { mkdirSync(resolve(process.argv[3], '..'), { recursive: true }); writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n'); }
console.log(JSON.stringify(result));
