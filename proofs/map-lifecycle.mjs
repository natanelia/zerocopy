import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { measureOwner, measureQuery, prepare, queries, rows, workloads } from './map-lifecycle-workload.mjs';

const [baseline, candidate, output, repetitions = '11'] = process.argv.slice(2);
const pairs = Number(repetitions), warmups = 3;
assert(baseline && candidate && output && Number.isSafeInteger(pairs) && pairs > 0,
  'Pass baseline and candidate build directories, a fresh output path and optionally a pair count');
const roots = { baseline: resolve(baseline), candidate: resolve(candidate) };
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const fixture = new URL('../website/assets/catalog-core.mjs', import.meta.url);
const workload = new URL('./map-lifecycle-workload.mjs', import.meta.url);
const build = root => Object.fromEntries([
  'arena.ts', 'shared-map.ts', 'compaction.ts', 'json-view.ts', 'rust/src/json.rs', 'persistent-core.wasm',
  ...readdirSync(join(root, 'dist')).filter(file => file.endsWith('.js')).sort().map(file => `dist/${file}`),
].map(file => [file, hash(join(root, file))]));
const builds = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, build(root)]));
const environment = { node: process.version, bun: process.versions.bun, arch: arch(), cpu: cpus()[0]?.model, kernel: release() };
const report = { environment, rows, pairs, warmups, builds, driver: hash(new URL(import.meta.url)), workload: hash(workload),
  fixture: hash(fixture), startedAt: new Date().toISOString(), samples: [] };

async function measure(run) {
  for (let pair = -warmups; pair < pairs; pair++) {
    for (let i = 0; i < workloads.length; i++) {
      const index = (i + pair + warmups) % workloads.length;
      const name = workloads[index], order = (pair + index) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      let storage;
      for (const side of order) {
        const result = await run[side](name, pair === -warmups);
        if (result.usedBytes !== undefined) {
          const sizes = [result.usedBytes, result.capacityBytes];
          if (storage) assert.deepEqual(sizes, storage, `Different arena size for ${name}`);
          storage = sizes;
        }
        report.samples.push({ pair, name, side, result });
      }
    }
    if (pair === -1 || pair % 4 === 3) console.log(`Finished ${pair + 1} of ${pairs} measured pairs`);
  }
}

if (process.env.BROWSER === 'chromium') {
  const { chromium } = await import('playwright');
  const server = createServer((request, response) => {
    const [, side, ...parts] = new URL(request.url, 'http://localhost').pathname.split('/');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const path = parts.join('/');
    if (!Object.hasOwn(roots, side)) return response.writeHead(404).end();
    if (!path) return response.end('<!doctype html><title>Shared map benchmark</title>');
    const file = path === 'proofs/map-lifecycle-workload.mjs' ? workload : path === 'website/assets/catalog-core.mjs' ? fixture
      : /^library\/[\w-]+\.js$/.test(path) ? join(roots[side], 'dist', parts[1]) : undefined;
    if (!file) return response.writeHead(404).end();
    response.setHeader('Content-Type', 'text/javascript');
    try { response.end(readFileSync(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--js-flags=--expose-gc'] });
    environment.chromium = browser.version();
    const run = {};
    for (const side of Object.keys(roots)) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/${side}/`);
      await page.evaluate(async () => {
        if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required');
        const workload = await import('./proofs/map-lifecycle-workload.mjs');
        const owner = workload.prepare(await import('./library/shared.js'));
        const worker = new Worker('./proofs/map-lifecycle-workload.mjs', { type: 'module' });
        globalThis.runMapBenchmark = (name, exhaustive) => {
          if (!workload.queries.includes(name)) return workload.measureOwner(owner, name, exhaustive);
          return new Promise((done, reject) => {
            const timeout = setTimeout(() => reject(new Error('Map scan worker timed out')), 20000);
            worker.onmessage = ({ data }) => {
              clearTimeout(timeout);
              if (data.error) reject(new Error(data.error)); else done(data);
            };
            worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
            worker.postMessage({ name, payload: owner.payload });
          });
        };
      });
      run[side] = (name, exhaustive) => page.evaluate(([name, all]) => globalThis.runMapBenchmark(name, all), [name, exhaustive]);
    }
    await measure(run);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
} else {
  const run = {};
  for (const [side, root] of Object.entries(roots)) {
    const api = await import(pathToFileURL(join(root, 'dist/shared.js')));
    const owner = prepare(api);
    run[side] = (name, exhaustive) => queries.includes(name) ? measureQuery(api, owner.payload, name) : measureOwner(owner, name, exhaustive);
  }
  await measure(run);
}

const median = samples => samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
for (const name of workloads) {
  const times = side => report.samples.filter(sample => sample.name === name && sample.side === side && sample.pair >= 0)
    .map(sample => sample.result.elapsedMs);
  const old = times('baseline'), next = times('candidate'), ratios = old.map((time, i) => time / next[i]);
  console.log(`${name}  ${median(old).toFixed(2)} → ${median(next).toFixed(2)} ms  ${median(ratios).toFixed(2)}×  ${ratios.filter(r => r > 1).length}/${pairs}`);
}
for (const [side, root] of Object.entries(roots)) assert.deepEqual(build(root), builds[side]);
report.finishedAt = new Date().toISOString();
writeFileSync(output, JSON.stringify(report), { flag: 'wx' });
