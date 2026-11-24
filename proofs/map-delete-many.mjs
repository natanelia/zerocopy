import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The same public API and fixtures run in both builds and all engines.
// Setup, result validation, and memory inspection are outside elapsed time.
async function benchmark({ baseline, candidate, pairs, warmups }) {
  const builds = await Promise.all([baseline, candidate].map(path => import(path + 'shared.js')));
  const cases = [
    { name: 'single-delete-control', size: 10000, count: 1, type: 'number', pattern: 'random', repeats: 64 },
    { name: 'sparse-random', size: 100000, count: 100, type: 'number', pattern: 'random', repeats: 8 },
    { name: 'unload-tile', size: 100000, count: 10000, type: 'object', pattern: 'tile', repeats: 1 },
    { name: 'filter-half', size: 100000, count: 50000, type: 'number', pattern: 'random', repeats: 1 },
    { name: 'replace-region', size: 100000, count: 99000, type: 'object', pattern: 'tile', repeats: 1 },
    { name: 'remove-all', size: 10000, count: 10000, type: 'number', pattern: 'random', repeats: 1 },
    { name: 'duplicates-and-misses', size: 10000, count: 5000, type: 'object', pattern: 'mixed', repeats: 1 },
    { name: 'missing-only-control', size: 10000, count: 1000, type: 'number', pattern: 'missing', repeats: 4 },
  ];
  const median = a => {
    const sorted = [...a].sort((x, y) => x - y), n = sorted.length;
    return (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2;
  };
  const rows = [];
  const used = (build, map) => build.getWorkerData({ map }, { copy: false }).arenas[0].used;
  for (const workload of cases) {
    const { name, size, count, type, pattern, repeats } = workload;
    const keyFor = i => i === 0 ? 'costarring' : i === 1 ? 'liquid'
      : i === 2 ? '\ufffd' : i === 3 ? '道路/🙂' : 'tile/' + Math.floor(i / 1000) + '/feature/' + i;
    const valueFor = i => type === 'number' ? i : { id: i, kind: i % 2 ? 'lane' : 'boundary', center: [i / 8, i / 16] };
    const entries = Array.from({ length: size }, (_, i) => [keyFor(i), valueFor(i)]);
    const keys = Array.from({ length: count }, (_, i) => pattern === 'missing' ? 'absent/' + i
      : keyFor(pattern === 'tile' ? i : (i * 8191 + 2) % size));
    if (pattern === 'mixed') keys.push('\ud800', 'costarring', 'costarring', 'absent/0', ...keys.slice(0, 500));
    const normalized = key => new TextDecoder().decode(new TextEncoder().encode(key));
    const deleted = new Set(keys.map(normalized));
    const expected = new Map(entries.filter(([key]) => !deleted.has(key)));
    const original = new Map(entries);

    function check(map, reference, description) {
      if (map.size !== reference.size) throw new Error(name + ': wrong size (' + description + ')');
      let seen = 0;
      for (const [key, value] of map.entries()) {
        if (!reference.has(key) || JSON.stringify(reference.get(key)) !== JSON.stringify(value)) {
          throw new Error(name + ': invalid value (' + description + ') for ' + key);
        }
        seen++;
      }
      if (seen !== reference.size) throw new Error(name + ': incorrect iteration count');
    }
    const samples = [];
    for (let round = -warmups; round < pairs; round++) {
      // Rotate the first build for every workload independently.
      const order = ((round + warmups + rows.length) & 1) ? [1, 0] : [0, 1];
      const pair = { round, order: order.map(i => i === 0 ? 'baseline' : 'candidate') };
      for (const variant of order) {
        const build = builds[variant];
        build.resetMap();
        const base = new build.SharedMap(type).setMany(entries);
        const before = used(build, base);
        const start = performance.now();
        let result;
        for (let i = 0; i < repeats; i++) result = base.deleteMany(keys);
        const ms = performance.now() - start;
        const after = used(build, result);
        // Check the entire output and retained input on every measured sample.
        check(result, expected, 'result');
        check(base, original, 'retained base');
        if (pattern === 'missing' && result !== base) throw new Error(name + ': no-op changed snapshot identity');
        for (const key of keys) if (result.has(key)) throw new Error(name + ': deleted key survives');
        // Exercise the published result too; attachment is outside timing.
        const payload = structuredClone(build.getWorkerData({ result, base }, { copy: false }));
        const attached = await build.initWorker(payload);
        if (attached.result.size !== expected.size || attached.base.size !== original.size) {
          throw new Error(name + ': invalid attached sizes');
        }
        // A surviving key and a deleted key are checked in the attached revision.
        const survivor = expected.keys().next().value;
        if (survivor !== undefined && JSON.stringify(attached.result.get(survivor)) !== JSON.stringify(expected.get(survivor))) {
          throw new Error(name + ': invalid attached survivor');
        }
        const removed = keys.find(key => original.has(normalized(key)));
        if (removed !== undefined && (attached.result.has(removed) || !attached.base.has(removed))) {
          throw new Error(name + ': invalid attached revision');
        }
        pair[variant === 0 ? 'baseline' : 'candidate'] = { ms, arenaBytes: after - before };
      }
      samples.push(pair);
    }
    const measured = samples.filter(s => s.round >= 0);
    const baselineMs = median(measured.map(s => s.baseline.ms));
    const candidateMs = median(measured.map(s => s.candidate.ms));
    rows.push({ ...workload, requestedKeys: keys.length, removedKeys: size - expected.size,
      baselineMs, candidateMs,
      pairedSpeedup: median(measured.map(s => s.baseline.ms / s.candidate.ms)),
      fasterPairs: measured.filter(s => s.candidate.ms < s.baseline.ms).length,
      baselineArenaBytes: median(measured.map(s => s.baseline.arenaBytes)),
      candidateArenaBytes: median(measured.map(s => s.candidate.arenaBytes)), samples });
  }
  return { pairs, warmups, rows };
}

const [baselinePath, candidatePath = 'dist', engine = 'node', pairArg = '11', warmupArg = '3'] = process.argv.slice(2);
const pairs = Number(pairArg), warmups = Number(warmupArg);
if (!baselinePath || !['node', 'bun', 'chromium', 'firefox', 'webkit'].includes(engine) ||
    !Number.isInteger(pairs) || pairs < 1 || !Number.isInteger(warmups) || warmups < 0) {
  throw new Error('Usage: node proofs/map-delete-many.mjs BASELINE_DIST CANDIDATE_DIST [node|bun|chromium|firefox|webkit] [pairs] [warmups]');
}
if ((engine === 'bun') !== Boolean(process.versions.bun)) {
  throw new Error('Use the requested Node or Bun runtime to invoke the driver');
}
const roots = { baseline: resolve(baselinePath), candidate: resolve(candidatePath) };
const fingerprints = {};
for (const [name, root] of Object.entries(roots)) {
  fingerprints[name] = createHash('sha256').update(await readFile(join(root, 'shared.js'))).digest('hex');
}
const meta = { cpu: cpus()[0].model, architecture: process.arch, platform: process.platform, fingerprints };
if (engine === 'node' || engine === 'bun') {
  const result = await benchmark({
    baseline: pathToFileURL(roots.baseline + '/').href,
    candidate: pathToFileURL(roots.candidate + '/').href, pairs, warmups,
  });
  console.log(JSON.stringify({ runtime: engine + ' ' + (process.versions.bun ?? process.versions.node), ...meta, ...result }, null, 2));
} else {
  const playwright = await import('playwright');
  const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Map deletion benchmark</title>'); return;
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
        baseline: origin + '/baseline/', candidate: origin + '/candidate/', pairs, warmups,
      });
      console.log(JSON.stringify({ runtime: engine + ' ' + browser.version(), ...meta, ...result }, null, 2));
    } finally { await browser.close(); }
  } finally { server.close(); }
}
