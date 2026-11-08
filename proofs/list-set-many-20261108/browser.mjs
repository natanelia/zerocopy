import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? '.'), output = resolve(process.argv[3] ?? 'list-set-many-browser.json');
assert.ok(!existsSync(output), 'Use a new output path; do not replace recorded evidence');
const proof = dirname(fileURLToPath(import.meta.url)), routes = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {};
for (const name of readdirSync(resolve(root, 'dist')).filter(name => name.endsWith('.js'))) {
  const content = readFileSync(resolve(root, 'dist', name));
  routes.set(`/build/${name}`, content); hashes[`dist/${name}`] = hash(content);
}
for (const name of ['browser-values.mjs', 'browser-worker.mjs', 'browser-case.mjs']) {
  const content = readFileSync(resolve(proof, name));
  routes.set(`/proof/${name}`, content); hashes[name] = hash(content);
}
assert.ok(routes.has('/build/shared.js'), 'Build the portable bundle first');
hashes['persistent-core.as.ts'] = hash(readFileSync(resolve(root, 'persistent-core.as.ts')));
hashes['shared-list.ts'] = hash(readFileSync(resolve(root, 'shared-list.ts')));
const result = { schema: 'zerocopy-list-set-many-browser/v1', startedAt: new Date().toISOString(), root,
  node: process.version, hashes, driverSha256: hash(readFileSync(fileURLToPath(import.meta.url))), status: 'running' };
const require = createRequire(resolve(root, 'package.json'));
const { chromium } = require('playwright');
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>SharedList batch worker proof</title>');
  } else if (routes.has(path)) {
    response.setHeader('Content-Type', 'text/javascript'); response.end(routes.get(path));
  } else response.writeHead(404).end();
});
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version();
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  result.checks = await page.evaluate(async () => (await import('/proof/browser-case.mjs')).runBrowserProof());
  assert.equal(result.checks.passed, true); assert.deepEqual(errors, []);
  result.status = 'passed';
  console.log(JSON.stringify(result.checks, null, 2));
} catch (error) {
  result.status = 'failed'; result.error = String(error.stack ?? error);
  console.error(result.error); process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  result.completedAt = new Date().toISOString();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
}
