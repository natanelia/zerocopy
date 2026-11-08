import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';

// Untimed portable-bundle checks in a real, cross-origin-isolated Chromium page.
// Usage: node browser.mjs PACKAGE_ROOT > browser.json
const root = resolve(process.argv[2] ?? '.');
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = () => Object.fromEntries(['arena.ts', 'persistent-core.wasm', 'dist/shared.js']
  .map(name => [name, hash(readFileSync(join(root, name)))]));
const sources = identity();
const workerSource = `import * as S from '/dist/shared.js';
let before, expected, iterator, first, arena, bytes;
const check=(list, values)=>{
 if(list.size!==values.length||!Object.isFrozen(list))throw Error('Wrong frozen List size');
 const actual=list.toArray();
 if(actual.length!==values.length)throw Error('Wrong array size');
 for(let i=0;i<values.length;i++)if(actual[i]!==values[i]||list.get(i)!==values[i])throw Error('Wrong boolean at '+i);
};
const unchanged=()=>{
 const now=new Uint8Array(arena.memory.buffer,65536,bytes.length);
 for(let i=0;i<bytes.length;i++)if(now[i]!==bytes[i])throw Error('Published reader bytes changed');
};
self.onmessage=async({data:m})=>{try{
 if(m.type==='initial'){
  before=(await S.initWorker(m.packet)).before;expected=m.expected;check(before,expected);
  arena=S.getWorkerData({before},{copy:false}).arenas[0];
  bytes=new Uint8Array(arena.memory.buffer,65536,arena.used-65536).slice();
  iterator=before.values();first=iterator.next().value;postMessage({type:'ready'});
 }
 if(m.type==='concurrent'){
  const control=new Int32Array(m.control),deadline=performance.now()+20000;let reads=0;
  postMessage({type:'reading'});
  while(reads<10000||!Atomics.load(control,0)){
   const i=reads%expected.length;if(before.get(i)!==expected[i])throw Error('Retained reader changed');
   reads++;if(performance.now()>deadline)throw Error('Writer did not finish');
  }
  const values=[first,...iterator];
  if(values.length!==expected.length)throw Error('Wrong resumed iterator size');
  for(let i=0;i<values.length;i++)if(values[i]!==expected[i])throw Error('Paused iterator changed');
  check(before,expected);unchanged();postMessage({type:'read',reads,pausedIteratorVerified:true});
 }
 if(m.type==='updated'){
  const lists=await S.initWorker(m.packet);check(before,expected);
  for(const [name,list] of Object.entries(lists))check(list,m.expected[name]);
  let rejected=false;try{lists.after.pushMany(Array(32768).fill(true));}catch(e){rejected=/read-only/.test(String(e));}
  if(!rejected)throw Error('Reader accepted append');
  unchanged();postMessage({type:'verified',readOnlyRejected:true,completeOutputsVerified:true});
 }
}catch(error){postMessage({error:String(error.stack||error)});}};`;
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Boolean List worker checks</title>');
    } else if (path === '/worker.mjs') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(workerSource);
    } else if (path.startsWith('/dist/') && /^[-\w]+\.js$/.test(basename(path))) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(readFileSync(join(root, 'dist', basename(path))));
    } else { response.statusCode = 404; response.end('Not found'); }
  } catch { response.statusCode = 500; response.end('Module unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw Error('Cross-origin isolation required');
    const S = await import('/dist/shared.js');
    const flags = count => Array.from({ length: count }, (_, i) => i % 3 === 0 || i % 7 === 2);
    const check = (list, expected) => {
      if (list.size !== expected.length || !Object.isFrozen(list)) throw Error('Wrong frozen List size');
      const actual = list.toArray();
      if (actual.length !== expected.length) throw Error('Wrong array size');
      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i] || list.get(i) !== expected[i]) throw Error('Wrong boolean at ' + i);
      }
    };
    const appendCounts = [256, 1024, 32767, 32768, 32769, 262144];
    for (const count of appendCounts) {
      S.resetSharedList();
      const prefix = flags(65), input = flags(count), before = new S.SharedList('boolean').pushMany(prefix);
      check(before.pushMany(input), [...prefix, ...input]); check(before, prefix);
    }
    const results = [];
    for (const copy of [false, true]) {
      S.resetSharedList();
      const original = flags(32833), before = new S.SharedList('boolean').pushMany(original);
      const arena = S.getWorkerData({ before }, { copy: false }).arenas[0];
      const bytes = new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536).slice();
      const initialCapacity = arena.memory.buffer.byteLength, control = new SharedArrayBuffer(4);
      const worker = new Worker('/worker.mjs', { type: 'module' }), inbox = [], waiters = [];
      const deliver = data => { if (waiters.length) waiters.shift()(data); else inbox.push(data); };
      worker.onmessage = ({ data }) => deliver(data);
      worker.onerror = event => deliver({ error: event.message });
      async function receive(type) {
        const message = inbox.length ? inbox.shift() : await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Worker timeout')), 30000);
          waiters.push(data => { clearTimeout(timer); resolve(data); });
        });
        if (message.error) throw Error(message.error);
        if (message.type !== type) throw Error('Unexpected worker reply: ' + message.type);
        return message;
      }
      try {
        worker.postMessage({ type: 'initial', packet: S.getWorkerData({ before }, { copy }), expected: original });
        await receive('ready');
        worker.postMessage({ type: 'concurrent', control }); await receive('reading');
        const input = flags(32768), other = flags(1024).map(value => !value);
        const after = before.pushMany(input), fork = before.pushMany(other), grown = before.pushMany(flags(262144));
        check(after, [...original, ...input]); check(fork, [...original, ...other]);
        check(grown, [...original, ...flags(262144)]); check(before, original);
        Atomics.store(new Int32Array(control), 0, 1);
        const read = await receive('read');
        if (arena.memory.buffer.byteLength <= initialCapacity) throw Error('Expected shared memory growth');
        const current = new Uint8Array(arena.memory.buffer, 65536, bytes.length);
        for (let i = 0; i < bytes.length; i++) if (current[i] !== bytes[i]) throw Error('Published writer bytes changed');
        const compacted = S.compact(after), expected = {
          before: original, after: [...original, ...input], fork: [...original, ...other], compacted: [...original, ...input],
        };
        check(compacted, expected.compacted);
        worker.postMessage({ type: 'updated', packet: S.getWorkerData({ before, after, fork, compacted }, { copy }), expected });
        const verified = await receive('verified');
        results.push({ copy, reads: read.reads, pausedIteratorVerified: read.pausedIteratorVerified,
          readOnlyRejected: verified.readOnlyRejected, completeOutputsVerified: verified.completeOutputsVerified,
          publishedBytesPreserved: true, initialCapacity, finalCapacity: arena.memory.buffer.byteLength });
      } finally { Atomics.store(new Int32Array(control), 0, 1); worker.terminate(); }
    }
    return { passed: true, timingMeasurements: false, crossOriginIsolated, appendCounts, results };
  });
  assert.deepEqual(errors, []); assert.deepEqual(identity(), sources);
  console.log(JSON.stringify({ ...result, browser: browser.version(), sources }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
