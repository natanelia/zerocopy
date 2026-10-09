import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';
import { ATTEMPT_PARAMETER } from '../assets/isolation.mjs';
import { cacheEarlyRegistration } from './isolation-registration-cache.mjs';

const { base } = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const demos = [
  ['compare/', 'compare-start'], ['explorer/', 'load-logs'],
  ['investigation-benchmark/', 'run-investigation-bench'],
  ['lab/', 'run-benchmark'], ['playground/', 'start-playground'],
];
async function ready(page, id) {
  await page.locator('#capability[data-state="ready"], #capability[data-state="blocked"]').waitFor();
  const state = await page.evaluate(async () => {
    const worker = value => value && ({ url: value.scriptURL, state: value.state });
    return {
      url: location.href,
      isolated: crossOriginIsolated,
      visible: document.visibilityState,
      phase: document.querySelector('#capability')?.dataset.state,
      message: document.querySelector('#capability-text')?.textContent,
      controller: worker(navigator.serviceWorker.controller),
      registrations: (await navigator.serviceWorker.getRegistrations()).map(value => ({
        scope: value.scope, active: worker(value.active), waiting: worker(value.waiting), installing: worker(value.installing),
      })),
    };
  });
  assert.equal(state.phase, 'ready', `Automatic setup failed: ${JSON.stringify(state)}`);
  await page.evaluate(() => globalThis.__zcDocumentReported);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(await page.locator('#' + id).isEnabled(), true);
  assert.equal(await page.locator('#enable-isolation').isHidden(), true);
  assert.equal(await page.locator('#capability-help').isHidden(), true);
  assert.equal(new URL(page.url()).searchParams.has(ATTEMPT_PARAMETER), false);
}
async function navigations(page) {
  const urls = [];
  // WebKit may initialize a provisional global while swapping into an isolated
  // process. Count parsed documents, not requests or those initial globals.
  // The test-only trace records both stages to diagnose unexpected reloads.
  const trace = [];
  await page.exposeBinding('__zcDocumentStart', ({ frame }, data) => {
    if (frame !== page.mainFrame()) return;
    trace.push(data);
    if (data.phase === 'parsed') urls.push(data.href);
  });
  await page.addInitScript(() => {
    const initial = { href: location.href, documentURL: document.URL, state: document.readyState, timeOrigin: performance.timeOrigin };
    void globalThis.__zcDocumentStart({ ...initial, phase: 'created' });
    globalThis.__zcDocumentReported = new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', () => {
        globalThis.__zcDocumentStart({ ...initial, phase: 'parsed' }).then(resolve);
      }, { once: true });
    });
  });
  Object.defineProperty(urls, 'trace', { value: trace });
  return urls;
}
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true });
  const errors = [];
  try {
    for (const isolated of [true, false]) {
      const server = createPreview({ base, isolated });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}`;
      try {
        const context = await browser.newContext();
        const page = await context.newPage(); page.setDefaultTimeout(25000);
        page.on('pageerror', error => errors.push(error.message));
        const visits = await navigations(page), requests = [], workers = [];
        page.on('request', request => requests.push(request.url()));
        page.on('worker', worker => workers.push(worker.url()));
        await page.goto(origin + base);
        assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, 'The homepage must not register a service worker');
        for (const [route, id] of demos) {
          visits.length = 0;
          const url = origin + base + route + '?query=timeout&limit=1000#main';
          await page.goto(url, { waitUntil: 'commit' });
          await ready(page, id);
          assert.equal(page.url(), url, 'Keep the original query and fragment');
          assert.equal(visits.length, isolated ? 1 : 2, `${name}: first visit to ${route}: ${JSON.stringify(visits)}; trace: ${JSON.stringify(visits.trace)}`);
          if (!isolated) assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), origin + base + route + 'isolation-sw.js');
          visits.length = 0;
          await page.reload({ waitUntil: 'commit' }); await ready(page, id);
          assert.equal(visits.length, 1, `${name}: a manual reload needs no setup reload`);
          await page.goto(origin + base);
          visits.length = 0;
          await page.goto(url, { waitUntil: 'commit' }); await ready(page, id);
          assert.equal(visits.length, 1, `${name}: a return visit needs no setup reload`);
        }
        assert.equal(workers.length, 0, 'Setup must not start application workers or benchmarks');
        assert.equal(requests.filter(url => url.includes('/library/')).length, 0, 'Setup must not allocate a dataset or load WASM');
        await page.goto(origin + base + 'docs/getting-started/');
        assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null, 'Demo workers must not control the guides');
        assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), isolated ? 0 : 5);
        await context.close();
        console.log(`Passed: ${name}, all five demos, automatic first visit, return visit, preserved URL, no data work (${isolated ? 'headers' : 'no headers'}).`);

        if (isolated) continue;
        // A real first visit while all web-storage access throws. No storage-based loop guard.
        const storage = await browser.newContext();
        await storage.addInitScript(() => {
          for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, key, { get() { throw new Error('Storage blocked by test'); } });
        });
        const p = await storage.newPage(); p.setDefaultTimeout(25000); p.on('pageerror', error => errors.push(error.message));
        const storageVisits = await navigations(p);
        await p.goto(origin + base + 'compare/?filter=errors#main', { waitUntil: 'commit' }); await ready(p, 'compare-start');
        assert.equal(storageVisits.length, 2); await storage.close();

        // Keep register()/getRegistration() views empty after a real install.
        // Readiness must recover from stale cross-process registration slots,
        // but only an actually isolated new document may enable the demo.
        const stale = await browser.newContext();
        await stale.addInitScript(() => {
          const container = navigator.serviceWorker;
          for (const method of ['register', 'getRegistration']) {
            const original = container[method].bind(container);
            container[method] = async (...args) => {
              const value = await original(...args);
              return value && Object.assign(new EventTarget(), {
                scope: value.scope, installing: null, waiting: null, active: null,
              });
            };
          }
        });
        const stalePair = [await stale.newPage(), await stale.newPage()];
        const staleHistories = await Promise.all(stalePair.map(navigations));
        for (const tab of stalePair) { tab.setDefaultTimeout(25000); tab.on('pageerror', error => errors.push(error.message)); }
        await Promise.all(stalePair.map(async tab => {
          await tab.goto(origin + base + 'compare/?stale-registration=1#main', { waitUntil: 'commit' });
          await ready(tab, 'compare-start');
          assert.equal(new URL(tab.url()).searchParams.get('stale-registration'), '1');
          assert.equal(new URL(tab.url()).hash, '#main');
        }));
        assert.ok(staleHistories.every(history => history.length >= 1 && history.length <= 2));
        await stale.close();

        // Two tabs can install/claim concurrently. Neither may loop or need a click.
        for (let round = 0; round < 10; round++) {
        const tabs = await browser.newContext();
        // Finish creating the browser views before racing application navigation.
        // Registration, activation and automatic navigation remain concurrent.
        const pair = [await tabs.newPage(), await tabs.newPage()];
        const histories = await Promise.all(pair.map(navigations));
        for (const tab of pair) { tab.setDefaultTimeout(25000); tab.on('pageerror', error => errors.push(error.message)); }
        const starts = await Promise.allSettled(pair.map(async tab => { await tab.goto(origin + base + 'compare/', { waitUntil: 'commit' }); await ready(tab, 'compare-start'); }));
        for (let index = 0; index < starts.length; index++) {
          if (starts[index].status === 'rejected') {
            console.error(`Concurrent tab ${index}:`, JSON.stringify(histories[index].trace));
            // A new document has a new wrapper cache. Compare it with the
            // failed document to distinguish a stalled install from stale
            // registration state. This diagnostic never changes the verdict.
            const observer = await tabs.newPage();
            await observer.goto(origin + base);
            console.error('Fresh document registration:', JSON.stringify(await observer.evaluate(async scope => {
              const value = await navigator.serviceWorker.getRegistration(scope);
              const worker = item => item && ({ url: item.scriptURL, state: item.state });
              return value && { scope: value.scope, active: worker(value.active), waiting: worker(value.waiting), installing: worker(value.installing) };
            }, origin + base + 'compare/')));
            throw starts[index].reason;
          }
        }
        assert.ok(histories.every(history => history.length >= 1 && history.length <= 2)); await tabs.close();
        }

        // A pre-registration lookup can permanently cache an empty wrapper.
        // Real service workers still install, and only a genuinely isolated
        // second document may pass. Run both tabs together, without retries.
        const cached = await browser.newContext();
        await cached.addInitScript(cacheEarlyRegistration);
        const cachedPair = [await cached.newPage(), await cached.newPage()];
        const cachedHistories = await Promise.all(cachedPair.map(navigations));
        for (const tab of cachedPair) { tab.setDefaultTimeout(25000); tab.on('pageerror', error => errors.push(error.message)); }
        await Promise.all(cachedPair.map(async tab => {
          const url = origin + base + 'compare/?cached-registration=1#main';
          await tab.goto(url, { waitUntil: 'commit' }); await ready(tab, 'compare-start');
          assert.equal(tab.url(), url);
          assert.equal(await tab.evaluate(() => navigator.serviceWorker.controller.scriptURL), origin + base + 'compare/isolation-sw.js');
        }));
        assert.ok(cachedHistories.every(history => history.length >= 1 && history.length <= 2));
        await cached.close();

        // Inject a policy/registration error once. Retry is a recovery action, not a first-visit gate.
        const failure = await browser.newContext();
        await failure.addInitScript(() => {
          const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
          let attempted = false;
          navigator.serviceWorker.register = (...args) => {
            if (!attempted) { attempted = true; return Promise.reject(new Error('Registration blocked by test')); }
            return register(...args);
          };
        });
        const f = await failure.newPage(); f.setDefaultTimeout(25000); const failedVisits = await navigations(f);
        f.on('pageerror', error => errors.push(error.message));
        await f.goto(origin + base + 'compare/'); await f.locator('#capability[data-state="blocked"]').waitFor();
        await f.evaluate(() => globalThis.__zcDocumentReported);
        assert.equal(failedVisits.length, 1); assert.equal(await f.locator('#compare-start').isDisabled(), true);
        assert.match(await f.locator('#capability-text').innerText(), /Registration blocked by test/);
        await f.getByRole('button', { name: 'Retry setup', exact: true }).click(); await ready(f, 'compare-start');
        assert.equal(failedVisits.length, 2); await failure.close();

        // Some embedded browsers throw on access, rather than hide the API.
        // The error UI must not read it again without protection.
        const restricted = await browser.newContext();
        await restricted.addInitScript(() => Object.defineProperty(navigator, 'serviceWorker', {
          get() { throw new Error('Service workers blocked by policy'); },
        }));
        const r = await restricted.newPage(); r.setDefaultTimeout(25000);
        r.on('pageerror', error => errors.push(error.message));
        const restrictedVisits = await navigations(r);
        await r.goto(origin + base + 'compare/');
        await r.locator('#capability[data-state="blocked"]').waitFor();
        await r.evaluate(() => globalThis.__zcDocumentReported);
        assert.match(await r.locator('#capability-text').innerText(), /blocked by policy/);
        assert.equal(await r.locator('#compare-start').isDisabled(), true);
        assert.equal(await r.locator('#enable-isolation').isHidden(), true);
        assert.equal(await r.locator('#capability-help').isVisible(), true);
        assert.equal(restrictedVisits.length, 1); await restricted.close();

        // Simulate a browser that stays non-isolated after successful installation.
        // Actual success above uses the unmodified browser security properties.
        const denied = await browser.newContext();
        await denied.addInitScript(() => Object.defineProperty(globalThis, 'crossOriginIsolated', { get: () => false }));
        const d = await denied.newPage(); d.setDefaultTimeout(25000); const deniedVisits = await navigations(d);
        d.on('pageerror', error => errors.push(error.message));
        await d.goto(origin + base + 'compare/', { waitUntil: 'commit' });
        await d.locator('#capability[data-state="blocked"]').waitFor();
        await d.evaluate(() => globalThis.__zcDocumentReported);
        assert.match(await d.locator('#capability-text').innerText(), /Automatic reloads have stopped/);
        assert.equal(await d.locator('#compare-start').isDisabled(), true);
        await d.waitForTimeout(300); assert.equal(deniedVisits.length, 2, 'A failed setup must not loop');
        await d.reload(); await d.locator('#capability[data-state="blocked"]').waitFor();
        await d.evaluate(() => globalThis.__zcDocumentReported);
        assert.equal(deniedVisits.length, 3, 'Even a manual reload must not restart the automatic loop');
        await denied.close();
        console.log(`Passed: ${name}, blocked storage, stale registration views, concurrent tabs, failed registration/retry, and failed-isolation reload guard.`);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
console.log(`Automatic isolation verified at ${base}. No enable click was used on successful first visits.`);
