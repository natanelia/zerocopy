// One supervised Node child owns one fresh default browser and its loopback server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveBrowser } from './heap-portability-adapter.mjs';
import { planFor, requireCI, LIMITS } from './heap-repair-screen-protocol.mjs';
import { json, sha256, manifest } from './heap-repair-screen-source.mjs';
import { deadline, observeWorkers } from './heap-portability-lifecycle.mjs';
import { persistNativeCheckpoint } from './heap-repair-screen-lifetime.mjs';
import { engineIdentity, bindProcessTree } from './heap-repair-screen-engine.mjs';
export async function runBrowser(request) {
  const { lane } = planFor(request.lane); assert(lane.browser);
  requireCI(lane, process.env, json(process.env.GITHUB_EVENT_PATH));
  const neutral = resolve(request.neutral), before = manifest(neutral), derived = deriveBrowser();
  const result = { status: 'running', stage: 'setup', request, requests: [], console: [], pageErrors: [], workers: [],
    workerCloseBarrier: { completed: false },
    browser: { launched: false, closeRequested: false, closeCompleted: false, disconnected: false }, before };
  const scripts = {
    '/study/workloads.mjs': derived.workload.source, '/study/subject.mjs': derived.subject.source,
    '/study/shims.mjs': derived.shims.source, '/study/workers.mjs': derived.parent.source,
    '/study/protocol.mjs': derived.protocol.source, '/study/fixture.mjs': derived.fixture.source,
    '/proofs/heap-entry-worker.mjs': derived.worker.source,
  };
  let server, browser;
  const checkpoint = stage => { result.stage = stage; process.stderr.write(JSON.stringify({ stage, browser: result.browser, workers: result.workers }) + '\n'); };
  try {
    result.provenance = await engineIdentity();
    result.processIdentity = [];
    const engines = await import('playwright');
    const version = json(new URL('../node_modules/playwright/package.json', import.meta.url)).version;
    assert.equal(version, lane.playwright); result.playwright = version;
    const browsersBytes = readFileSync(new URL('../node_modules/playwright-core/browsers.json', import.meta.url));
    const pins = json(new URL('./heap-portability-pins.json', import.meta.url));
    assert.equal(sha256(browsersBytes), pins.playwright.browsersJsonSha256);
    result.browserRevisions = { sha256: sha256(browsersBytes), manifest: JSON.parse(browsersBytes) };
    const engine = engines[lane.runtime], executable = engine.executablePath();
    result.engine = { name: lane.runtime, executable, sha256: sha256(readFileSync(executable)) };
    server = createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
      try {
        const url = new URL(req.url, 'http://localhost'); assert.equal(url.search, ''); assert.equal(url.hash, '');
        let bytes, type = 'text/javascript';
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (url.pathname === '/') { bytes = Buffer.from('<!doctype html><link rel="icon" href="data:,"><title>Heap entry portability subject</title>'); type = 'text/html'; }
        else if (Object.hasOwn(scripts, url.pathname)) bytes = Buffer.from(scripts[url.pathname]);
        else {
          assert(url.pathname.startsWith('/subject/'));
          const path = resolve(neutral, url.pathname.slice('/subject/'.length)); assert(path.startsWith(neutral + sep));
          bytes = readFileSync(path); assert.equal(sha256(bytes), before[path.slice(neutral.length + 1)]);
          if (path.endsWith('.json')) type = 'application/json'; else if (path.endsWith('.wasm')) type = 'application/wasm';
        }
        result.requests.push({ path: url.pathname, sha256: sha256(bytes), bytes: bytes.length });
        res.setHeader('Content-Type', type); res.end(bytes);
      } catch (error) { result.pageErrors.push(String(error)); res.writeHead(404); res.end(); }
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(4173, '127.0.0.1', done); });
    const origin = 'http://127.0.0.1:4173';
    checkpoint('launch'); browser = await engine.launch(result.provenance.launchOptions);
    result.browser.launched = true; result.engine.version = browser.version();
    assert.equal(result.engine.version, '155.0');
    result.processIdentity.push({ checkpoint: 'after-launch', ...persistNativeCheckpoint('after-launch', bindProcessTree(process.pid, result.provenance)) });
    browser.on('disconnected', () => { result.browser.disconnected = true; });
    checkpoint('page'); const page = await deadline(browser.newPage(), 30000, 'Page creation');
    page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => result.pageErrors.push(String(error.stack ?? error)));
    const workerObserver = observeWorkers(page, result.workers);
    await page.goto(origin, { timeout: 30000 });
    result.processIdentity.push({ checkpoint: 'before-work', ...persistNativeCheckpoint('before-work', bindProcessTree(process.pid, result.provenance)) }); checkpoint('evaluate');
    result.raw = await deadline(page.evaluate(async ({ request, origin }) => {
      if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw new Error('Shared-memory isolation unavailable');
      const entryUrl = origin + '/subject/dist/shared.js';
      if (request.phase === 'correctness' && request.kind === 'worker') {
        const { semanticChecks } = await import(origin + '/study/workers.mjs');
        return semanticChecks(entryUrl, request.copy);
      }
      if (request.phase === 'correctness') {
        const { fixtureCheck } = await import(origin + '/study/fixture.mjs');
        return fixtureCheck(entryUrl, request.name);
      }
      const { CASES } = await import(origin + '/study/workloads.mjs');
      const workload = CASES.find(row => row.name === request.name); if (!workload) throw new Error('Unknown workload');
      const { subject } = await import(origin + '/study/subject.mjs');
      return subject({ entryUrl, workload, phase: request.phase,
        repeat: request.repeat, warmupScans: request.warmupScans, authorization: 'frozen-ci-subject' });
    }, { request, origin }), request.phase === 'correctness' ? LIMITS.correctnessMs : 180000, 'Browser workload');
    assert.equal(result.raw.status, 'completed'); assert.equal(result.pageErrors.length, 0);
    assert.equal(result.workers.length, request.kind === 'worker' ? 1 : 0);
    checkpoint('worker-close');
    await workerObserver.waitForClose(request.kind === 'worker' ? 1 : 0, LIMITS.workerCloseMs, result.workerCloseBarrier);
    result.processIdentity.push({ checkpoint: 'after-work', ...persistNativeCheckpoint('after-work', bindProcessTree(process.pid, result.provenance)) });
    result.status = 'completed';
  } catch (error) { result.status = 'failed'; result.error = String(error.stack ?? error); }
  finally {
    if (browser) {
      result.browser.closeRequested = true; checkpoint('close');
      try { await deadline(browser.close(), LIMITS.browserCloseMs, 'Browser close'); result.browser.closeCompleted = true; }
      catch (error) { result.status = 'failed'; result.cleanupError = String(error); }
      if (!result.browser.disconnected || result.workers.some(worker => !worker.closed)) { result.status = 'failed'; result.cleanupError ??= 'Browser/worker closure not observed'; }
    }
    if (server) {
      try { server.closeAllConnections(); await deadline(new Promise(done => server.close(done)), 30000, 'Server close'); result.serverClosed = true; }
      catch (error) { result.status = 'failed'; result.cleanupError ??= String(error); }
    }
    try { result.after = manifest(neutral); assert.deepEqual(result.after, before); }
    catch (error) { result.status = 'failed'; result.error ??= String(error); }
    try { result.provenanceAfter = await engineIdentity(); assert.deepEqual(result.provenanceAfter, result.provenance); }
    catch (error) { result.status = 'failed'; result.error ??= String(error.stack ?? error); }
    checkpoint('terminal');
  }
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let result;
  try { result = await runBrowser(JSON.parse(process.argv[2])); }
  catch (error) { result = { status: 'failed', error: String(error.stack ?? error) }; }
  console.log(JSON.stringify(result, (_, value) => typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value))
    ? { binary64: Object.is(value, -0) ? '-0' : String(value) } : value));
  if (result.status !== 'completed') process.exitCode = 1;
}
