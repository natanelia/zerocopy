import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';
const results = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Spatial proof</title>'); }
    else if (/^\/dist\/[\w.-]+\.js$/.test(path)) { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(new URL(`..${path}`, import.meta.url))); }
    else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 500; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) for (const fallback of [false, true]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const result = await page.evaluate(async fallback => {
        if (!crossOriginIsolated) throw new Error('Expected isolation');
        if (fallback) WebAssembly.validate = () => false;
        const { SharedList, getWorkerData, initWorker } = await import('/dist/shared.js');
        const { countPointsInBox } = await import('/dist/numeric.js');
        let checks = 0;
        for (const size of [0, 1, 2, 15, 16, 17, 31, 32, 33, 513, 16385]) {
          const values = Array.from({ length: size * 2 }, (_, i) => i % 31 - 15);
          if (size) values[0] = NaN;
          if (size > 1) values[2] = Infinity;
          if (size > 2) values[5] = -Infinity;
          const points = new SharedList('number').pushMany(values);
          for (const minX of [-Infinity, -0, 2, Infinity, NaN]) for (const maxY of [-Infinity, 0, 12, Infinity, NaN]) {
            const box = { minX, minY: -10, maxX: 10, maxY };
            let expected = 0;
            for (let i = 0; i < values.length; i += 2) expected += Number(values[i] >= box.minX && values[i] <= box.maxX && values[i + 1] >= box.minY && values[i + 1] <= box.maxY);
            if (countPointsInBox(points, box) !== expected) throw new Error(`Mismatch: ${size}`);
            checks++;
          }
        }
        const old = new SharedList('number').pushMany(Array.from({ length: 34 }, () => 1));
        const attached = (await initWorker(getWorkerData({ old }, { copy: false }))).old;
        const next = old.pushMany(Array.from({ length: 32768 }, () => 1)).set(0, 99).set(1, 99);
        const box = { minX: 0, minY: 0, maxX: 2, maxY: 2 };
        if (countPointsInBox(old, box) !== 17 || countPointsInBox(attached, box) !== 17 || countPointsInBox(next, box) !== 16400) throw new Error('Snapshot mismatch');
        return { checks, fallback, attachment: 'same-realm read-only; not a browser Worker' };
      }, fallback);
      assert.deepEqual(errors, []);
      const row = { engine: name, version: browser.version(), ...result };
      results.push(row); console.log('SPATIAL-BROWSER', JSON.stringify(row));
    } finally { await browser.close(); }
  }
} finally {
  mkdirSync('proofs/results', { recursive: true });
  writeFileSync('proofs/results/spatial-browsers.json', JSON.stringify({ commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, results }, null, 2));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
