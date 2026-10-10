import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';

const base = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url))).base;
const searchJSON = readFileSync(new URL('../_site/search.json', import.meta.url), 'utf8');
const screenshots = fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(screenshots, { recursive: true });
const server = createPreview({ base });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, ...(name === 'chromium' && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    context.on('page', page => { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); });
    try {
      const page = await context.newPage();
      await page.goto(origin + base + 'docs/collections/');
      assert.equal(await page.locator('.doc-toc a[href="#custom-ordering"]').isVisible(), true);
      const opener = page.getByRole('button', { name: 'Search documentation' });
      await opener.click();
      await page.locator('.search-result').first().waitFor();
      assert.match(await page.locator('#search-status').innerText(), /Start with a guide/);
      assert.ok((await page.locator('.search-result').first().getAttribute('href')).startsWith(base + 'docs/'));
      await page.locator('#search-input').fill('custom ordering');
      const result = page.locator('.search-result').first();
      assert.equal(await result.getAttribute('href'), base + 'docs/collections/#custom-ordering');
      assert.ok((await result.locator('p').innerText()).length > 0);
      await page.keyboard.press('ArrowDown');
      assert.equal(await result.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.locator('#search-input').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page.waitForURL('**/docs/collections/#custom-ordering');
      assert.equal(await page.locator('dialog').evaluate(node => node.open), false);
      // Returning focus must not undo the section's native fragment navigation.
      await page.waitForFunction(() => {
        const rect = document.querySelector('#custom-ordering').getBoundingClientRect();
        return rect.top >= 70 && rect.top < innerHeight / 2;
      });
      await page.goBack(); await page.waitForURL('**/docs/collections/');
      await page.goForward(); await page.waitForURL('**/docs/collections/#custom-ordering');
      assert.equal(await page.locator('dialog').evaluate(node => node.open), false);
      await opener.click(); await page.locator('#search-input').fill('<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('.search-result').count(), 0);
      assert.equal(await page.locator('#search-results img, #search-results script').count(), 0);
      assert.match(await page.locator('#search-status').innerText(), /No results/);
      await page.keyboard.press('Escape');
      assert.equal(await opener.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Control+k');
      assert.match(await page.locator('#search-status').innerText(), /No results/);
      await page.getByRole('button', { name: 'Close search' }).click();
      assert.equal(await page.locator('dialog').evaluate(node => node.open), false);
      await opener.click(); await page.locator('#search-input').fill('');
      await page.locator('.search-result').first().waitFor();
      await page.screenshot({ path: `${screenshots}/docs-search-${name}.png` });
      await page.keyboard.press('Escape');
      await page.locator('.doc-pagination a[rel="next"]').click();
      await page.waitForURL('**/docs/text-search/');
      await page.locator('.doc-pagination a[rel="prev"]').click();
      await page.waitForURL('**/docs/collections/');
      await page.goBack(); await page.waitForURL('**/docs/text-search/');
      await page.goForward(); await page.waitForURL('**/docs/collections/');
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async text => { globalThis.__copied = text; } },
      }));
      const code = await page.locator('article .code-block code').first().textContent();
      await page.locator('article .copy-code').first().click();
      assert.equal(await page.evaluate(() => globalThis.__copied), code);
      await page.locator('.copy-page').click();
      const markdown = readFileSync(new URL('../_site/markdown/collections.md', import.meta.url), 'utf8');
      await page.waitForFunction(expected => globalThis.__copied === expected, markdown);

      for (const failure of ['http', 'json', 'old-schema', 'route']) {
        const broken = await browser.newContext();
        let attempts = 0;
        await broken.route('**/search.json', route => {
          attempts++;
          if (attempts > 1) return route.continue();
          const body = failure === 'json' ? '{' : failure === 'old-schema' ? '[{"title":"Old","route":"docs/collections/"}]'
            : failure === 'route' ? JSON.stringify([{ title: 'Bad', heading: '', context: '', description: '', text: '', route: '//example.org/' }]) : '{}';
          return route.fulfill({ status: failure === 'http' ? 503 : 200, contentType: 'application/json', body });
        });
        try {
          const failed = await broken.newPage(); failed.setDefaultTimeout(15000);
          failed.on('pageerror', error => errors.push(error.message));
          await failed.goto(origin + base + 'docs/collections/');
          await failed.getByRole('button', { name: 'Search documentation' }).click();
          await failed.getByRole('button', { name: 'Retry search' }).waitFor();
          assert.equal(await failed.locator('.search-result').count(), 0);
          if (failure === 'old-schema') {
            await failed.getByRole('button', { name: 'Close search' }).click();
            await failed.getByRole('button', { name: 'Search documentation' }).click();
          } else await failed.getByRole('button', { name: 'Retry search' }).click();
          await failed.locator('.search-result').first().waitFor();
          assert.equal(attempts, 2);
          assert.equal(await failed.locator('#search-retry').isVisible(), false);
          assert.equal(await failed.locator('#search-results').getAttribute('aria-busy'), 'false');
        } finally { await broken.close(); }
      }

      const delayed = await browser.newContext();
      let release, attempts = 0;
      const pending = new Promise(resolve => { release = resolve; });
      await delayed.route('**/search.json', async route => {
        attempts++; await pending;
        await route.fulfill({ contentType: 'application/json', body: searchJSON });
      });
      try {
        const waiting = await delayed.newPage(); waiting.setDefaultTimeout(15000);
        waiting.on('pageerror', error => errors.push(error.message));
        await waiting.goto(origin + base + 'docs/collections/');
        const started = waiting.waitForRequest('**/search.json');
        started.catch(() => {});
        await waiting.getByRole('button', { name: 'Search documentation' }).click(); await started;
        await waiting.locator('#search-input').fill('custom ordering');
        await waiting.getByRole('button', { name: 'Close search' }).click();
        await waiting.getByRole('button', { name: 'Search documentation' }).click();
        release(); await waiting.locator('.search-result').first().waitFor();
        assert.equal(attempts, 1, 'Reopening must reuse the pending index request');
        assert.equal(await waiting.locator('.search-result').first().getAttribute('href'), base + 'docs/collections/#custom-ordering');
      } finally { release(); await delayed.close(); }

      const noJS = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce' });
      try {
        const plain = await noJS.newPage(); plain.setDefaultTimeout(15000);
        for (const width of [1024, 390, 320]) {
          await plain.setViewportSize({ width, height: 900 });
          await plain.goto(origin + base + 'docs/collections/');
          assert.equal(await plain.locator('.mobile-page-menu').isVisible(), true);
          await plain.locator('.mobile-page-menu summary').focus(); await plain.keyboard.press('Enter');
          const heading = plain.locator('.mobile-page-menu a[href="#custom-ordering"]');
          assert.equal(await heading.isVisible(), true);
          await heading.click(); await plain.waitForURL('**/#custom-ordering');
          if (width < 850) {
            await plain.locator('.mobile-docs-menu summary').click();
            assert.equal(await plain.locator('.mobile-docs-menu [aria-current="page"]').count(), 1);
            assert.ok(await plain.locator('.mobile-docs-menu h2').count() > 1);
          }
          assert.equal(await plain.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await plain.screenshot({ path: `${screenshots}/docs-no-js-${width}-${name}.png`, fullPage: true });
          await plain.locator('.doc-pagination a[rel="next"]').click();
          await plain.waitForURL('**/docs/text-search/');
        }
      } finally { await noJS.close(); }
      assert.deepEqual(errors, []);
      console.log(`Passed: ${name} docs sections, keyboard search, hostile input, retry, close/reopen, no-JS navigation and mobile/tablet layout at ${base}.`);
    } finally { await context.close(); await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
