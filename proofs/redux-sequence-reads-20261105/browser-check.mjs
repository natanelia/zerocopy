import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Usage: node browser-check.mjs BUILT_REPOSITORY [checkpoint|sequence|both]
// Playwright resolves from the target repository. CHROMIUM_EXECUTABLE is
// optional when Playwright already has a Chromium installation.
const repository = resolve(process.argv[2] ?? '.');
const mode = process.argv[3] ?? 'both';
if (!['checkpoint', 'sequence', 'both'].includes(mode)) throw new Error('Invalid proof mode: ' + mode);
const { chromium } = createRequire(join(repository, 'package.json'))('playwright');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function same(actual, expected, path = 'value') {
  if (Object.is(actual, expected)) return;
  assert(actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object', path + ': scalar mismatch');
  assert(Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected), path + ': prototype mismatch');
  const actualKeys = Reflect.ownKeys(actual), expectedKeys = Reflect.ownKeys(expected);
  assert(actualKeys.length === expectedKeys.length, path + ': own-key count mismatch');
  for (let i = 0; i < expectedKeys.length; i++) {
    assert(actualKeys[i] === expectedKeys[i], path + ': own-key order mismatch');
    same(actual[actualKeys[i]], expected[expectedKeys[i]], path + '.' + String(expectedKeys[i]));
  }
}
function frozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert(Object.isFrozen(value), 'Expected a frozen output');
  for (const key of Object.keys(value)) frozen(value[key]);
}
function numberValue(value) {
  if (Number.isNaN(value)) return ['n', 'NaN'];
  if (value === Infinity) return ['n', 'Infinity'];
  if (value === -Infinity) return ['n', '-Infinity'];
  return Object.is(value, -0) ? ['n', '-0'] : value;
}
function verifySequences(R, values, expected) {
  same(Object.keys(values), expected.map(spec => spec.name), 'sequence names');
  const codec = R.createZerocopyCodec();
  for (const spec of expected) {
    const collection = values[spec.name];
    assert(collection.size === spec.values.length, spec.name + ': incorrect size');
    const encoded = codec.encode(collection);
    same(encoded, { $zerocopyRedux: 1, value: ['c', spec.kind, spec.type, null,
      spec.values.map(value => spec.type === 'number' ? numberValue(value) : value)] }, spec.name);
    assert(Object.isFrozen(encoded), 'Portable envelope must remain frozen');
  }
}
function mapValues(map) {
  return [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function bytesSame(before, after) {
  assert(before.length === after.length, 'Byte length changed');
  for (let i = 0; i < before.length; i++) assert(before[i] === after[i], 'Published byte changed at ' + i);
}
function readOnly(action) {
  let error;
  try { action(); } catch (caught) { error = caught; }
  assert(error instanceof Error && /read-only/.test(error.message), 'Expected a read-only attachment');
}
const helperSource = [assert, same, frozen, numberValue, verifySequences, mapValues, bytesSame, readOnly]
  .map(fn => 'export ' + fn.toString()).join('\n');

async function browserWorker() {
  const S = await import('/dist/shared.js'), R = await import('/dist/redux.js');
  const H = await import('/proof-helpers.mjs');
  H.assert(self.crossOriginIsolated, 'Worker must be cross-origin isolated');
  let retained, retainedExpected;
  self.onmessage = async event => {
    const message = event.data;
    try {
      const attached = await S.initWorker(message.payload);
      if (message.kind === 'sequence') {
        if (retained) H.verifySequences(R, retained, retainedExpected);
        H.verifySequences(R, attached, message.expected);
        for (const spec of message.expected) {
          const collection = attached[spec.name], value = spec.type === 'number' ? 3 : true;
          H.readOnly(() => spec.kind === 'SharedStack' ? collection.push(value) : collection.enqueue(value));
        }
        if (!retained) { retained = attached; retainedExpected = message.expected; }
      } else {
        H.same(H.mapValues(attached.map), message.expected, 'worker checkpoint map');
        H.readOnly(() => attached.map.set('forbidden', 1));
      }
      self.postMessage({ id: message.id, ok: true });
    } catch (error) { self.postMessage({ id: message.id, ok: false, error: error.stack ?? String(error) }); }
  };
  self.postMessage({ boot: true });
}

async function browserProof({ mode }) {
  const S = await import('/dist/shared.js'), R = await import('/dist/redux.js');
  const H = await import('/proof-helpers.mjs');
  H.assert(self.crossOriginIsolated, 'Page must be cross-origin isolated');
  H.assert(typeof SharedArrayBuffer === 'function', 'SharedArrayBuffer unavailable');
  const checks = [];
  let nextMessage = 0;
  function receive(worker, predicate, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Worker proof timed out')), 20000);
      const message = event => { if (predicate(event.data)) finish(event.data.ok === false ? new Error(event.data.error) : null, event.data); };
      const error = event => finish(new Error(event.message || 'Worker error'));
      function finish(error, result) {
        clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', errorHandler);
        if (error) reject(error); else resolve(result);
      }
      const errorHandler = error;
      worker.addEventListener('message', message); worker.addEventListener('error', errorHandler);
      send?.();
    });
  }
  async function startWorker() {
    const worker = new Worker('/proof-worker.mjs', { type: 'module' });
    try { await receive(worker, result => result.boot === true); return worker; }
    catch (error) { worker.terminate(); throw error; }
  }
  function request(worker, message) {
    const id = ++nextMessage;
    const transfer = message.payload.arenas.flatMap(arena => arena.copy ? [arena.copy.buffer] : []);
    return receive(worker, result => result.id === id, () => worker.postMessage({ ...message, id }, transfer));
  }
  function grow(structures) {
    const payload = S.getWorkerData(structures, { copy: false });
    for (const arena of payload.arenas) {
      const memory = arena.memory, oldBuffer = memory.buffer;
      H.assert(oldBuffer instanceof SharedArrayBuffer, 'Expected shared WASM memory');
      const bytes = new Uint8Array(oldBuffer, 0, arena.used).slice();
      memory.grow(1);
      H.assert(memory.buffer !== oldBuffer, 'Growth must expose a refreshed buffer');
      H.bytesSame(bytes, new Uint8Array(memory.buffer, 0, arena.used));
    }
  }

  if (mode === 'sequence' || mode === 'both') {
    const numbers = Array.from({ length: 131 }, (_, i) => i / 2 - 30);
    numbers[36] = -0; numbers[37] = NaN; numbers[64] = Infinity; numbers[96] = -Infinity;
    const booleans = Array.from({ length: 97 }, (_, i) => i % 3 === 0);
    let numberStack = new S.SharedStack('number'), booleanStack = new S.SharedStack('boolean');
    let numberQueue = new S.SharedQueue('number'), booleanQueue = new S.SharedQueue('boolean');
    for (const value of numbers.slice(0, 97)) numberStack = numberStack.push(value);
    for (const value of booleans.slice(0, 65)) booleanStack = booleanStack.push(value);
    for (const value of numbers) numberQueue = numberQueue.enqueue(value);
    for (const value of booleans) booleanQueue = booleanQueue.enqueue(value);
    for (let i = 0; i < 35; i++) numberQueue = numberQueue.dequeue();
    for (let i = 0; i < 33; i++) booleanQueue = booleanQueue.dequeue();
    const original = { numberStack, booleanStack, numberQueue, booleanQueue };
    const expected = [
      { name: 'numberStack', kind: 'SharedStack', type: 'number', values: numbers.slice(0, 97).reverse() },
      { name: 'booleanStack', kind: 'SharedStack', type: 'boolean', values: booleans.slice(0, 65).reverse() },
      { name: 'numberQueue', kind: 'SharedQueue', type: 'number', values: numbers.slice(35) },
      { name: 'booleanQueue', kind: 'SharedQueue', type: 'boolean', values: booleans.slice(33) },
    ];
    H.verifySequences(R, original, expected);
    checks.push('portable numeric/boolean stack and offset-queue encoding');
    for (const copy of [false, true]) {
      const worker = await startWorker();
      try {
        await request(worker, { kind: 'sequence', payload: S.getWorkerData(original, { copy }), expected });
        grow(original);
        const updated = {
          numberStack: numberStack.push(12345), booleanStack: booleanStack.pop(),
          numberQueue: numberQueue.dequeue().enqueue(-12345), booleanQueue: booleanQueue.enqueue(false),
        };
        const nextExpected = [
          { ...expected[0], values: [12345, ...expected[0].values] },
          { ...expected[1], values: expected[1].values.slice(1) },
          { ...expected[2], values: [...expected[2].values.slice(1), -12345] },
          { ...expected[3], values: [...expected[3].values, false] },
        ];
        H.verifySequences(R, original, expected); H.verifySequences(R, updated, nextExpected);
        await request(worker, { kind: 'sequence', payload: S.getWorkerData(updated, { copy }), expected: nextExpected });
        checks.push((copy ? 'copy' : 'shared') + ' worker: old/new sequence roots after owner edits and growth');
      } finally { worker.terminate(); }
    }
  }

  if (mode === 'checkpoint' || mode === 'both') {
    const dictionary = Object.create(null);
    for (const key of ['__proto__', 'constructor', 'toString', '', 'é', '🙂']) dictionary[key] = { key };
    const sparse = new Array(6); sparse[1] = undefined; sparse[3] = -0; sparse[5] = ['nested'];
    const tree = { rows: [{ id: 1, nested: { flags: [true, false] } }], sparse, dictionary,
      numbers: [0, -0, NaN, Infinity, -Infinity], missing: undefined, nil: null };
    const entries = [['__proto__', -0], ['a', Infinity], ['z', NaN]];
    const source = new S.SharedMap('number').setMany(entries);
    const state = { tree, first: source, again: source };
    const packet = R.encodeZerocopyState(state), text = JSON.stringify(packet);
    const restoredStates = [R.decodeZerocopyState(packet), R.deserializeZerocopyState(text)];
    for (const restored of restoredStates) {
      H.same(Object.keys(restored), ['tree', 'first', 'again'], 'checkpoint root keys');
      H.assert(Object.getPrototypeOf(restored) === Object.prototype, 'Checkpoint root prototype');
      H.same(restored.tree, tree, 'checkpoint plain tree'); H.frozen(restored.tree);
      H.assert(Object.isFrozen(restored) && Object.isFrozen(restored.first), 'Checkpoint must remain frozen');
      H.assert(restored.first === restored.again, 'Checkpoint snapshot aliases must be retained');
      H.same(H.mapValues(restored.first), entries, 'checkpoint map values');
      const updated = restored.first.set('new', 77);
      H.same(H.mapValues(restored.first), entries, 'retained checkpoint map');
      H.assert(updated.get('new') === 77 && updated.size === 4, 'Restored imports must remain writable');
    }
    H.assert(JSON.stringify(packet) === text, 'Checkpoint packet mutated');
    H.same(H.mapValues(source), entries, 'source checkpoint map');
    checks.push('checkpoint decode/deserialize: sparse/null-prototype/special-value tree, aliases and writable imports');
    for (const copy of [false, true]) {
      const worker = await startWorker();
      try {
        await request(worker, { kind: 'checkpoint', payload: S.getWorkerData({ map: restoredStates[0].first }, { copy }), expected: entries });
        checks.push((copy ? 'copy' : 'shared') + ' worker: restored checkpoint map remains readable and read-only');
      } finally { worker.terminate(); }
    }
  }
  return { mode, crossOriginIsolated: self.crossOriginIsolated, checks };
}

const workerSource = 'await (' + browserWorker.toString() + ')();';
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>Zerocopy browser correctness proof</title>'); return;
    }
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    if (pathname === '/proof-helpers.mjs') { response.end(helperSource); return; }
    if (pathname === '/proof-worker.mjs') { response.end(workerSource); return; }
    if (pathname.startsWith('/dist/')) {
      const filename = resolve(repository, pathname.slice(1));
      if (filename.startsWith(join(repository, 'dist') + sep)) { response.end(readFileSync(filename)); return; }
    }
    response.statusCode = 404; response.end('Not found');
  } catch { response.statusCode = 404; response.end('Not found'); }
});

let browser;
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'load' });
  const result = await page.evaluate(browserProof, { mode });
  assert(errors.length === 0, 'Browser page errors: ' + errors.join('; '));
  console.log(JSON.stringify({ browser: browser.version(), ...result, timingMeasurements: false }, null, 2));
} catch (error) {
  console.error(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
