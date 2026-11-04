// Supplementary browser evidence for isolated map/list read improvements.
// Build baseline and candidate first. No dependency installation or network access.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { cpus, platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';

const base = resolve(process.env.BROWSER_BASE_ROOT);
const candidate = resolve(process.env.BROWSER_CANDIDATE_ROOT);
const kind = process.env.BROWSER_CASE_KIND;
assert(['list', 'map'].includes(kind));
const output = resolve(process.env.BROWSER_OUTPUT);
assert(!existsSync(output), 'Use a new output path; do not overwrite recorded browser evidence');
const rounds = Number(process.env.BROWSER_ROUNDS ?? 4);
assert(Number.isInteger(rounds) && rounds >= 2 && rounds <= 12);
const require = createRequire(resolve(candidate, 'package.json'));
const { chromium } = require('playwright');
const browserOptions = { headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function manifest(root) {
  const files = [...readdirSync(root).filter(name => name.endsWith('.ts')),
    ...readdirSync(resolve(root, 'dist')).filter(name => name.endsWith('.js')).map(name => `dist/${name}`)];
  return { commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    files: Object.fromEntries(files.sort().map(name => [name, sha(readFileSync(resolve(root, name)))])) };
}
const before = { baseline: manifest(base), candidate: manifest(candidate) };
let selectedRoot = candidate;
const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Read benchmark</title>'); return; }
    const match = /^\/(build|proofs)\/(.+\.m?js)$/.exec(path);
    if (!match) { res.writeHead(404).end(); return; }
    const root = resolve(selectedRoot, match[1] === 'build' ? 'dist' : 'proofs');
    const file = resolve(root, match[2]);
    if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const result = { method: 'One build per fresh Chromium process; balanced AB/BA process pairs; shared loopback URL; 6 warm-up batches and 9 measured batches; full arrays checked after timing. Setup and validation excluded. Supplementary diagnostic measurements, not a universal performance guarantee.',
  kind, date: new Date().toISOString(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, rounds,
  source: before, driverSha256: sha(readFileSync(new URL(import.meta.url))), correctness: null, processes: [] };
try {
  // Run instrumentation/correctness in a disposable process, separate from timing.
  const browser = await chromium.launch(browserOptions);
  result.browserVersion = browser.version();
  try {
    const page = await browser.newPage(); await page.goto(url);
    result.correctness = await page.evaluate(async kind => {
      if (!crossOriginIsolated) throw new Error('Missing isolation');
      const api = await import('/build/shared.js');
      if (kind === 'list') {
        const checks = await (await import('/proofs/primitive-scan-checks.mjs')).runScanChecks(api);
        const worker = await (await import('/proofs/primitive-scan-worker-check.mjs')).checkWorker(api,
          new Worker('/proofs/primitive-scan-worker.mjs', { type: 'module' }), new URL('/build/shared.js', location.href).href);
        return { checks, worker };
      }
      let assertions = 0;
      const equal = (a, b) => { assertions++; if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Map values mismatch'); };
      for (const type of ['number', 'boolean', 'string', 'object']) {
        api.resetMap();
        const entries = Array.from({ length: 1059 }, (_, i) => [`key-${i}`, type === 'number' ? i + .5 : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `界-${i}` : { id: i }]);
        entries.push(['costarring', entries[0][1]], ['liquid', entries[1][1]]);
        const map = new api.SharedMap(type).setMany(entries);
        const expected = [...map.entries()].map(entry => entry[1]);
        for (const copy of [false, true]) {
          const attached = (await api.initWorker(api.getWorkerData({ map }, { copy }))).map;
          equal([...attached.values()], expected);
        }
        const iterator = map.values(); const first = iterator.next().value;
        const fork = map.set('key-0', entries[1][1]);
        map.setMany(Array.from({ length: 100000 }, (_, i) => [`growth-${i}`, entries[0][1]]));
        equal([first, ...iterator], expected); equal([...map.values()], expected);
        equal(fork.get('key-0'), entries[1][1]);
      }
      api.resetMap();
      const numeric = new api.SharedMap('number').setMany([['a', -0], ['b', NaN], ['c', Infinity], ['d', -Infinity]]);
      const expected = [...numeric.entries()].map(entry => entry[1]), actual = [...numeric.values()];
      for (let i = 0; i < expected.length; i++) { assertions++; if (!Object.is(expected[i], actual[i])) throw new Error('Float edge value mismatch'); }
      return { assertions };
    }, kind);
  } finally { await browser.close(); }
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const variant of order) {
      selectedRoot = variant === 'baseline' ? base : candidate;
      const browser = await chromium.launch(browserOptions);
      try {
        const page = await browser.newPage(); await page.goto(url);
        const rows = await page.evaluate(async kind => {
          const api = await import('/build/shared.js');
          const { makeCases } = await import('/proofs/primitive-scan-cases.mjs');
          const cases = [];
          for (const type of ['number', 'boolean', 'string', 'object']) {
            for (const size of type === 'number' || type === 'boolean' ? [1024, 65536] : [1024]) {
              if (kind === 'list') {
                cases.push(makeCases([api], size, type, 'SharedList').find(row => row.name.endsWith('.toArray')));
              } else {
                api.resetMap();
                const entries = Array.from({ length: size }, (_, i) => [`key-${i}`, type === 'number' ? i + .5 : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `界-${i}` : { id: i, label: `row-${i}` }]);
                const map = new api.SharedMap(type).setMany(entries);
                const score = v => typeof v === 'number' ? v : typeof v === 'boolean' ? +v : typeof v === 'string' ? v.length : v.id;
                const values = [...map.entries()].map(entry => entry[1]);
                const checksum = values.reduce((sum, value, i) => sum + score(value) * ((i & 31) + 1), 0);
                cases.push({ name: `SharedMap<${type}>.values`, size, array: false,
                  run() { let sum = 0, count = 0; for (const value of map.values()) sum += score(value) * (((count++) & 31) + 1); if (count !== size) throw new Error('Row count mismatch'); return sum; },
                  check(value) { if (value !== checksum) throw new Error('Order-sensitive checksum mismatch'); } });
              }
            }
          }
          return cases.map(item => {
            // Equal work and retained-output cap for both variants, no per-build calibration.
            const repeat = Math.max(1, Math.min(256, Math.floor(1048576 / item.size)));
            function batch() {
              const outputs = new Array(repeat); const start = performance.now();
              for (let i = 0; i < repeat; i++) outputs[i] = item.run(0);
              const elapsed = performance.now() - start;
              for (const output of outputs) item.check(output);
              return elapsed;
            }
            const warmupMs = Array.from({ length: 6 }, batch);
            const samplesMs = Array.from({ length: 9 }, batch);
            return { name: item.name, size: item.size, repeat, warmupMs, samplesMs, medianMsPerOperation: [...samplesMs].sort((a, b) => a - b)[4] / repeat };
          });
        }, kind);
        result.processes.push({ round, variant, order, rows });
        mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
        console.log(`${kind} browser round ${round + 1}/${rounds}: ${variant}`);
      } finally { await browser.close(); }
    }
  }
  result.summary = result.processes[0].rows.map((first, index) => {
    const pairs = Array.from({ length: rounds }, (_, round) => {
      const get = variant => result.processes.find(p => p.round === round && p.variant === variant).rows[index].medianMsPerOperation;
      return { beforeMs: get('baseline'), afterMs: get('candidate'), speedup: get('baseline') / get('candidate') };
    });
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2; };
    return { name: first.name, size: first.size, beforeMs: median(pairs.map(p => p.beforeMs)), afterMs: median(pairs.map(p => p.afterMs)), medianPairedSpeedup: median(pairs.map(p => p.speedup)), pairs };
  });
  result.sourceAfter = { baseline: manifest(base), candidate: manifest(candidate) };
  assert.deepEqual(result.sourceAfter.baseline.files, before.baseline.files, 'Baseline source/build changed during browser run');
  assert.deepEqual(result.sourceAfter.candidate.files, before.candidate.files, 'Candidate source/build changed during browser run');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ browser: result.browserVersion, correctness: result.correctness, summary: result.summary }));
} finally { await new Promise(resolve => server.close(resolve)); }
