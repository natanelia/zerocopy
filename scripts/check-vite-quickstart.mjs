import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { extract } from './doc-examples.mjs';

// This gate installs published packages and runs browsers. It is separate from
// source-only docs checks and runs once in the hosted documentation workflow.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run this starter gate in GitHub Actions');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-vite-starter-'));
const artifacts = join(root, 'website/artifacts'); mkdirSync(artifacts, { recursive: true });
const guide = 'docs/getting-started.md';
const pins = { zerocopy: '0.2.1', vite: '8.3.4' };
const expected = 'Owner current: 10001\nWorker current: 10001\nWorker retained: 10000';
const files = [
  ['vite.config.mjs', 'starter-vite-config', 'js'], ['index.html', 'starter-html', 'html'],
  ['main.ts', 'readme-direct-owner', 'ts'], ['state.worker.ts', 'readme-direct-reader', 'ts'],
];
const result = { packages: pins, installedPackages: {}, node: process.version, sourceSHA256: {}, checks: [], cleanupErrors: [] };
let server, failure;
const errorDetails = error => ({ name: error.name, message: error.message, stack: error.stack });
function bounded(promise, label, milliseconds = 30000) {
  // The workflow's five-minute cap is the final bound: Promise.race reports a
  // timeout but cannot cancel an in-progress Vite startup operation.
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function checkBrowsers(phase) {
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    result.stage = `${phase}: ${name}`;
    const browser = await engine.launch({ headless: true, timeout: 30000 });
    let browserFailure;
    try {
      const page = await browser.newPage(); page.setDefaultTimeout(15000);
      const check = { phase, browser: name, version: browser.version(), navigations: [], errors: [] };
      result.checks.push(check);
      page.on('pageerror', error => check.errors.push(error.message));
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) check.navigations.push({ url: frame.url(), at: new Date().toISOString() });
      });
      await page.addInitScript(() => { globalThis.__starterDocument = crypto.randomUUID(); });
      const response = await page.goto(origin, { timeout: 15000 });
      assert.equal(response.status(), 200);
      const headers = check.headers = response.headers();
      assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
      assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      await page.waitForFunction(text => document.querySelector('pre[role="status"]')?.textContent === text, expected);
      const observe = () => page.evaluate(() => ({ document: globalThis.__starterDocument,
        isolated: crossOriginIsolated, output: document.querySelector('pre[role="status"]')?.textContent }));
      check.beforeScreenshot = await observe();
      assert.equal(check.beforeScreenshot.output, expected);
      assert.equal(check.beforeScreenshot.isolated, true);
      await page.screenshot({ path: join(artifacts, `vite-starter-${phase}-${name}.png`) });
      check.afterScreenshot = await observe();
      check.output = check.afterScreenshot.output;
      assert.equal(check.output, expected, 'Retained starter output must match the expected counts');
      assert.deepEqual(check.afterScreenshot, check.beforeScreenshot, 'Screenshot and result must come from one completed document');
      await bounded(page.close(), 'validated starter page cleanup');
      assert.equal(check.navigations.length, 1, 'The first visit must complete without a full-page reload');
      assert.deepEqual(check.errors, []);
      console.log(`Passed: published zerocopy ${pins.zerocopy}, Vite ${pins.vite}, ${phase}, ${name}, isolated worker counts.`);
      if (phase === 'development') {
        const plain = await browser.newPage(); plain.setDefaultTimeout(15000);
        await plain.route(origin + '/', async route => {
          const response = await route.fetch({ timeout: 15000 });
          const headers = response.headers();
          delete headers['cross-origin-opener-policy']; delete headers['cross-origin-embedder-policy'];
          await route.fulfill({ response, headers });
        });
        await plain.addInitScript(() => {
          globalThis.__starterWorkers = 0;
          const NativeWorker = Worker;
          globalThis.Worker = class extends NativeWorker {
            constructor(...args) { super(...args); globalThis.__starterWorkers++; }
          };
        });
        const rejection = plain.waitForEvent('pageerror'); rejection.catch(() => {});
        await plain.goto(origin, { timeout: 15000 });
        assert.equal((await rejection).message, 'Shared worker memory requires cross-origin isolation');
        assert.equal(await plain.evaluate(() => crossOriginIsolated), false);
        assert.equal(await plain.evaluate(() => globalThis.__starterWorkers), 0);
        assert.match(await plain.locator('pre[role="status"]').textContent(), /Shared memory is unavailable/);
        result.checks.push({ phase, browser: name, isolationGuard: 'passed', workers: 0 });
      }
    } catch (error) { browserFailure = error; throw error; }
    finally {
      try { await bounded(browser.close(), 'browser cleanup'); }
      catch (error) {
        result.cleanupErrors.push({ stage: `${phase}: ${name}`, ...errorDetails(error) });
        if (!browserFailure) throw error;
      }
    }
  }
}

