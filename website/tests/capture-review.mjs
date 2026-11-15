// Capture the built site with actual browser rendering and real studio workers.
// Keep binary review evidence outside _site: the Pages publisher serves text assets.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';

const build = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const output = fileURLToPath(new URL('../review/screenshots/', import.meta.url));
mkdirSync(output, { recursive: true });
const server = createPreview({ base: build.base });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}${build.base}`;
const engine = process.env.CAPTURE_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), 'Unknown capture browser');
const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true,
  ...(engine === 'chromium' ? { args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
const errors = [], captures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  async function capture(name, fullPage = false) {
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
    await page.screenshot({ path: output + name, fullPage, animations: 'disabled' });
    captures.push({ file: name, viewport: page.viewportSize(), fullPage });
  }
  await page.goto(origin); await page.locator('.reader-node').first().waitFor();
  await capture('home-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('home-mobile.png', true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + 'playground/');
  await page.getByRole('button', { name: 'Connect a worker' }).click();
  await page.waitForFunction(() => document.querySelector('#reader-value').firstChild.textContent === '12');
  for (const id of [2, 3]) {
    await page.locator('#add-reader').click();
    await page.waitForFunction(index => document.querySelector(`#studio-reader-${index}`).dataset.ready === 'true', id);
  }
  await page.locator('#stock').fill('7'); await page.locator('#price').fill('119.50');
  await page.getByRole('button', { name: 'Publish revision' }).click();
  await page.waitForFunction(() => document.querySelector('#reader-value').firstChild.textContent === '7');
  await page.locator('#pin-revision-2').selectOption('1');
  await page.waitForFunction(() => document.querySelector('#retained-2-value').firstChild.textContent === '7');
  await page.locator('#stock').fill('4');
  await page.getByRole('button', { name: 'Publish revision' }).click();
  await page.waitForFunction(() => {
    const stock = id => document.querySelector(`#${id}`).firstChild.textContent;
    return !document.querySelector('#apply-edit').disabled &&
      document.querySelector('#owner-revision').textContent === 'r2' &&
      ['reader-value', 'reader-2-value', 'reader-3-value'].every(id => stock(id) === '4') &&
      ['retained-value', 'retained-2-value', 'retained-3-value'].every((id, index) => stock(id) === ['12', '7', '12'][index]);
  });
  const studio = await page.evaluate(() => ({
    currentRevision: Number(document.querySelector('#owner-revision').textContent.slice(1)),
    currentStock: Number(document.querySelector('#owner-value').firstChild.textContent),
    pinnedStock: ['retained-value', 'retained-2-value', 'retained-3-value'].map(id => Number(document.querySelector(`#${id}`).firstChild.textContent)),
  }));
  studio.workers = page.workers().length;
  assert.deepEqual(studio, { workers: 3, currentRevision: 2, currentStock: 4, pinnedStock: [12, 7, 12] });
  await capture('studio-desktop.png', true);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('studio-mobile.png', true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + 'benchmarks/'); await capture('benchmarks-desktop.png', true);
  await page.goto(origin + 'docs/choose-zerocopy/'); await capture('adoption-desktop.png');
  assert.deepEqual(errors, []);
  writeFileSync(output + 'capture.json', JSON.stringify({ sourceCommit: build.sourceCommit, base: build.base,
    engine, browser: browser.version(), reducedMotion: true, captures,
    studio,
  }, null, 2) + '\n');
  console.log(`Captured ${captures.length} review screenshots with real worker state. Source ${build.sourceCommit}.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
