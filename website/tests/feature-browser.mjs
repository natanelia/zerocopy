/** Real feature-map workers, equivalent answers, lifecycle, export and visual checks. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';
const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const artifacts = process.env.BROWSER_ARTIFACTS_DIR || fileURLToPath(new URL('../artifacts/', import.meta.url)); mkdirSync(artifacts, { recursive: true });
const server = createPreview({ base: meta.base }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
// A normal navigation restores the template placeholder; bfcache can restore
// the cleared stopped page. Both must have no record data or active session.
async function assertEmptySession(page, panels) {
  await page.locator('#feature-load:not([disabled])').waitFor();
  for (const id of ['feature-stop', 'feature-id', 'feature-query', 'feature-view', 'feature-edit']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} must be disabled after navigation`);
  }
  assert.equal(await page.locator('#feature-count').isDisabled(), false);
  assert.equal(await page.locator('#feature-detail').innerText(), 'No feature loaded.');
  assert.equal(await page.locator('#feature-revision').innerText(), '—');
  assert.equal(await page.locator('#feature-view-label').innerText(), '—');
  for (const field of ['found', 'invalid', 'closed', 'read']) {
    assert.deepEqual(await page.locator(`[data-${field}]`).allTextContents(), Array(panels).fill('—'));
  }
  assert.deepEqual(await page.locator('[data-checked]').allTextContents(), Array(panels).fill('No result yet'));
  assert.match(await page.locator('#feature-status').innerText(), /^(Load the sample to start the workers\.|Stopped\. Owner and reader workers are terminated\. Load a new session to continue\.)$/);
  const rows = page.locator('#feature-rows tr'), count = await rows.count();
  assert.ok(count <= 1, 'No result rows may survive navigation');
  assert.equal(await rows.locator('button').count(), 0, 'No stale record action may survive navigation');
  if (count) {
    assert.equal(await rows.innerText(), 'Load features to inspect the registry.');
    assert.equal(await rows.locator('td[colspan="5"]').count(), 1);
    assert.equal(await rows.locator('td').count(), 1, 'The placeholder is the only cell');
  }
}
const deadline = setTimeout(() => { console.error('Feature browser gate exceeded 240 seconds'); process.exit(1); }, 240000); deadline.unref();
try {
  for (const name of process.env.FEATURE_BROWSERS?.split(',') || ['chromium', 'webkit']) {
    assert.ok(['chromium', 'webkit'].includes(name));
    const browser = await ({ chromium, webkit })[name].launch({ headless: true, ...(name === 'chromium' && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] } : {}) });
    let activePage;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const page = activePage = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
      for (const route of ['explorer/', 'compare/']) {
        await page.goto(origin + meta.base + route); await page.locator('#feature-load:not([disabled])').waitFor();
        await page.locator('#feature-count').selectOption('1000'); await page.locator('#feature-load').click();
        await page.waitForFunction(() => document.querySelector('#feature-status').textContent.startsWith('Loaded and verified'));
        const panels = route === 'compare/' ? 4 : 1;
        assert.equal(await page.locator('[data-feature-kind]').count(), panels);
        assert.deepEqual(await page.locator('[data-found]').allTextContents(), Array(panels).fill('910 / 1000'));
        assert.match(await page.locator('#feature-detail').innerText(), /"lanes": 0/);
        await page.locator('#feature-edit').click();
        await page.waitForFunction(() => document.querySelector('#feature-revision').textContent === '1');
        assert.match(await page.locator('#feature-detail').innerText(), /"lanes": 2/);
        assert.deepEqual(await page.locator('[data-closed]').allTextContents(), Array(panels).fill('100'));
        await page.locator('#feature-view').selectOption('initial');
        await page.waitForFunction(() => document.querySelector('#feature-view-label').textContent === 'Initial · revision 0');
        assert.match(await page.locator('#feature-detail').innerText(), /"lanes": 0/);
        await page.locator('#feature-edit').click();
        await page.waitForFunction(() => document.querySelector('#feature-revision').textContent === '2');
        assert.match(await page.locator('#feature-detail').innerText(), /"revision": 0/);
        await page.locator('#feature-view').selectOption('current');
        await page.waitForFunction(() => document.querySelector('#feature-view-label').textContent === 'Current · revision 2');
        assert.match(await page.locator('#feature-detail').innerText(), /"revision": 2/);
        await page.locator('#feature-id').fill('road/099999'); await page.locator('#feature-query').click();
        await page.waitForFunction(() => document.querySelector('#feature-detail').textContent.startsWith('No record for'));
        assert.deepEqual(await page.locator('[data-found]').allTextContents(), Array(panels).fill('909 / 1000'));
        await page.locator('#feature-id').fill('road/000000'); await page.locator('#feature-query').click();
        await page.waitForFunction(() => document.querySelector('#feature-detail').textContent.includes('"id": "road/000000"'));
        await page.screenshot({ path: `${artifacts}/feature-${route.slice(0, -1)}-${name}-desktop.png`, fullPage: true });
        await page.locator('#feature-stop').click(); await page.locator('#feature-load:not([disabled])').waitFor();
        assert.equal(await page.locator('#feature-rows tr').count(), 0);
        await page.locator('#feature-load').dblclick();
        await page.waitForFunction(() => document.querySelector('#feature-status').textContent.startsWith('Loaded and verified'));
        await page.goto(origin + meta.base + 'docs/maps/'); await page.goBack();
        await assertEmptySession(page, panels);
        await page.goto(origin + meta.base + 'docs/maps/'); await page.goto(origin + meta.base + route);
        await page.locator('#feature-load:not([disabled])').waitFor(); await page.locator('#feature-count').selectOption('1000'); await page.locator('#feature-load').click();
        await page.waitForFunction(() => document.querySelector('#feature-status').textContent.startsWith('Loaded and verified'));
        await page.goBack(); await page.goForward();
        await assertEmptySession(page, panels);
      }
      await page.goto(origin + meta.base + 'explorer/'); await page.locator('#feature-load:not([disabled])').waitFor();
      await page.locator('#feature-count').selectOption('100000'); await page.locator('#feature-load').click();
      await page.waitForFunction(() => document.querySelector('#feature-status').textContent.startsWith('Loaded and verified'), undefined, { timeout: 60000 });
      assert.equal(await page.locator('[data-found]').innerText(), '910 / 1000');
      await page.locator('#feature-edit').click(); await page.waitForFunction(() => document.querySelector('#feature-revision').textContent === '1');
      await page.locator('#feature-view').selectOption('initial'); await page.waitForFunction(() => document.querySelector('#feature-view-label').textContent === 'Initial · revision 0');
      assert.match(await page.locator('#feature-detail').innerText(), /"lanes": 0/);
      await page.locator('#feature-stop').click(); await page.locator('#feature-load:not([disabled])').waitFor();
      await page.goto(origin + meta.base + 'investigation-benchmark/'); await page.locator('#feature-run:not([disabled])').waitFor();
      await page.locator('#feature-count').selectOption('1000'); await page.locator('#feature-run').click();
      await page.waitForFunction(() => document.querySelector('#feature-benchmark-status').textContent.startsWith('Complete.'), undefined, { timeout: 90000 });
      const downloadPromise = page.waitForEvent('download'); await page.locator('#feature-export').click(); const download = await downloadPromise;
      const raw = JSON.parse(readFileSync(await download.path(), 'utf8'));
      assert.equal(raw.schema, 'zerocopy-feature-map-browser/v1'); assert.equal(raw.raw.length, 36); assert.equal(raw.raw.filter(record => !record.warmup).length, 28);
      assert.equal(raw.sourceCommit, meta.sourceCommit); assert.deepEqual(raw.dependencies, meta.dependencies);
      for (const record of raw.raw) {
        assert.equal(record.verification.first.answer.lookup.found, 910);
        assert.equal(record.verification.updated.answer.validation.closed, 100);
        assert.equal(record.verification.initial.answer.validation.closed, 0);
        assert.equal(record.verification.first.answer.lookup.fingerprint, record.verification.repeat.answer.lookup.fingerprint);
        assert.ok(record.updatePublicationMs >= record.updateMs && record.updatePublicationMs >= record.editPublicationMs);
      }
      writeFileSync(`${artifacts}/feature-benchmark-${name}.json`, JSON.stringify(raw, null, 2));
      await page.locator('#feature-count').selectOption('100000'); await page.locator('#feature-run').click(); await page.locator('#feature-cancel').click();
      assert.match(await page.locator('#feature-benchmark-status').innerText(), /Stopped/); assert.equal(await page.locator('#feature-export').isDisabled(), true);
      await page.locator('#feature-run').click(); await page.goto(origin + meta.base + 'docs/maps/'); await page.goBack();
      await page.locator('#feature-run:not([disabled])').waitFor(); assert.equal(await page.locator('#feature-export').isDisabled(), true);
      await page.goto(origin + meta.base + 'docs/maps/'); await page.goto(origin + meta.base + 'investigation-benchmark/');
      await page.locator('#feature-run:not([disabled])').waitFor(); await page.locator('#feature-run').click();
      await page.goBack(); await page.goForward();
      await page.locator('#feature-run:not([disabled])').waitFor(); assert.equal(await page.locator('#feature-export').isDisabled(), true);
      assert.equal(await page.locator('#feature-benchmark-results').innerText(), '');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const route of ['explorer/', 'compare/', 'investigation-benchmark/', 'docs/memory-comparison/', 'historical/log-explorer/']) {
          await page.goto(origin + meta.base + route);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} ${width}px ${route}`);
          for (const field of await page.locator('.feature-controls input, .feature-controls select').all()) {
            assert.ok((await field.boundingBox()).width >= 200, `${name} ${width}px ${route} usable form control`);
          }
        }
      }
      await page.goto(origin + meta.base + 'compare/'); await page.locator('#feature-load:not([disabled])').waitFor(); await page.locator('#feature-count').selectOption('1000'); await page.locator('#feature-load').click();
      await page.waitForFunction(() => document.querySelector('#feature-status').textContent.startsWith('Loaded and verified'));
      assert.deepEqual(await page.locator('[data-found]').allTextContents(), Array(4).fill('910 / 1000'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} loaded comparison at 320px`);
      await page.screenshot({ path: `${artifacts}/feature-compare-${name}-mobile.png`, fullPage: true });
      await page.locator('#feature-stop').click(); await page.locator('#feature-load:not([disabled])').waitFor();
      await page.goto(origin + meta.base + 'explorer/'); await page.locator('#feature-load:not([disabled])').waitFor(); await page.locator('#feature-count').selectOption('1000'); await page.locator('#feature-load').click();
      await page.waitForFunction(() => document.querySelector('#feature-status').textContent.startsWith('Loaded and verified'));
      await page.screenshot({ path: `${artifacts}/feature-explorer-${name}-mobile.png`, fullPage: true });
      assert.deepEqual(errors, []); await context.close();
      const plainContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
      const plain = await plainContext.newPage(); await plain.goto(origin + meta.base + 'docs/memory-comparison/');
      assert.equal(await plain.locator('[data-feature-memory-chart]').count(), 2);
      assert.match(await plain.locator('[data-feature-memory-chart="rss-eight"]').innerText(), /Separate 8-reader run/);
      assert.match(await plain.locator('article').innerText(), /different CPU|different host|separate cohorts/);
      assert.match(await plain.locator('h1').innerText(), /SharedMap memory comparison/);
      await plain.screenshot({ path: `${artifacts}/feature-memory-${name}-mobile.png`, fullPage: true }); await plainContext.close();
      const staticServer = createPreview({ base: meta.base, isolated: false }); staticServer.listen(0, '127.0.0.1'); await once(staticServer, 'listening');
      try {
        const staticContext = await browser.newContext(), staticPage = activePage = await staticContext.newPage(); staticPage.setDefaultTimeout(25000);
        await staticPage.goto(`http://127.0.0.1:${staticServer.address().port}${meta.base}explorer/`);
        await staticPage.waitForFunction(() => crossOriginIsolated && !document.querySelector('#feature-load').disabled);
        await staticPage.locator('#feature-count').selectOption('1000'); await staticPage.locator('#feature-load').click();
        await staticPage.waitForFunction(() => document.querySelector('#feature-status').textContent.startsWith('Loaded and verified'));
        await staticPage.locator('#feature-edit').click(); await staticPage.waitForFunction(() => document.querySelector('#feature-revision').textContent === '1');
        await staticPage.locator('#feature-view').selectOption('initial'); await staticPage.waitForFunction(() => document.querySelector('#feature-view-label').textContent === 'Initial · revision 0');
        assert.match(await staticPage.locator('#feature-detail').innerText(), /"lanes": 0/);
        await staticPage.locator('#feature-stop').click(); await staticPage.locator('#feature-load:not([disabled])').waitFor();
        await staticContext.close();
      } finally { staticServer.closeAllConnections(); await new Promise(resolve => staticServer.close(resolve)); }
      console.log(`Passed ${name}: real feature-map workers at 1k/100k, sparse edits/history, Stop/restart/navigation, 36 benchmark records, headerless workers, no-JS charts and mobile layout at ${meta.base}`);
    } catch (error) {
      if (activePage && !activePage.isClosed()) {
        console.error(`Failure in ${name} at ${activePage.url()}`);
        console.error((await activePage.locator('body').innerText().catch(() => '')).slice(0, 5000));
        await activePage.screenshot({ path: `${artifacts}/feature-failure-${name}.png`, fullPage: true }).catch(() => {});
      }
      throw error;
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); clearTimeout(deadline); }
