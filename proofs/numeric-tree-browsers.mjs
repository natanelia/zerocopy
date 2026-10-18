import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const roots = { baseline: resolve(process.env.BASE_DIR ?? '../zerocopy'), candidate: resolve(process.env.CANDIDATE_DIR ?? '.') };
const outFile = resolve(process.env.OUT_FILE ?? 'proofs/results/numeric-tree-20261017/browsers.json');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function gitHead(dir) {
  const entry = resolve(dir, '.git');
  const gitDir = statSync(entry).isDirectory() ? entry : resolve(dir, readFileSync(entry, 'utf8').trim().replace(/^gitdir: /, ''));
  const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  const ref = head.replace(/^ref: /, '');
  const commonDir = existsSync(resolve(gitDir, 'commondir')) ? resolve(gitDir, readFileSync(resolve(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
  for (const root of [gitDir, commonDir]) if (existsSync(resolve(root, ref))) return readFileSync(resolve(root, ref), 'utf8').trim();
  const packed = readFileSync(resolve(commonDir, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${ref}`));
  assert.ok(packed, `Cannot resolve Git HEAD at ${dir}`);
  return packed.split(' ')[0];
}
function sources() {
  return Object.fromEntries(Object.entries(roots).map(([label, dir]) => [label, {
    commit: gitHead(dir),
    files: Object.fromEntries(['numeric-kernels.as.ts', 'numeric-spatial.as.ts', 'numeric.ts', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm'].map(name => [name, hash(resolve(dir, name))])),
    dist: Object.fromEntries(readdirSync(resolve(dir, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => [name, hash(resolve(dir, 'dist', name))])),
  }]));
}
const source = sources();
const workerSource = `
const options = new URL(location.href).searchParams;
const label = options.get('variant');
const fallback = options.get('fallback') === '1';
const bounds = [[-Infinity, Infinity], [-0, 0], [-1000, 1000], [Infinity, Infinity]];
let list, countInRange, expected;
onmessage = async ({ data }) => {
  let phase = 'worker-import-existing';
  try {
    if (data.kind === 'init') {
      const { initWorker } = await import('/' + label + '/dist/shared.js');
      phase = 'worker-attach-existing';
      ({ original: list } = await initWorker(data.transport));
      expected = data.expected;
      phase = 'worker-read-existing';
      let all = 0; list.forEach(value => { all += Number(value >= -Infinity && value <= Infinity); });
      if (all !== expected[0]) throw new Error('Existing list scan failed');
      if (fallback) WebAssembly.validate = () => false;
      phase = 'worker-import-numeric';
      ({ countInRange } = await import('/' + label + '/dist/numeric.js'));
      phase = 'worker-write-guard';
      let blocked = false; try { list.push(1); } catch { blocked = true; }
      if (!blocked) throw new Error('Attached list accepted a write');
    }
    phase = 'worker-range-scan';
    for (let round = 0; round < 256; round++) for (let i = 0; i < bounds.length; i++) {
      if (countInRange(list, ...bounds[i]) !== expected[i]) throw new Error('Worker snapshot changed');
    }
    postMessage({ ok: true, kind: data.kind });
  } catch (error) { postMessage({ ok: false, phase, message: String(error), stack: error.stack }); }
};`;
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Numeric tree proof</title>'); return; }
    if (pathname === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(workerSource); return; }
    const module = pathname.match(/^\/(baseline|candidate)\/(dist\/[\w.-]+\.js|numeric-kernels(?:-simd)?\.wasm)$/);
    if (!module) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    response.end(readFileSync(resolve(roots[module[1]], module[2])));
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
async function pageRun(engine, operation, options) {
  // A fresh process prevents another page from consuming WebKit's memory
  // reservation budget and obscuring a baseline/candidate difference.
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.goto(origin);
    const result = await page.evaluate(operation, options);
    assert.deepEqual(errors, []);
    return { version: browser.version(), ...result };
  } finally { await browser.close(); }
}
async function kernelChecks({ label, fallback }) {
  if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required');
  if (fallback) WebAssembly.validate = () => false;
  const { SharedList, getWorkerData, initWorker } = await import(`/${label}/dist/shared.js`);
  const { countInRange } = await import(`/${label}/dist/numeric.js`);
  const bounds = [[-Infinity, Infinity], [-0, 0], [-1000, 1000], [1000, 1000], [Infinity, Infinity], [-Infinity, -Infinity], [-Number.MIN_VALUE, Number.MIN_VALUE], [NaN, 1000], [-1000, NaN], [10, -10]];
  const special = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE];
  const reference = (values, lo, hi) => values.reduce((n, value) => n + Number(value >= lo && value <= hi), 0);
  let checks = 0;
  const values = Array.from({ length: 32801 }, (_, i) => i % 31 === 0 ? special[Math.floor(i / 31) % special.length] : i % 2001 - 1000);
  const original = new SharedList('number').pushMany(values);
  const data = getWorkerData({ original }, { copy: false });
  const attached = (await initWorker(data)).original;
  const memory = data.arenas[0].memory, initialBytes = memory.buffer.byteLength;
  const changed = original.pushMany(Array.from({ length: 524288 }, () => 777)).set(0, 123456);
  if (memory.buffer.byteLength <= initialBytes) throw new Error('The owner did not grow memory');
  for (const [lo, hi] of bounds) {
    const expected = reference(values, lo, hi);
    if (countInRange(original, lo, hi) !== expected || countInRange(attached, lo, hi) !== expected) throw new Error('Attached snapshot changed after growth');
    checks += 2;
  }
  if (countInRange(changed, 123456, 123456) !== 1) throw new Error('Changed snapshot failed');
  checks++;
  for (const size of [0, 1, 2, 3, 15, 16, 17, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 1056, 1057, 32768, 32769, 32800, 32801, 1048609]) {
    const input = Array.from({ length: size }, (_, i) => i % 31 === 0 ? special[Math.floor(i / 31) % special.length] : i % 2001 - 1000);
    const list = new SharedList('number').pushMany(input);
    for (const [lo, hi] of bounds) {
      if (countInRange(list, lo, hi) !== reference(input, lo, hi)) throw new Error(`Range mismatch at ${size}/${lo}/${hi}`);
      checks++;
    }
  }
  const probe = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
  const simd = !fallback && WebAssembly.validate(probe);
  const bytes = await (await fetch(`/${label}/numeric-kernels${simd ? '-simd' : ''}.wasm`)).arrayBuffer();
  const endMemory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const kernel = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: endMemory } }).exports;
  const view = new DataView(endMemory.buffer);
  for (let size = 1; size <= 32; size++) {
    const tail = endMemory.buffer.byteLength - size * 8;
    for (let i = 0; i < size; i++) view.setFloat64(tail + i * 8, i, true);
    if (kernel.countInRange(0, 0, tail, size, -Infinity, Infinity) !== size) throw new Error(`Tail overread at ${size}`);
    checks++;
  }
  const root = 64, firstBranch = 256, lastBranch = 384, tail = 512;
  view.setUint32(root, firstBranch, true); view.setUint32(root + 4, lastBranch, true);
  view.setUint32(root + 8, 0xffffff00, true); view.setUint32(lastBranch + 4, 0xffffff00, true);
  const treeValues = [];
  for (let leaf = 0; leaf < 33; leaf++) {
    const pointer = leaf === 32 ? endMemory.buffer.byteLength - 256 : 1024 + leaf * 256;
    view.setUint32(leaf === 32 ? lastBranch : firstBranch + leaf * 4, pointer, true);
    for (let index = 0; index < 32; index++) {
      const value = special[(leaf * 32 + index) % special.length];
      treeValues.push(value); view.setFloat64(pointer + index * 8, value, true);
    }
  }
  for (let tailSize = 1; tailSize <= 32; tailSize++) {
    const value = special[(treeValues.length + tailSize - 1) % special.length];
    view.setFloat64(tail + (tailSize - 1) * 8, value, true);
    const visible = [...treeValues, ...Array.from({ length: tailSize }, (_, i) => view.getFloat64(tail + i * 8, true))];
    for (const [lo, hi] of bounds) {
      if (kernel.countInRange(root, 2, tail, visible.length, lo, hi) !== reference(visible, lo, hi)) throw new Error(`Tree boundary mismatch at ${tailSize}/${lo}/${hi}`);
      checks++;
    }
  }
  return { ok: true, label, fallback, simd, checks, growth: true };
}
async function workerChecks({ label, fallback }) {
  let phase = 'page-import-existing', worker;
  try {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required');
    const { SharedList, getWorkerData } = await import(`/${label}/dist/shared.js`);
    const special = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE];
    const values = Array.from({ length: 32801 }, (_, i) => i % 31 === 0 ? special[Math.floor(i / 31) % special.length] : i % 2001 - 1000);
    const original = new SharedList('number').pushMany(values);
    const bounds = [[-Infinity, Infinity], [-0, 0], [-1000, 1000], [Infinity, Infinity]];
    const expected = bounds.map(([lo, hi]) => values.reduce((n, value) => n + Number(value >= lo && value <= hi), 0));
    const transport = getWorkerData({ original }, { copy: false });
    const memory = transport.arenas[0].memory, initialBytes = memory.buffer.byteLength;
    phase = 'page-create-worker';
    worker = new Worker(`/worker.mjs?variant=${label}&fallback=${fallback ? 1 : 0}`, { type: 'module' });
    function ask(command) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Worker response timed out')); }, 15000);
        const message = event => {
          cleanup();
          if (event.data.ok) resolve(event.data);
          else reject(Object.assign(new Error(event.data.message), { phase: event.data.phase, details: event.data.stack }));
        };
        const error = event => { cleanup(); reject(new Error(event.message)); };
        function cleanup() { clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error); }
        worker.addEventListener('message', message); worker.addEventListener('error', error);
        try { worker.postMessage(command); } catch (error) { cleanup(); reject(error); }
      });
    }
    phase = 'page-send-snapshot';
    await ask({ kind: 'init', transport, expected });
    phase = 'page-grow-owner';
    const duringGrowth = ask({ kind: 'read' });
    const changed = original.pushMany(Array.from({ length: 524288 }, () => 777)).set(0, 123456);
    if (memory.buffer.byteLength <= initialBytes) throw new Error('The owner did not grow memory');
    await duringGrowth;
    await ask({ kind: 'read-after-growth' });
    if (fallback) WebAssembly.validate = () => false;
    phase = 'page-import-numeric';
    const { countInRange } = await import(`/${label}/dist/numeric.js`);
    for (let i = 0; i < bounds.length; i++) if (countInRange(original, ...bounds[i]) !== expected[i]) throw new Error('Page snapshot changed');
    if (countInRange(changed, 123456, 123456) !== 1) throw new Error('Changed owner snapshot failed');
    return { ok: true, label, fallback, growth: true, scans: 3 * 256 * bounds.length };
  } catch (error) { return { ok: false, label, fallback, phase: error.phase ?? phase, message: String(error), details: error.details ?? error.stack }; }
  finally { worker?.terminate(); }
}
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    for (const fallback of [false, true]) {
      for (const label of ['baseline', 'candidate']) {
        const result = await pageRun(engine, kernelChecks, { label, fallback });
        results.push({ engine: name, kind: 'kernel', ...result });
        console.log('NUMERIC-TREE-BROWSER', JSON.stringify({ engine: name, kind: 'kernel', ...result }));
      }
      const control = await pageRun(engine, workerChecks, { label: 'baseline', fallback });
      const candidate = await pageRun(engine, workerChecks, { label: 'candidate', fallback });
      results.push({ engine: name, kind: 'worker', ...control }, { engine: name, kind: 'worker', ...candidate });
      console.log('NUMERIC-TREE-BROWSER', JSON.stringify({ engine: name, kind: 'worker', control, candidate }));
      if (control.ok) assert.equal(candidate.ok, true, JSON.stringify(candidate));
      else {
        // This is an existing limit only when current main and the candidate
        // fail at the same import phase in fresh WebKit processes.
        assert.equal(name, 'webkit', JSON.stringify(control));
        assert.equal(control.phase, 'worker-import-existing', JSON.stringify(control));
        assert.match(control.message, /RangeError: Out of memory/);
        if (!candidate.ok) {
          assert.equal(candidate.phase, control.phase, JSON.stringify(candidate));
          assert.match(candidate.message, /RangeError: Out of memory/);
        }
      }
    }
  }
  assert.deepEqual(sources(), source, 'Sources changed during browser checks');
} finally {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), source, driver: hash(new URL(import.meta.url)), results, scope: 'Browser correctness; no browser performance claim.' }, null, 2) + '\n');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
