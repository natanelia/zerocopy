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
async function complete(count) {
  await page.waitForFunction(() =>
    document.querySelector('#compare-parity').dataset.verified === 'true' ||
    (!document.querySelector('#compare-start').disabled && /(?:error|stopped|failed|memory)/i.test(document.querySelector('#compare-status').textContent)));
  const status = await page.locator('#compare-status').innerText();
  assert.equal(await page.locator('#compare-parity').getAttribute('data-verified'), 'true', `${engine} ${count}: ${status}`);
  assert.equal(await page.locator('#compare-count').getAttribute('data-count'), String(count));
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
        assert.equal(await page.locator('#compare-start').isDisabled(), true);
        await page.locator('#enable-isolation').click();
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
          } finally { peer.close(); }
        });
        assert.equal(libraryRequests, 0, 'Native readers must not depend on the WASM engine');
        await context.unroute('**/library/**');
      }
      for (const size of (isolated ? ['1000', '100000', '1000'] : ['1000'])) {
        await page.locator('#compare-size').selectOption(size);
        await page.locator('#compare-start').click(); await complete(Number(size));
        await page.locator('#compare-freeze').click(); await complete(Number(size));
        await page.locator('#compare-append').click();
        await page.waitForFunction(count => document.querySelector('#compare-live').dataset.count === String(count) && document.querySelector('#comparison-workspace').getAttribute('aria-busy') === 'false', Number(size) + 2000);
        assert.equal(await page.locator('#compare-count').getAttribute('data-count'), size);
        await page.locator('#compare-freeze').click(); await complete(Number(size) + 2000);
        await page.locator('#compare-stop').click();
        assert.equal(await page.locator('#compare-count').getAttribute('data-count'), '0');
        console.log(`Passed: ${engine} ${size} events, freeze/append/resume, Stop/restart (${isolated ? 'headers' : 'service-worker isolation'}).`);
      }
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
