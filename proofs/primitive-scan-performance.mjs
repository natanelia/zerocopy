/** Run AFTER building both public bundles. Ratios are diagnostic, not a gate. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScanChecks } from './primitive-scan-checks.mjs';
import { runComparison } from './primitive-scan-cases.mjs';
import { checkWorker } from './primitive-scan-worker-check.mjs';

const root = resolve(import.meta.dirname, '..');
const baseRoot = resolve(process.env.PRIMITIVE_BASE ?? resolve(root, '.primitive-baseline'));
const candidateRoot = resolve(process.env.PRIMITIVE_CANDIDATE ?? root);
const browserName = process.env.BROWSER;
const runtime = browserName ?? (typeof Bun === 'undefined' ? 'node' : 'bun');
const round = Number(process.env.ROUND ?? 1);
assert(Number.isInteger(round) && round >= 1 && round <= 10, 'ROUND must be 1..10');
function commit(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unavailable (local bundle override)'; }
}
const metadata = { runtime, round, baseline: commit(baseRoot), candidate: commit(candidateRoot),
  platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  node: process.version, bun: typeof Bun === 'undefined' ? null : Bun.version,
  v8: process.versions.v8 ?? null, browserVersion: null };
let result;
if (!browserName) {
  const module = pathToFileURL(resolve(candidateRoot, 'dist/shared.js')).href;
  const candidate = await import(module);
  const baseline = await import(pathToFileURL(resolve(baseRoot, 'dist/shared.js')).href);
  const correctness = await runScanChecks(candidate);
  let worker = 'not run: Bun uses its separate transport proof; this worker test requires Node';
  if (runtime === 'node') {
    const { Worker } = await import('node:worker_threads');
    worker = await checkWorker(candidate, new Worker(new URL('./primitive-scan-worker.mjs', import.meta.url)), module, true);
  }
  result = { correctness, worker, ...await runComparison(baseline, candidate, { round }) };
} else {
  assert(['chromium', 'firefox', 'webkit'].includes(browserName), 'Unsupported BROWSER');
  const browsers = await import('playwright');
  const allowedProofs = new Set(['primitive-scan-checks.mjs', 'primitive-scan-cases.mjs',
    'primitive-scan-worker.mjs', 'primitive-scan-worker-check.mjs']);
  const server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Primitive scan proof</title>'); return;
      }
      const match = /^\/(baseline|candidate|proofs)\/(.+)$/.exec(decodeURIComponent(url.pathname));
      if (!match) { response.writeHead(404).end(); return; }
      const directory = match[1] === 'baseline' ? resolve(baseRoot, 'dist')
        : match[1] === 'candidate' ? resolve(candidateRoot, 'dist') : resolve(root, 'proofs');
      const file = resolve(directory, match[2]);
      if (!file.startsWith(directory + sep) || !/\.m?js$/.test(file)
        || match[1] === 'proofs' && !allowedProofs.has(match[2])) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await browsers[browserName].launch();
    metadata.browserVersion = browser.version();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    result = await page.evaluate(async round => {
      if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required');
      const [baseline, candidate, checks, bench, workerCheck] = await Promise.all([
        import('/baseline/shared.js'), import('/candidate/shared.js'),
        import('/proofs/primitive-scan-checks.mjs'), import('/proofs/primitive-scan-cases.mjs'),
        import('/proofs/primitive-scan-worker-check.mjs'),
      ]);
      const correctness = await checks.runScanChecks(candidate);
      const worker = await workerCheck.checkWorker(candidate,
        new Worker('/proofs/primitive-scan-worker.mjs', { type: 'module' }),
        new URL('/candidate/shared.js', location.href).href);
      return { correctness, worker, ...await bench.runComparison(baseline, candidate, { round }) };
    }, round);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
const outputDir = resolve(root, 'proofs/results/primitive-scan');
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, `${runtime}-${round}.json`), JSON.stringify({ ...metadata, ...result }, null, 2) + '\n');
console.log(`${runtime} round ${round}: ${result.correctness.count} checks; ${result.worker}`);
for (const row of result.rows) console.log(`${row.name} n=${row.size}: ${row.speedup.toFixed(2)}x${row.reviewSlowdown ? ' REVIEW SLOWDOWN' : ''}${row.shortBatch ? ' SHORT BATCH' : ''}`);