try {
  result.stage = 'materialize documented files';
  const markdown = readFileSync(join(root, guide), 'utf8');
  for (const [name, version] of Object.entries(pins)) assert.ok(markdown.includes(`${name}@${version}`), `Guide pin differs: ${name}`);
  for (const [file, marker, language] of files) {
    const source = extract(guide, marker, language) + '\n';
    writeFileSync(join(temporary, file), source);
    result.sourceSHA256[file] = createHash('sha256').update(source).digest('hex');
  }
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: 'zerocopy-starter-check', private: true,
    dependencies: { zerocopy: pins.zerocopy }, devDependencies: { vite: pins.vite } }, null, 2));
  result.stage = 'install exact published packages';
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary, stdio: 'inherit', timeout: 120000 });
  for (const [name, version] of Object.entries(pins)) {
    result.installedPackages[name] = JSON.parse(readFileSync(join(temporary, 'node_modules', name, 'package.json'))).version;
    assert.equal(result.installedPackages[name], version);
  }
  writeFileSync(join(artifacts, 'vite-starter-package-lock.json'), readFileSync(join(temporary, 'package-lock.json')));
  result.stage = 'start Vite development server';
  const vite = await bounded(import(pathToFileURL(join(temporary, 'node_modules/vite/dist/node/index.js')).href), 'Vite import');
  server = await bounded(vite.createServer({ root: temporary, server: { host: '127.0.0.1', port: 0 } }), 'dev server creation');
  await bounded(server.listen(), 'dev server startup');
  await checkBrowsers('development');
  await bounded(server.close(), 'dev server cleanup'); server = undefined;
  result.stage = 'Vite production build';
  execFileSync(process.execPath, [join(temporary, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: temporary, stdio: 'inherit', timeout: 60000 });
  result.stage = 'start Vite production preview';
  server = await bounded(vite.preview({ root: temporary, preview: { host: '127.0.0.1', port: 0 } }), 'preview startup');
  await checkBrowsers('production-preview');
  result.stage = 'complete';
} catch (error) { failure = error; }
finally {
  try {
    if (server) {
      if (typeof server.close === 'function') await bounded(server.close(), 'server cleanup');
      else { server.httpServer.closeAllConnections(); await bounded(new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())), 'preview cleanup'); }
    }
  } catch (error) { result.cleanupErrors.push({ stage: 'server cleanup', ...errorDetails(error) }); }
  finally {
    try { rmSync(temporary, { recursive: true, force: true }); }
    catch (error) { result.cleanupErrors.push({ stage: 'temporary application cleanup', ...errorDetails(error) }); }
    result.status = failure || result.cleanupErrors.length ? 'failed' : 'passed';
    if (failure) result.error = errorDetails(failure);
    try { writeFileSync(join(artifacts, 'vite-starter-result.json'), JSON.stringify(result, null, 2) + '\n'); }
    catch (error) { console.error('Could not save starter evidence:', error); failure ??= error; }
  }
}
if (failure) throw failure;
if (result.cleanupErrors.length) throw new Error('Starter cleanup failed; see vite-starter-result.json');
