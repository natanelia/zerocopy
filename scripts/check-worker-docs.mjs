import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { extract } from './doc-examples.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(root, '.worker-docs-'));
const guide = 'docs/workers.md';
const cases = [
  { name: 'direct', file: 'README.md', marker: 'readme-direct-owner', expected: [[30], [50]], workers: 1, direct: true },
  { name: 'quickstart', file: 'README.md', marker: 'dx-main', expected: [[30], [50]], workers: 1 },
  { name: 'local', file: guide, marker: 'dx-local', expected: [[30], [50]], workers: 0 },
  { name: 'connect', file: guide, marker: 'dx-connect', expected: [[30]], workers: 1 },
  { name: 'individual', file: guide, marker: 'dx-individual', expected: [[[50, 50]]], workers: 2 },
  { name: 'pool', file: guide, marker: 'dx-pool', expected: [[[1000, 30, 50]]], workers: 4 },
  { name: 'port', file: guide, marker: 'dx-port-main', expected: [[30]], workers: 1,
    worker: ['integrated.worker.ts', 'dx-port-worker'] },
  { name: 'shared', file: guide, marker: 'dx-shared-main', expected: [[30], [50]], workers: 0,
    worker: ['limits.shared-worker.ts', 'dx-shared-worker'] },
];

