/** Run isolated public operations in real Chromium, Firefox, and WebKit.
 * node proofs/utf8-write-browser.mjs ../baseline/dist/shared.js dist/shared.js output.json
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { utf8WriteCases, compareUtf8WriteStorage } from './utf8-write-workloads.mjs';

const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
assert(beforeArg && afterArg && outputArg, 'Usage: utf8-write-browser.mjs before-entry after-entry output.json');
const paths = { before: resolve(beforeArg), after: resolve(afterArg) };
const folders = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, dirname(path)]));
const entries = Object.fromEntries(Object.entries(paths).map(([key, path]) => {
  const name = basename(path);
  assert(/^[a-zA-Z0-9_.-]+\.js$/.test(name), 'Entry names must be JavaScript filenames');
  return [key, '/' + key + '/' + name];
}));
const settings = { count: Number(process.env.UTF8_COUNT ?? 5000), samples: Number(process.env.UTF8_SAMPLES ?? 7),
  warmups: Number(process.env.UTF8_WARMUPS ?? 5), round: Number(process.env.UTF8_ROUND ?? 0),
  selected: process.env.UTF8_CASES?.split(',') };
for (const [key, low, high] of [['count', 64, 50000], ['samples', 1, 100], ['warmups', 0, 100], ['round', 0, 100]]) {
  assert(Number.isSafeInteger(settings[key]) && settings[key] >= low && settings[key] <= high, 'Invalid ' + key);
}
if (settings.selected) assert(settings.selected.every(name => utf8WriteCases.some(spec => spec.name === name)), 'Unknown workload');
const cases = utf8WriteCases.filter(spec => !settings.selected || settings.selected.includes(spec.name));
const available = { chromium, firefox, webkit }, engines = process.env.UTF8_ENGINES?.split(',') ?? Object.keys(available);
assert(engines.length && engines.every(name => available[name]), 'Unknown browser engine');
const buildSha256 = Object.fromEntries(Object.entries(folders).map(([key, folder]) => {
  const digest = createHash('sha256');
  for (const name of readdirSync(folder).filter(name => name.endsWith('.js')).sort()) {
    digest.update(name).update('\0').update(readFileSync(resolve(folder, name))).update('\0');
  }
  return [key, digest.digest('hex')];
}));
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>UTF-8 write proof</title>'); return;
    }
    const match = /^\/(before|after)\/([a-zA-Z0-9_.-]+\.js)$/.exec(path);
    const file = path === '/workloads.mjs' ? new URL('./utf8-write-workloads.mjs', import.meta.url)
      : match ? resolve(folders[match[1]], match[2]) : undefined;
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
const quantile = (input, fraction) => {
  const sorted = [...input].sort((a, b) => a - b), position = (sorted.length - 1) * fraction, low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
};
const runs = [];
const report = { schema: 'zerocopy-utf8-write-browser/v1', date: new Date().toISOString(),
  platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, settings, paths, buildSha256,
  method: 'One fresh browser context and page per variant and workload; each page imports only one build. Variant order rotates by workload and round. Fresh arena before every run. Initialization, validation, SHA256, and sample transfer are outside timing. All measured pairs compare exact payload hashes, descriptors, used bytes, and backing bytes after retrieval. No explicit GC or timing threshold.', runs };
mkdirSync(dirname(resolve(outputArg)), { recursive: true });
const save = () => writeFileSync(outputArg, JSON.stringify(report, null, 2) + '\n');
save();

async function measureVariant(browser, row, spec, variant) {
  const state = row.variants[variant] = { complete: false };
  save();
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Persist each completed sample, including those before a later failure.
    await page.exposeFunction('saveUtf8WriteSample', record => {
      assert.equal(record.sample, row.records[variant].length, 'Unexpected sample order');
      const { sample, ...result } = record;
      row.records[variant].push(result); save();
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    Object.assign(state, await page.evaluate(() => ({ userAgent: navigator.userAgent, crossOriginIsolated })));
    save();
    assert.equal(state.crossOriginIsolated, true, 'Shared-memory isolation is required');
    const operations = await page.evaluate(async ({ entry, spec, settings }) => {
      const { createUtf8WriteWorkload, checkUtf8WriteStorage } = await import('/workloads.mjs');
      const api = await import(entry), work = createUtf8WriteWorkload(api, spec, settings.count);
      const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(n => n.toString(16).padStart(2, '0')).join('');
      let reference;
      for (let sample = -settings.warmups; sample < settings.samples; sample++) {
        work.setup();
        const start = performance.now(), result = work.run(), ms = performance.now() - start;
        const checked = work.verify(result);
        const { canonical, ...metadata } = checked.logical ?? {};
        const record = { usedBytes: checked.usedBytes, backingBytes: checked.backingBytes,
          payloadSha256: await hash(checked.payload), descriptor: checked.descriptor,
          ...(checked.logical ? { logical: { ...metadata,
            canonicalSha256: await hash(new TextEncoder().encode(canonical)) } } : {}) };
        if (reference) checkUtf8WriteStorage(record, reference);
        else reference = record;
        if (sample >= 0) await window.saveUtf8WriteSample({ sample, ms, ...record });
      }
      return work.count;
    }, { entry: entries[variant], spec, settings });
    assert.deepEqual(errors, []);
    assert.equal(operations, row.operations);
    assert.equal(row.records[variant].length, settings.samples);
    const times = row.records[variant].map(record => record.ms);
    row[variant] = { medianMs: quantile(times, 0.5), p95Ms: quantile(times, 0.95) };
    state.complete = true; save();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error); save();
    throw error;
  } finally { if (context) await context.close(); }
}

server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  for (const engine of engines) {
    const run = { engine, complete: false, cases: [] };
    runs.push(run); save();
    let browser;
    try {
      browser = await available[engine].launch({ headless: true });
      run.browserVersion = browser.version(); save();
      for (const [index, spec] of cases.entries()) {
        const order = (index + settings.round) % 2 ? ['after', 'before'] : ['before', 'after'];
        const row = { ...spec, operations: Math.min(settings.count, spec.limit ?? settings.count), order,
          complete: false, variants: {}, records: { before: [], after: [] } };
        run.cases.push(row); save();
        try {
          for (const variant of order) await measureVariant(browser, row, spec, variant);
          for (let sample = 0; sample < settings.samples; sample++) {
            const { ms: beforeMs, ...before } = row.records.before[sample];
            const { ms: afterMs, ...after } = row.records.after[sample];
            compareUtf8WriteStorage(spec, row.operations, before, after);
          }
          row.speedup = row.before.medianMs / row.after.medianMs;
          row.complete = true; save();
          console.log(engine + ' ' + row.name + ': ' + row.speedup.toFixed(2) + 'x');
        } catch (error) {
          row.error = error instanceof Error ? error.message : String(error); save();
          throw error;
        }
      }
      const first = run.cases[0].variants.before;
      Object.assign(run, { userAgent: first.userAgent, crossOriginIsolated: first.crossOriginIsolated, complete: true }); save();
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error); save();
      throw error;
    } finally { if (browser) await browser.close(); }
  }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
