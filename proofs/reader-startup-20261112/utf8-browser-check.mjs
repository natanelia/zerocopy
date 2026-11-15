// bun build utf8.ts --target browser --format esm --outfile /tmp/utf8.mjs
// CHROMIUM_EXECUTABLE=/path/to/chromium node utf8-browser-check.mjs /tmp/utf8.mjs OUTPUT.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [modulePath, outputPath] = process.argv.slice(2);
assert.ok(modulePath && outputPath, 'Expected compiled UTF-8 module and output JSON paths');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = hash(readFileSync(join(root, 'utf8.ts'))), moduleBytes = readFileSync(modulePath);
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>UTF-8 correctness</title>'); return; }
  response.setHeader('Content-Type', 'text/javascript');
  if (path === '/utf8.mjs') { response.end(moduleBytes); return; }
  if (/^\/dist\/[\w.-]+\.js$/.test(path)) { response.end(readFileSync(join(root, path))); return; }
  response.writeHead(404).end();
});
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const checks = [], check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
    const { decodeUtf8 } = await import('/utf8.mjs'), encoder = new TextEncoder(), native = TextDecoder.prototype.decode;
    const shared = bytes => { const storage = new SharedArrayBuffer(bytes.length + 11), view = new Uint8Array(storage, 5, bytes.length); view.set(bytes); return view; };
    let acceptsShared = true; try { new TextDecoder().decode(shared(Uint8Array.of(65))); } catch { acceptsShared = false; }
    check(crossOriginIsolated && !acceptsShared, 'actual browser shared-view rejection');
    for (const text of ['', '\ufeff界🙂\0', '\ud800', 'x'.repeat(65536), '界'.repeat(22000)]) {
      const bytes = encoder.encode(text);
      for (const ignoreBOM of [false, true]) check(decodeUtf8(new TextDecoder('utf-8', { ignoreBOM }), shared(bytes))
        === new TextDecoder('utf-8', { ignoreBOM }).decode(bytes), `native decoding ${bytes.length}/${ignoreBOM}`);
    }
    const fatal = new TextDecoder('utf-8', { fatal: true }); let rejected = false;
    try { decodeUtf8(fatal, shared(Uint8Array.of(0xff))); } catch { rejected = true; }
    check(rejected && decodeUtf8(fatal, shared(encoder.encode('after'))) === 'after', 'fatal decode releases storage');
    for (const text of ['outer界', 'outer界'.repeat(12000)]) {
      const outer = shared(encoder.encode(text)), inner = shared(encoder.encode('inner🙂'));
      const decoder = new TextDecoder(), nested = new TextDecoder(); let getters = 0;
      Object.defineProperty(nested, 'decode', { get() { inner.fill(0x78); return native; } });
      Object.defineProperty(decoder, 'decode', { get() {
        getters++; check(decodeUtf8(nested, inner) === 'inner🙂', 'nested copy before getter'); outer.fill(0x78); return native;
      } });
      check(decodeUtf8(decoder, outer) === text && getters === 1, `outer copy before getter ${text.length}`);
    }
    const retained = [], custom = new TextDecoder();
    Object.defineProperty(custom, 'decode', { value(input) { check(this === custom, 'custom decoder receiver'); retained.push(input); return Reflect.apply(native, this, [input]); } });
    check(decodeUtf8(custom, shared(encoder.encode('retained🙂'))) === 'retained🙂', 'custom decode');
    decodeUtf8(new TextDecoder(), shared(encoder.encode('overwrite scratch')));
    check(new TextDecoder().decode(retained[0]) === 'retained🙂', 'custom input remains independent');
    const api = await import('/dist/shared.js');
    for (const type of ['object', 'string']) {
      const values = ['\ufeff界🙂', 'short', 'x'.repeat(65537)].map(text => type === 'object' ? { text, nested: [1, null] } : text);
      const map = new api.SharedMap(type).setMany(values.map((value, index) => [String(index), value]));
      const list = new api.SharedList(type).pushMany(values);
      for (const copy of [false, true]) {
        const attached = await api.initWorker(api.getWorkerData({ map, list }, { copy }));
        for (let index = 0; index < values.length; index++) {
          const fromMap = attached.map.get(String(index)), fromList = attached.list.get(index);
          check(JSON.stringify(fromMap) === JSON.stringify(values[index]) && JSON.stringify(fromList) === JSON.stringify(values[index]), `collection values ${type}/${copy}/${index}`);
          if (type === 'object') check(Object.isFrozen(fromMap.nested) && Object.isFrozen(fromList.nested), `deep freezing ${copy}/${index}`);
        }
      }
    }
    return { userAgent: navigator.userAgent, crossOriginIsolated, acceptsShared, checks };
  });
  assert.equal(hash(readFileSync(join(root, 'utf8.ts'))), sourceHash);
  writeFileSync(outputPath, JSON.stringify({ sourceHash, moduleHash: hash(moduleBytes), browser: browser.version(), verified: true, ...result }, null, 2) + '\n');
  console.log(JSON.stringify({ verified: true, browser: browser.version(), checks: result.checks.length, sourceHash }));
} finally {
  await browser?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
}
