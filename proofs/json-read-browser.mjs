/** Real browser reads in fresh isolated contexts, using the process fixtures.
 * node proofs/json-read-browser.mjs ../baseline/dist/shared.js dist/shared.js output.json
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpus, release } from 'node:os';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { jsonReadCases, quantile, compareJsonReadStorage } from './json-read-workloads.mjs';

const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
assert(beforeArg && afterArg && outputArg, 'Usage: json-read-browser.mjs before-entry after-entry output.json');
const paths = { before: resolve(beforeArg), after: resolve(afterArg) };
const folders = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, dirname(path)]));
const entries = Object.fromEntries(Object.entries(paths).map(([variant, path]) => {
  const name = basename(path);
  assert(/^[a-zA-Z0-9_.-]+\.js$/.test(name), 'Entry names must be JavaScript filenames');
  return [variant, `/${variant}/${name}`];
}));
const settings = { count: Number(process.env.JSON_READ_COUNT ?? 512), samples: Number(process.env.JSON_READ_SAMPLES ?? 7),
  warmups: Number(process.env.JSON_READ_WARMUPS ?? 5), passes: Number(process.env.JSON_READ_PASSES ?? 32),
  rounds: Number(process.env.JSON_READ_ROUNDS ?? 3), selected: process.env.JSON_READ_CASES?.split(',') };
for (const [key, low, high] of [['count', 16, 16384], ['samples', 1, 100], ['warmups', 0, 100], ['passes', 1, 1024], ['rounds', 1, 10]]) {
  assert(Number.isSafeInteger(settings[key]) && settings[key] >= low && settings[key] <= high, `Invalid ${key}`);
}
if (settings.selected) assert(settings.selected.every(name => jsonReadCases.some(spec => spec.name === name)), 'Unknown workload');
const cases = jsonReadCases.filter(spec => !settings.selected || settings.selected.includes(spec.name));
const available = { chromium, firefox, webkit }, engines = process.env.JSON_READ_ENGINES?.split(',') ?? Object.keys(available);
assert(engines.length && engines.every(engine => available[engine]), 'Unknown browser engine');
function hashFiles(folder, files) {
  const digest = createHash('sha256');
  for (const file of files.sort()) digest.update(file).update('\0').update(readFileSync(resolve(folder, file))).update('\0');
  return digest.digest('hex');
}
const buildSha256 = Object.fromEntries(Object.entries(folders).map(([variant, folder]) =>
  [variant, hashFiles(folder, readdirSync(folder).filter(name => name.endsWith('.js')))]));
const sourceSha256 = Object.fromEntries(Object.entries(folders).map(([variant, folder]) => {
  const source = dirname(folder), files = readdirSync(source).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  return [variant, files.length ? hashFiles(source, files) : undefined];
}));
const report = { schema: 'zerocopy-json-read-browser/v1', date: new Date().toISOString(),
  cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch, osRelease: release(),
  settings, paths, buildSha256, sourceSha256,
  harnessSha256: hashFiles(dirname(fileURLToPath(import.meta.url)), ['json-read-workloads.mjs', 'json-read-browser.mjs']),
  method: 'One fresh browser context and page per build, workload, and round. Variant order alternates by workload and round. COOP/COEP enable shared memory. Each sample attaches a fresh read-only reader outside timing. Only warm/saturated cases prime values. Timed public get/peek calls consume a scalar checksum. Native-JSON equality, deep freeze, mutable caller inputs, descriptors, allocation lengths, and SHA-256 are verified outside timing. No explicit GC or timing threshold.',
  runs: [], summary: [] };
mkdirSync(dirname(resolve(outputArg)), { recursive: true });
const save = () => writeFileSync(outputArg, JSON.stringify(report, null, 2) + '\n');
save();
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>JSON read proof</title>'); return; }
    const match = /^\/(before|after)\/([a-zA-Z0-9_.-]+\.js)$/.exec(path);
    const file = path === '/workloads.mjs' ? new URL('./json-read-workloads.mjs', import.meta.url)
      : match ? resolve(folders[match[1]], match[2]) : undefined;
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});

async function measure(browser, row, spec, variant) {
  const state = row.variants[variant] = { complete: false, milliseconds: [] }; save();
  const context = await browser.newContext();
  try {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('saveJsonReadSample', ({ sample, ms }) => {
      assert.equal(sample, state.milliseconds.length, 'Unexpected sample order');
      state.milliseconds.push(ms); save();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, crossOriginIsolated }));
    assert.equal(environment.crossOriginIsolated, true, 'Shared-memory isolation is required');
    state.environment = environment; save();
    const result = await page.evaluate(async ({ entry, spec, settings }) => {
      const { createJsonReadWorkload, checkJsonReadStorage } = await import('/workloads.mjs');
      const api = await import(entry), work = createJsonReadWorkload(api, spec, settings.count, settings.passes);
      const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const evidence = async checked => ({ allocatedBytes: checked.allocatedBytes, usedBytes: checked.usedBytes,
        backingBytes: checked.backingBytes, payloadSha256: await hash(checked.payload),
        descriptorSha256: await hash(new TextEncoder().encode(JSON.stringify(checked.descriptors))) });
      const integrity = await evidence(work.storage()), reference = JSON.stringify(integrity);
      let verifiedRuns = 0, logical;
      for (let sample = -settings.warmups; sample < settings.samples; sample++) {
        await work.setup();
        if (JSON.stringify(await evidence(work.storage())) !== reference) throw new Error('Storage changed before a read');
        const start = performance.now(), checksum = work.run(), ms = performance.now() - start;
        const checked = work.verify(checksum);
        checkJsonReadStorage(await evidence(checked), integrity);
        if (checked.logical) {
          const { canonical, ...metadata } = checked.logical;
          const current = { ...metadata, canonicalSha256: await hash(new TextEncoder().encode(canonical)) };
          if (logical && JSON.stringify(current) !== JSON.stringify(logical)) throw new Error('Verified map changed between reads');
          logical = current;
        }
        verifiedRuns++;
        if (sample >= 0) await window.saveJsonReadSample({ sample, ms });
      }
      return { integrity, logical, verifiedRuns, requestedCount: work.requestedCount, count: work.count, passes: work.passes,
        operations: work.operations, totalValues: work.totalValues,
        snapshotCount: work.snapshotCount, fixture: work.fixture };
    }, { entry: entries[variant], spec, settings });
    assert.deepEqual(errors, []); assert.equal(state.milliseconds.length, settings.samples);
    Object.assign(state, result, { medianMs: quantile(state.milliseconds, 0.5), p95Ms: quantile(state.milliseconds, 0.95), complete: true }); save();
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); save(); throw error; }
  finally { await context.close(); }
}

server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  for (const engine of engines) {
    const run = { engine, complete: false, cases: [] }; report.runs.push(run); save();
    let browser;
    try {
      browser = await available[engine].launch({ headless: true }); run.browserVersion = browser.version(); save();
      for (let round = 0; round < settings.rounds; round++) for (const [index, spec] of cases.entries()) {
        const order = (round + index) % 2 ? ['after', 'before'] : ['before', 'after'];
        const row = { ...spec, round, order, complete: false, variants: {} }; run.cases.push(row); save();
        for (const variant of order) await measure(browser, row, spec, variant);
        const { before, after } = row.variants;
        compareJsonReadStorage(spec, before.totalValues, before, after);
        assert.equal(after.count, before.count); assert.equal(after.requestedCount, before.requestedCount);
        assert.equal(after.operations, before.operations); assert.deepEqual(after.fixture, before.fixture);
        row.speedup = before.medianMs / after.medianMs; row.complete = true; save();
        console.log(`${engine} round ${round + 1}: ${spec.name}: ${row.speedup.toFixed(2)}x`);
      }
      for (const spec of cases) {
        const found = run.cases.filter(row => row.name === spec.name);
        const summary = Object.fromEntries(['before', 'after'].map(variant => {
          const times = found.flatMap(row => row.variants[variant].milliseconds);
          return [variant, { medianMs: quantile(times, 0.5), p95Ms: quantile(times, 0.95), samples: times.length }];
        }));
        report.summary.push({ engine, browserVersion: run.browserVersion, ...spec,
          requestedCount: found[0].variants.before.requestedCount, count: found[0].variants.before.count,
          passes: found[0].variants.before.passes,
          operations: found[0].variants.before.operations, ...summary, speedup: summary.before.medianMs / summary.after.medianMs,
          roundSpeedups: found.map(row => row.speedup),
          integrity: found[0].variants.before.integrity,
          integrityByVariant: { before: found[0].variants.before.integrity, after: found[0].variants.after.integrity },
          logical: found[0].variants.before.logical });
      }
      run.complete = true; save();
    } catch (error) { run.error = error instanceof Error ? error.message : String(error); save(); throw error; }
    finally { if (browser) await browser.close(); }
  }
  report.complete = true; save();
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
