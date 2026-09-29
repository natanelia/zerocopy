import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';
import ts from 'typescript';
import { browserExamples, extract } from './doc-examples.mjs';

/** Compile a documented file, changing only module URLs for the local test server. */
function compile(file, marker) {
  return ts.transpileModule(extract(file, marker, 'ts'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/(['"])zerocopy\1/g, "'/dist/shared.js'")
    .replace(/(['"])\.\/worker\.ts\1/g, "'./worker.js'");
}

const routes = new Map();
for (const example of browserExamples) {
  routes.set(`/${example.name}/main.js`, compile(example.file, example.owner));
  routes.set(`/${example.name}/worker.js`, compile(example.file, example.reader));
}
const dist = new URL('../dist/', import.meta.url);
for (const name of readdirSync(dist)) {
  if (name.endsWith('.js')) routes.set(`/dist/${name}`, readFileSync(new URL(name, dist), 'utf8'));
}
assert.ok(routes.has('/dist/shared.js'), 'Build the portable bundle before testing browser examples');

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const document = /^\/(readme|guide)\/(isolated|plain)$/.exec(path);
  if (!document || document[2] === 'isolated') {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  response.setHeader('Cache-Control', 'no-store');
  if (document) {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<script type="module" src="/${document[1]}/main.js"></script>`);
  } else if (routes.has(path)) {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(routes.get(path));
  } else {
    response.writeHead(404).end();
  }
});

let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const example of browserExamples) {
    for (const isolated of [false, true]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [], runtimeRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (new URL(request.url()).pathname.startsWith('/dist/')) runtimeRequests.push(request.url());
        });
        await page.addInitScript(() => {
          globalThis.docMessages = [];
          globalThis.docWorkerCount = 0;
          const NativeWorker = globalThis.Worker;
          globalThis.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args);
              globalThis.docWorkerCount++;
              this.addEventListener('message', event => globalThis.docMessages.push(event.data));
            }
          };
        });
        const rejection = isolated ? null : page.waitForEvent('pageerror');
        await page.goto(`${origin}/${example.name}/${isolated ? 'isolated' : 'plain'}`);
        assert.equal(await page.evaluate(() => crossOriginIsolated), isolated);
        if (isolated) {
          await page.waitForFunction(() => globalThis.docMessages.length === 1);
          assert.deepEqual(await page.evaluate(() => globalThis.docMessages[0]), example.expected);
          assert.equal(await page.evaluate(() => globalThis.docWorkerCount), 1);
          assert.deepEqual(errors, []);
        } else {
          assert.equal((await rejection).message, 'Shared worker memory requires cross-origin isolation');
          assert.deepEqual(runtimeRequests, [], 'The guard must run before the library import');
          assert.equal(await page.evaluate(() => globalThis.docWorkerCount), 0);
        }
        console.log(`Passed: ${example.name} browser example (${isolated ? 'shared worker' : 'isolation guard'}).`);
      } finally {
        await context.close();
      }
    }
  }
  console.log(`Browser examples verified with Chromium ${browser.version()}.`);
} finally {
  try { await browser?.close(); } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
