import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { cacheEarlyRegistration } from '../../website/tests/isolation-registration-cache.mjs';

const baseline = '56211356dfdb7356b8b3e572109625aa81207d0a';
const original = execFileSync('git', ['show', `${baseline}:website/assets/isolation.mjs`], { encoding: 'utf8' });
const candidate = readFileSync('website/assets/isolation.mjs', 'utf8');
const worker = readFileSync('website/assets/isolation-sw.js', 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const output = { baseline, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), hashes: { original: digest(original), candidate: digest(candidate), worker: digest(worker) }, records: [] };
mkdirSync('proofs/website-isolation-register-first/results', { recursive: true });
const save = () => writeFileSync('proofs/website-isolation-register-first/results/browser.json', JSON.stringify(output, null, 2) + '\n');
save();
const html = `<!doctype html><meta charset="utf-8"><title>Isolation setup regression</title><p id="state">starting</p><script type="module">
import { prepareIsolation } from './isolation.mjs';
try { const state = await prepareIsolation({ workerURL: new URL('./isolation-sw.js', location.href) }); document.querySelector('#state').textContent = state; }
catch (error) { document.querySelector('#state').textContent = 'blocked'; document.querySelector('#state').dataset.error = error.message; }
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path.endsWith('/isolation.mjs')) { res.setHeader('Content-Type', 'text/javascript'); res.end(path.includes('/baseline/') ? original : candidate); }
  else if (path.endsWith('/isolation-sw.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end(worker); }
  else { res.setHeader('Content-Type', 'text/html'); res.end(path === '/' ? '<!doctype html><title>Observer</title>' : html); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const injected of [false, true]) {
        const rounds = injected ? 1 : 10;
        for (let round = 0; round < rounds; round++) {
          // Fixed balanced source order; no retries and no discarded failures.
          for (const role of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
            const context = await browser.newContext();
            const record = { engine: engineName, version: browser.version(), injected, round, role, trace: [], states: [] };
            output.records.push(record); save();
            try {
              await context.exposeBinding('__trace', ({ page }, event) => { record.trace.push({ page: context.pages().indexOf(page), ...event }); });
              await context.addInitScript(() => {
                const container = navigator.serviceWorker;
                const worker = item => item && ({ url: item.scriptURL, state: item.state });
                const view = item => item && ({ scope: item.scope, active: worker(item.active), waiting: worker(item.waiting), installing: worker(item.installing) });
                const trace = (kind, value) => void globalThis.__trace({ kind, value, time: performance.timeOrigin + performance.now(), href: location.href });
                let previous;
                for (const method of ['getRegistration', 'register']) {
                  const original = container[method].bind(container);
                  container[method] = async (...args) => {
                    if (method === 'register') trace('register-start', args.map(String));
                    const value = await original(...args), snapshot = view(value), serialized = JSON.stringify(snapshot);
                    if (method === 'register' || previous !== serialized) { trace(method, snapshot); previous = serialized; }
                    return value;
                  };
                }
                container.ready.then(value => trace('ready', view(value)));
                globalThis.__parsedReported = new Promise(resolve => document.addEventListener('DOMContentLoaded', () => {
                  globalThis.__trace({ kind: 'parsed', value: { isolated: crossOriginIsolated }, time: performance.timeOrigin + performance.now(), href: location.href }).then(resolve);
                }, { once: true }));
              });
              if (injected) await context.addInitScript(cacheEarlyRegistration);
              const pages = [await context.newPage(), await context.newPage()];
              for (const page of pages) page.setDefaultTimeout(25000);
              const scope = `${origin}/zerocopy/previews/pr-22/${baseline}/${role}/compare/`;
              const results = await Promise.allSettled(pages.map(async page => {
                await page.goto(scope + '?query=timeout#main', { waitUntil: 'commit' });
                await page.waitForFunction(() => ['ready', 'blocked'].includes(document.querySelector('#state')?.textContent));
                await page.evaluate(() => globalThis.__parsedReported);
                return page.evaluate(() => ({ state: document.querySelector('#state').textContent, error: document.querySelector('#state').dataset.error, isolated: crossOriginIsolated, url: location.href, controller: navigator.serviceWorker.controller?.scriptURL ?? null }));
              }));
              record.states = results.map(result => result.status === 'fulfilled' ? result.value : { state: 'error', error: String(result.reason) });
              if (record.states.some(state => state.state !== 'ready')) {
                const observer = await context.newPage(); await observer.goto(origin);
                assert.equal(await observer.evaluate(() => Object.hasOwn(navigator.serviceWorker, 'ready')), false, 'Observer must use the native readiness API outside the modelled demo scope');
                record.freshRegistration = await observer.evaluate(async scope => {
                  const value = await navigator.serviceWorker.getRegistration(scope);
                  return value && { scope: value.scope, active: value.active && { url: value.active.scriptURL, state: value.active.state }, installing: value.installing?.state ?? null, waiting: value.waiting?.state ?? null };
                }, scope);
              }
              for (const state of record.states.filter(state => state.state === 'ready')) {
                assert.equal(state.isolated, true);
                assert.equal(state.controller, scope + 'isolation-sw.js');
                assert.equal(state.url, scope + '?query=timeout#main');
              }
              for (let index = 0; index < 2; index++) {
                const parsed = record.trace.filter(event => event.page === index && event.kind === 'parsed').length;
                assert.ok(parsed >= 1 && parsed <= 2, 'One parsed document and at most one automatic reload');
              }
            } catch (error) { record.error = String(error.stack ?? error); }
            finally { save(); await context.close(); }
            console.log(JSON.stringify({ engine: engineName, injected, round, role, states: record.states, freshRegistration: record.freshRegistration, error: record.error }));
          }
        }
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); save(); }
for (const record of output.records) {
  assert.equal(record.error, undefined);
  if (record.role === 'candidate') assert.ok(record.states.every(state => state.state === 'ready'), JSON.stringify(record));
  if (record.role === 'baseline' && record.injected) {
    assert.ok(record.states.every(state => state.state === 'blocked' && /timed out/.test(state.error)), 'The original source must reproduce the cached-wrapper failure');
    assert.equal(record.freshRegistration?.active?.state, 'activated', 'The underlying real worker must have completed activation');
  }
}
assert.equal(output.records.length, 44);
console.log('Completed all 44 fixed scenarios; every result retained.');
