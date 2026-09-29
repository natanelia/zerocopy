import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';
const root = resolve('.');
const server = createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Geometry proof</title>'); return; }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, results = [];
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      const result = await page.evaluate(async () => {
        const { SharedList, getWorkerData, initWorker } = await import('/dist/shared.js');
        const { bboxXY } = await import('/dist/geometry.js');
        const { coordinates, bboxReference, exact } = await import('/proofs/geometry-fixtures.mjs');
        const memory = getWorkerData({ p: new SharedList('number') }, { copy: false }).arenas[0].memory;
        const module = new WebAssembly.Module(await (await fetch('/geometry-kernels.wasm')).arrayBuffer());
        const k = new WebAssembly.Instance(module, { env: { memory } }).exports;
        let checks = 0;
        for (let seed = 1; seed <= 1024; seed++) {
          const values = coordinates(seed, seed % 129, seed & 1 ? 'random' : 'road');
          if (seed % 5 === 0) for (let i = 0; i < values.length; i++) values[i] = i % 3 ? 0 : -0;
          if (seed % 7 === 0) for (let i = 0; i < values.length; i += 5) values[i] = NaN;
          const p = new SharedList('number').pushMany(values), expected = bboxReference(values);
          exact(bboxXY(p), expected, `public seed=${seed}`);
          k.bboxXY(p.root, p.depth, p.tail, p.size);
          exact([k.bboxMinX(), k.bboxMinY(), k.bboxMaxX(), k.bboxMaxY()], expected, `kernel seed=${seed}`);
          checks += 2;
        }
        const old = new SharedList('number').pushMany([0,0,2,3]);
        const attached = await initWorker(getWorkerData({ old }, { copy: false }));
        old.pushMany(coordinates(31, 32768)).set(0, -99);
        exact(bboxXY(attached.old), [0,0,2,3], 'read-only retained snapshot');
        return { checks, isolated: crossOriginIsolated, attachment: 'same-realm read-only snapshot; not a browser Worker' };
      });
      const record = { engine, version: browser.version(), ...result };
      results.push(record); console.log('GEOMETRY BROWSER', JSON.stringify(record));
    } finally { await browser.close(); }
  }
} finally {
  server.close(); mkdirSync('proofs/results', { recursive: true });
  writeFileSync('proofs/results/geometry-browsers.json', JSON.stringify(results, null, 2));
}
