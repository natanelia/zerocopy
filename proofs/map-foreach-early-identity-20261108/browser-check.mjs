import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';

const repository = resolve(process.argv[2] ?? '.');
const { chromium } = createRequire(join(repository, 'package.json'))('playwright');
const fileHash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function identity() {
  const hashes = (base, names) => Object.fromEntries(names.sort().map(name => [name, fileHash(join(base, name))]));
  return {
    sources: hashes(repository, ['arena.ts', 'shared-map.ts']),
    wasm: hashes(repository, readdirSync(repository).filter(name => name.endsWith('.wasm'))),
    bundles: hashes(join(repository, 'dist'), readdirSync(join(repository, 'dist')).filter(name => name.endsWith('.js'))),
    driver: fileHash(new URL(import.meta.url)), fixtures: fileHash(new URL('./worker-fixtures.mjs', import.meta.url)),
  };
}
const proofIdentity = identity();
async function workerProof() {
  const S = await import('/dist/shared.js'), H = await import('/proof-fixtures.mjs');
  H.assert(self.crossOriginIsolated, 'Worker isolation');
  let handle;
  self.onmessage = async event => {
    const message = event.data;
    try {
      handle ??= H.createWorkerHandler(S, result => self.postMessage(result), new Int32Array(message.control));
      self.postMessage(await handle(message));
    } catch (error) { self.postMessage({ ok: false, error: error.stack ?? String(error) }); }
  };
  self.postMessage({ type: 'ready' });
}
async function pageProof() {
  const S = await import('/dist/shared.js'), H = await import('/proof-fixtures.mjs');
  H.assert(self.crossOriginIsolated && typeof SharedArrayBuffer === 'function', 'Page isolation');
  const checks = [], writer = H.reentrantWriter(S);
  function receive(worker, type, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Worker proof timed out: ${type}`)), 25000);
      const message = event => { if (event.data.ok === false || event.data.type === type) finish(event.data.ok === false ? new Error(event.data.error) : null, event.data); };
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
  for (const copy of [false, true]) {
    const original = H.fixture(S), bytes = H.capture(S, original.structures);
    const controlBuffer = new SharedArrayBuffer(4), control = new Int32Array(controlBuffer);
    const worker = new Worker('/proof-worker.mjs', { type: 'module' });
    try {
      await receive(worker, 'ready');
      const payload = S.getWorkerData(original.structures, { copy });
      await receive(worker, 'paused', () => worker.postMessage({ type: 'initial', payload,
        expected: original.expected, control: controlBuffer }));
      const updated = H.editAndGrow(S, original.structures);
      const resumed = receive(worker, 'scanned');
      Atomics.store(control, 0, 1); Atomics.notify(control, 0);
      const first = await resumed;
      const second = await receive(worker, 'complete', () => worker.postMessage({ type: 'updated',
        payload: S.getWorkerData(updated, { copy }), expected: H.expected(updated) }));
      H.verify(original.structures, original.expected); H.unchanged(bytes);
      checks.push({ transport: copy ? 'copy' : 'shared', first, second });
    } finally { Atomics.store(control, 0, 1); Atomics.notify(control, 0); worker.terminate(); }
  }
  return { crossOriginIsolated: self.crossOriginIsolated, writer, checks, timingMeasurements: false };
}
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Map forEach early-identity correctness proof</title>'); return; }
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
  assert.deepEqual(identity(), proofIdentity, 'Proof source/build identity');
  console.log(JSON.stringify({ browser: browser.version(), runtime: process.versions, date: new Date().toISOString(), ...proofIdentity, ...result }, null, 2));
} catch (error) {
  console.error(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
