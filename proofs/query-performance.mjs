/** Same-machine browser proof using the shipped coordinator and real workers.
 * Keep three baselines: released code, released code with equal scheduling, and
 * candidate. The latter two use byte-identical query functions and checkpoints.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const base = resolve(process.argv[2] ?? join(root, '.proof-baseline'));
const output = resolve(process.argv[3] ?? join(root, 'proofs/results/query-performance.json'));
assert.notEqual(root, base);
const sourceSHA = dir => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
const digest = dir => {
  const hash = createHash('sha256');
  for (const name of readdirSync(join(dir, 'dist')).filter(name => name.endsWith('.js')).sort()) hash.update(name + '\0').update(readFileSync(join(dir, 'dist', name))).update('\0');
  return hash.digest('hex');
};
const oldCore = readFileSync(join(base, 'website/assets/explorer-core.mjs'), 'utf8');
const newCore = readFileSync(join(root, 'website/assets/explorer-core.mjs'), 'utf8');
const oldYield = 'export const yieldToEvents = () => new Promise(resolve => setTimeout(resolve, 0));';
const newYield = newCore.slice(newCore.indexOf('// A posted message'), newCore.indexOf('/** Periodic task-queue'));
// Fail rather than quietly compare different filtering or summary algorithms.
assert.equal(oldCore.replace(oldYield + '\n', newYield), newCore, 'The only common query change must be scheduling');
const variants = ['baseline', 'baseline-equal-scheduler', 'candidate'];
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Query performance proof</title>'); return; }
  const [, variant, ...parts] = url.pathname.split('/');
  if (!variants.includes(variant)) { response.writeHead(404).end(); return; }
  const source = join(variant === 'candidate' ? root : base, 'website/_site');
  const file = resolve(source, parts.join('/'));
  if (!file.startsWith(source + sep)) { response.writeHead(403).end(); return; }
  try {
    assert.ok(statSync(file).isFile());
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    response.end(variant === 'baseline-equal-scheduler' && file.endsWith('/assets/explorer-core.mjs') ? newCore : readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const record = {
  schema: 'zerocopy-query-performance/v1', timestamp: new Date().toISOString(),
  base: { commit: sourceSHA(base), librarySHA256: digest(base) },
  candidate: { commit: sourceSHA(root), librarySHA256: digest(root) },
  method: 'Three independent runs per engine, size and variant. Variant order rotates each run. Each run uses the shipped four-path worker benchmark with two warmups and seven measured samples. baseline-equal-scheduler changes ONLY the common task-queue yield implementation; candidate and all its competitors share that scheduler. Query functions, data, reference validation, checkpoints and sample counts are unchanged. No speed assertion on a noisy CI machine. Report each query as well as the fixed query mix.',
  runs: [],
};
mkdirSync(resolve(output, '..'), { recursive: true });
const save = () => writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
try {
  for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
    const browser = await launcher.launch({ headless: true });
    try {
      for (const entries of [1000, 10000, 100000]) for (let repetition = 0; repetition < 3; repetition++) {
        const order = [...variants.slice(repetition), ...variants.slice(0, repetition)];
        for (const variant of order) {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            const result = await page.evaluate(async ({ variant, entries, source }) => {
              if (!crossOriginIsolated) throw Error('The proof must use actual shared memory');
              const prefix = `/${variant}/investigation-benchmark/assets/`;
              const { Peer } = await import(prefix + 'explorer-peer.mjs');
              const peer = new Peer(new URL(prefix + 'explorer-bench-runner.mjs', location.href));
              try { return await peer.request('run', { entries, source }, 120000); }
              finally { peer.close(); }
            }, { variant, entries, source: variant === 'candidate' ? record.candidate.commit : record.base.commit });
            assert.deepEqual(errors, []); assert.equal(result.raw.length, 28);
            for (const row of result.raw) for (const phase of ['initialMs', 'queryMs', 'updateMs']) assert.ok(Number.isFinite(row[phase]) && row[phase] >= 0);
            record.runs.push({ engine, browserVersion: browser.version(), entries, repetition, variant, result }); save();
            console.log(`${engine} ${entries} ${variant} run ${repetition + 1}: shared query=${result.summary.shared.query.median.toFixed(2)}ms update=${result.summary.shared.update.median.toFixed(2)}ms; immutable query=${result.summary.immutable.query.median.toFixed(2)}ms update=${result.summary.immutable.update.median.toFixed(2)}ms`);
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); save(); }
assert.equal(record.runs.length, 54, 'All engines, variants, sizes, and repetitions must finish');
console.log(`Full raw results: ${output}`);
