/** Same live coordinator and same four architectures; no substitute kernels.
 * Baseline: merged source. Control: baseline library/append with the new shared
 * scheduler. Candidate: all changes. The control separates timer savings from
 * library gains. Each measured answer still passes the independent oracle.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = resolve(root, process.env.QUERY_BASELINE_SITE ?? '.proof-baseline/website/_site');
const candidate = resolve(root, 'website/_site');
const control = resolve(root, '.proof-query-control');
const artifacts = resolve(root, 'website/artifacts');
mkdirSync(artifacts, { recursive: true });
cpSync(candidate, control, { recursive: true });
for (const route of ['', 'compare', 'explorer', 'investigation-benchmark', 'lab', 'playground']) {
  cpSync(join(baseline, route, 'library'), join(control, route, 'library'), { recursive: true });
}
for (const route of ['', 'compare', 'explorer', 'investigation-benchmark']) {
  cpSync(join(baseline, route, 'assets/explorer-storage.mjs'), join(control, route, 'assets/explorer-storage.mjs'));
}

const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
async function serve(directory) {
  const metadata = JSON.parse(readFileSync(join(directory, 'build.json')));
  const server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (!pathname.startsWith(metadata.base)) throw new Error('outside base');
      let path = resolve(directory, pathname.slice(metadata.base.length));
      if (!path.startsWith(directory + sep) && path !== directory) throw new Error('outside root');
      if (statSync(path).isDirectory()) path = join(path, 'index.html');
      res.setHeader('Content-Type', mime[extname(path)] ?? 'text/plain');
      res.end(readFileSync(path));
    } catch { res.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, metadata, url: `http://127.0.0.1:${server.address().port}${metadata.base}investigation-benchmark/` };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summary(runs) {
  return Object.fromEntries(['shared', 'immutable', 'replicated', 'centralized'].map(path => [path,
    Object.fromEntries(['initial', 'query', 'update'].map(phase => {
      const values = runs.flatMap(run => run.result.samples[path][phase]);
      return [phase, { medianMs: median(values), samples: values.length }];
    }))]));
}
const repetitions = Number(process.env.QUERY_REPETITIONS ?? 3);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const sizes = (process.env.QUERY_SIZES ?? '10000,100000').split(',').map(Number);
assert.ok(sizes.every(size => [1000, 10000, 100000].includes(size)));
const engines = (process.env.QUERY_ENGINES ?? 'chromium,webkit').split(',');
assert.ok(engines.every(engine => ['chromium', 'webkit'].includes(engine)));
const sites = {};
const report = {
  schema: 'zerocopy-query-audit/v1', baselineCommit: process.env.QUERY_BASE_COMMIT,
  candidateCommit: process.env.QUERY_HEAD_COMMIT,
  timestamp: new Date().toISOString(), repetitions, sizes,
  target: 'At least 1.25x Immutable.js for both pooled query and append+publish+query medians at 100000 sample events. This is a measured margin, not a statistical significance claim.',
  method: 'Fresh coordinator and reader workers per run. Original two warmups, seven samples, query mix, rotated path order, input size, reference checks, and all four architectures retained. Outer variant order also rotates. Control combines baseline library and scalar appends with the candidate scheduler. Candidate and Immutable.js always use identical scan functions and checkpoint scheduling. No result cache or skipped work. Runs and per-query results are retained, including losses. Browser startup, module loading and initial construction remain separate from timed phases. Sample messages repeat; results must not be generalized to unique arbitrary text.',
  runs: [], summary: []
};
function save() { writeFileSync(join(artifacts, 'query-performance.json'), JSON.stringify(report, null, 2) + '\n'); }
try {
  sites.baseline = await serve(baseline); sites.control = await serve(control); sites.candidate = await serve(candidate);
  assert.equal(sites.baseline.metadata.dependencies.immutable, sites.candidate.metadata.dependencies.immutable);
  report.baselineBuild = sites.baseline.metadata; report.candidateBuild = sites.candidate.metadata;
  for (const engine of engines) {
    const browser = await ({ chromium, webkit }[engine]).launch({ headless: true,
      ...(engine === 'chromium' ? { args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
    try {
      for (const entries of sizes) for (let repetition = 0; repetition < repetitions; repetition++) {
        const labels = ['baseline', 'control', 'candidate'];
        const order = [...labels.slice(repetition % 3), ...labels.slice(0, repetition % 3)];
        for (const variant of order) {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            await page.goto(sites[variant].url);
            const result = await page.evaluate(({ entries, source }) => new Promise((resolve, reject) => {
              const worker = new Worker(new URL('./assets/explorer-bench-runner.mjs', location.href), { type: 'module' });
              const finish = (error, value) => { clearTimeout(timer); worker.terminate(); error ? reject(new Error(error)) : resolve(value); };
              const timer = setTimeout(() => finish('Benchmark timeout'), 180000);
              worker.onerror = event => finish(event.message || 'Worker failed');
              worker.onmessage = ({ data }) => {
                if (data?.protocol !== 'zerocopy/log-demo/v1' || data.id !== 1) return;
                finish(data.error, data.value);
              };
              worker.postMessage({ protocol: 'zerocopy/log-demo/v1', id: 1, type: 'run', entries, source });
            }), { entries, source: sites[variant].metadata.sourceCommit });
            assert.equal(result.raw.length, 28); assert.equal(result.config.samplesPerPath, 7);
            assert.equal(result.dependencies.immutable, sites.candidate.metadata.dependencies.immutable);
            for (const row of result.raw) {
              assert.match(row.checks, /full row page/);
              for (const phase of ['initialMs', 'queryMs', 'updateMs']) assert.ok(Number.isFinite(row[phase]) && row[phase] >= 0);
            }
            report.runs.push({ engine, browserVersion: browser.version(), entries, repetition, variant, result }); save();
            console.log(JSON.stringify({ engine, entries, repetition, variant, shared: result.summary.shared, immutable: result.summary.immutable }));
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  }
  for (const engine of engines) for (const entries of sizes) {
    const group = report.runs.filter(run => run.engine === engine && run.entries === entries);
    const variants = Object.fromEntries(['baseline', 'control', 'candidate'].map(variant => [variant, summary(group.filter(run => run.variant === variant))]));
    const current = variants.candidate;
    const speedup = Object.fromEntries(['query', 'update'].map(phase => [phase, current.immutable[phase].medianMs / current.shared[phase].medianMs]));
    const perQuery = Object.fromEntries(['timeout', 'service', 'request'].map(name => {
      const records = group.filter(run => run.variant === 'candidate').flatMap(run => run.result.raw).filter(row => (row.query.term ?? 'service') === name);
      return [name, Object.fromEntries(['queryMs', 'updateMs'].map(phase => [phase, Object.fromEntries(['shared', 'immutable'].map(path => [path, median(records.filter(row => row.path === path).map(row => row[phase]))]))]))];
    }));
    report.summary.push({ engine, entries, variants, speedupVsImmutable: speedup, targetMet: speedup.query >= 1.25 && speedup.update >= 1.25, perQuery });
  }
  save(); console.log(JSON.stringify({ summary: report.summary }, null, 2));
} finally { await Promise.all(Object.values(sites).map(({ server }) => new Promise(resolve => server.close(resolve)))); }