/** Keep application logic intact; change only module URLs for the test environment. */
function compile(source, extension, browser = false) {
  let js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  js = js.replace(/(['"])\.\/tasks\1/g, `'./tasks.${extension}'`)
    .replace(/(['"])(\.\/[^'"\n]+)\.ts\1/g, (_match, _quote, file) => `'${file}.${extension}'`);
  if (browser) {
    js = js.replace(/(['"])zerocopy(?:\/(worker|state))?\1/g,
      (_match, _quote, entry) => `'/dist/${entry ?? 'shared'}.js'`);
  }
  return js;
}

/** Materialize exactly the files a reader copies, not parallel hand-written fixtures. */
function sourcesFor(example) {
  if (example.direct) {
    return new Map([
      ['main.ts', extract(example.file, example.marker, 'ts')],
      ['state.worker.ts', extract('README.md', 'readme-direct-reader', 'ts')],
    ]);
  }
  const sources = new Map([
    ['tasks.ts', extract('README.md', 'dx-tasks', 'ts')],
    ['main.ts', extract(example.file, example.marker, 'ts')],
  ]);
  if (example.worker) sources.set(example.worker[0], extract(guide, example.worker[1], 'ts'));
  else if (example.name !== 'local') sources.set('limits.worker.ts', extract('README.md', 'dx-worker', 'ts'));
  return sources;
}

/** Keep direct data access ahead of the optional task example, without a hidden task setup. */
function checkDirectReadFraming() {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const direct = readme.indexOf('<!-- example: readme-direct-owner -->');
  const tasks = readme.indexOf('<!-- example: dx-tasks -->');
  assert.ok(direct >= 0 && tasks > direct, 'The README must show direct reads before task setup');
  const sources = sourcesFor(cases.find(example => example.direct));
  assert.equal(sources.size, 2, 'Direct reads need only an owner and a reader');
  for (const source of sources.values()) {
    assert.doesNotMatch(source, /\b(?:defineTasks|serve|spawn|pool|local)\s*(?:<[^>]*>)?\s*\(/,
      'The direct-read quickstart must not require task APIs');
  }
}

/** Strictly check all TypeScript samples, including intentional negative call-site checks. */
function checkTypes() {
  const paths = [];
  for (const example of [...cases, { name: 'type-errors', file: guide, marker: 'dx-type-errors' }]) {
    const directory = join(temporary, example.name);
    mkdirSync(directory);
    for (const [file, source] of sourcesFor(example)) {
      const destination = join(directory, file);
      writeFileSync(destination, source);
      paths.push(destination);
    }
  }
  const program = ts.createProgram(paths, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    noEmit: true, skipLibCheck: true, types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.webworker.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  console.log(`Passed: ${paths.length} Markdown TypeScript files (TypeScript ${ts.version}).`);
}

/** Execute the documented local code and the real Node Worker pair. */
function checkNode() {
  const localDirectory = join(temporary, 'local');
  for (const [file, source] of sourcesFor(cases.find(example => example.name === 'local'))) {
    writeFileSync(join(localDirectory, file.replace(/\.ts$/, '.mjs')), compile(source, 'mjs'));
  }
  // Node has no browser isolation flag. This supplies only that environment flag.
  const localURL = pathToFileURL(join(localDirectory, 'main.mjs')).href;
  const localOutput = execFileSync(process.execPath, ['--input-type=module', '-e',
    `globalThis.crossOriginIsolated = true; await import(${JSON.stringify(localURL)});`],
  { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(localOutput.trim(), '30\n50');
  console.log('Passed: documented local execution and immediate update.');

  const nodeDirectory = join(temporary, 'node');
  mkdirSync(nodeDirectory);
  writeFileSync(join(nodeDirectory, 'main.mjs'), extract(guide, 'dx-node-main', 'js'));
  writeFileSync(join(nodeDirectory, 'limits.worker.mjs'), extract(guide, 'dx-node-worker', 'js'));
  const nodeOutput = execFileSync(process.execPath, [join(nodeDirectory, 'main.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(nodeOutput.trim(), '30\n50');
  console.log('Passed: documented Node Worker pair and immediate update.');
}

/** Run every browser entry with isolation, and verify guards before runtime imports. */
async function checkBrowser() {
  const { chromium } = await import('playwright');
  const routes = new Map();
  for (const example of cases) {
    for (const [file, source] of sourcesFor(example)) {
      const js = compile(source, 'js', true);
      const tail = file === 'main.ts'
        ? (example.direct ? '\nglobalThis.__docDispose = () => { state.dispose(); worker.terminate(); };\n' : '')
          + '\nglobalThis.__docDone = true;\n'
        : '';
      routes.set(`/${example.name}/${file.replace(/\.ts$/, '.js')}`, js + tail);
    }
  }
  for (const name of readdirSync(join(root, 'dist'))) {
    if (name.endsWith('.js')) routes.set(`/dist/${name}`, readFileSync(join(root, 'dist', name), 'utf8'));
  }
  assert.ok(routes.has('/dist/worker.js') && routes.has('/dist/state.js'), 'Build the package first');
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const document = /^\/([a-z-]+)\/(isolated|plain)$/.exec(path);
    if (!document || document[2] === 'isolated') {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    response.setHeader('Cache-Control', 'no-store');
    if (document && cases.some(example => example.name === document[1])) {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<script type="module" src="/${document[1]}/main.js"></script>`);
    } else if (routes.has(path)) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(routes.get(path));
    } else response.writeHead(404).end();
  });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await chromium.launch({ headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;

    async function checkPage(context, example, isolated) {
      const page = await context.newPage();
      const requests = [], errors = [], readerLogs = [];
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (example.direct && message.location().url.endsWith('/state.worker.js')) readerLogs.push(message.text());
      });
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/dist/')) requests.push(request.url());
      });
      await page.addInitScript(() => {
        globalThis.__docDone = false;
        globalThis.__docLogs = [];
        globalThis.__docWorkers = 0;
        globalThis.__docSharedWorkers = 0;
        globalThis.__docTaskFrames = 0;
        const log = console.log.bind(console);
        console.log = (...args) => { globalThis.__docLogs.push(args); log(...args); };
        const WorkerClass = globalThis.Worker;
        globalThis.Worker = class extends WorkerClass {
          constructor(...args) {
            super(...args);
            globalThis.__docWorkers++;
            this.addEventListener('message', event => {
              if (event.data?.protocol === 'zerocopy/tasks') globalThis.__docTaskFrames++;
            });
          }
          postMessage(...args) {
            if (args[0]?.protocol === 'zerocopy/tasks') globalThis.__docTaskFrames++;
            return super.postMessage(...args);
          }
        };
        if (typeof SharedWorker !== 'undefined') {
          const SharedWorkerClass = globalThis.SharedWorker;
          globalThis.SharedWorker = class extends SharedWorkerClass {
            constructor(...args) { super(...args); globalThis.__docSharedWorkers++; }
          };
        }
      });
      const rejected = isolated ? null : page.waitForEvent('pageerror');
      const readerComplete = example.direct && isolated ? page.waitForEvent('console', {
        predicate: message => message.location().url.endsWith('/state.worker.js') && message.text() === 'Worker retained: 30',
      }) : null;
      // Observe the timeout even when an earlier assertion prevents awaiting it.
      readerComplete?.catch(() => {});
      await page.goto(`${origin}/${example.name}/${isolated ? 'isolated' : 'plain'}`);
      assert.equal(await page.evaluate(() => crossOriginIsolated), isolated);
      if (!isolated) {
        assert.equal((await rejected).message, 'Shared worker memory requires cross-origin isolation');
        assert.deepEqual(requests, [], `${example.name}: loaded runtime before the isolation check`);
        assert.equal(await page.evaluate(() => globalThis.__docWorkers + globalThis.__docSharedWorkers), 0);
      } else {
        await page.waitForFunction(() => globalThis.__docDone);
        if (readerComplete) {
          await readerComplete;
          assert.deepEqual(readerLogs, ['Worker initial: 30', 'Worker current: 50', 'Worker retained: 30']);
          assert.equal(await page.evaluate(() => globalThis.__docTaskFrames), 0,
            'Direct state reads must not use task messages');
        }
        assert.deepEqual(errors, [], `${example.name}: unexpected page errors`);
        assert.deepEqual(await page.evaluate(() => globalThis.__docLogs), example.expected);
        assert.equal(await page.evaluate(() => globalThis.__docWorkers), example.workers);
        assert.equal(await page.evaluate(() => globalThis.__docSharedWorkers), example.name === 'shared' ? 1 : 0);
        if (example.direct) await page.evaluate(() => globalThis.__docDispose());
      }
      await page.close();
    }

    for (const example of cases) {
      for (const isolated of [false, true]) {
        const context = await browser.newContext();
        try {
          await checkPage(context, example, isolated);
          console.log(`Passed: ${example.name} (${isolated ? 'browser execution' : 'isolation guard'}).`);
        } finally { await context.close(); }
      }
    }
    // Same context, URL and worker name. Each tab still supplies its own state.
    const context = await browser.newContext();
    try {
      const shared = cases.find(example => example.name === 'shared');
      await Promise.all([checkPage(context, shared, true), checkPage(context, shared, true)]);
      console.log('Passed: documented SharedWorker connections from two tabs.');
    } finally { await context.close(); }
    console.log(`Worker Markdown examples verified with Chromium ${browser.version()}.`);
  } finally {
    try { await browser?.close(); } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

try {
  checkDirectReadFraming();
  checkTypes();
  checkNode();
  if (!process.argv.includes('--node-only')) await checkBrowser();
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
