import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPreview } from '../serve.mjs';
import { generateColumns } from '../assets/explorer-core.mjs';
import { reference } from '../assets/explorer-reference.mjs';
const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const base = meta.base, artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
const server = createPreview({ base }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let page; const errors = [];
async function complete(count) {
  await page.waitForFunction(count => document.querySelector('#comparison-workspace').getAttribute('aria-busy') === 'false' && document.querySelector('#compare-parity').dataset.verified === 'true' && Number(document.querySelector('#compare-count').dataset.count) === count, count);
}
async function match(expected) {
  await page.waitForFunction(expected => document.querySelector('#comparison-workspace').getAttribute('aria-busy') === 'false' && document.querySelector('#compare-parity').dataset.verified === 'true' && Number(document.querySelector('#matches-shared').textContent.replaceAll(',', '')) === expected, expected);
  assert.equal(Number((await page.locator('#matches-native').innerText()).replaceAll(',', '')), expected);
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(90000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + base + 'compare/');
  assert.equal(await page.locator('#compare-mode').inputValue(), 'incremental');
  await page.locator('#compare-start').click(); await complete(100000);
  assert.equal(await page.locator('#copies-shared').innerText(), '0'); assert.equal(await page.locator('#copies-native').innerText(), '200,000');
  assert.equal(await page.locator('#rows-shared tr').count(), 50); assert.equal(await page.locator('#timeline-native button').count(), 60);
  const expected = reference(generateColumns(0, 100000), { term: 'timeout', level: 2 });
  await page.locator('#compare-term').fill('timeout'); await page.locator('#compare-level').selectOption('2'); await page.locator('#compare-query').click(); await match(expected.search.total);
  for (const path of ['shared', 'native']) assert.deepEqual(await page.locator(`#rows-${path} tr`).evaluateAll(rows => rows.map(row => Number(row.dataset.index))), expected.search.indices);
  await page.locator('#compare-freeze').click(); await complete(100000);
  assert.match(await page.locator('#compare-view').innerText(), /Frozen/);
  await page.locator('#compare-append').click();
  await page.waitForFunction(() => document.querySelector('#compare-live').dataset.count === '102000' && document.querySelector('#comparison-workspace').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#compare-count').getAttribute('data-count'), '100000');
  assert.equal(await page.locator('#copies-native').innerText(), '204,000'); assert.equal(await page.locator('#copies-shared').innerText(), '0');
  await match(expected.search.total);
  await page.screenshot({ path: artifacts + '/comparison-desktop.png', fullPage: true });
  await page.locator('#compare-next').click(); await complete(100000);
  const second = reference(generateColumns(0, 100000), { term: 'timeout', level: 2, offset: 50 });
  assert.deepEqual(await page.locator('#rows-shared tr').evaluateAll(rows => rows.map(row => Number(row.dataset.index))), second.search.indices);
  await page.locator('#compare-term').fill('<img src=x onerror=alert(1)>'); await page.locator('#compare-query').click(); await match(0);
  assert.equal(await page.locator('#rows-shared img').count(), 0);
  await page.locator('#compare-term').fill('retry'); await page.locator('#compare-query').click();
  await page.locator('#compare-term').fill('timeout'); await page.locator('#compare-query').click(); await match(expected.search.total);
  await page.locator('#compare-freeze').click(); await complete(102000);
  const download = page.waitForEvent('download'); await page.locator('#compare-export').click();
  const raw = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
  assert.equal(raw.schema, 'zerocopy-live-comparison/v1'); assert.equal(raw.verified, true);
  for (const path of ['shared', 'native']) for (const key of ['queryMs', 'publishMs']) assert.ok(Number.isFinite(raw.results[path][key]) && raw.results[path][key] >= 0);
  writeFileSync(artifacts + '/comparison.json', JSON.stringify(raw, null, 2));
  await page.locator('#compare-stream').click(); await page.waitForFunction(() => Number(document.querySelector('#compare-live').dataset.count) >= 104000);
  await page.locator('#compare-stop').click(); assert.equal(await page.locator('#compare-count').getAttribute('data-count'), '0');
  assert.equal(await page.locator('#compare-export').isDisabled(), true);
  await page.locator('#compare-mode').selectOption('full'); await page.locator('#compare-size').selectOption('1000');
  await page.locator('#compare-start').click(); await complete(1000); await page.locator('#compare-append').click(); await complete(3000);
  assert.equal(await page.locator('#copies-native').innerText(), '8,000'); // 2 * 1000 initially + 2 * 3000 now.
  await page.locator('#compare-stop').click(); await page.locator('#compare-size').selectOption('100000'); await page.locator('#compare-start').click(); await page.locator('#compare-stop').click();
  assert.equal(await page.locator('#compare-start').isDisabled(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#compare-size').selectOption('1000'); await page.locator('#compare-start').click(); await complete(1000);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: artifacts + '/comparison-mobile.png', fullPage: true }); await page.locator('#compare-stop').click(); await context.close();
  console.log('Passed: real comparison, 100,000 events, exact outputs, incremental and full-copy counters, retained native/shared views, stream, export, latest query, stop, mobile.');
  const plain = createPreview({ base, isolated: false }); plain.listen(0, '127.0.0.1'); await once(plain, 'listening');
  try {
    const ctx = await browser.newContext(); page = await ctx.newPage(); page.setDefaultTimeout(90000); page.on('pageerror', error => errors.push(error.message));
    const host = `http://127.0.0.1:${plain.address().port}`;
    await page.goto(host + base + 'compare/'); assert.equal(await page.locator('#compare-start').isDisabled(), true);
    await page.locator('#enable-isolation').click(); await page.waitForFunction(() => crossOriginIsolated && !document.querySelector('#compare-start').disabled);
    await page.locator('#compare-size').selectOption('1000'); await page.locator('#compare-start').click(); await complete(1000); await page.locator('#compare-stop').click();
    await page.goto(host + base + 'docs/getting-started/'); assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
    await ctx.close();
  } finally { plain.closeAllConnections(); await new Promise(resolve => plain.close(resolve)); }
  assert.deepEqual(errors, []);
  console.log(`Passed: comparison on no-header hosting at ${base}; docs stay outside the service-worker scope.`);
} catch (error) {
  if (page && !page.isClosed()) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: artifacts + '/comparison-failure.png', fullPage: true }); }
  throw error;
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
