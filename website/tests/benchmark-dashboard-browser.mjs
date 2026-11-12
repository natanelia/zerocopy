/** Recorded charts stay inspectable; one action replaces them with checked local results. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';

const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const recorded = JSON.parse(readFileSync(new URL('../assets/catalog-benchmark-recording.json', import.meta.url)));
const artifacts = process.env.BROWSER_ARTIFACTS_DIR || fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });
const server = createPreview({ base: meta.base }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const url = origin + meta.base + 'benchmarks/';
const ready = page => page.locator('#feature-run:not([disabled])').waitFor();
async function capture(page, filename) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: `${artifacts}/${filename}`, fullPage: true });
}

async function chartData(page) {
  return page.locator('#feature-benchmark-results [data-phase]').evaluateAll(charts => charts.map(chart => ({
    phase: chart.dataset.phase,
    maximum: Number(chart.dataset.timingMaximum),
    rows: [...chart.querySelectorAll('[data-case]')].map(row => ({
      id: row.dataset.case,
      median: Number(row.dataset.medianMs),
      display: row.querySelector('.benchmark-value').textContent,
      width: Number.parseFloat(row.querySelector('.benchmark-bar-track > span').style.width),
    })),
  })));
}

async function assertCharts(page, raw) {
  const charts = await chartData(page);
  assert.equal(charts.length, 9);
  for (const chart of charts) {
    assert.deepEqual(chart.rows.map(row => row.id), raw.config.phaseCaseIds[chart.phase]);
    for (const row of chart.rows) {
      const median = raw.summary[row.id][chart.phase].median;
      assert.equal(row.median, median, `${chart.phase}/${row.id}: exact recorded value`);
      assert.equal(row.display.replace(/\s+/g, ' ').trim(), `${median.toFixed(2)} ms`);
      // CSSOM serializes percentage values at browser precision.
      assert.ok(Math.abs(row.width - median / chart.maximum * 100) < 0.001, `${chart.phase}/${row.id}: zero-based bar`);
    }
  }
}

const deadline = setTimeout(() => { console.error('Benchmark dashboard gate exceeded 300 seconds'); process.exit(1); }, 300000); deadline.unref();
try {
  for (const name of process.env.DASHBOARD_BROWSERS?.split(',') || ['chromium', 'webkit']) {
    assert.ok(['chromium', 'webkit'].includes(name));
    const browser = await ({ chromium, webkit })[name].launch({ headless: true,
      ...(name === 'chromium' ? { args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
    try {
      const plainContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
      const plain = await plainContext.newPage(); await plain.goto(url);
      assert.equal(await plain.locator('[data-memory-readers]').count(), 2);
      assert.equal(await plain.locator('[data-memory-bytes]').count(), 8);
      assert.equal(await plain.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      assert.equal(await plain.locator('#feature-benchmark-results [data-phase]:visible').count(), 2);
      assert.equal(await plain.locator('#feature-recorded-export').isVisible(), true);
      await assertCharts(plain, recorded);
      assert.equal(await plain.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await plainContext.close();

      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], requests = [];
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.goto(url); await ready(page);
      assert.equal(page.workers().length, 0, 'Reading the recorded dashboard starts no benchmark workers');
      assert.equal(requests.filter(request => request.includes('/library/')).length, 0, 'Recorded charts do not require WASM');
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      assert.equal(await page.locator('#feature-count').inputValue(), String(recorded.config.entries));
      await assertCharts(page, recorded);
      const disclosure = page.locator('#feature-benchmark-results details > summary');
      await disclosure.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('#feature-benchmark-results [data-phase]:visible').count(), 9);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#feature-benchmark-results [data-phase]:visible').count(), 2);
      await capture(page, `benchmark-dashboard-${name}-recorded-desktop.png`);
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, `benchmark-dashboard-${name}-recorded-mobile.png`);
      await page.setViewportSize({ width: 1440, height: 1000 });

      const startedAt = Date.now();
      await page.getByRole('button', { name: 'Run performance benchmark on my device', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, meta.base + 'benchmarks/', 'One click runs the test in place');
      assert.equal(await page.locator('#feature-run').isDisabled(), true);
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded', 'In-flight samples must not replace completed evidence');
      await page.waitForFunction(() => document.querySelector('#feature-benchmark-status').textContent.startsWith('Complete.'), undefined, { timeout: 120000 });
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'device');
      const downloaded = page.waitForEvent('download'); await page.locator('#feature-export').click();
      const raw = JSON.parse(readFileSync(await (await downloaded).path(), 'utf8'));
      assert.equal(raw.schema, 'zerocopy-product-catalog-browser/v3');
      assert.equal(raw.sourceCommit, meta.sourceCommit);
      assert.equal(raw.environment.userAgent, await page.evaluate(() => navigator.userAgent));
      assert.equal(raw.environment.crossOriginIsolated, true);
      assert.equal(raw.config.entries, recorded.config.entries);
      assert.ok(Date.parse(raw.measuredAt) >= startedAt);
      assert.equal(raw.raw.length, 63);
      assert.equal(raw.raw.filter(sample => !sample.warmup).length, 49);
      for (const sample of raw.raw) {
        assert.equal(sample.verification.updated.answer.validation.unavailable, 100);
        assert.equal(sample.verification.initial.answer.validation.unavailable, 0);
        assert.equal(sample.verification.updated.answer.lookup.found, 910);
      }
      await assertCharts(page, raw);
      writeFileSync(`${artifacts}/benchmark-dashboard-${name}.json`, JSON.stringify(raw, null, 2));
      await capture(page, `benchmark-dashboard-${name}-device-desktop.png`);
      const completed = await chartData(page);
      const provenance = await page.locator('#feature-result-origin').innerText();
      await page.evaluate(() => {
        document.querySelector('#feature-benchmark-form').requestSubmit();
        document.querySelector('#feature-cancel').click();
      });
      assert.match(await page.locator('#feature-benchmark-status').innerText(), /Stopped/);
      assert.deepEqual(await chartData(page), completed, 'Cancel preserves the previous complete bars');
      assert.equal(await page.locator('#feature-result-origin').innerText(), provenance);
      assert.equal(await page.locator('#feature-export').isEnabled(), true);

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} ${width}px dashboard`);
        assert.ok((await page.locator('#feature-run').boundingBox()).width >= 200);
      }
      await page.goto(origin + meta.base + 'docs/catalog/'); await page.goBack(); await ready(page);
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      await assertCharts(page, recorded);
      assert.equal(await page.locator('#feature-export').isVisible(), false);
      assert.deepEqual(errors, []); await context.close();

      const failedContext = await browser.newContext();
      await failedContext.addInitScript(() => {
        window.Worker = class { constructor() { throw new Error('Dashboard test worker startup failure'); } };
      });
      const failed = await failedContext.newPage(); await failed.goto(url); await ready(failed);
      await failed.locator('#feature-run').click();
      await failed.waitForFunction(() => document.querySelector('#feature-benchmark-status').textContent.includes('Dashboard test worker startup failure'));
      assert.equal(await failed.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      assert.equal(await failed.locator('#feature-recorded-export').isVisible(), true);
      await assertCharts(failed, recorded);
      assert.equal(failed.workers().length, 0); await failedContext.close();
      console.log(`Passed ${name}: memory-first SSR, recorded provenance, one-click real run/export, legal phase bars, keyboard disclosure, cancel/failure, navigation, and 320px/390px layouts.`);
    } finally { await browser.close(); }
  }
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
