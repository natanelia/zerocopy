import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

// Import the existing transport first. Check its scalar read before loading
// numeric code, so allocation or transport failures have an exact phase.
const workerSource = `let list;
onmessage = async ({ data }) => {
  let phase = 'import-existing-transport';
  try {
    if (data.__shared) {
      const { initWorker } = await import('/dist/shared.js');
      phase = 'attach-existing-snapshot';
      ({ list } = await initWorker(data)); postMessage('ready');
    } else if (data === 'baseline') {
      phase = 'existing-forEach'; let count = 0;
      list.forEach(value => { count += Number(value >= -Infinity && value <= Infinity); });
      postMessage(count);
    } else {
      phase = 'import-numeric';
      const { countInRange } = await import('/dist/numeric.js');
      phase = 'execute-numeric'; postMessage(countInRange(list, -Infinity, Infinity));
    }
  } catch (error) { postMessage({ error: phase + ': ' + String(error) + '\\n' + error.stack }); }
};`;
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Numeric proof</title>'); }
    else if (path === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(workerSource); }
    else if (/^\/dist\/[\w.-]+\.js$/.test(path)) { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(new URL(`..${path}`, import.meta.url))); }
    else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 500; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch();
    try {
      for (const fallback of [false, true]) {
        const page = await browser.newPage();
        const errors = []; page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => console.log('BROWSER-STAGE', name, fallback, message.text()));
        await page.goto(origin);
        const result = await page.evaluate(async fallback => {
          if (!crossOriginIsolated) throw new Error('Expected cross-origin isolation');
          if (fallback) WebAssembly.validate = () => false;
          const { SharedList, getWorkerData } = await import('/dist/shared.js');
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
          console.log('main-thread kernel checks passed', checks);
          let list = new SharedList('number').pushMany(Array.from({ length: 33 }, () => 1));
          const old = list, data = getWorkerData({ list }, { copy: false });
          const worker = new Worker('/worker.mjs', { type: 'module' });
          function receive() {
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => { cleanup(); reject(new Error('Worker timeout')); }, 15000);
              const message = event => { cleanup(); event.data?.error ? reject(new Error(event.data.error)) : resolve(event.data); };
              const error = event => { cleanup(); reject(new Error(event.message)); };
              function cleanup() { clearTimeout(timeout); worker.removeEventListener('message', message); worker.removeEventListener('error', error); }
              worker.addEventListener('message', message); worker.addEventListener('error', error);
            });
          }
          async function ask(command) { const response = receive(); worker.postMessage(command); return response; }
          try {
            if (await ask(data) !== 'ready') throw new Error('Worker did not attach');
            console.log('existing worker snapshot attached');
            if (await ask('baseline') !== 33) throw new Error('Existing worker forEach failed');
            console.log('existing worker forEach passed');
            if (await ask('numeric') !== 33) throw new Error('Worker numeric read failed');
            const response = ask('numeric');
            list = list.pushMany(Array.from({ length: 32768 }, () => 1)).set(0, 99);
            if (await response !== 33 || countInRange(old, 0, 2) !== 33 || countInRange(list, 99, 99) !== 1) throw new Error('Snapshot isolation failure');
            if (await ask('numeric') !== 33) throw new Error('Worker snapshot changed after growth');
          } finally { worker.terminate(); }
          return { checks, fallback, isolated: crossOriginIsolated };
        }, fallback);
        assert.deepEqual(errors, []);
        console.log('BROWSER', JSON.stringify({ engine: name, version: browser.version(), ...result }));
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
