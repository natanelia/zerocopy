/** Actual browser worker benchmark. Before/control/after use identical inputs.
 * The control uses the OLD library with the NEW common scheduler/bulk caller.
 * This separates engine gains from removal of timer delays affecting ALL paths.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.env.PERF_BASE ?? 'f3ba7a494b77c4b2e46540a599d98440c629cb5a';
assert.match(baseline, /^[a-f0-9]{40}$/);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const temp = mkdtempSync(join(tmpdir(), 'zerocopy-query-proof-'));
const original = join(temp, 'source'), site = join(temp, 'site');
const artifacts = join(root, 'proofs/query-results'); mkdirSync(artifacts, { recursive: true });
let browser, server;
const runs = [];
const median = values => {
  assert.ok(values.length > 0, 'A median needs at least one sample');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
try {
  mkdirSync(original); mkdirSync(site);
  const archive = execFileSync('git', ['archive', '--format=tar', baseline], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', original], { input: archive });
  symlinkSync(join(root, 'node_modules'), join(original, 'node_modules'), 'dir');
  execFileSync('bun', ['run', 'build:wasm'], { cwd: original, stdio: 'inherit' });
  execFileSync('bun', ['run', 'build:browser'], { cwd: original, stdio: 'inherit' });
  const dependency = JSON.parse(readFileSync(join(root, 'node_modules/immutable/package.json'))).version;
  assert.equal(dependency, JSON.parse(readFileSync(join(original, 'package.json'))).devDependencies.immutable);
  for (const variant of ['legacy', 'control', 'candidate']) {
    const dir = join(site, variant); mkdirSync(dir);
    cpSync(join(variant === 'legacy' ? original : root, 'website/assets'), join(dir, 'assets'), { recursive: true });
    mkdirSync(join(dir, 'library'));
    for (const file of readdirSync(join(variant === 'candidate' ? root : original, 'dist'))) {
      if (file.endsWith('.js')) cpSync(join(variant === 'candidate' ? root : original, 'dist', file), join(dir, 'library', file));
    }
    mkdirSync(join(dir, 'vendor'));
    cpSync(join(root, 'node_modules/immutable/dist/immutable.es.js'), join(dir, 'vendor/immutable.mjs'));
    writeFileSync(join(dir, 'vendor/version.mjs'), `export const immutableVersion=${JSON.stringify(dependency)};`);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>Query proof</title></head><body>Browser worker proof</body></html>');
  }
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    let file = resolve(site, '.' + path);
    if (!file.startsWith(site + sep)) { res.writeHead(403).end(); return; }
    if (path.endsWith('/')) file = join(file, 'index.html');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'text/javascript');
    try { res.end(readFileSync(file)); } catch { res.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const entries of [1000, 10000, 100000]) {
    // Three independent contexts per variant at the main workload size. Rotate
    // outer execution order as well as the benchmark's inner architecture order.
    for (let repeat = 0; repeat < (entries === 100000 ? 3 : 1); repeat++) {
      const variants = ['legacy', 'control', 'candidate'];
      const order = [...variants.slice(repeat), ...variants.slice(0, repeat)];
      for (const variant of order) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/`);
          const result = await page.evaluate(async ({ entries, variant, source }) => {
            const { Peer } = await import(`/${variant}/assets/explorer-peer.mjs`);
            const peer = new Peer(new URL(`/${variant}/assets/explorer-bench-runner.mjs`, location));
            try { return await peer.request('run', { entries, source }, 120000); }
            finally { peer.close(); }
          }, { entries, variant, source: variant === 'candidate' ? commit : baseline });
          assert.equal(result.raw.length, 28);
          assert.equal(result.environment.crossOriginIsolated, true);
          assert.equal(result.dependencies.immutable, dependency);
          for (const path of Object.values(result.samples)) for (const values of Object.values(path)) {
            assert.equal(values.length, 7); assert.ok(values.every(n => Number.isFinite(n) && n >= 0));
          }
          runs.push({ variant, repeat, entries, result });
          writeFileSync(join(artifacts, `${variant}-${entries}-${repeat}.json`), JSON.stringify(result, null, 2) + '\n');
          console.log(JSON.stringify({ variant, repeat, entries, summary: result.summary }));
        } finally { await context.close(); }
      }
    }
  }
  // Exercise cooperative cancellation in a real browser task queue. This view
  // is synthetic to keep the test alive long enough without allocating a huge
  // dataset. It is NOT included in the performance samples above.
  const cancellationContext = await browser.newContext();
  try {
    const page = await cancellationContext.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/candidate/`);
    const cancelled = await page.evaluate(async () => {
      const core = new URL('/candidate/assets/explorer-core.mjs', location).href;
      const code = `import { search } from ${JSON.stringify(core)};
        let cancelled=false;
        self.onmessage=async({data})=>{
          if(data==='cancel'){cancelled=true;return;}
          self.postMessage('started');
          try { await search({length:20000000,get:()=>0},{level:1},()=>cancelled); self.postMessage('completed'); }
          catch(e){self.postMessage(e.message);}
        };`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      try { return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Cancellation was not serviced')), 10000);
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        worker.onmessage = ({data}) => { if(data==='started')worker.postMessage('cancel'); else {clearTimeout(timer);resolve(data);} };
        worker.postMessage('go');
      }); } finally { worker.terminate(); URL.revokeObjectURL(url); }
    });
    assert.match(cancelled, /cancelled/);
  } finally { await cancellationContext.close(); }
  const table = [];
  for (const entries of [1000, 10000, 100000]) for (const variant of ['legacy', 'control', 'candidate']) {
    const selected = runs.filter(run => run.entries === entries && run.variant === variant);
    const phases = {};
    for (const phase of ['initial', 'query', 'update']) {
      const shared = median(selected.flatMap(run => run.result.samples.shared[phase]));
      const immutable = median(selected.flatMap(run => run.result.samples.immutable[phase]));
      phases[phase] = { sharedMs: shared, immutableMs: immutable, immutableOverShared: immutable / shared };
    }
    table.push({ entries, variant, phases });
  }
  const byQuery = [];
  for (const variant of ['legacy', 'control', 'candidate']) {
    const records = runs.filter(run => run.variant === variant && run.entries === 100000).flatMap(run => run.result.raw);
    for (const query of [...new Set(records.map(row => JSON.stringify(row.query)))]) {
      const select = path => records.filter(row => row.path === path && JSON.stringify(row.query) === query);
      byQuery.push({ variant, query: JSON.parse(query), samples: select('shared').length,
        sharedQueryMs: median(select('shared').map(row => row.queryMs)), immutableQueryMs: median(select('immutable').map(row => row.queryMs)),
        sharedUpdateMs: median(select('shared').map(row => row.updateMs)), immutableUpdateMs: median(select('immutable').map(row => row.updateMs)) });
    }
  }
  const report = { schema: 'zerocopy-query-performance/v1', baseline, commit, browser: browser.version(), dependency, table, byQuery,
    method: 'Same data, independent answer oracle, same Immutable.js, two warmups and seven samples per run. Legacy retains old timers/scalar appends. Control changes common task yields and uses the existing bulk append API but keeps the old library. Candidate adds per-list leaf cache and bounded arena string interning. Three independently initialized repetitions at 100000 events; rotated order. No timing samples removed. Raw JSON is retained. Smaller workloads are smoke measurements, not speed gates.' };
  writeFileSync(join(artifacts, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['# Query and update performance', '', `Baseline: \`${baseline}\` · Candidate: \`${commit}\` · Chromium ${browser.version()} · Immutable.js ${dependency}`, '',
    '| Events | Variant | Shared query ms | Immutable query ms | Ratio | Shared update ms | Immutable update ms | Ratio |', '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const row of table) { const { query: q, update: u } = row.phases; lines.push(`| ${row.entries} | ${row.variant} | ${q.sharedMs.toFixed(3)} | ${q.immutableMs.toFixed(3)} | ${q.immutableOverShared.toFixed(2)}× | ${u.sharedMs.toFixed(3)} | ${u.immutableMs.toFixed(3)} | ${u.immutableOverShared.toFixed(2)}× |`); }
  lines.push('', report.method, '', 'Ratios compare Immutable.js time / zerocopy time. Higher than 1 means zerocopy is faster. Timings are not memory measurements or guarantees.');
  writeFileSync(join(artifacts, 'SUMMARY.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
