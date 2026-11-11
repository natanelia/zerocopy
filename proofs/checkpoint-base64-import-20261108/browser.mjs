import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../../', import.meta.url)));
const worker = `
import { initWorker } from '/dist/shared.js';
let current, expected;
const check = () => {
  if (current.old !== current.alias) {
    // Worker descriptors may reconstruct equal wrappers separately.
    if (JSON.stringify(current.old.toWorkerData()) !== JSON.stringify(current.alias.toWorkerData())) throw Error('alias roots changed');
  }
  if (JSON.stringify(current.old.get('child').toArray()) !== JSON.stringify(expected)) throw Error('worker values differ');
  if (!Object.isFrozen(current.old) || !Object.isFrozen(current.old.get('child'))) throw Error('worker snapshots not frozen');
  let rejected = false;
  try { current.old.set('forbidden', current.old.get('child')); } catch (error) { rejected = /read-only/.test(error.message); }
  if (!rejected) throw Error('worker attachment is writable');
};
self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'attach') { current = await initWorker(data.payload); expected = data.expected; }
    check(); self.postMessage({ id: data.id, ok: true });
  } catch (error) { self.postMessage({ id: data.id, error: String(error.stack ?? error) }); }
};
`;
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Checkpoint byte decoder verification</title>'); }
  else if (path === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(worker); }
  else if (/^\/dist\/[\w.-]+\.js$/.test(path)) {
    try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(root, path))); }
    catch { response.statusCode = 404; response.end(); }
  } else { response.statusCode = 404; response.end(); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const cases = [];
  for (const mode of ['native', 'missing', 'noncallable']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(origin);
      const result = await page.evaluate(async mode => {
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        check(crossOriginIsolated, 'page must be isolated');
        const native = Uint8Array.fromBase64, descriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
        const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
        let nativeCalls = 0;
        if (mode === 'native') {
          check(typeof native === 'function', 'this browser must expose the real standard byte decoder');
          Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, writable: true, value: function (text) {
            check(this === Uint8Array, 'native decoder receiver differs'); nativeCalls++;
            return Reflect.apply(native, this, [text]);
          } });
          Object.defineProperty(globalThis, 'Buffer', { configurable: true, get() { throw new Error('preferred standard API should not inspect Buffer'); } });
        } else {
          Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, writable: true, value: mode === 'missing' ? undefined : 7 });
          Object.defineProperty(globalThis, 'Buffer', { configurable: true, writable: true, value: mode === 'missing' ? undefined : { from: 7 } });
        }
        const R = await import('/dist/redux.js'), S = await import('/dist/shared.js');
        if (descriptor) Object.defineProperty(Uint8Array, 'fromBase64', descriptor); else delete Uint8Array.fromBase64;
        if (bufferDescriptor) Object.defineProperty(globalThis, 'Buffer', bufferDescriptor); else delete globalThis.Buffer;
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const padding = new Map();
        for (let length = 0; length < 24 && padding.size < 3; length++) {
          const value = '\0\u007f\u0080街道🙂' + 'x'.repeat(length), packet = R.encodeZerocopyState(new S.SharedList('string').push(value));
          padding.set(packet.arenas[0].used % 3, { packet, value });
        }
        check(padding.size === 3, 'missing final-byte cases');
        for (const [remainder, { packet, value }] of padding) {
          check(R.decodeZerocopyState(packet).get(0) === value, 'decoded value differs');
          if (!remainder) continue;
          const changed = JSON.parse(JSON.stringify(packet)), text = changed.arenas[0].base64;
          const index = text.length - (remainder === 1 ? 3 : 2);
          changed.arenas[0].base64 = text.slice(0, index) + alphabet[alphabet.indexOf(text[index]) | 1] + text.slice(index + 1);
          check(R.decodeZerocopyState(changed).get(0) === value, 'unused padding bits changed behavior');
        }
        const values = Array.from({ length: 80 }, (_, i) => `${i}:` + '路🙂\0'.repeat(1024));
        const child = new S.SharedList('string').pushMany(values), source = new S.SharedMap('SharedList<string>').set('child', child);
        const packet = R.encodeZerocopyState({ old: source, alias: source, ui: { selected: 7 } }), text = JSON.stringify(packet);
        const first = R.decodeZerocopyState(packet), second = R.deserializeZerocopyState(text);
        check(first.old === first.alias && second.old === second.alias, 'checkpoint aliases changed');
        check(Object.isFrozen(first) && Object.isFrozen(first.ui), 'state tree not frozen');
        check(JSON.stringify(first.old.get('child').toArray()) === JSON.stringify(values), 'large decode differs');
        check(JSON.stringify(second.old.get('child').toArray()) === JSON.stringify(values), 'large deserialize differs');
        const firstWire = S.getWorkerData({ old: first.old }, { copy: false }), secondWire = S.getWorkerData({ old: second.old }, { copy: false });
        check(firstWire.arenas[0].id !== secondWire.arenas[0].id, 'imports reused arena identity');
        const workers = [];
        let sequence = 0;
        const request = (worker, data) => new Promise((resolveReply, reject) => {
          const id = ++sequence, timer = setTimeout(() => reject(new Error('worker timeout')), 10000);
          const receive = ({ data }) => { if (data.id !== id) return; clearTimeout(timer); worker.removeEventListener('message', receive); data.error ? reject(new Error(data.error)) : resolveReply(data); };
          worker.addEventListener('message', receive); worker.postMessage({ ...data, id });
        });
        try {
          for (const copy of [false, true]) {
            const worker = new Worker('/worker.mjs', { type: 'module' }); workers.push(worker);
            await request(worker, { kind: 'attach', payload: S.getWorkerData({ old: first.old, alias: first.old }, { copy }), expected: values });
          }
          const oldBytes = firstWire.arenas[0].memory.buffer.byteLength;
          const grown = first.old.set('grown', first.old.get('child').push('g'.repeat(oldBytes + 65536)));
          check(firstWire.arenas[0].memory.buffer.byteLength > oldBytes, 'test must grow source memory');
          check(grown.get('grown').size === values.length + 1, 'writable import fork failed');
          for (const worker of workers) await request(worker, { kind: 'check' });
          check(JSON.stringify(first.old.get('child').toArray()) === JSON.stringify(values), 'old snapshot changed after growth');
          check(JSON.stringify(packet) === text, 'input packet changed');
          check(mode === 'native' ? nativeCalls > 0 : nativeCalls === 0, 'decoder path mismatch');
          return { mode, nativeSupported: typeof native === 'function', nativeCalls, paddingCases: padding.size,
            decodedBytes: packet.arenas.reduce((sum, item) => sum + item.used, 0), sharedWorker: true, copiedWorker: true, memoryGrowth: true, retainedSnapshots: true, readOnlyAttachments: true };
        } finally { for (const worker of workers) worker.terminate(); }
      }, mode);
      cases.push(result);
    } finally { await context.close(); }
  }
  assert.equal(cases.length, 3);
  console.log(JSON.stringify({ browser: await browser.version(), cases }, null, 2));
} finally { await browser?.close(); await new Promise(resolveClose => server.close(resolveClose)); }
