import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { chromium } from 'playwright';

const kind = process.argv[2], root = resolve(process.argv[3] ?? '.');
assert.ok(kind === 'map' || kind === 'list', 'Usage: node browser.mjs map|list PACKAGE_ROOT');
const workerSource = `import * as S from '/dist/shared.js';
let before, oracle, kind;
const check=(value, expected)=>{
 if(value.size!==expected.length) throw Error('Wrong collection size');
 if(kind==='list') expected.forEach((v,i)=>{if(!Object.is(value.get(i),v))throw Error('Wrong list value '+i)});
 else expected.forEach(([k,v])=>{if(!Object.is(value.get(k),v))throw Error('Wrong map value '+k)});
};
self.onmessage=async({data:m})=>{try{
 if(m.type==='initial') {kind=m.kind; before=(await S.initWorker(m.packet)).before; oracle=m.expected; check(before,oracle); postMessage({type:'ready'});}
 if(m.type==='concurrent') {
  const control=new Int32Array(m.control); let reads=0; postMessage({type:'reading'});
  const deadline=performance.now()+20000;
  while(reads<10000||!Atomics.load(control,0)){
   const i=reads%oracle.length;
   if(kind==='list'){if(!Object.is(before.get(i),oracle[i]))throw Error('Old list changed')}
   else if(!Object.is(before.get(oracle[i][0]),oracle[i][1]))throw Error('Old map changed');
   reads++; if(performance.now()>deadline)throw Error('Owner did not finish');
  }
  postMessage({type:'read',reads});
 }
 if(m.type==='updated'){
  const next=await S.initWorker(m.packet);check(before,oracle);
  for(const name of Object.keys(m.expected))check(next[name],m.expected[name]);
  let failed=false;try {if(kind==='list')next.after.setMany([[0,8]]);else next.after.deleteMany(Array(512).fill('missing'));}catch(e){failed=/read-only/.test(String(e))}
  if(!failed)throw Error('Attached writer was accepted');
  postMessage({type:'verified'});
 }
}catch(error){postMessage({error:String(error.stack||error)})}};`;
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Collection worker proof</title>'); }
    else if (path === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(workerSource); }
    else if (path.startsWith('/dist/') && /^[-\w]+\.js$/.test(basename(path))) {
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
  const result = await page.evaluate(async kind => {
    if (!crossOriginIsolated) throw Error('Expected cross-origin isolation');
    const S = await import('/dist/shared.js'), results = [];
    const all = value => kind === 'list' ? value.toArray() : [...value.entries()];
    const checkMap = (value, expected) => {
      if (value.size !== expected.size || !Object.isFrozen(value)) throw Error('Invalid Map result');
      for (const [key, item] of expected) if (!Object.is(value.get(key), item)) throw Error('Wrong Map value '+key);
    };
    for (const copy of [false, true]) {
      if (kind === 'list') S.resetSharedList(); else S.resetMap();
      const count = kind === 'list' ? 32801 : 8192;
      const input = Array.from({ length: count }, (_, i) => i + 0.5);
      input[0] = NaN; input[1] = -0; input[2] = Infinity; input[3] = -Infinity;
      const before = kind === 'list' ? new S.SharedList('number').pushMany(input)
        : new S.SharedMap('number').setMany(input.map((value, i) => [`key/${i}`, value]));
      const arena = S.getWorkerData({ before }, { copy: false }).arenas[0];
      const bytes = new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536).slice();
      const initialCapacity = arena.memory.buffer.byteLength, control = new SharedArrayBuffer(4);
      const worker = new Worker('/worker.mjs', { type: 'module' });
      const inbox = [], waiters = [];
      worker.onmessage = ({ data }) => { if (waiters.length) waiters.shift()(data); else inbox.push(data); };
      async function receive(type) {
        const value = inbox.length ? inbox.shift() : await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Worker timeout')), 30000);
          waiters.push(data => { clearTimeout(timer); resolve(data); });
        });
        if (value.error) throw Error(value.error);
        if (value.type !== type) throw Error('Unexpected worker reply '+value.type);
        return value;
      }
      try {
        worker.postMessage({ type: 'initial', kind, packet: S.getWorkerData({ before }, { copy }), expected: all(before) });
        await receive('ready');
        worker.postMessage({ type: 'concurrent', control }); await receive('reading');
        let after, fork, extra = {}, expectedAfter;
        if (kind === 'list') {
          const edits = Array.from({ length: 1024 }, (_, i) => [(Math.imul(i, 2654435761) >>> 0) % count, -i - 1]);
          after = before.setMany(edits); fork = before.setMany([[0, -44], [count - 1, -55]]);
          const expected = input.slice(); for (const [index, value] of edits) expected[index] = value;
          expected.forEach((value, i) => { if (!Object.is(after.get(i), value)) throw Error('Wrong batch edit'); });
          before.pushMany(Array(200000).fill(9));
        } else {
          after = before.deleteMany(Array.from({ length: 4096 }, (_, i) => `key/${i * 2}`));
          fork = before.deleteMany(Array.from({ length: 2048 }, (_, i) => `key/${i * 2 + 1}`));
          expectedAfter = new Map(input.flatMap((value, i) => i % 2 ? [[`key/${i}`, value]] : []));
          checkMap(after, expectedAfter);
          const requestShapes = {
            boundary511: Array.from({ length: 511 }, (_, i) => `key/${i}`),
            boundary512: Array.from({ length: 512 }, (_, i) => `key/${i}`),
            lateHits: Array.from({ length: 1000 }, (_, i) => i < 32 ? `missing/${i}` : `key/${i}`),
            sparseHits: Array.from({ length: 1000 }, (_, i) => i % 16 ? `missing/${i}` : `key/${i}`),
            densePrefixMisses: Array.from({ length: 1000 }, (_, i) => i < 32 ? `key/${i}` : `missing/${i}`),
          };
          const pairs = input.map((value, i) => [`key/${i}`, value]);
          for (const [name, keys] of Object.entries(requestShapes)) {
            const expected = new Map(pairs); for (const key of keys) expected.delete(key);
            const value = before.deleteMany(keys); extra[name] = value;
            if (value.size !== expected.size || !Object.isFrozen(value)) throw Error('Invalid result '+name);
            for (const [key, item] of expected) if (!Object.is(value.get(key), item)) throw Error('Wrong value '+name+'/'+key);
          }
          const forkExpected = new Map(pairs);
          for (let i = 0; i < 2048; i++) forkExpected.delete(`key/${i * 2 + 1}`);
          if (fork.size !== forkExpected.size) throw Error('Wrong fork size');
          for (const [key, item] of forkExpected) if (!Object.is(fork.get(key), item)) throw Error('Wrong fork value '+key);
          before.setMany(Array.from({ length: 24000 }, (_, i) => [`growth/${i}`, i]));
        }
        Atomics.store(new Int32Array(control), 0, 1);
        const read = await receive('read');
        if (arena.memory.buffer.byteLength <= initialCapacity) throw Error('Expected memory growth');
        const current = new Uint8Array(arena.memory.buffer, 65536, bytes.length);
        bytes.forEach((value, i) => { if (current[i] !== value) throw Error('Published bytes changed'); });
        const compacted = S.compact(after), structures = { before, after, fork, compacted, ...extra };
        const expected = Object.fromEntries(Object.entries(structures).map(([name, value]) => [name, all(value)]));
        if (kind === 'map') {
          checkMap(compacted, expectedAfter);
          expected.after = [...expectedAfter]; expected.compacted = [...expectedAfter];
        }
        worker.postMessage({ type: 'updated', packet: S.getWorkerData(structures, { copy }),
          expected });
        await receive('verified');
        results.push({ copy, reads: read.reads, initialCapacity, finalCapacity: arena.memory.buffer.byteLength,
          checkedSnapshots: Object.keys(structures) });
      } finally { Atomics.store(new Int32Array(control), 0, 1); worker.terminate(); }
    }
    return { passed: true, crossOriginIsolated, kind, results };
  }, kind);
  console.log(JSON.stringify({ ...result, browser: await browser.version() }, null, 2));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
