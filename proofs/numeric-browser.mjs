import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

const baseline = '75e3626ccc6400d1ae195aefdd3526906622009e';
const results = [];
// No numeric import happens until the existing transport has attached and read.
const workerSource = `const options = new URL(location.href).searchParams;
const prefix = options.get('base') === '1' ? '/baseline/dist' : '/dist';
let list;
onmessage = async ({ data }) => {
  let phase = 'worker-import-existing';
  try {
    if (data.__shared) {
      const { initWorker } = await import(prefix + '/shared.js');
      phase = 'worker-attach-existing';
      ({ list } = await initWorker(data)); postMessage('ready');
    } else if (data === 'baseline') {
      phase = 'worker-existing-forEach'; let count = 0;
      list.forEach(value => { count += Number(value >= -Infinity && value <= Infinity); });
      postMessage(count);
    } else {
      if (options.get('scalar') === '1') WebAssembly.validate = () => false;
      phase = 'worker-import-numeric';
      const { countInRange } = await import('/dist/numeric.js');
      phase = 'worker-execute-numeric'; postMessage(countInRange(list, -Infinity, Infinity));
    }
  } catch (error) { postMessage({ failure: { phase, message: String(error), stack: error.stack } }); }
};`;
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Numeric proof</title>'); }
    else if (path === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(workerSource); }
    else if (/^\/(baseline\/)?dist\/[\w.-]+\.js$/.test(path)) {
      const relative = path.startsWith('/baseline/') ? `../.numeric-baseline/${path.slice('/baseline/'.length)}` : `..${path}`;
      response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(new URL(relative, import.meta.url)));
    } else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 500; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function pageRun(engine, operation, options) {
  // Use a fresh process for each case. Other pages cannot consume its Wasm
  // reservation budget and hide a baseline-versus-candidate difference.
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
async function kernelChecks(fallback) {
  if (!crossOriginIsolated) throw new Error('Expected cross-origin isolation');
  if (fallback) WebAssembly.validate = () => false;
  const { SharedList } = await import('/dist/shared.js');
  const { countInRange } = await import('/dist/numeric.js');
  let checks = 0;
  for (const size of [0, 1, 2, 3, 15, 16, 17, 31, 32, 33, 63, 65, 1025, 32769]) {
    const values = Array.from({ length: size }, (_, i) => i % 13 - 6);
    if (size) values[0] = NaN;
    if (size > 1) values[1] = Infinity;
    if (size > 2) values[2] = -Infinity;
    const list = new SharedList('number').pushMany(values);
    for (const lo of [-Infinity, -0, 2, Infinity, NaN]) for (const hi of [-Infinity, 0, 4, Infinity, NaN]) {
      const expected = values.reduce((sum, value) => sum + Number(value >= lo && value <= hi), 0);
      if (countInRange(list, lo, hi) !== expected) throw new Error(`Mismatch at size ${size}`);
      checks++;
    }
  }
  return { checks, fallback, isolated: crossOriginIsolated };
}
async function transportChecks({ original, fallback }) {
  let phase = 'page-import-existing', worker;
  try {
    if (!crossOriginIsolated) throw new Error('Expected cross-origin isolation');
    const prefix = original ? '/baseline/dist' : '/dist';
    const { SharedList, getWorkerData } = await import(prefix + '/shared.js');
    phase = 'page-create-snapshot';
    let list = new SharedList('number').pushMany(Array.from({ length: 33 }, () => 1));
    const old = list, data = getWorkerData({ list }, { copy: false });
    worker = new Worker(`/worker.mjs?base=${original ? 1 : 0}&scalar=${fallback ? 1 : 0}`, { type: 'module' });
    async function ask(command) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Worker timeout')); }, 15000);
        const message = event => {
          cleanup();
          if (event.data?.failure) reject(Object.assign(new Error(event.data.failure.message), { phase: event.data.failure.phase, details: event.data.failure.stack }));
          else resolve(event.data);
        };
        const error = event => { cleanup(); reject(new Error(event.message)); };
        function cleanup() { clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error); }
        worker.addEventListener('message', message); worker.addEventListener('error', error);
        try { worker.postMessage(command); } catch (error) { cleanup(); reject(error); }
      });
    }
    phase = 'page-send-snapshot';
    if (await ask(data) !== 'ready') throw new Error('Worker did not attach');
    if (await ask('baseline') !== 33) throw new Error('Existing worker forEach failed');
    let countInRange;
    if (!original) {
      phase = 'page-import-numeric';
      if (fallback) WebAssembly.validate = () => false;
      ({ countInRange } = await import('/dist/numeric.js'));
      if (await ask('numeric') !== 33) throw new Error('Worker numeric read failed');
    }
    phase = 'snapshot-isolation';
    const reading = ask(original ? 'baseline' : 'numeric');
    list = list.pushMany(Array.from({ length: 32768 }, () => 1)).set(0, 99);
    if (await reading !== 33 || await ask(original ? 'baseline' : 'numeric') !== 33) throw new Error('Worker snapshot changed after growth');
    if (!original && (countInRange(old, 0, 2) !== 33 || countInRange(list, 99, 99) !== 1)) throw new Error('Page snapshot changed');
    return { ok: true, original, fallback };
  } catch (error) {
    return { ok: false, original, fallback, phase: error.phase ?? phase, message: String(error), details: error.details ?? error.stack };
  } finally { worker?.terminate(); }
}
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    for (const fallback of [false, true]) {
      const result = await pageRun(engine, kernelChecks, fallback);
      results.push({ engine: name, kind: 'kernel', ...result });
      console.log('BROWSER-KERNEL', JSON.stringify({ engine: name, ...result }));
    }
    const control = await pageRun(engine, transportChecks, { original: true, fallback: false });
    console.log('BROWSER-TRANSPORT-BASELINE', JSON.stringify({ engine: name, baseline, ...control }));
    results.push({ engine: name, kind: 'baseline-transport', baseline, ...control });
    for (const fallback of [false, true]) {
      const candidate = await pageRun(engine, transportChecks, { original: false, fallback });
      results.push({ engine: name, kind: 'candidate-transport', ...candidate });
      console.log('BROWSER-TRANSPORT-CANDIDATE', JSON.stringify({ engine: name, ...candidate }));
      if (control.ok) assert.equal(candidate.ok, true, JSON.stringify(candidate));
      else {
        // This is not a worker pass. Only the exact existing allocation failure
        // reproduced on pinned main is a baseline-limited transport result.
        assert.equal(name, 'webkit', JSON.stringify(control));
        assert.equal(control.phase, 'worker-import-existing', JSON.stringify(control));
        assert.match(control.message, /RangeError: Out of memory/);
        if (!candidate.ok) {
          assert.equal(candidate.phase, control.phase, JSON.stringify(candidate));
          assert.match(candidate.message, /RangeError: Out of memory/);
          console.log('BROWSER-BASELINE-LIMITATION', JSON.stringify({ engine: name, fallback, baseline, phase: control.phase, message: control.message }));
        }
      }
    }
  }
} finally {
  mkdirSync('proofs/results', { recursive: true });
  writeFileSync('proofs/results/numeric-browsers.json', JSON.stringify({ baseline, commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, results }, null, 2));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
