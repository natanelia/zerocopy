/** Recorded charts stay inspectable; one action replaces them with checked local results. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { READ_CASES } from '../assets/catalog-read-workloads.mjs';
import { chromium, firefox, webkit } from 'playwright';
import { createPreview } from '../serve.mjs';

const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const recorded = JSON.parse(readFileSync(new URL('../assets/catalog-read-recording.json', import.meta.url)));
const artifacts = process.env.BROWSER_ARTIFACTS_DIR || fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });
const server = createPreview({ base: meta.base });
// Toggle faults in the test HTTP server. Enabling browser request interception
// after 162 short-lived worker samples can wait on stale Chromium targets.
// Normal requests still use the production preview handler byte for byte.
let serverFault;
const requestListeners = server.listeners('request');
assert.equal(requestListeners.length, 1, 'Expected one preview request handler');
const [serveRequest] = requestListeners;
server.removeListener('request', serveRequest);
server.on('request', (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const metadataFault = serverFault === 'metadata' && path === meta.base + 'build.json';
  const libraryFault = serverFault === 'library' && path === meta.base + 'benchmarks/library/shared.js';
  if (metadataFault || libraryFault) {
    response.writeHead(200, {
      'Content-Type': metadataFault ? 'application/json' : 'text/javascript',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    response.end(metadataFault ? JSON.stringify({ ...meta, sourceCommit: 'f'.repeat(40) }) : '// intentionally different library bytes');
    return;
  }
  Reflect.apply(serveRequest, server, [request, response]);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const url = origin + meta.base + 'benchmarks/';
const ready = page => page.locator('#feature-run:not([disabled])').waitFor();
const visibleCount = value => value.schema.endsWith('/v4') ? 4 : 2;
async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const workerLifecycles = new WeakMap();
function observeWorkers(page) {
  const state = { created: 0, closed: 0 };
  workerLifecycles.set(page, state);
  page.on('worker', worker => {
    state.created++;
    worker.once('close', () => { state.closed++; });
  });
}
async function assertWorkersStopped(page, label, timeoutMs = 10000) {
  // terminate() can return before Chromium's worker-target close notification
  // reaches Playwright. Await
  // those events; do not sleep, disconnect handles, or accept a nonzero count.
  if (page.workers().length) {
    await new Promise((resolve, reject) => {
      const watched = new Set();
      let settled = false, timer;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        page.off('worker', watch);
        page.off('close', closedPage);
        for (const worker of watched) worker.off('close', check);
        error ? reject(error) : resolve();
      };
      const check = () => { if (page.workers().length === 0) finish(); };
      const watch = worker => {
        if (settled || watched.has(worker)) return;
        watched.add(worker); worker.on('close', check);
      };
      const closedPage = () => finish(new Error(`${label}: page closed before worker shutdown was observed`));
      timer = setTimeout(() => {
        const state = workerLifecycles.get(page);
        finish(new Error(`${label}: worker shutdown exceeded ${timeoutMs} ms; ${JSON.stringify({
          created: state?.created ?? null, closed: state?.closed ?? null,
          pendingCount: page.workers().length, pendingURLs: page.workers().map(worker => worker.url()),
        })}`));
      }, timeoutMs);
      page.on('worker', watch);
      page.on('close', closedPage);
      for (const worker of page.workers()) watch(worker);
      // Subscribe before checking again, covering closure during registration.
      check();
    });
  }
  assert.equal(page.workers().length, 0, label);
}
async function downloadResult(page) {
  const pending = page.waitForEvent('download');
  await page.locator('#feature-export').click();
  const download = await pending;
  const path = await bounded(download.path(), 20000, 'Benchmark export download completion');
  assert.equal(typeof path, 'string', 'Benchmark export must have a local file');
  return { value: JSON.parse(readFileSync(path, 'utf8')), filename: download.suggestedFilename() };
}
async function capture(page, filename) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: `${artifacts}/${filename}`, fullPage: true });
}

async function chartData(page) {
  return page.locator('#feature-benchmark-results [data-phase]').evaluateAll(charts => charts.map(chart => ({
    track: chart.dataset.track,
    workload: chart.dataset.workload,
    phase: chart.dataset.phase,
    maximum: Number(chart.dataset.timingMaximum),
    rows: [...chart.querySelectorAll('[data-case]')].map(row => ({
      id: row.dataset.case,
      api: row.querySelector('.benchmark-api')?.textContent ?? null,
      median: Number(row.dataset.medianMs),
      display: row.querySelector('.benchmark-value').textContent,
      width: Number.parseFloat(row.querySelector('.benchmark-bar-track > span').style.width),
    })),
  })));
}

async function assertCharts(page, value) {
  const charts = await chartData(page), legacy = value.legacy ?? value;
  const v4 = value.schema.endsWith('/v4');
  assert.equal(charts.filter(chart => chart.track === 'legacy').length, 9);
  assert.equal(charts.filter(chart => chart.track === 'reads').length, v4 ? 16 : 0);
  if (v4) {
    assert.deepEqual(charts.slice(0, 4).map(chart => [chart.track, chart.workload, chart.phase]), [
      ['reads', 'full-object-get', 'firstQueryMs'],
      ['reads', 'full-object-get', 'repeatQueryMs'],
      ['reads', 'selective-fields', 'firstQueryMs'],
      ['reads', 'full-object-get', 'constructionToFirstAnswerMs'],
    ]);
  }
  for (const chart of charts) {
    assert.ok(['reads', 'legacy'].includes(chart.track));
    const section = chart.track === 'legacy' ? legacy : value;
    const expectedCases = chart.track === 'legacy' ? section.config.phaseCaseIds[chart.phase]
      : READ_CASES.filter(item => chart.workload === 'explicit-materialization'
        ? item.workload.startsWith('view-to-object-') : item.workload === chart.workload).map(item => item.id);
    assert.deepEqual(chart.rows.map(row => row.id), expectedCases, `${chart.track}/${chart.workload}/${chart.phase}: exact cases and order`);
    const expectedMaximum = Math.max(.01, ...expectedCases.map(id => section.summary[id][chart.phase].median));
    assert.equal(chart.maximum, expectedMaximum);
    for (const row of chart.rows) {
      const median = section.summary[row.id][chart.phase].median;
      assert.equal(row.median, median, `${chart.phase}/${row.id}: exact recorded value`);
      assert.equal(row.display.replace(/\s+/g, ' ').trim(), `${median.toFixed(2)} ms`);
      assert.equal(row.api, chart.track === 'reads' ? READ_CASES.find(item => item.id === row.id).api : null);
      // CSSOM serializes percentage values at browser precision.
      assert.ok(Math.abs(row.width - median / chart.maximum * 100) < 0.001, `${chart.phase}/${row.id}: zero-based bar`);
    }
  }
}
function assertExport(value, path) {
  assert.equal(value.schema, 'zerocopy-product-catalog-browser/v4');
  assert.equal(value.status, 'complete');
  assert.equal(value.sourceCommit, meta.sourceCommit);
  assert.deepEqual(value.cases, READ_CASES);
  assert.equal(value.raw.length, 99);
  assert.equal(value.legacy.raw.length, 63);
  assert.equal(value.execution.length, 162);
  assert.deepEqual(value.dependencies, meta.dependencies);
  for (const sample of value.legacy.raw) {
    const full = sample.updateMode === 'full';
    assert.ok(sample.updatePublicationMs >= sample.editPublicationMs);
    const phases = ['generationMs', 'constructionMs', 'publicationMs', 'firstQueryMs', 'repeatQueryMs', 'updateMs', 'editPublicationMs', 'updatePublicationMs', 'updatedQueryMs'];
    for (const phase of phases) {
      assert.equal(Object.hasOwn(sample, phase), !full || ['editPublicationMs', 'updatePublicationMs'].includes(phase), `${sample.caseId}: export only measured phases`);
    }
    if (full) {
      assert.deepEqual(Object.keys(sample.verification), ['updated', 'initial']);
      assert.equal(sample.editGenerationMs, undefined);
    } else {
      assert.equal(sample.verification.first.answer.lookup.found, 910);
      assert.equal(sample.verification.first.answer.lookup.fingerprint, sample.verification.repeat.answer.lookup.fingerprint);
      assert.ok(sample.updatePublicationMs >= sample.updateMs);
      assert.ok(Number.isFinite(sample.editGenerationMs));
    }
  }
  writeFileSync(path, JSON.stringify(value, null, 2));
  // Independent proof recomputes all read/legacy summaries, per-sample totals,
  // reader checks, copy counts, identity hashes and the rotated execution order.
  const verified = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('../../proofs/benchmark-integration-20261115/verify.mjs', import.meta.url)), path,
  ], { encoding: 'utf8' }));
  assert.equal(verified.status, 'passed');
}
async function assertPassive(page, requests, from = 0) {
  await ready(page);
  await assertWorkersStopped(page, 'Recorded charts retain no benchmark workers');
  assert.equal(requests.slice(from).filter(request => request.includes('/library/')).length, 0, 'Setup, reload and return stay metadata-only');
}
async function assertFailedAttempt(page, message, charts, provenance) {
  await page.waitForFunction(() => document.querySelector('#feature-benchmark-status').textContent.startsWith('Run failed:'));
  assert.deepEqual(await chartData(page), charts, 'A failed attempt preserves the completed chart');
  assert.equal(await page.locator('#feature-result-origin').innerText(), provenance);
  const exported = await downloadResult(page), failed = exported.value;
  assert.match(exported.filename, /failed\.json$/);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.summary, null); assert.equal(failed.legacy.summary, null);
  assert.equal(failed.raw.length + failed.legacy.raw.length, 0);
  assert.match(failed.failures[0].message, message);
  await assertWorkersStopped(page, 'Failed attempts release every worker');
  return failed;
}

const browserNames = process.env.DASHBOARD_BROWSERS?.split(',') || ['chromium', 'webkit'];
// The v4 workload has 18 rotated cases (162 fresh-worker samples), up from 7.
const gateTimeoutMs = browserNames.length * 300000;
const deadline = setTimeout(() => { console.error(`Benchmark dashboard gate exceeded ${gateTimeoutMs / 1000} seconds`); process.exit(1); }, gateTimeoutMs); deadline.unref();
try {
  for (const name of browserNames) {
    assert.ok(['chromium', 'firefox', 'webkit'].includes(name));
    const browser = await ({ chromium, firefox, webkit })[name].launch({ headless: true,
      ...(name === 'chromium' ? { args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
    let activePage, engineFailure;
    const events = [];
    const record = (phase, details = {}) => {
      events.push({ at: new Date().toISOString(), phase, ...details });
      writeFileSync(`${artifacts}/benchmark-dashboard-${name}-events.json`, JSON.stringify(events, null, 2));
    };
    try {
      record('recorded charts without JavaScript');
      const plainContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
      const plain = await plainContext.newPage(); await plain.goto(url);
      assert.equal(await plain.locator('[data-memory-readers]').count(), 2);
      assert.equal(await plain.locator('[data-memory-bytes]').count(), 8);
      assert.equal(await plain.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      assert.equal(await plain.locator('#feature-benchmark-results [data-phase]:visible').count(), visibleCount(recorded));
      assert.equal(await plain.locator('#feature-recorded-export').isVisible(), true);
      await assertCharts(plain, recorded);
      assert.equal(await plain.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await plainContext.close();

      record('metadata-only setup and keyboard disclosures');
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const page = activePage = await context.newPage(), errors = [], requests = [];
      observeWorkers(page);
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.goto(url); await assertPassive(page, requests);
      const reloadFrom = requests.length; await page.reload(); await assertPassive(page, requests, reloadFrom);
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      assert.equal(await page.locator('#feature-count').inputValue(), String(recorded.config.entries));
      await assertCharts(page, recorded);
      const disclosure = page.locator('#feature-benchmark-results details > summary').first();
      await disclosure.focus(); await page.keyboard.press('Enter');
      assert.ok(await page.locator('#feature-benchmark-results [data-phase]:visible').count() > visibleCount(recorded));
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#feature-benchmark-results [data-phase]:visible').count(), visibleCount(recorded));
      await capture(page, `benchmark-dashboard-${name}-recorded-desktop.png`);
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, `benchmark-dashboard-${name}-recorded-mobile.png`);
      await page.setViewportSize({ width: 1440, height: 1000 });

      record('complete benchmark requested');
      const startedAt = Date.now();
      await page.getByRole('button', { name: 'Run performance benchmark on my device', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, meta.base + 'benchmarks/', 'One click runs the test in place');
      assert.equal(await page.locator('#feature-run').isDisabled(), true);
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded', 'In-flight samples must not replace completed evidence');
      await page.waitForFunction(() => /^(Complete\.|Run failed:)/.test(document.querySelector('#feature-benchmark-status').textContent), undefined, { timeout: 240000 });
      assert.match(await page.locator('#feature-benchmark-status').innerText(), /^Complete\./, 'A benchmark error must fail the gate immediately');
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'device');
      const exported = await downloadResult(page), raw = exported.value;
      assert.match(exported.filename, /complete\.json$/);
      assert.equal(raw.environment.userAgent, await page.evaluate(() => navigator.userAgent));
      assert.equal(raw.environment.crossOriginIsolated, true);
      assert.equal(raw.config.entries, recorded.config.entries);
      assert.ok(Date.parse(raw.measuredAt) >= startedAt);
      assertExport(raw, `${artifacts}/benchmark-dashboard-${name}.json`);
      record('completed benchmark exported and independently verified');
      await assertCharts(page, raw);
      await assertWorkersStopped(page, 'Completed runs release every owner and reader');
      await capture(page, `benchmark-dashboard-${name}-device-desktop.png`);
      record('cancelled attempt preserves completed evidence');
      const completed = await chartData(page);
      const provenance = await page.locator('#feature-result-origin').innerText();
      await page.locator('#feature-run').click();
      await page.waitForFunction(() => document.querySelector('#feature-benchmark-progress').value > 0);
      await page.locator('#feature-cancel').click();
      assert.match(await page.locator('#feature-benchmark-status').innerText(), /Stopped/);
      assert.deepEqual(await chartData(page), completed, 'Cancel preserves the previous complete bars');
      assert.equal(await page.locator('#feature-result-origin').innerText(), provenance);
      assert.equal(await page.locator('#feature-export').isEnabled(), true);
      const cancelled = await downloadResult(page);
      assert.match(cancelled.filename, /cancelled\.json$/);
      assert.equal(cancelled.value.status, 'cancelled');
      assert.equal(cancelled.value.summary, null); assert.equal(cancelled.value.legacy.summary, null);
      assert.ok(cancelled.value.raw.length + cancelled.value.legacy.raw.length > 0, 'Export keeps samples completed before Stop');
      assert.ok(cancelled.value.raw.length + cancelled.value.legacy.raw.length < 162, 'Interrupted attempt is never exported as complete');
      assert.ok(cancelled.value.failures.length > 0);
      await assertWorkersStopped(page, 'Stop releases workers');

      serverFault = 'metadata';
      record('changed build metadata enabled in test HTTP server');
      await page.locator('#feature-run').click();
      const mismatch = await assertFailedAttempt(page, /different commits/, completed, provenance);
      assert.equal(mismatch.identityStatus, 'failed');
      assert.equal(mismatch.buildIdentity, null); assert.equal(mismatch.assetVerification, null);
      assert.equal(await page.locator('#feature-run').isDisabled(), true, 'Rejected build identity cannot be reused');
      serverFault = undefined;
      record('changed metadata rejected before measurement and failure exported');

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} ${width}px dashboard`);
        assert.ok((await page.locator('#feature-run').boundingBox()).width >= 200);
      }
      await page.goto(origin + meta.base + 'docs/catalog/'); const returnFrom = requests.length; await page.goBack(); await assertPassive(page, requests, returnFrom);
      assert.equal(await page.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      await assertCharts(page, recorded);
      assert.equal(await page.locator('#feature-export').isVisible(), false);
      // The metadata can match while fetched library bytes are stale.
      const recordedCharts = await chartData(page), recordedOrigin = await page.locator('#feature-result-origin').innerText();
      serverFault = 'library';
      record('changed library bytes enabled in test HTTP server');
      await page.locator('#feature-run').click();
      const badHash = await assertFailedAttempt(page, /Build mismatch for shared\.js/, recordedCharts, recordedOrigin);
      assert.equal(badHash.identityStatus, 'failed');
      assert.equal(badHash.assetVerification, null);
      serverFault = undefined;
      record('changed library rejected before measurement and failure exported');
      const hashReloadFrom = requests.length;
      await page.reload(); await assertPassive(page, requests, hashReloadFrom);

      record('navigation during a running attempt');
      // Leave a running attempt, then restore both back and forward history.
      await page.locator('#feature-run').click();
      await page.waitForFunction(() => document.querySelector('#feature-benchmark-progress').value > 0);
      await page.goto(origin + meta.base + 'docs/catalog/'); const activeReturnFrom = requests.length;
      await page.goBack(); await assertPassive(page, requests, activeReturnFrom);
      await assertCharts(page, recorded);
      assert.equal(await page.locator('#feature-export').isVisible(), false);
      await page.goForward(); const forwardReturnFrom = requests.length;
      await page.goBack(); await assertPassive(page, requests, forwardReturnFrom);
      await assertCharts(page, recorded);
      assert.deepEqual(errors, []); await context.close();

      record('worker startup failure before measurement');
      const failedContext = await browser.newContext();
      await failedContext.addInitScript(() => {
        window.Worker = class { constructor() { throw new Error('Dashboard test worker startup failure'); } };
      });
      const failed = activePage = await failedContext.newPage(); observeWorkers(failed); await failed.goto(url); await ready(failed);
      await failed.locator('#feature-run').click();
      await assertFailedAttempt(failed, /Dashboard test worker startup failure/, await chartData(failed), await failed.locator('#feature-result-origin').innerText());
      assert.equal(await failed.locator('#feature-result-origin').getAttribute('data-result-origin'), 'recorded');
      assert.equal(await failed.locator('#feature-recorded-export').isVisible(), true);
      await assertCharts(failed, recorded);
      await assertWorkersStopped(failed, 'Startup failure leaves no workers'); await failedContext.close();
      record('all dashboard assertions passed');
      console.log(`Passed ${name}: memory-first SSR, recorded provenance, one-click v4 run/export, all read and legacy medians, keyboard disclosure, partial cancel/worker failure, stale metadata and asset rejection, navigation, and 320px/390px layouts.`);
    } catch (error) {
      engineFailure = error;
      // Log the actual failure before browser-dependent diagnostics or cleanup.
      console.error(`Failure in ${name} at ${activePage?.url() ?? 'startup'}: ${error.stack ?? error}`);
      record('test failure', { message: error.message, stack: error.stack });
      if (activePage && !activePage.isClosed()) {
        const status = await bounded(activePage.locator('#feature-benchmark-status, #feature-build-identity').allTextContents(), 4000, 'Failure status capture')
          .catch(diagnostic => [`Status unavailable: ${diagnostic.message}`]);
        console.error(status);
        await bounded(activePage.screenshot({ path: `${artifacts}/benchmark-dashboard-${name}-failure.png`, fullPage: true, timeout: 5000 }), 6000, 'Failure screenshot')
          .catch(diagnostic => console.error(`Screenshot unavailable: ${diagnostic.message}`));
      }
      throw error;
    } finally {
      serverFault = undefined;
      try { await bounded(browser.close(), 10000, 'Browser cleanup'); }
      catch (error) { console.error(error.message); if (!engineFailure) throw error; }
    }
  }
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
