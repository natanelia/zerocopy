import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';

const { base } = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const artifacts = process.env.BROWSER_ARTIFACTS_DIR || fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });
const server = createPreview({ base }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const value = (page, id) => page.locator(`#${id}`).evaluate(node => node.firstChild.textContent);
async function ready(page) { await page.waitForFunction(() => !document.querySelector('#apply-edit').disabled); }
async function publish(page, stock, revision, price) {
  await ready(page); await page.locator('#stock').fill(String(stock));
  if (price !== undefined) await page.locator('#price').fill(String(price));
  await page.locator('#apply-edit').click();
  await page.waitForFunction(version => document.querySelector('#owner-revision').textContent === `r${version}` && !document.querySelector('#apply-edit').disabled, revision);
}

try {
  for (const name of process.env.STUDIO_BROWSERS?.split(',') || ['chromium', 'webkit']) {
    assert.ok(['chromium', 'webkit'].includes(name));
    const browser = await ({ chromium, webkit })[name].launch({ headless: true,
      ...(name === 'chromium' ? { args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + base + 'playground/');
      assert.equal(page.workers().length, 0);
      await page.waitForFunction(() => !document.querySelector('#start-playground').disabled);
      await page.evaluate(() => {
        document.querySelector('#start-playground').click();
        document.querySelector('#stop-playground').click();
      });
      assert.equal(page.workers().length, 0, 'Disconnect cancels initialization before a worker starts');
      await page.getByRole('button', { name: 'Connect a worker' }).click(); await ready(page);
      assert.equal(page.workers().length, 1);
      assert.equal(await value(page, 'reader-value'), '12'); assert.equal(await value(page, 'retained-value'), '12');

      await page.locator('#stock').fill('0'); await page.locator('#price').fill('119.50');
      assert.equal(await value(page, 'owner-value'), '12', 'A draft must not publish until requested');
      await publish(page, 0, 1, 119.50);
      assert.equal(await value(page, 'reader-value'), '0'); assert.equal(await value(page, 'retained-value'), '12');
      assert.equal(await page.locator('#reader-availability').innerText(), 'Sold out');
      assert.equal(await page.locator('#studio-reader-1 [data-latest-price]').innerText(), '$119.50');
      assert.equal(await page.locator('#studio-reader-1 [data-pinned-price]').innerText(), '$129.00');

      await page.locator('#add-reader').click(); await ready(page);
      await page.locator('#add-reader').click(); await ready(page);
      assert.equal(page.workers().length, 3); assert.equal(await page.locator('#add-reader').isDisabled(), true);
      assert.equal(await value(page, 'retained-2-value'), '0', 'Late reader pins its actual first revision');
      await publish(page, 6, 2, 120);
      for (const id of ['reader-value', 'reader-2-value', 'reader-3-value']) assert.equal(await value(page, id), '6');
      assert.equal(await value(page, 'retained-value'), '12');
      assert.equal(await value(page, 'retained-2-value'), '0');
      await page.locator('#pin-revision-1').selectOption('1'); await ready(page);
      assert.equal(await value(page, 'retained-value'), '0');
      await page.locator('#studio-reader-2 [data-pin-latest]').click(); await ready(page);
      assert.equal(await value(page, 'retained-2-value'), '6');
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: `${artifacts}/studio-${name}-desktop.png`, fullPage: true });

      await page.locator('[data-product="keyboard"]').click();
      assert.equal(await value(page, 'reader-value'), '24');
      await publish(page, 23, 3, 85);
      assert.equal(await value(page, 'reader-value'), '23');
      assert.equal(await value(page, 'retained-value'), '24');
      for (const invalid of ['-1', '1.5', '201', '']) {
        await page.locator('#stock').fill(invalid); await page.locator('#apply-edit').click();
        assert.equal(await page.locator('#owner-revision').innerText(), 'r3');
      }
      await page.locator('#stock').fill('20'); await page.locator('#price').fill('1.005');
      await page.locator('#apply-edit').click();
      assert.equal(await page.locator('#owner-revision').innerText(), 'r3');

      for (let revision = 4; revision <= 13; revision++) await publish(page, 20 + revision, revision, 85);
      assert.equal(await page.locator('#revision-timeline li').count(), 8);
      for (let id = 1; id <= 3; id++) assert.ok(await page.locator(`#pin-revision-${id} option`).count() <= 10);
      await page.locator('#pin-revision-1').selectOption('0'); await ready(page);
      assert.equal(await value(page, 'retained-value'), '24', 'First snapshot survives bounded recent history');
      assert.equal(await page.locator('#studio-reader-1 [data-pinned-price]').innerText(), '$89.00');
      await page.locator('[data-product="headphones"]').click();
      assert.equal(await value(page, 'reader-value'), '6', 'Editing another product does not change headphones');
      assert.equal(await value(page, 'retained-value'), '12');

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflow at ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: `${artifacts}/studio-${name}-mobile.png`, fullPage: true });
      const closed = page.workers().map(worker => worker.waitForEvent('close'));
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await Promise.all(closed);
      assert.equal(page.workers().length, 0); assert.equal(await page.locator('#apply-edit').isDisabled(), true);
      await page.locator('#start-playground').click(); await ready(page);
      assert.equal(await value(page, 'reader-value'), '12'); assert.equal(await page.locator('#owner-revision').innerText(), 'r0');
      assert.equal(page.workers().length, 1);
      // Exercise the persisted-page teardown path even in test engines that
      // disable the back/forward cache. A restored page must not imply live readers.
      const retainedPageClosed = page.workers().map(worker => worker.waitForEvent('close'));
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      await Promise.all(retainedPageClosed);
      assert.match(await page.locator('#studio-status').innerText(), /Page navigation ended this session/);
      assert.equal(await page.locator('#studio-session-label').innerText(), 'No workers running');
      assert.equal(await page.locator('#start-playground').isEnabled(), true);
      await page.locator('#start-playground').click(); await ready(page);
      const navigationClosed = page.workers().map(worker => worker.waitForEvent('close'));
      await page.goto(origin + base + 'docs/getting-started/'); await Promise.all(navigationClosed);
      assert.deepEqual(errors, []); await context.close();

      // A constructor failure must leave a usable reconnect path and no live worker.
      const failureContext = await browser.newContext();
      await failureContext.addInitScript(() => {
        const NativeWorker = window.Worker; let first = true;
        window.Worker = class extends NativeWorker {
          constructor(...args) { if (first) { first = false; throw new Error('Test worker startup failure'); } super(...args); }
        };
      });
      const failure = await failureContext.newPage();
      await failure.goto(origin + base + 'playground/'); await failure.locator('#start-playground').click();
      await failure.waitForFunction(() => document.querySelector('#studio-status').textContent.includes('Test worker startup failure'));
      assert.equal(failure.workers().length, 0);
      await failure.locator('#start-playground').click(); await ready(failure);
      assert.equal(await value(failure, 'reader-value'), '12'); await failureContext.close();
      console.log(`Passed ${name}: real workers, draft/publish separation, price/stock edits, independent pins, late joins, bounded history, invalid edits, reconnect, teardown, 320px/390px layouts.`);
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
