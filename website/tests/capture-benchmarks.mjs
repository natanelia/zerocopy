// Capture the first-visit benchmark experience, with real recorded measurements.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPreview } from '../serve.mjs';

const build = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const recording = JSON.parse(readFileSync(new URL('../assets/catalog-benchmark-recording.json', import.meta.url)));
const output = fileURLToPath(new URL('../review/screenshots/', import.meta.url));
mkdirSync(output, { recursive: true });
const server = createPreview({ base: build.base });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const captures = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}${build.base}benchmarks/`);
  await page.locator('#feature-run:not([disabled])').waitFor();
  for (const [name, width, height] of [['benchmarks-desktop.png', 1440, 1000], ['benchmarks-mobile.png', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: output + name, fullPage: true, animations: 'disabled' });
    captures.push({ file: name, viewport: { width, height }, fullPage: true });
  }
  assert.deepEqual(errors, []);
  writeFileSync(output + 'benchmark-capture.json', JSON.stringify({ sourceCommit: build.sourceCommit, base: build.base,
    browser: browser.version(), reducedMotion: true, captures,
    performance: { display: 'recorded', sourceCommit: recording.sourceCommit, measuredAt: recording.measuredAt,
      entries: recording.config.entries, readers: recording.config.readers, samplesPerCase: recording.config.samplesPerCase },
  }, null, 2) + '\n');
  console.log(`Captured the memory-first benchmark page at desktop and mobile widths. Source ${build.sourceCommit}.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
