// Browser supplement for the fixed long-query workload. Build both bundles first.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { cpus, platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';

const base = resolve(process.env.BROWSER_BASE_ROOT), candidate = resolve(process.env.BROWSER_CANDIDATE_ROOT);
const output = resolve(process.env.BROWSER_OUTPUT), rounds = 4;
assert(!existsSync(output), 'Use a new output path; never overwrite recorded evidence');
const { chromium } = createRequire(resolve(candidate, 'package.json'))('playwright');
const options = { headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixturePath = resolve(candidate, 'proofs/long-text-search-20261105/fixtures.mjs');
function manifest(root) {
  const files = [...readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')),
    ...readdirSync(resolve(root, 'dist')).filter(name => name.endsWith('.js')).map(name => `dist/${name}`)];
  return { commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    files: Object.fromEntries(files.sort().map(name => [name, sha(readFileSync(resolve(root, name)))])) };
}
const source = { baseline: manifest(base), candidate: manifest(candidate) };
let selectedRoot = candidate;
const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Search benchmark</title>'); return; }
    if (path === '/fixtures.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(fixturePath)); return; }
    const match = /^\/build\/(.+\.js)$/.exec(path), root = resolve(selectedRoot, 'dist');
    const file = match && resolve(root, match[1]);
    if (!file || !file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const result = { method: 'One public bundle per fresh Chromium process, fixed shared URL and fixture module; four balanced AB/BA process pairs; five warmup and nine measured batches. Identical fixed repetitions from the Node/Bun fixture catalogue. Full per-row native includes oracle before timing; index-weighted checksums after each timed batch. Timed region compiles one predicate and scans all rows per repetition.',
  date: new Date().toISOString(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, rounds, source,
  driverSha256: sha(readFileSync(new URL(import.meta.url))), fixtureSha256: sha(readFileSync(fixturePath)), correctness: null, processes: [] };
try {
  const browser = await chromium.launch(options); result.browserVersion = browser.version();
  try {
    const page = await browser.newPage(); await page.goto(url);
    result.correctness = await page.evaluate(async () => {
      if (!crossOriginIsolated) throw new Error('Cross-origin isolation required');
      const api = await import('/build/shared.js');
      const { CASES, ROWS, fixture } = await import('/fixtures.mjs');
      let assertions = 0;
      for (const spec of CASES) {
        api.resetSharedList(); const { values, matches } = fixture(spec);
        const list = new api.SharedList('string').pushMany(values);
        const states = [list];
        for (const copy of [false, true]) states.push((await api.initWorker(api.getWorkerData({ list }, { copy }))).list);
        const readers = states.map(state => state.compileTextSearch(spec.term, { caseSensitive: spec.caseSensitive }));
        // Preserve the captured immutable range when its writer allocates new records.
        list.pushMany(Array.from({ length: 10000 }, (_, i) => 'new allocation '.repeat(30) + i));
        for (const read of readers) for (let i = 0; i < ROWS; i++) {
          assertions++; if (read(i) !== matches[i]) throw new Error(`${spec.name}/${i}: mismatch`);
        }
        for (const index of [-1, ROWS, NaN, .5, Infinity]) {
          assertions++; if (readers[0](index)) throw new Error('Invalid index matched');
        }
      }
      return { assertions, cases: CASES.length, checks: 'Native substring oracle; writer, shared/copy attachments, existing predicates after growth, invalid indexes' };
    });
  } finally { await browser.close(); }
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const variant of order) {
      selectedRoot = variant === 'baseline' ? base : candidate;
      const browser = await chromium.launch(options);
      try {
        const page = await browser.newPage(); await page.goto(url);
        const rows = await page.evaluate(async reverse => {
          const api = await import('/build/shared.js');
          const { CASES, ROWS, fixture } = await import('/fixtures.mjs');
          const rows = [];
          for (const spec of reverse ? [...CASES].reverse() : CASES) {
            api.resetSharedList(); const { values, matches, checksum } = fixture(spec);
            const list = new api.SharedList('string').pushMany(values);
            const initial = list.compileTextSearch(spec.term, { caseSensitive: spec.caseSensitive });
            for (let i = 0; i < ROWS; i++) if (initial(i) !== matches[i]) throw new Error('Oracle mismatch');
            function batch() {
              let total = 0; const start = performance.now();
              for (let r = 0; r < spec.repetitions; r++) {
                const read = list.compileTextSearch(spec.term, { caseSensitive: spec.caseSensitive });
                for (let i = 0; i < ROWS; i++) if (read(i)) total += i + ROWS + 1;
              }
              const elapsed = performance.now() - start;
              if (total !== checksum * spec.repetitions) throw new Error('Checksum mismatch');
              return elapsed / spec.repetitions;
            }
            const warmupMs = Array.from({ length: 5 }, batch), samplesMs = Array.from({ length: 9 }, batch);
            rows.push({ name: spec.name, role: spec.role, rows: ROWS, repetitions: spec.repetitions, checksum, warmupMs, samplesMs,
              medianMsPerScan: [...samplesMs].sort((a, b) => a - b)[4] });
          }
          return rows;
        }, round % 2 !== 0);
        result.processes.push({ round, variant, order, rows });
        mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
        console.log(`search browser round ${round + 1}/${rounds}: ${variant}`);
      } finally { await browser.close(); }
    }
  }
  const median = values => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
  result.summary = result.processes[0].rows.map(first => {
    const pairs = Array.from({ length: rounds }, (_, round) => {
      const get = variant => result.processes.find(p => p.round === round && p.variant === variant).rows.find(row => row.name === first.name).medianMsPerScan;
      return { beforeMs: get('baseline'), afterMs: get('candidate'), speedup: get('baseline') / get('candidate') };
    });
    return { name: first.name, role: first.role, beforeMs: median(pairs.map(p => p.beforeMs)), afterMs: median(pairs.map(p => p.afterMs)), medianPairedSpeedup: median(pairs.map(p => p.speedup)), pairs };
  });
  result.sourceAfter = { baseline: manifest(base), candidate: manifest(candidate) };
  for (const role of ['baseline', 'candidate']) assert.deepEqual(result.sourceAfter[role].files, source[role].files, 'Source/build changed during comparison');
  assert.equal(sha(readFileSync(fixturePath)), result.fixtureSha256);
  assert.equal(sha(readFileSync(new URL(import.meta.url))), result.driverSha256);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ browser: result.browserVersion, correctness: result.correctness, summary: result.summary }));
} finally { await new Promise(resolve => server.close(resolve)); }
