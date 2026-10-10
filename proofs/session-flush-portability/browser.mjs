import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { readInputs, hash, log, containment, emit, finish } from './subject.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
const probe = process.argv[2] === 'probe';
const input = probe ? null : readInputs(process.argv.slice(2));
const runtime = probe ? process.argv[3] : input.identity.runtime;
assert(['chromium','firefox','webkit'].includes(runtime));
const launcher = { chromium, firefox, webkit }[runtime];
const expectedBrowser = input?.runtimeManifest.browsers[runtime];
const allowed = new Map();
allowed.set('/workload.mjs', readFileSync(resolve(ROOT, 'workload.mjs')));
if (input) for (const row of JSON.parse(readFileSync(resolve(ROOT,'INPUT-PINS.json'))).files) {
  if (row.path.startsWith(`arms/${input.identity.arm}/dist/`)) allowed.set('/' + row.path, readFileSync(resolve(ROOT,row.path)));
}
const served = new Map();
const server = createServer((req,res) => {
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cache-Control','no-store');
  if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Session flush screen</title>'); return; }
  const bytes = allowed.get(req.url);
  if (!bytes) { res.writeHead(404); res.end(); return; }
  served.set(req.url, hash(bytes)); res.setHeader('Content-Type','application/javascript'); res.end(bytes);
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browserServer, browser;
try {
  if (input) await log({ event:'subject-start', ...input.identity, ...input.references });
  // launchServer exposes the owned process PID through Playwright's public API.
  const launchOptions = { headless:true, timeout:15000, ...(runtime === 'chromium' ? { channel:'chromium' } : {}) };
  browserServer = await launcher.launchServer(launchOptions);
  browser = await launcher.connect(browserServer.wsEndpoint());
  if (expectedBrowser) assert.equal(browser.version(), expectedBrowser.version);
  await containment([process.pid,browserServer.process().pid]);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil:'load',timeout:10000 });
  const capabilities = await page.evaluate(() => {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Shared memory or isolation unavailable');
    const memory = new WebAssembly.Memory({initial:1,maximum:2,shared:true});
    if (!(memory.buffer instanceof SharedArrayBuffer)) throw new Error('WASM shared memory unavailable');
    let previous = performance.now(), minimum = Infinity, observations = 0;
    for (let i=0;i<10000;i++) { const current=performance.now(); if(current>previous) { minimum=Math.min(minimum,current-previous); observations++; } previous=current; }
    if(!observations) throw new Error('Unable to observe timer resolution');
    return {crossOriginIsolated:true,sharedMemory:true,timerResolutionMs:minimum,timerResolutionObservations:observations,userAgent:navigator.userAgent};
  });
  if (probe) {
    const record = { runtime,version:browser.version(),configuredExecutable:launcher.executablePath(),launchOptions,
      browserRootPID:browserServer.process().pid,capabilities,playwrightVersion:JSON.parse(readFileSync(resolve(ROOT,'node_modules/playwright/package.json'))).version };
    writeFileSync(process.argv[4], JSON.stringify(record,null,2)+'\n',{flag:'wx'});
    await log({event:'probe',...record});
  } else {
    // Page-to-controller calls occur only before/after the page-local timed region.
    await page.exposeFunction('screenEmit', emit);
    const result = await page.evaluate(async ({item,protocol,identity,counts}) => {
      const {runWorkload}=await import('/workload.mjs');
      return runWorkload({item,protocol,identity,counts,
        sharedURL:`/arms/${identity.arm}/dist/shared.js`,workerURL:`/arms/${identity.arm}/dist/worker.js`,
        emit:row=>globalThis.screenEmit(row),now:()=>performance.now()*1e6});
    }, {item:input.item,protocol:input.protocol,identity:input.identity,counts:input.counts});
    assert.deepEqual(pageErrors,[]);
    assert(served.has(`/arms/${input.identity.arm}/dist/shared.js`) && served.has(`/arms/${input.identity.arm}/dist/worker.js`));
    await context.close(); await browser.close(); browser=null; await browserServer.close(); browserServer=null;
    await finish(input,{...result,browser:{version:expectedBrowser.version,capabilities,servedSHA256:Object.fromEntries(served)}});
  }
} finally {
  if(browser) await browser.close();
  if(browserServer) await browserServer.close();
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
