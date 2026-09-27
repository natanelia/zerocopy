import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPreview } from '../serve.mjs';
const base = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url))).base;
const screenshots = fileURLToPath(new URL('../artifacts/', import.meta.url)); mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
const server = createPreview({ base }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [];
let activePage;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, reducedMotion: 'reduce' });
  const page = activePage = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const requested = []; page.on('request', request => requested.push(request.url()));
  await page.goto(origin + base); await page.locator('.reader-node').first().waitFor();
  assert.equal(await page.locator('.reader-node').count(), 3);
  await page.getByRole('button', { name: 'Cloned', exact: true }).click(); assert.equal(await page.locator('#storage-count').innerText(), '4 separate stores');
  await page.getByRole('button', { name: 'Shared', exact: true }).click();
  await page.locator('#worker-count').focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('.reader-node').count(), 4);
  await page.getByRole('tab', { name: 'worker.ts' }).click(); await page.locator('#panel-reader').waitFor({ state: 'visible' });
  assert.ok(requested.every(url => !url.includes('/library/')), 'Product page must not load the WASM runtime');
  await page.keyboard.press('Control+k'); await page.locator('#search-input').fill('compaction');
  await page.locator('.search-result').first().waitFor(); assert.ok(await page.locator('.search-result').count() > 0);
  await page.locator('#search-input').fill('<script>alert(1)</script>'); assert.equal(await page.locator('.search-result').count(), 0);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog').evaluate(node => node.open), false);
  await page.screenshot({ path: screenshots + '/home-desktop.png', fullPage: true });
  await page.goto(origin + base + 'docs/getting-started/'); assert.ok(await page.locator('article').innerText().then(text => text.includes('connectSharedSession')));
  await page.screenshot({ path: screenshots + '/docs-desktop.png', fullPage: true });
  await page.goto(origin + base + 'playground/'); await page.getByRole('button', { name: 'Connect a worker' }).click();
  await page.waitForFunction(() => document.querySelector('#reader-value').textContent.includes('30'));
  await page.locator('#speed').fill('70'); await page.getByRole('button', { name: 'Apply edit' }).click();
  await page.waitForFunction(() => document.querySelector('#reader-value').textContent.includes('70'));
  assert.match(await page.locator('#owner-value').innerText(), /70/); assert.match(await page.locator('#retained-value').innerText(), /30/);
  await page.screenshot({ path: screenshots + '/playground-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.goto(origin + base + 'lab/'); await page.locator('#entries').selectOption('1000');
  await page.getByRole('button', { name: 'Run benchmark' }).click(); await page.waitForFunction(() => document.querySelector('#benchmark-status').textContent.startsWith('Complete.'));
  assert.equal(await page.locator('.result-row').count(), 2); assert.match(await page.locator('#benchmark-detail').innerText(), /checksums passed/);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-results').click(); const download = await downloadPromise;
  const raw = JSON.parse(readFileSync(await download.path(), 'utf8')); assert.equal(raw.samples.shared.length, 7); assert.equal(raw.samples.native.length, 7); assert.equal(raw.raw.length, 14);
  for (const sample of raw.raw) for (const reader of sample.readers) assert.equal(reader.checksum, 499500);
  writeFileSync(screenshots + '/benchmark-samples.json', JSON.stringify(raw, null, 2));
  await page.screenshot({ path: screenshots + '/lab-desktop.png', fullPage: true });
  await page.locator('#entries').selectOption('50000'); await page.getByRole('button', { name: 'Run benchmark' }).click(); await page.getByRole('button', { name: 'Stop run' }).click();
  assert.match(await page.locator('#benchmark-status').innerText(), /Stopped/); assert.equal(await page.locator('#export-results').isDisabled(), true);
  const mobile = await context.newPage(); await mobile.setViewportSize({ width: 390, height: 844 });
  for (const route of ['', 'docs/collections/', 'lab/', 'playground/', 'use-cases/']) {
    await mobile.goto(origin + base + route);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Horizontal overflow at ' + route);
  }
  await mobile.goto(origin + base); await mobile.screenshot({ path: screenshots + '/home-mobile.png', fullPage: true });
  await mobile.getByRole('button', { name: 'Menu', exact: true }).click(); assert.equal(await mobile.locator('#mobile-nav').isVisible(), true);
  const noJs = await browser.newContext({ javaScriptEnabled: false }); const plain = await noJs.newPage();
  await plain.goto(origin + base + 'docs/collections/'); assert.ok((await plain.locator('article').innerText()).includes('SharedMap')); await noJs.close();
  await context.close();
  console.log('Passed: desktop/mobile layout, lazy runtime, navigation, safe search, no-JS docs, actual worker snapshots, live benchmark checksums/export, and cancellation.');
  const staticServer = createPreview({ base, isolated: false }); staticServer.listen(0, '127.0.0.1'); await once(staticServer, 'listening');
  try {
    const ctx = await browser.newContext(); const p = activePage = await ctx.newPage(); p.setDefaultTimeout(25000);
    const staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;
    p.on('pageerror', error => errors.push(error.message));
    p.on('requestfailed', request => console.error('Static-host request failed:', request.url(), request.failure()?.errorText));
    await p.goto(staticOrigin + base + 'lab/'); assert.equal(await p.locator('#run-benchmark').isDisabled(), true);
    await p.locator('#enable-isolation').click();
    await p.waitForFunction(() => crossOriginIsolated && !document.querySelector('#run-benchmark').disabled);
    await p.locator('#entries').selectOption('1000'); await p.locator('#readers').selectOption('1'); await p.locator('#run-benchmark').click();
    await p.waitForFunction(() => document.querySelector('#benchmark-status').textContent.startsWith('Complete.'));
    await p.goto(staticOrigin + base + 'playground/');
    assert.equal(await p.locator('#start-playground').isDisabled(), true, 'Lab isolation must not silently cover the playground');
    await p.locator('#enable-isolation').click();
    await p.waitForFunction(() => crossOriginIsolated && !document.querySelector('#start-playground').disabled);
    await p.locator('#start-playground').click();
    await p.waitForFunction(() => document.querySelector('#reader-value').textContent.includes('30'));
    await p.locator('#speed').fill('90'); await p.locator('#apply-edit').click();
    await p.waitForFunction(() => document.querySelector('#reader-value').textContent.includes('90'));
    assert.match(await p.locator('#retained-value').innerText(), /30/);
    await p.locator('#stop-playground').click();
    await p.goto(staticOrigin + base + 'docs/getting-started/');
    assert.equal(await p.evaluate(() => navigator.serviceWorker.controller), null, 'Demo isolation must not control the docs');
    await ctx.close(); console.log('Passed: static host without headers → two independent scoped isolation flows → actual benchmark and snapshot updates.');
  } finally { staticServer.closeAllConnections(); await new Promise(resolve => staticServer.close(resolve)); }
  assert.deepEqual(errors, []);
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    console.error('Failure at', activePage.url());
    console.error(await activePage.locator('body').innerText().catch(() => 'Page unavailable'));
    await activePage.screenshot({ path: screenshots + '/failure.png', fullPage: true }).catch(() => {});
  }
  throw error;
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
