import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const repository = resolve(process.argv[2] ?? '.');
const { chromium } = createRequire(join(repository, 'package.json'))('playwright');
async function workerProof() {
  const S = await import('/dist/shared.js'), H = await import('/proof-fixtures.mjs');
  H.assert(self.crossOriginIsolated, 'Worker isolation');
  const handle = H.createWorkerHandler(S);
  self.onmessage = async event => {
    const message = event.data;
    try { self.postMessage({ id: message.id, ...await handle(message.payload, message.expected) }); }
    catch (error) { self.postMessage({ id: message.id, ok: false, error: error.stack ?? String(error) }); }
  };
  self.postMessage({ ready: true });
}
async function pageProof() {
  const S = await import('/dist/shared.js'), H = await import('/proof-fixtures.mjs');
  H.assert(self.crossOriginIsolated && typeof SharedArrayBuffer === 'function', 'Page isolation');
  const checks = [];
  let id = 0;
  function receive(worker, predicate, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Worker proof timed out')), 20000);
      const message = event => { if (predicate(event.data)) finish(event.data.ok === false ? new Error(event.data.error) : null, event.data); };
      const error = event => finish(new Error(event.message || 'Worker error'));
      function finish(error, result) {
        clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', errorHandler);
        if (error) reject(error); else resolve(result);
      }
      const errorHandler = error;
      worker.addEventListener('message', message); worker.addEventListener('error', errorHandler);
      send?.();
    });
  }
  async function send(worker, structures, expected, copy) {
    const payload = S.getWorkerData(structures, { copy }), requestId = ++id;
    return receive(worker, value => value.id === requestId,
      () => worker.postMessage({ id: requestId, payload, expected }, payload.arenas.flatMap(arena => arena.copy ? [arena.copy.buffer] : [])));
  }
  for (const copy of [false, true]) {
    const original = H.fixture(S), worker = new Worker('/proof-worker.mjs', { type: 'module' });
    try {
      await receive(worker, result => result.ready === true);
      const first = await send(worker, original.structures, original.expected, copy);
      H.grow(S, original.structures);
      const updated = H.edited(S, original.structures, original.expected);
      H.verifySnapshots(S, original.structures, original.expected);
      H.verifySnapshots(S, updated.structures, updated.expected);
      const second = await send(worker, updated.structures, updated.expected, copy);
      H.assert(first.ok && second.ok, 'Both worker versions verified');
      checks.push({ transport: copy ? 'copy' : 'shared', first, second });
    } finally { worker.terminate(); }
  }
  return { crossOriginIsolated: self.crossOriginIsolated, checks, timingMeasurements: false };
}
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Compaction correctness proof</title>'); return; }
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    if (pathname === '/proof-fixtures.mjs') { response.end(readFileSync(new URL('./worker-fixtures.mjs', import.meta.url))); return; }
    if (pathname === '/proof-worker.mjs') { response.end(`await (${workerProof.toString()})();`); return; }
    if (pathname.startsWith('/dist/')) {
      const filename = resolve(repository, pathname.slice(1));
      if (filename.startsWith(join(repository, 'dist') + sep)) { response.end(readFileSync(filename)); return; }
    }
    response.statusCode = 404; response.end('Not found');
  } catch { response.statusCode = 404; response.end('Not found'); }
});
let browser;
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
  const result = await page.evaluate(pageProof);
  if (errors.length) throw new Error(errors.join('; '));
  console.log(JSON.stringify({ browser: browser.version(), ...result }, null, 2));
} catch (error) {
  console.error(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
