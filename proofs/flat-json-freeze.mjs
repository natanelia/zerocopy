import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The same public API and fixtures run in both builds and all engines.
// Setup and result validation are outside local read timings.
async function benchmark({ baseline, candidate, pairs, warmups, copyAttachment }) {
  const urls = [baseline, candidate];
  const builds = await Promise.all(urls.map(path => import(path + 'shared.js')));
  const cases = [
    { name: 'flat-short', size: 1000, queries: 1000, shape: 'short' },
    { name: 'flat-feature-10k', size: 10000, queries: 1000, shape: 'feature' },
    { name: 'flat-feature-100k', size: 100000, queries: 10000, shape: 'feature' },
    { name: 'wide-attributes', size: 1000, queries: 256, shape: 'wide' },
    { name: 'very-wide-control', size: 32, queries: 32, shape: 'very-wide' },
    { name: 'nested-route', size: 10000, queries: 1000, shape: 'route' },
    { name: 'nested-first-field', size: 10000, queries: 1000, shape: 'route-first' },
    { name: 'nested-middle-field', size: 10000, queries: 1000, shape: 'route-middle' },
    { name: 'mixed-map-10k', size: 10000, queries: 1000, shape: 'mixed' },
    { name: 'quoted-brackets', size: 10000, queries: 1000, shape: 'quoted' },
    { name: 'flat-long-message', size: 10000, queries: 1000, shape: 'long' },
    ...['short','feature','route','quoted','long'].flatMap(shape => [
      { name: 'view-frozen-' + shape, size: 1000, queries: 1000, shape, mode: 'view' },
      { name: 'direct-codec-' + shape, size: 1000, queries: 1000, shape, mode: 'codec' },
    ]),
  ];
  function row(shape, i) {
    const feature = { id: i, tile: 'tile/' + Math.floor(i / 1000), kind: i % 2 ? 'lane' : 'boundary',
      x: 103.85 + i / 1e6, y: 1.29 + i / 1e6, heading: i % 360, speed: i % 80,
      elevation: i / 17, width: 3.5, revision: 3, active: i % 5 !== 0, name: '道路 ' + i,
      turn: 'none', source: 'survey', verified: true, parent: null, region: 'SG' };
    if (shape === 'mixed') shape = ['short','feature','route','route-first','route-middle','quoted','long'][i % 7];
    if (shape === 'short') return { id: i, speed: i % 80, active: i % 5 !== 0 };
    if (shape === 'wide' || shape === 'very-wide') {
      for (let k = 0; k < (shape === 'wide' ? 256 : 4096); k++) feature['attr' + k] = i + k;
      return feature;
    }
    if (shape === 'route' || shape === 'route-first' || shape === 'route-middle') {
      const geometry = { coordinates: Array.from({length: 32}, (_, k) => [feature.x + k / 1e5, feature.y - k / 1e5]) };
      if (shape === 'route-first') return { geometry, tags: ['route', 'mapped'], ...feature };
      if (shape === 'route-middle') return { ...feature, geometry, tags: ['route', 'mapped'], tail: 'mapped' };
      return { ...feature, geometry, tags: ['route', 'mapped'] };
    }
    if (shape === 'quoted') return { ...feature, name: 'lane [left] {survey} ' + i };
    if (shape === 'long') return { ...feature, description: ('Survey update · 東京 · confirmed speed and lane geometry ').repeat(20) };
    return feature;
  }
  function frozen(value) {
    if (value === null || typeof value !== 'object') return true;
    if (!Object.isFrozen(value)) return false;
    for (const child of Object.values(value)) if (!frozen(child)) return false;
    return true;
  }
  async function measure(api, payload, workload, url) {
    const { size, queries, shape } = workload;
    const ids = Array.from({length: queries}, (_, n) => (n * 8191 + 7) % size);
    const keys = ids.map(i => 'feature/' + i);
    let map, read, attachMs = 0;
    if (workload.mode === 'codec') {
      const { codecs } = await import(url + 'codec-proof.js');
      const encoder = new TextEncoder();
      const records = ids.map(id => {
        const encoded = encoder.encode(JSON.stringify(row(shape, id)));
        const buf = new Uint8Array(encoded.length + 6);
        buf.set(encoded, 3);
        return buf;
      });
      read = () => records.map(buf => codecs.object.decode(buf, 3, buf.length - 6));
    } else {
      const start = performance.now();
      ({ map } = await api.initWorker(payload));
      attachMs = performance.now() - start;
      read = workload.mode === 'view'
        ? () => keys.map(key => map.getView(key).toObject({ freeze: true }))
        : () => keys.map(key => map.get(key));
    }
    let start = performance.now();
    const first = read();
    const firstMs = performance.now() - start;
    start = performance.now();
    const repeat = read();
    const repeatMs = performance.now() - start;
    if (map && map.size !== size) throw Error('Incorrect map size');
    for (let i = 0; i < keys.length; i++) {
      const expected = JSON.stringify(row(shape, ids[i]));
      if (workload.mode && first[i] === repeat[i]) throw Error('Materialization must return fresh values');
      if (JSON.stringify(first[i]) !== expected || JSON.stringify(repeat[i]) !== expected || !frozen(first[i]) || !frozen(repeat[i])) {
        throw Error('Incorrect or mutable result: ' + workload.name + ' ' + keys[i]);
      }
    }
    if (map && map.get('missing/record') !== undefined) throw Error('Incorrect missing key');
    return { attachMs, firstMs, attachAndFirstMs: attachMs + firstMs, repeatMs, checked: keys.length * 2 };
  }
  const browser = typeof window !== 'undefined';
  async function readInWorker(url, payload, workload) {
    // Each sample gets a fresh actual browser worker. Validation is outside
    // the local attach/read timers; wall time includes the verification too.
    const source = row.toString() + '\n' + frozen.toString() + '\n' + measure.toString() +
      '\nself.onmessage = async ({data}) => { try { const api = data.workload.mode === "codec" ? null : await import(data.url + "shared.js"); self.postMessage(await measure(api, data.payload, data.workload, data.url)); } catch (e) { self.postMessage({error: String(e)}); } };';
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(blobUrl, { type: 'module' });
    try {
      const start = performance.now();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Worker timed out')), 20000);
        worker.onmessage = ({data}) => { clearTimeout(timer); if (data.error) reject(Error(data.error)); else resolve(data); };
        worker.onerror = error => { clearTimeout(timer); reject(Error(error.message)); };
        worker.postMessage({ url, payload, workload });
      });
      return { ...result, workerWallIncludingVerificationMs: performance.now() - start };
    } finally {
      worker.terminate(); URL.revokeObjectURL(blobUrl);
    }
  }
  const median = values => { const a = [...values].sort((x,y) => x-y); return (a[(a.length-1)>>1] + a[a.length>>1])/2; };
  const p95 = values => [...values].sort((a,b) => a-b)[Math.ceil(values.length*.95)-1];
  const rows = [];
  for (const workload of cases) {
    const { size, shape } = workload;
    const entries = Array.from({length: size}, (_, i) => ['feature/' + i, row(shape,i)]);
    const payloads = workload.mode === 'codec' ? [null, null] : builds.map(api => {
      api.resetMap();
      const map = new api.SharedMap('object').setMany(entries);
      return api.getWorkerData({ map }, { copy: copyAttachment });
    });
    const samples = [];
    // Larger, balanced samples for the suspected regressions and new callers.
    const casePairs = workload.name === 'flat-feature-100k' || workload.name === 'flat-feature-10k' || workload.name === 'very-wide-control'
      ? pairs : Math.max(pairs, 22);
    for (let round = -warmups; round < casePairs; round++) {
      const order = ((round + warmups + rows.length) & 1) ? [1,0] : [0,1];
      const sample = { round, order: order.map(i => i ? 'candidate' : 'baseline') };
      for (const i of order) {
        sample[i ? 'candidate' : 'baseline'] = browser
          ? await readInWorker(urls[i], payloads[i], workload)
          : await measure(builds[i], payloads[i], workload, urls[i]);
      }
      samples.push(sample);
    }
    const measured = samples.filter(s => s.round >= 0);
    const metrics = {};
    for (const metric of workload.mode === 'codec' ? ['firstMs','repeatMs'] : ['attachMs','firstMs','attachAndFirstMs','repeatMs']) {
      const a = measured.map(s => s.baseline[metric]), b = measured.map(s => s.candidate[metric]);
      metrics[metric] = { baseline: median(a), candidate: median(b), baselineP95: p95(a), candidateP95: p95(b),
        pairedSpeedup: median(a.map((x,i) => b[i] > 0 ? x/b[i] : 1)),
        fasterPairs: a.filter((x,i) => x > b[i]).length };
    }
    rows.push({ ...workload, pairs: casePairs, metrics, samples });
  }
  return { pairs, warmups, attachment: copyAttachment ? 'copied' : 'shared', execution: browser ? 'fresh worker' : 'fresh local reader', rows };
}

