import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPreview } from '../serve.mjs';
import { generateColumns } from '../assets/explorer-core.mjs';
import { reference } from '../assets/explorer-reference.mjs';
const metadata = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const base = metadata.base, artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
const server = createPreview({ base }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let page;
const errors = [];
async function count(id, value) {
  await page.waitForFunction(({ id, value }) => Number(document.getElementById(id).dataset.count) === value, { id, value });
}
async function matches(value) {
  await page.waitForFunction(value => document.querySelector('#match-count').textContent.replaceAll(',', '') === String(value) && document.querySelector('#investigation').getAttribute('aria-busy') === 'false', value);
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(60_000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + base);
  assert.equal(await page.locator('.use-case-card').count(), 6);
  assert.match(await page.locator('h1').innerText(), /Share your data/);
  await page.goto(origin + base + 'explorer/');
  assert.equal(await page.locator('#log-size').inputValue(), '100000');
  await page.locator('#load-logs').click(); await count('view-count', 100000); await matches(100000);
  assert.equal(await page.locator('#log-rows tr').count(), 50);
  assert.equal(await page.locator('#log-bars button').count(), 60);
  const expected = reference(generateColumns(0, 100000), { term: 'timeout', level: 2 });
  await page.locator('#log-term').fill('timeout'); await page.locator('#log-level').selectOption('2'); await page.locator('#query-logs').click(); await matches(expected.search.total);
  assert.deepEqual(await page.locator('#log-rows tr').evaluateAll(rows => rows.map(row => Number(row.dataset.index))), expected.search.indices);
  const details = JSON.parse(await page.locator('#event-detail').innerText()); assert.equal(details.index, undefined); assert.equal(details.event, expected.search.indices[0]);
  assert.equal(details.message, expected.rows[0].message);
  await page.locator('#freeze-logs').click();
  await page.waitForFunction(() => document.querySelector('#view-mode').textContent.startsWith('Frozen'));
  await page.locator('#append-logs').click(); await count('live-count', 102000);
  assert.equal(await page.locator('#view-count').getAttribute('data-count'), '100000');
  await page.locator('#stream-logs').click(); await page.waitForFunction(() => Number(document.querySelector('#live-count').dataset.count) >= 104000);
  await page.locator('#stream-logs').click();
  assert.equal(await page.locator('#view-count').getAttribute('data-count'), '100000');
  await page.screenshot({ path: artifacts + '/log-explorer-desktop.png', fullPage: true });
  await page.locator('#next-logs').click();
  const secondPage = reference(generateColumns(0, 100000), { term: 'timeout', level: 2, offset: 50 });
  await page.waitForFunction(first => Number(document.querySelector('#log-rows tr').dataset.index) === first, secondPage.search.indices[0]);
  assert.deepEqual(await page.locator('#log-rows tr').evaluateAll(rows => rows.map(row => Number(row.dataset.index))), secondPage.search.indices);
  await page.locator('#log-term').fill('<img src=x onerror=alert(1)>'); await page.locator('#query-logs').click(); await matches(0);
  assert.equal(await page.locator('#log-rows img').count(), 0);
  // Several superseded intents must not apply late search results.
  await page.locator('#log-term').fill('retry'); await page.locator('#query-logs').click();
  await page.locator('#log-term').fill('timeout'); await page.locator('#query-logs').click(); await matches(expected.search.total);
  await page.locator('#log-bars button').nth(34).click();
  await page.waitForFunction(() => !document.querySelector('#clear-time').hidden);
  await page.locator('#clear-time').click(); await matches(expected.search.total);
  await page.locator('#freeze-logs').click();
  await page.waitForFunction(() => document.querySelector('#view-count').dataset.count === document.querySelector('#live-count').dataset.count);
  await page.locator('#reset-logs').click(); assert.equal(await page.locator('#view-count').getAttribute('data-count'), '0');
  await page.locator('#log-size').selectOption('1000'); await page.locator('#load-logs').click(); await page.locator('#reset-logs').click();
  await page.waitForFunction(() => !document.querySelector('#load-logs').disabled);
  await page.locator('#load-logs').click(); await count('view-count', 1000); await page.locator('#reset-logs').click();
  console.log('Passed: 100,000-event explorer, reference checks, pagination, frozen/live divergence, filters, restarts, and stop during startup.');

  await page.goto(origin + base + 'investigation-benchmark/');
  for (const size of ['1000', '10000', '100000']) {
  await page.locator('#investigation-size').selectOption(size); await page.locator('#run-investigation-bench').click();
  await page.waitForFunction(() => document.querySelector('#investigation-bench-status').textContent.startsWith('Complete.'), {}, { timeout: 120_000 });
  assert.equal(await page.locator('.architecture-result').count(), 3); assert.equal(await page.locator('.architecture-result .result-row').count(), 12);
  const download = page.waitForEvent('download'); await page.locator('#export-investigation-bench').click();
  const raw = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
  assert.equal(raw.schema, 'zerocopy-investigation-benchmark/v2'); assert.equal(raw.raw.length, 28);
  assert.deepEqual(Object.keys(raw.samples).sort(), ['centralized', 'immutable', 'replicated', 'shared']);
  for (const path of Object.values(raw.samples)) for (const values of Object.values(path)) { assert.equal(values.length, 7); assert.ok(values.every(n => Number.isFinite(n) && n >= 0)); }
  assert.equal(raw.dependencies.immutable, metadata.dependencies.immutable);
  writeFileSync(artifacts + `/investigation-benchmark-${size}.json`, JSON.stringify(raw, null, 2));
  writeFileSync(artifacts + '/investigation-benchmark.json', JSON.stringify(raw, null, 2));
  }
  await page.screenshot({ path: artifacts + '/investigation-benchmark.png', fullPage: true });
  await page.locator('#investigation-size').selectOption('100000'); await page.locator('#run-investigation-bench').click(); await page.locator('#stop-investigation-bench').click();
  await page.waitForFunction(() => !document.querySelector('#run-investigation-bench').disabled);
  assert.match(await page.locator('#investigation-bench-status').innerText(), /Stopped/); assert.equal(await page.locator('#export-investigation-bench').isDisabled(), true);
  console.log('Passed: four-architecture benchmark at all three sizes, full reference verification, all samples exported, and early cancellation.');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['explorer/', 'investigation-benchmark/', 'use-cases/', 'docs/use-cases/']) {
    await page.goto(origin + base + route);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, route);
  }
  await page.goto(origin + base + 'explorer/'); await page.locator('#log-size').selectOption('1000'); await page.locator('#load-logs').click(); await count('view-count', 1000);
  await page.screenshot({ path: artifacts + '/log-explorer-mobile.png', fullPage: true }); await page.locator('#reset-logs').click();
  await context.close();

  const staticServer = createPreview({ base, isolated: false }); staticServer.listen(0, '127.0.0.1'); await once(staticServer, 'listening');
  try {
    const staticOrigin = `http://127.0.0.1:${staticServer.address().port}`, ctx = await browser.newContext();
    page = await ctx.newPage(); page.setDefaultTimeout(60_000); page.on('pageerror', error => errors.push(error.message));
    for (const [route, runId, sizeId, statusId] of [['explorer/', 'load-logs', 'log-size', 'view-count'], ['investigation-benchmark/', 'run-investigation-bench', 'investigation-size', 'investigation-bench-status']]) {
      await page.goto(staticOrigin + base + route);
      await page.waitForFunction(id => crossOriginIsolated && !document.getElementById(id).disabled, runId);
      await page.locator('#' + sizeId).selectOption('1000'); await page.locator('#' + runId).click();
      if (route === 'explorer/') { await count(statusId, 1000); await page.locator('#reset-logs').click(); }
      else await page.waitForFunction(() => document.querySelector('#investigation-bench-status').textContent.startsWith('Complete.'), {}, { timeout: 120_000 });
    }
    await page.goto(staticOrigin + base + 'docs/use-cases/');
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
    await ctx.close();
    console.log('Passed: new demo scopes work independently on no-header hosting; docs remain uncontrolled.');
  } finally { staticServer.closeAllConnections(); await new Promise(resolve => staticServer.close(resolve)); }
  assert.deepEqual(errors, []);
} catch (error) {
  if (page && !page.isClosed()) {
    console.error('Failure at', page.url()); console.error(await page.locator('body').innerText());
    await page.screenshot({ path: artifacts + '/explorer-failure.png', fullPage: true }).catch(() => {});
  }
  throw error;
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
