import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const runtime = process.env.RUNTIME ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(runtime)) throw new Error('Unknown browser');
const roots = { candidate: dirname(resolve(process.argv[2] ?? 'dist/shared.js')), baseline: dirname(resolve(process.argv[3] ?? '.ordered-churn-baseline/dist/shared.js')), proofs: dirname(fileURLToPath(import.meta.url)) };
const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Ordered churn checks</title>'); return; }
  const [, scope, ...parts] = new URL(req.url, 'http://localhost').pathname.split('/'), root = roots[scope];
  const path = root && resolve(root, ...parts);
  if (!path || !path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(path)); } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`, engine = (await import('playwright'))[runtime], results = [];
try {
  for (const variant of ['baseline', 'candidate']) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage(); await page.goto(origin);
      const result = await page.evaluate(async ({ origin, variant }) => {
        if (!crossOriginIsolated) throw new Error('Cross-origin isolation required');
        const S = await import(`${origin}/${variant}/shared.js`), checks = await import(`${origin}/proofs/ordered-churn-checks.mjs`), { checkChurnWorker } = await import(`${origin}/proofs/ordered-churn-worker-check.mjs`);
        const cases = await checks.runChurnChecks(S), mechanism = checks.runChurnMechanism(S, variant === 'candidate'), workers = [];
        for (const copy of [false, true]) workers.push(await checkChurnWorker(S, new Worker(`${origin}/proofs/ordered-churn-worker.mjs`, { type: 'module' }), `${origin}/${variant}/shared.js`, copy));
        return { cases, mechanism, workers };
      }, { origin, variant });
      results.push({ variant, runtime, version: browser.version(), ...result });
    } finally { await browser.close(); }
  }
} finally { await new Promise(done => server.close(done)); }
const output = process.argv[4] ?? `proofs/results/ordered-churn/${runtime}-checks.json`; mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