const [baselinePath, candidatePath = 'dist', engine = 'node', pairArg = '11', warmupArg = '3'] = process.argv.slice(2);
const pairs = Number(pairArg), warmups = Number(warmupArg);
if (!baselinePath || !['node', 'bun', 'chromium', 'firefox', 'webkit'].includes(engine) ||
    !Number.isInteger(pairs) || pairs < 1 || !Number.isInteger(warmups) || warmups < 0) {
  throw new Error('Usage: node proofs/flat-json-freeze.mjs BASELINE_DIST CANDIDATE_DIST [node|bun|chromium|firefox|webkit] [pairs] [warmups]');
}
if ((engine === 'bun') !== Boolean(process.versions.bun)) {
  throw new Error('Use the requested Node or Bun runtime to invoke the driver');
}
const roots = { baseline: resolve(baselinePath), candidate: resolve(candidatePath) };
// Bundle the internal codec independently with the same installed Bun version.
// Both A/A directories resolve the same source; each A/B directory resolves its pinned checkout.
for (const root of Object.values(roots)) {
  execFileSync('bun', ['build', join(root, '..', 'codec.ts'), '--target=browser', '--format=esm', '--outfile', join(root, 'codec-proof.js')], { stdio: ['ignore', 'ignore', 'inherit'] });
}
const fingerprints = {};
for (const [name, root] of Object.entries(roots)) {
  const modules = (await readdir(root)).filter(file => file.endsWith('.js')).sort();
  fingerprints[name] = Object.fromEntries(await Promise.all(modules.map(async file => [file,
    createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
}
const meta = { cpu: cpus()[0].model, architecture: process.arch, platform: process.platform, fingerprints };
if (engine === 'node' || engine === 'bun') {
  const result = await benchmark({
    baseline: pathToFileURL(roots.baseline + '/').href,
    candidate: pathToFileURL(roots.candidate + '/').href, pairs, warmups,
    copyAttachment: engine === 'bun',
  });
  console.log(JSON.stringify({ runtime: engine + ' ' + (process.versions.bun ?? process.versions.node), ...meta, ...result }, null, 2));
} else {
  const playwright = await import('playwright');
  const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Flat JSON read benchmark</title>'); return;
    }
    const match = /^\/(baseline|candidate)\/([\w.-]+\.js)$/.exec(req.url);
    try {
      if (!match) throw new Error('Unknown module');
      res.setHeader('Content-Type', 'application/javascript');
      res.end(await readFile(join(roots[match[1]], match[2])));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((ready, reject) => server.once('error', reject).listen(0, '127.0.0.1', ready));
  try {
    const browser = await playwright[engine].launch({ headless: true });
    try {
      const page = await browser.newPage();
      const origin = 'http://127.0.0.1:' + server.address().port;
      await page.goto(origin);
      if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('Shared memory requires an isolated page');
      const result = await page.evaluate(benchmark, {
        baseline: origin + '/baseline/', candidate: origin + '/candidate/', pairs, warmups, copyAttachment: false,
      });
      console.log(JSON.stringify({ runtime: engine + ' ' + browser.version(), ...meta, ...result }, null, 2));
    } finally { await browser.close(); }
  } finally { server.close(); }
}
