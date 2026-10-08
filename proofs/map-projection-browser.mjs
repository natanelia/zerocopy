import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { benchmarkConfig, workloadCases, roundOrders, measureCase, finishRow, summarize, prepareComparison, bundleManifest, sourceManifest, sha256, method } from './map-projection-performance.mjs';

const [baseline, candidate, output = `proofs/results/map-projection-browsers-${Date.now()}.json`] = process.argv.slice(2);
if (!baseline || !candidate) throw new Error('Usage: node proofs/map-projection-browser.mjs BASELINE/dist/shared.js CANDIDATE/dist/shared.js OUTPUT.json; env: BENCH_MODE=ab|aa-baseline|aa-candidate, CASE_FILTER, ROUNDS, IMPORT_ORDER, WARM_ORDER, ORDER_OFFSET, ENGINES');
const config = benchmarkConfig(15), workloads = workloadCases(config.caseFilter), comparison = prepareComparison(baseline, candidate, config.mode);
const roots = Object.fromEntries(Object.entries(comparison.paths).map(([name, path]) => [name, dirname(path)]));
// Even an A/A measurement verifies workers against the actual candidate build.
roots['worker-candidate'] = dirname(resolve(candidate));
const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Map projection proof</title>'); return; }
  const [, variant, ...parts] = new URL(req.url, 'http://localhost').pathname.split('/'), root = roots[variant];
  const path = root && resolve(root, ...parts);
  if (!path || !path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(readFileSync(path)); }
  catch { res.writeHead(404); res.end(); }
});
const engines = (process.env.ENGINES ?? 'chromium,firefox,webkit').split(',');
for (const name of engines) if (!['chromium', 'firefox', 'webkit'].includes(name)) throw new Error(`Unknown engine: ${name}`);
const results = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const paths = Object.fromEntries(Object.entries(comparison.paths).map(([name, path]) => [name, `${origin}/${name}/${basename(path)}`]));
  for (const name of engines) {
    const browser = await { chromium, firefox, webkit }[name].launch({ headless: true, ...(name === 'chromium' && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
    try {
      const runs = [];
      for (let round = 0; round < config.rounds; round++) {
        const orders = roundOrders(round, config), rows = [];
        for (const workload of workloads) {
          // newPage creates a new context and realm, closed after this one
          // operation. No earlier keys/values case can warm its entry generator.
          const page = await browser.newPage();
          try {
            await page.goto(origin);
            if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('Cross-origin isolation required');
            const row = finishRow(await page.evaluate(measureCase, { workload, paths, config, orders }));
            rows.push(row);
          } finally { await page.close(); }
        }
        runs.push({ round, orders, rows });
        console.log(`${name} round ${round + 1}/${config.rounds}: ${rows.length} isolated workloads (${config.mode})`);
      }
      // Correctness checks have their own page and never warm a timing realm.
      const workerPage = await browser.newPage();
      let workerResult;
      try {
        await workerPage.goto(origin);
        workerResult = await workerPage.evaluate(async entryUrl => {
          if (!crossOriginIsolated) throw new Error('Cross-origin isolation required');
          const S = await import(entryUrl);
          let verifiedWorkerProjections = 0;
          for (const copy of [false, true]) {
            S.resetOrderedMap(); S.resetSortedMap();
            let ordered = new S.SharedOrderedMap('object').set('🙂', { i: 1 }).set('a', { i: 2 });
            let sorted = new S.SharedSortedMap('object').set('🙂', { i: 1 }).set('a', { i: 2 });
            ordered = ordered.delete('🙂').set('🙂', { i: 3 });
            const expected = {};
            for (const [name, map] of Object.entries({ ordered, sorted })) for (const operation of ['keys', 'values', 'entries']) expected[`${name}/${operation}`] = [...map[operation]()];
            const code = `import * as S from ${JSON.stringify(entryUrl)}; const projections={}; onmessage = async ({data}) => { if(data.type==='init') { const maps = await S.initWorker(data.payload); for(const [name,map] of Object.entries(maps)) for(const operation of ['keys','values','entries']) {const iterator=map[operation](); projections[name+'/'+operation]={iterator,first:iterator.next().value};} postMessage('ready'); } else { postMessage(Object.fromEntries(Object.entries(projections).map(([name,{first,iterator}])=>[name,[first,...iterator]]))); } };`;
            const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), worker = new Worker(url, { type: 'module' });
            const exchange = data => new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Browser worker timed out')), 30000);
              worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
              worker.onerror = error => { clearTimeout(timer); reject(new Error(error.message)); };
              worker.postMessage(data);
            });
            try {
              if (await exchange({ type: 'init', payload: S.getWorkerData({ ordered, sorted }, { copy }) }) !== 'ready') throw new Error('Worker not ready');
              for (let i = 0; i < 512; i++) { ordered = ordered.set(`new-${i}`, { text: 'x'.repeat(1024) }); sorted = sorted.set(`new-${i}`, { text: 'x'.repeat(1024) }); }
              if (JSON.stringify(await exchange({ type: 'resume' })) !== JSON.stringify(expected)) throw new Error('Worker snapshot changed');
              verifiedWorkerProjections += Object.keys(expected).length;
            } finally { worker.terminate(); URL.revokeObjectURL(url); }
          }
          return { realWorkerSharedAndCopy: true, verifiedWorkerProjections, crossOriginIsolated };
        }, `${origin}/worker-candidate/${basename(candidate)}`);
      } finally { await workerPage.close(); }
      assert.equal(workerResult.verifiedWorkerProjections, 12);
      results.push({ browser: name, version: browser.version(), rounds: config.rounds, rows: summarize(runs), runs, ...workerResult });
      console.log(`${name}: ${workloads.length} differential cases × ${config.rounds} fresh-page rounds; all six projections passed in real shared and copy workers`);
    } finally { await browser.close(); }
  }
  assert.equal(results.length, engines.length);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify({
    schemaVersion: 2, date: new Date().toISOString(), config, engines,
    baseline: comparison.sourcePaths.baseline, candidate: comparison.sourcePaths.candidate,
    measuredSourcePaths: comparison.measuredSourcePaths, manifests: comparison.manifests, sourceManifests: comparison.sourceManifests, sourceDiff: comparison.sourceDiff,
    workerCandidateManifest: bundleManifest(candidate), workerCandidateSourceManifest: sourceManifest(candidate),
    harnessSha256: {
      browser: sha256(readFileSync(fileURLToPath(import.meta.url))),
      sharedMeasurement: sha256(readFileSync(new URL('./map-projection-performance.mjs', import.meta.url))),
    },
    summaryTimingUnit: 'milliseconds per full scan', rawTimingUnit: 'milliseconds per batch',
    method: method('browser page/context/realm'), results,
  }, null, 2) + '\n');
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  comparison.cleanup();
}
