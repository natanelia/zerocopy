import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { arch, cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPayload, measureProjection, rowCount, workloads } from './json-skip-workload.mjs';

const [baseline, candidate, output, repetitions = '11'] = process.argv.slice(2);
assert(baseline && candidate && output, 'Pass two built checkouts and a new output JSON path');
const pairs = Number(repetitions), warmups = 3;
assert(Number.isSafeInteger(pairs) && pairs > 0);
const roots = { baseline: resolve(baseline), candidate: resolve(candidate) };
const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const environment = {
  node: process.version, bun: process.versions.bun, cpu: cpus()[0]?.model, arch: arch(), kernel: release(),
};
const evidence = { environment, rowCount, pairs, warmups, builds: {}, samples: [], startedAt: new Date().toISOString() };
for (const [side, root] of Object.entries(roots)) {
  const dist = join(root, 'dist');
  evidence.builds[side] = {
    jsonSource: hash(join(root, 'rust/src/json.rs')),
    persistentCore: hash(join(root, 'persistent-core.wasm')),
    bundle: Object.fromEntries(readdirSync(dist).filter(file => file.endsWith('.js')).sort()
      .map(file => [file, hash(join(dist, file))])),
  };
}
evidence.driver = hash(fileURLToPath(import.meta.url));
evidence.workload = hash(join(scriptDir, 'json-skip-workload.mjs'));
const catalog = 'catalog-selective';
const measured = process.env.BROWSER === 'chromium' ? [...workloads, catalog] : workloads;
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

async function runPaired(readers) {
  for (let pair = -warmups; pair < pairs; pair++) {
    for (let offset = 0; offset < measured.length; offset++) {
      const index = (offset + pair + warmups) % measured.length, name = measured[index];
      for (const side of (pair + index) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const result = await readers[side](name);
        if (name === catalog) assert.equal(result.status, 'passed');
        else {
          assert.equal(result.matches, 1000);
          assert.equal(result.timestampSum, 5047500);
        }
        evidence.samples.push({ pair, side, name, result });
      }
    }
  }
}

if (process.env.BROWSER === 'chromium') {
  const { chromium } = await import('playwright');
  // Serve identical catalog assets for both builds. The real catalog owner
  // starts two cross-origin-isolated readers and checks the full projections.
  const assets = join(roots.baseline, 'website/assets');
  evidence.catalogAssets = Object.fromEntries(readdirSync(assets).filter(file => file.endsWith('.mjs')).sort()
    .map(file => [file, hash(join(assets, file))]));
  const server = createServer((request, response) => {
    const [, side, directory, file, ...tail] = new URL(request.url, 'http://localhost').pathname.split('/');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    try {
      assert(Object.hasOwn(roots, side) && !tail.length);
      if (!directory) {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Shared reader benchmark</title>');
        return;
      }
      const source = directory === 'json-skip-workload.mjs' && file === undefined ? join(scriptDir, directory)
        : /^[\w-]+\.(?:js|mjs)$/.test(file ?? '') && (directory === 'library' ? join(roots[side], 'dist', file)
          : directory === 'assets' ? join(assets, file) : undefined);
      assert(source);
      const content = readFileSync(source);
      response.setHeader('Content-Type', 'text/javascript');
      response.end(content);
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    environment.chromium = browser.version();
    const readers = {};
    for (const side of Object.keys(roots)) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/${side}/`);
      await page.evaluate(async () => {
        if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required');
        const { createPayload } = await import('./json-skip-workload.mjs');
        const api = await import('./library/shared.js');
        const worker = new Worker('./json-skip-workload.mjs', { type: 'module' });
        globalThis.runProjection = data => new Promise((done, reject) => {
          const timeout = setTimeout(() => reject(new Error('Projection worker timed out')), 15000);
          worker.onmessage = ({ data: result }) => {
            clearTimeout(timeout);
            if (result.error) reject(new Error(result.error)); else done(result);
          };
          worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
          worker.postMessage(data);
        });
        if (!(await globalThis.runProjection(createPayload(api))).ready) throw new Error('Worker attachment failed');
      });
      readers[side] = name => page.evaluate(async ({ name, catalog }) => {
        if (name !== catalog) return globalThis.runProjection(name);
        const { sampleReadCase } = await import('./assets/read-benchmark-runner.mjs');
        const { readCase } = await import('./assets/catalog-read-workloads.mjs');
        return sampleReadCase(readCase('selective-shared-view'), 10000);
      }, { name, catalog });
    }
    await runPaired(readers);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
} else {
  const readers = {};
  for (const [side, root] of Object.entries(roots)) {
    const api = await import(pathToFileURL(join(root, 'dist/shared.js')));
    const maps = await api.initWorker(createPayload(api));
    readers[side] = name => measureProjection(maps, name);
  }
  await runPaired(readers);
}

for (const name of measured) {
  const metric = name === catalog ? 'firstQueryMs' : 'elapsedMs';
  const times = side => evidence.samples.filter(item => item.name === name && item.side === side && item.pair >= 0)
    .map(item => item.result[metric]);
  const old = times('baseline'), next = times('candidate'), ratios = old.map((time, i) => time / next[i]);
  console.log(`${name}  ${median(old).toFixed(2)} → ${median(next).toFixed(2)} ms  ${median(ratios).toFixed(2)}×  ${ratios.filter(ratio => ratio > 1).length}/${pairs}`);
}
evidence.finishedAt = new Date().toISOString();
writeFileSync(output, JSON.stringify(evidence), { flag: 'wx' });
