/** Correctness only: real module workers in Chromium, Firefox and WebKit. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, release } from 'node:os';
import { chromium, firefox, webkit } from 'playwright';
import { capture, manifest, sha256 } from './worker-arena-source-guard.mjs';

const [entryArg, outputArg] = process.argv.slice(2);
assert(entryArg && outputArg, 'Usage: RUNTIME_SHA=<full SHA> node proofs/worker-arena-browser.mjs RUNTIME/dist/shared.js OUTPUT.json');
const entry = resolve(entryArg), library = dirname(entry), runtimeRoot = dirname(library), output = resolve(outputArg);
assert.equal(entry, resolve(library, 'shared.js'));
const runtime = capture(runtimeRoot);
assert.equal(runtime.commit, process.env.RUNTIME_SHA, 'Runtime checkout must match the explicit frozen SHA');
assert.equal(runtime.sourceDirty, false, 'Runtime production source must be clean');
const proofs = dirname(fileURLToPath(import.meta.url));
const helperNames = ['worker-arena-protocol.mjs', 'worker-arena-browser-worker.mjs'];
const report = {
  schema: 'zerocopy-worker-arena-browser-correctness/v1', date: new Date().toISOString(), complete: false,
  method: 'Correctness-only shared protocol: real module-worker attach, retained cold reads, re-export and owner reattachment; 1/2/49 arenas, shared/copy modes. No timing samples or speed claims.',
  runtime, proofCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(proofs, '..'), encoding: 'utf8' }).trim(),
  proofManifest: manifest(resolve(proofs, '..'), ['proofs/worker-arena-protocol.mjs', 'proofs/worker-arenas.mjs', 'proofs/worker-arena-browser-worker.mjs', 'proofs/worker-arena-browser.mjs', 'proofs/worker-arena-source-guard.mjs', '.github/workflows/worker-arena-browser-correctness.yml']),
  host: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch, osRelease: release() },
  engines: [],
};
report.proofSourceStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...report.proofManifest.files.map(file => file.path)], { cwd: resolve(proofs, '..'), encoding: 'utf8' }).trimEnd();
assert.equal(report.proofSourceStatus, '', 'Proof helpers must be committed and clean');
mkdirSync(dirname(output), { recursive: true });
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); save();
const assets = new Map(helperNames.map(name => [`/proofs/${name}`, readFileSync(resolve(proofs, name))]));
for (const name of readdirSync(library).filter(name => name.endsWith('.js'))) assets.set(`/library/${name}`, readFileSync(resolve(library, name)));
report.servedFiles = [...assets].map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));
for (const file of runtime.build.files) assert.equal(sha256(assets.get(`/library/${file.path.slice('dist/'.length)}`)), file.sha256);
for (const name of helperNames) assert.equal(sha256(assets.get(`/proofs/${name}`)), report.proofManifest.files.find(file => file.path === `proofs/${name}`).sha256);
save();
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Worker arena correctness</title>'); return; }
  const body = assets.get(path);
  if (!body) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/javascript'); response.end(body);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const row = { engine, complete: false, results: [] }; report.engines.push(row); save();
    let browser, context;
    try {
      browser = await launcher.launch({ headless: true }); row.browserVersion = browser.version();
      context = await browser.newContext(); const page = await context.newPage(), pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      row.environment = await page.evaluate(() => ({ isolated: crossOriginIsolated, userAgent: navigator.userAgent }));
      assert.equal(row.environment.isolated, true);
      await page.exposeFunction('saveArenaScenario', result => { row.results.push(result); save(); });
      await page.evaluate(async () => {
        const api = await import('/library/shared.js');
        const { ARENA_COUNTS, runArenaScenario } = await import('/proofs/worker-arena-protocol.mjs');
        for (const arenas of ARENA_COUNTS) for (const copy of [false, true]) {
          const worker = new Worker('/proofs/worker-arena-browser-worker.mjs', { type: 'module' });
          try {
            const exchange = message => new Promise((resolve, reject) => {
              const timeout = setTimeout(() => finish(new Error('Browser worker proof timed out')), 20000);
              const onMessage = event => {
                if (event.data.error) finish(new Error(event.data.error));
                else if (!event.data.workerEnvironment?.isolated || !event.data.workerEnvironment?.dedicatedWorker) finish(new Error('Missing real isolated-worker evidence'));
                else finish(undefined, event.data);
              };
              const onError = event => finish(new Error(event.message || 'Browser worker error'));
              const finish = (error, value) => { clearTimeout(timeout); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onError); error ? reject(error) : resolve(value); };
              worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onError);
              try { worker.postMessage(message); } catch (error) { finish(error); }
            });
            await window.saveArenaScenario(await runArenaScenario(api, exchange, arenas, copy));
          } finally { worker.terminate(); }
        }
      });
      assert.deepEqual(pageErrors, []); assert.equal(row.results.length, 6);
      assert.deepEqual(row.results.map(result => [result.arenas, result.copy]), [[1, false], [1, true], [2, false], [2, true], [49, false], [49, true]]);
      row.complete = true; save(); console.log(`${engine}: all six real-worker transport scenarios passed`);
    } catch (error) { row.error = error.stack ?? String(error); save(); throw error; }
    finally { if (context) await context.close(); if (browser) await browser.close(); }
  }
  const after = capture(runtimeRoot);
  assert.equal(after.commit, runtime.commit); assert.equal(after.sourceDirty, false);
  assert.equal(after.source.sha256, runtime.source.sha256); assert.equal(after.build.sha256, runtime.build.sha256);
  assert.equal(manifest(resolve(proofs, '..'), report.proofManifest.files.map(file => file.path)).sha256, report.proofManifest.sha256);
  report.complete = true; save();
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
