import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Usage: node browser.mjs PACKAGE_ROOT. No timings are collected.
const root = resolve(process.argv[2] ?? '.'), folder = dirname(fileURLToPath(import.meta.url));
const workerSource = `
import * as S from '/dist/shared.js';
import {makeFixture,checkMap,checkReads,checkReadonly,readState,checkReadState} from '/read-fixtures.mjs';
let retained,fixture,saved;
self.onmessage=async({data:m})=>{try{
 if(m.type==='initial'){
  fixture=makeFixture(m.valueType); retained=(await S.initWorker(m.packet)).before;
  saved=readState(S,retained);
  checkMap(retained,fixture.models.before,fixture.queries);
  checkReadonly(retained,fixture.readonlyValue);checkReadState(S,retained,saved);
  postMessage({type:'ready'});
 }else if(m.type==='concurrent'){
  const control=new Int32Array(m.control),deadline=performance.now()+20000;
  let reads=0;postMessage({type:'reading'});
  while(reads<12288||!Atomics.load(control,0)){
   reads+=checkReads(retained,fixture.concurrentKeys,fixture.models.before);
   if(performance.now()>deadline)throw Error('Owner did not finish mutations');
  }
  postMessage({type:'read',reads});
 }else if(m.type==='updated'){
  const attached=await S.initWorker(m.packet);
  checkMap(retained,fixture.models.before,fixture.queries);checkReadState(S,retained,saved);
  for(const [name,model]of Object.entries(fixture.models)){
   const state=readState(S,attached[name]);
   checkMap(attached[name],model,fixture.queries);checkReadonly(attached[name],fixture.readonlyValue);
   checkReadState(S,attached[name],state);
  }
  for(let i=0;i<4;i++)for(const name of ['before','after','fork','compacted']){
   checkReads(attached[name],fixture.concurrentKeys,fixture.models[name]);
  }
  postMessage({type:'verified'});
 }
}catch(error){postMessage({error:String(error.stack||error)})}};`;
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Map read worker proof</title>');
    } else if (path === '/worker.mjs') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(workerSource);
    } else if (path === '/read-fixtures.mjs') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(resolve(folder, 'read-fixtures.mjs')));
    } else if (path.startsWith('/dist/') && /^[-\w]+\.js$/.test(basename(path))) {
      response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(resolve(root, 'dist', basename(path))));
    } else { response.statusCode = 404; response.end('Not found'); }
  } catch { response.statusCode = 500; response.end('Could not load module'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw Error('Expected cross-origin isolation');
    const S = await import('/dist/shared.js');
    const { types, makeFixture, checkMap, checkBytes, readState, checkReadState } = await import('/read-fixtures.mjs');
    const results = [];
    for (const copy of [false, true]) for (const valueType of types) {
      S.resetMap();
      const fixture = makeFixture(valueType), before = new S.SharedMap(valueType).setMany(fixture.entries);
      const saved = readState(S, before), initialCapacity = saved.arena.memory.buffer.byteLength;
      checkMap(before, fixture.models.before, fixture.queries); checkReadState(S, before, saved);
      const control = new SharedArrayBuffer(4), worker = new Worker('/worker.mjs', { type: 'module' });
      const inbox = [], waiters = [];
      const deliver = data => { if (waiters.length) waiters.shift()(data); else inbox.push(data); };
      worker.onmessage = ({ data }) => deliver(data);
      worker.onerror = event => deliver({ error: event.message || 'Browser worker error' });
      worker.onmessageerror = () => deliver({ error: 'Browser worker message could not be decoded' });
      async function receive(type) {
        const value = inbox.length ? inbox.shift() : await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Worker timeout')), 30000);
          waiters.push(data => { clearTimeout(timer); resolve(data); });
        });
        if (value.error) throw Error(value.error);
        if (value.type !== type) throw Error('Unexpected worker reply ' + value.type);
        return value;
      }
      try {
        worker.postMessage({ type: 'initial', valueType, packet: S.getWorkerData({ before }, { copy }) });
        await receive('ready');
        worker.postMessage({ type: 'concurrent', control }); await receive('reading');
        const after = before.setMany(fixture.afterWrites).delete(fixture.deleteAfter);
        const fork = before.setMany(fixture.forkWrites).delete(fixture.deleteFork);
        before.setMany(fixture.growth());
        Atomics.store(new Int32Array(control), 0, 1);
        const read = await receive('read');
        if (saved.arena.memory.buffer.byteLength <= initialCapacity) throw Error('Expected owner memory growth');
        checkBytes(saved.arena.memory, saved.bytes);
        const compacted = S.compact(after), structures = { before, after, fork, compacted };
        for (const [name, map] of Object.entries(structures)) checkMap(map, fixture.models[name], fixture.queries);
        worker.postMessage({ type: 'updated', packet: S.getWorkerData(structures, { copy }) });
        await receive('verified');
        results.push({ copy, valueType, reads: read.reads, sourceCount: before.size, resultCount: after.size,
          initialCapacity, finalCapacity: saved.arena.memory.buffer.byteLength, retainedBytesUnchanged: true,
          readerAllocationsUnchanged: true, oldMissAndNewPresenceVerified: true,
          checkedSnapshots: Object.keys(structures) });
      } finally { Atomics.store(new Int32Array(control), 0, 1); worker.terminate(); }
    }
    return { passed: true, crossOriginIsolated, operations: ['getMany', 'get', 'has'],
      independentInputOracles: true, results };
  });
  console.log(JSON.stringify({ ...result, browser: await browser.version() }, null, 2));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
