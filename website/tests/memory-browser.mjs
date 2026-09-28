import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';

// A mobile viewport in Chromium is not a WebKit memory test.
const engine = process.env.BROWSER ?? 'webkit';
assert.ok(['chromium', 'webkit'].includes(engine));
const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const browser = await ({ chromium, webkit }[engine]).launch({ headless: true });
let page;
const errors = [];
async function action(selector, count, frozen, liveCount = count) {
  const before = Number(await page.locator('#comparison-workspace').getAttribute('data-completed-operation') ?? 0);
  await page.locator(selector).click();
  await page.waitForFunction(before => {
    const workspace = document.querySelector('#comparison-workspace');
    return (workspace.getAttribute('aria-busy') === 'false' &&
      Number(workspace.dataset.completedOperation ?? 0) > before &&
      document.querySelector('#compare-parity').dataset.verified === 'true') ||
      (!document.querySelector('#compare-start').disabled &&
        /(?:error|stopped|failed|memory)/i.test(document.querySelector('#compare-status').textContent));
  }, before);
  const status = await page.locator('#compare-status').innerText();
  assert.equal(await page.locator('#compare-parity').getAttribute('data-verified'), 'true', `${engine} ${count}: ${status}`);
  assert.ok(Number(await page.locator('#comparison-workspace').getAttribute('data-completed-operation')) > before, 'Each action must produce a new verified result');
  assert.equal(await page.locator('#comparison-workspace').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#comparison-workspace').getAttribute('data-frozen'), String(frozen));
  assert.equal(await page.locator('#compare-count').getAttribute('data-count'), String(count));
  assert.equal(await page.locator('#compare-live').getAttribute('data-count'), String(liveCount));
}
try {
  for (const isolated of [true, false]) {
    const server = createPreview({ base: meta.base, isolated });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      page = await context.newPage(); page.setDefaultTimeout(90000);
      page.on('pageerror', error => errors.push(error.stack || error.message));
      page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
      await page.goto(`http://127.0.0.1:${server.address().port}${meta.base}compare/`);
      if (!isolated) {
        await page.waitForFunction(() => crossOriginIsolated && !document.querySelector('#compare-start').disabled);
      }
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      if (isolated) {
        let libraryRequests = 0;
        await context.route('**/library/**', route => { libraryRequests++; return route.abort(); });
        await page.evaluate(async () => {
          const { Peer } = await import('./assets/explorer-peer.mjs');
          const { generateColumns } = await import('./assets/explorer-core.mjs');
          const peer = new Peer(new URL('./assets/comparison-reader.mjs', location.href));
          try {
            await peer.request('ping');
            await peer.request('native', { columns: generateColumns(0, 1000) });
            await peer.request('append', { columns: generateColumns(1000, 2000) });
            const answer = await peer.request('query', { role: 'search', count: 3000, query: {} });
            if (answer.search.total !== 3000) throw new Error('Native reader returned the wrong count');
            await peer.request('prepare-immutable');
            await peer.request('immutable-init', { columns: generateColumns(0, 1000) });
            await peer.request('retain', { enabled: true });
            await peer.request('immutable-append', { columns: generateColumns(1000, 2000) });
            const frozen = await peer.request('query', { role: 'search', count: 1000, query: {} });
            if (frozen.search.total !== 1000) throw new Error('Immutable.js lost its retained root');
            // Full replacement must also preserve the frozen root.
            await peer.request('immutable-init', { columns: generateColumns(0, 5000) });
            const replaced = await peer.request('query', { role: 'search', count: 1000, query: {} });
            if (replaced.search.total !== 1000) throw new Error('Full replication lost the retained root');
            await peer.request('retain', { enabled: false });
            const live = await peer.request('query', { role: 'search', count: 5000, query: {} });
            if (live.search.total !== 5000) throw new Error('Immutable.js did not resume live');
          } finally { peer.close(); }
        });
        assert.equal(libraryRequests, 0, 'Native and Immutable.js readers must not depend on the WASM engine');
        await context.unroute('**/library/**');
      }
      for (const size of ['1000', '100000', '1000']) {
        await page.locator('#compare-size').selectOption(size);
        await action('#compare-start', Number(size), false);
        await action('#compare-freeze', Number(size), true);
        await action('#compare-append', Number(size), true, Number(size) + 2000);
        assert.equal(await page.locator('#compare-count').getAttribute('data-count'), size);
        assert.equal(await page.locator('#copies-immutable').innerText(), await page.locator('#copies-native').innerText());
        assert.equal(await page.locator('#matches-immutable').innerText(), await page.locator('#matches-native').innerText());
        await action('#compare-freeze', Number(size) + 2000, false);
        await page.locator('#compare-stop').click();
        assert.equal(await page.locator('#compare-count').getAttribute('data-count'), '0');
        console.log(`Passed: ${engine} ${size} events, freeze/append/resume, Stop/restart (${isolated ? 'headers' : 'service-worker isolation'}).`);
      }
      // Verify the four-path controlled benchmark under both hosting policies.
      await page.goto(`http://127.0.0.1:${server.address().port}${meta.base}investigation-benchmark/`);
      if (!isolated) {
        await page.waitForFunction(() => crossOriginIsolated && !document.querySelector('#run-investigation-bench').disabled);
      }
      await page.locator('#investigation-size').selectOption('1000'); await page.locator('#run-investigation-bench').click();
      await page.waitForFunction(() => document.querySelector('#investigation-bench-status').textContent.startsWith('Complete.'), {}, { timeout: 120000 });
      assert.equal(await page.locator('.architecture-result .result-row').count(), 12);
    } finally {
      await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Memory regression passed in ${engine} ${browser.version()} at ${meta.base}.`);
} catch (error) {
  if (page && !page.isClosed()) {
    mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
    console.error(await page.locator('body').innerText());
  }
  throw error;
} finally { await browser.close(); }
