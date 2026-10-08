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
const STAGE_PREFIX = 'worker-arena-proof-stage:';
async function bounded(promise, milliseconds, label) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds); })]); }
  finally { clearTimeout(timeout); }
}
const helperNames = ['worker-arena-protocol.mjs', 'worker-arena-browser-worker.mjs'];
const report = {
  schema: 'zerocopy-worker-arena-browser-correctness/v2', date: new Date().toISOString(), complete: false,
  method: 'Correctness-only shared protocol: each unchanged 1/2/49-arena shared/copy scenario gets a fresh browser process, page and worker; both generations and all retention/forwarding checks remain. Failures are recorded and remaining scenarios/engines run; any failure still makes the final exit fail. No timing samples, runtime changes, forced GC or browser bypass flags.',
  isolation: 'fresh-browser-process-per-scenario',
  historicalStress: { record: 'proofs/worker-arena-browser-results/combined-stress-controls.json', mode: 'six scenarios accumulated in one browser process', baselineRun: 37816393088, candidateRun: 37814394788, outcome: 'Both failed 49/copy at worker attachment in Chromium153; retained separately, not converted to a passing result.' },
  runtime, proofCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(proofs, '..'), encoding: 'utf8' }).trim(),
  proofManifest: manifest(resolve(proofs, '..'), ['proofs/worker-arena-protocol.mjs', 'proofs/worker-arenas.mjs', 'proofs/worker-arena-browser-worker.mjs', 'proofs/worker-arena-browser.mjs', 'proofs/worker-arena-source-guard.mjs', 'proofs/worker-arena-browser-results/combined-stress-controls.json', '.github/workflows/worker-arena-browser-correctness.yml']),
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
  const scenarios = [1, 2, 49].flatMap(arenas => [false, true].map(copy => ({ arenas, copy })));
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const row = { engine, complete: false, results: [] }; report.engines.push(row); save();
    for (const scenario of scenarios) {
      const result = { ...scenario, complete: false, failureContext: { engine, ...scenario, generation: null, phase: 'browser-launch' } };
      row.results.push(result); save();
      let browser, context;
      try {
        browser = await launcher.launch({ headless: true }); result.browserVersion = browser.version();
        result.failureContext.phase = 'page-setup';
        context = await browser.newContext(); const page = await context.newPage(), pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => {
          const text = message.text();
          if (!text.startsWith(STAGE_PREFIX)) return;
          try {
            result.failureContext = JSON.parse(text.slice(STAGE_PREFIX.length));
            result.contextEvidence = 'Last progress event received before an outer failure; caught protocol errors return their exact stage.';
          } catch {}
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        result.environment = await page.evaluate(() => ({ isolated: crossOriginIsolated, userAgent: navigator.userAgent }));
        assert.equal(result.environment.isolated, true);
        result.failureContext.phase = 'page-evaluate';
        const outcome = await bounded(page.evaluate(async ({ engine, arenas, copy, stagePrefix }) => {
          let failureContext = { engine, arenas, copy, generation: 0, phase: 'page-import' };
          const progress = stage => { failureContext = { engine, ...stage }; console.debug(stagePrefix + JSON.stringify(failureContext)); };
          let worker;
          try {
            const api = await import('/library/shared.js');
            const { runArenaScenario } = await import('/proofs/worker-arena-protocol.mjs');
            worker = new Worker('/proofs/worker-arena-browser-worker.mjs', { type: 'module' });
            const exchange = message => new Promise((resolve, reject) => {
              const timeout = setTimeout(() => finish(new Error('Browser worker proof timed out')), 20000);
              const onMessage = event => {
                if (event.data.error) {
                  failureContext = { engine, arenas, copy, generation: message.generation, ...event.data.failureContext };
                  finish(new Error(event.data.error));
                } else if (!event.data.workerEnvironment?.isolated || !event.data.workerEnvironment?.dedicatedWorker) finish(new Error('Missing real isolated-worker evidence'));
                else finish(undefined, event.data);
              };
              const onError = event => finish(new Error(event.message || 'Browser worker error'));
              const finish = (error, value) => { clearTimeout(timeout); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onError); error ? reject(error) : resolve(value); };
              worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onError);
              try { worker.postMessage(message); } catch (error) { finish(error); }
            });
            const checked = await runArenaScenario(api, exchange, arenas, copy, progress);
            return { passed: true, checked };
          } catch (error) { return { passed: false, error: error.stack ?? String(error), failureContext }; }
          finally { worker?.terminate(); }
        }, { engine, ...scenario, stagePrefix: STAGE_PREFIX }), 60000, 'Browser scenario');
        result.pageErrors = pageErrors;
        if (!outcome.passed) { result.error = outcome.error; result.failureContext = outcome.failureContext; result.contextEvidence = 'Exact caught protocol error stage'; }
        else {
          assert.deepEqual(pageErrors, []);
          assert.equal(outcome.checked.arenas, scenario.arenas); assert.equal(outcome.checked.copy, scenario.copy);
          Object.assign(result, outcome.checked, { complete: true }); delete result.failureContext; delete result.contextEvidence;
        }
      } catch (error) { result.error = error.stack ?? String(error); }
      finally {
        // Always attempt browser closure, even if context cleanup fails.
        for (const resource of [context, browser]) {
          try { if (resource) await bounded(resource.close(), 10000, 'Browser resource cleanup'); }
          catch (error) { (result.cleanupErrors ??= []).push(error.stack ?? String(error)); result.complete = false; }
        }
        save();
      }
      console.log(`${engine}: arenas=${scenario.arenas}, copy=${scenario.copy}: ${result.complete ? 'passed' : 'FAILED; recorded in report'}`);
    }
    row.complete = row.results.length === scenarios.length && row.results.every(result => result.complete); save();
  }
  const after = capture(runtimeRoot);
  assert.equal(after.commit, runtime.commit); assert.equal(after.sourceDirty, false);
  assert.equal(after.source.sha256, runtime.source.sha256); assert.equal(after.build.sha256, runtime.build.sha256);
  assert.equal(manifest(resolve(proofs, '..'), report.proofManifest.files.map(file => file.path)).sha256, report.proofManifest.sha256);
  report.executionComplete = true;
  report.complete = report.engines.length === 3 && report.engines.every(row => row.complete);
  save();
  assert.equal(report.complete, true, 'Browser correctness failures are recorded in the report');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
