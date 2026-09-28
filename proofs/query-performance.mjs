/** Before/after browser proof against the actual PR base (manual run: current main).
 * The matched control uses the new scheduler and public bulk caller but keeps
 * the original library. This separates engine work from caller improvements.
 * All samples, including unique-text losses, are retained.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { matchScheduler } from './query-control.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const baseRoot = resolve(root, '.proof-baseline/website/_site');
const currentRoot = resolve(root, 'website/_site');
const matchedRoot = resolve(root, '.proof-baseline/matched-site');
const out = resolve(root, 'proofs/results/query-performance'); mkdirSync(out, { recursive: true });
cpSync(baseRoot, matchedRoot, { recursive: true });
const originalCore = readFileSync(resolve(baseRoot, 'assets/explorer-core.mjs'), 'utf8');
const currentCore = readFileSync(resolve(currentRoot, 'assets/explorer-core.mjs'), 'utf8');
const matchedCore = matchScheduler(originalCore, currentCore);
const currentStorage = readFileSync(resolve(currentRoot, 'assets/explorer-storage.mjs'), 'utf8');
function replaceCore(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) replaceCore(path);
    else if (item.name === 'explorer-storage.mjs') writeFileSync(path, currentStorage);
    else if (item.name === 'explorer-core.mjs') {
      const text = readFileSync(path, 'utf8');
      assert.equal(text, originalCore, 'Every baseline scope must have identical query code');
      writeFileSync(path, matchedCore);
    }
  }
}
replaceCore(matchedRoot);
// A separate diagnostic uses an event ID in every message. Do not change the
// public demonstration fixture or silently drop this harder text workload.
function uniqueFixture(folder) {
  const target = folder + '-unique';
  cpSync(folder, target, { recursive: true });
  function visit(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.name === 'explorer-core.mjs') {
        const text = readFileSync(path, 'utf8');
        const needle = 'n % 240, message };';
        assert.ok(text.includes(needle), 'Revisit the diagnostic when generation changes');
        writeFileSync(path, text.replace(needle, "n % 240, message: message + ' [event ' + index + ']' };"));
      }
    }
  }
  visit(target); return target;
}
const contentTypes = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serve(folder) {
  return createServer((req, res) => {
    try {
      let path = resolve(folder, '.' + new URL(req.url, 'http://localhost').pathname);
      if (path !== folder && !path.startsWith(folder + sep)) { res.writeHead(403).end(); return; }
      if (statSync(path).isDirectory()) path = resolve(path, 'index.html');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Content-Type', contentTypes[extname(path)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store'); res.end(readFileSync(path));
    } catch { res.writeHead(404).end(); }
  });
}
const variants = Object.entries({ original: baseRoot, matched: matchedRoot, optimized: currentRoot })
  .map(([name, folder]) => ({ name, folder, server: serve(folder), fixture: 'repeated' }));
const uniqueVariants = variants.filter(x => x.name !== 'original').map(variant => {
  const folder = uniqueFixture(variant.folder);
  return { name: variant.name, folder, server: serve(folder), fixture: 'unique' };
});
const servers = [...variants, ...uniqueVariants];
for (const variant of servers) { variant.server.listen(0, '127.0.0.1'); await once(variant.server, 'listening'); variant.origin = `http://127.0.0.1:${variant.server.address().port}`; }
const runs = [], rounds = Number(process.env.PERF_REPEATS ?? 3);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 10);
const median = values => { const a = [...values].sort((a, b) => a - b); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
try {
  for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
    const browser = await browserType.launch({ headless: true });
    try {
      // Three independent repeats for the target workload; one clearly labelled
      // seven-sample run per control for unique text, not a universal speed gate.
      for (let repeat = 0; repeat <= rounds; repeat++) {
        const order = repeat === rounds ? uniqueVariants : [...variants.slice(repeat % 3), ...variants.slice(0, repeat % 3)];
        for (const variant of order) {
          const context = await browser.newContext(); const page = await context.newPage();
          const errors = []; page.on('pageerror', error => errors.push(error.message));
          try {
            const meta = JSON.parse(readFileSync(resolve(variant.folder, 'build.json'), 'utf8'));
            await page.goto(variant.origin + '/investigation-benchmark/');
            const result = await page.evaluate(async source => {
              if (!crossOriginIsolated) throw new Error('Not isolated');
              const { Peer } = await import('./assets/explorer-peer.mjs');
              const peer = new Peer(new URL('./assets/explorer-bench-runner.mjs', location.href));
              try { return await peer.request('run', { entries: 100000, source }, 180000); }
              finally { peer.close(); }
            }, meta.sourceCommit ?? meta.commit ?? 'unknown');
            assert.equal(result.raw.length, 28);
            assert.equal(result.config.entries, 100000);
            assert.deepEqual(Object.keys(result.samples).sort(), ['centralized', 'immutable', 'replicated', 'shared']);
            for (const path of Object.values(result.samples)) for (const values of Object.values(path)) {
              assert.equal(values.length, 7); assert.ok(values.every(x => Number.isFinite(x) && x >= 0));
            }
            assert.deepEqual(errors, []);
            const record = { engine, browserVersion: browser.version(), repeat, variant: variant.name, fixture: variant.fixture, ...result };
            runs.push(record); writeFileSync(resolve(out, `${engine}-${variant.fixture}-${variant.name}-${repeat}.json`), JSON.stringify(record, null, 2));
            const medians = {};
            for (const [path, phases] of Object.entries(result.samples)) {
              medians[path] = Object.fromEntries(Object.entries(phases).map(([phase, values]) => [phase, median(values)]));
            }
            console.log(engine, variant.fixture, variant.name, repeat, JSON.stringify(medians));
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  }
  const summary = {};
  for (const engine of ['chromium', 'webkit']) {
    summary[engine] = {};
    for (const variant of variants.map(x => x.name)) {
      const set = runs.filter(x => x.engine === engine && x.variant === variant && x.fixture === 'repeated');
      summary[engine][variant] = {};
      for (const path of ['shared', 'immutable', 'replicated', 'centralized']) {
        summary[engine][variant][path] = Object.fromEntries(['initial', 'query', 'update'].map(phase => [phase, {
          medianMs: median(set.flatMap(x => x.samples[path][phase])),
          runMedians: set.map(x => median(x.samples[path][phase])),
        }]));
      }
    }
  }
  const byQuery = [];
  for (const run of runs) for (const sample of run.raw) {
    const key = JSON.stringify({ engine: run.engine, fixture: run.fixture, variant: run.variant, path: sample.path, query: sample.query });
    let group = byQuery.find(x => x.key === key);
    if (!group) { group = { key, engine: run.engine, fixture: run.fixture, variant: run.variant, path: sample.path, query: sample.query, samples: [] }; byQuery.push(group); }
    group.samples.push({ repeat: run.repeat, initialMs: sample.initialMs, queryMs: sample.queryMs, updateMs: sample.updateMs });
  }
  for (const group of byQuery) group.medians = Object.fromEntries(['initialMs', 'queryMs', 'updateMs'].map(phase => [phase, median(group.samples.map(x => x[phase]))]));
  writeFileSync(resolve(out, 'by-query.json'), JSON.stringify(byQuery, null, 2));
  writeFileSync(resolve(out, 'summary.json'), JSON.stringify({ schema: 'zerocopy-query-audit/v1', repeats: rounds, summary,
    note: 'Original retains shipped timers. Matched uses the same scheduler for every path and public bulk append caller but keeps the original collection runtime. Optimized uses snapshot-local leaf reads, bounded string interning, and public bulk append. All input, role counts, reference checks, seven samples and rotation are unchanged. Each repeat uses a fresh browser context and workers. Unique-message diagnostics are retained separately with one run per control per browser. Results apply only to these workloads; not memory measurements.' }, null, 2));
} finally {
  for (const variant of servers) { variant.server.closeAllConnections(); await new Promise(resolve => variant.server.close(resolve)); }
}
