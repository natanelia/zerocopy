import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const repository = resolve(process.argv[2] ?? '.');
const { chromium } = createRequire(join(repository, 'package.json'))('playwright');

function assert(condition, message) { if (!condition) throw new Error(message); }
function same(actual, expected, path = 'value') {
  if (Object.is(actual, expected)) return;
  assert(actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object', path + ': scalar mismatch');
  assert(Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected), path + ': prototype mismatch');
  const ak = Reflect.ownKeys(actual), ek = Reflect.ownKeys(expected);
  assert(ak.length === ek.length, path + ': own-key count mismatch');
  for (let i = 0; i < ek.length; i++) {
    assert(ak[i] === ek[i], path + ': key mismatch'); same(actual[ak[i]], expected[ek[i]], path + '.' + String(ek[i]));
  }
}
function encoded(value) {
  if (typeof value !== 'number') return value;
  if (Number.isNaN(value)) return ['n', 'NaN'];
  if (!Number.isFinite(value)) return ['n', value > 0 ? 'Infinity' : '-Infinity'];
  return Object.is(value, -0) ? ['n', '-0'] : value;
}
function insert(root, value, priority, max) {
  if (!root || (max ? priority > root.priority : priority < root.priority)) return { value, priority, left: root, right: null, rank: 1 };
  let left = root.left, right = insert(root.right, value, priority, max);
  if ((left?.rank ?? 0) < right.rank) [left, right] = [right, left];
  return { value: root.value, priority: root.priority, left, right, rank: (right?.rank ?? 0) + 1 };
}
function envelope(input, type, max) {
  let root = null;
  for (const [value, priority] of input) root = insert(root, value, priority, max);
  const pending = root ? [root] : [], rows = [];
  for (let i = 0; i < pending.length; i++) {
    const node = pending[i], left = node.left ? pending.push(node.left) - 1 : -1;
    const right = node.right ? pending.push(node.right) - 1 : -1;
    rows.push([encoded(node.value), encoded(node.priority), left, right]);
  }
  return { $zerocopyRedux: 1, value: ['c', 'SharedPriorityQueue', type, max, rows] };
}
function verify(R, snapshots, expected, attached = false) {
  const codec = R.createZerocopyCodec();
  same(Object.keys(snapshots), Object.keys(expected), 'heap names');
  for (const name of Object.keys(expected)) {
    const heap = snapshots[name], result = codec.encode(heap);
    same(result, expected[name], name);
    assert(Object.isFrozen(result) && Object.isFrozen(heap), 'Expected immutable envelope/snapshot');
    assert(codec.stringify(heap) === JSON.stringify(expected[name]), 'Stringified wire rows differ');
    if (attached) {
      for (const action of [() => heap.enqueue(heap.peek(), 0), () => heap.dequeue()]) {
        let error; try { action(); } catch (caught) { error = caught; }
        assert(error instanceof Error && /read-only/.test(error.message), 'Attached heap must reject allocating updates');
      }
    }
  }
}
const helpers = [assert, same, encoded, insert, envelope, verify].map(fn => 'export ' + fn.toString()).join('\n');

async function browserWorker() {
  const S = await import('/dist/shared.js'), R = await import('/dist/redux.js'), H = await import('/helpers.mjs');
  H.assert(self.crossOriginIsolated, 'Worker must be isolated');
  let retained, retainedExpected;
  self.onmessage = async ({ data }) => {
    try {
      const snapshots = await S.initWorker(data.packet);
      if (retained) H.verify(R, retained, retainedExpected, true);
      H.verify(R, snapshots, data.expected, true);
      if (!retained) { retained = snapshots; retainedExpected = data.expected; }
      self.postMessage({ id: data.id, ok: true });
    } catch (error) { self.postMessage({ id: data.id, ok: false, error: String(error.stack ?? error) }); }
  };
  self.postMessage({ ready: true });
}

async function browserProof() {
  const S = await import('/dist/shared.js'), R = await import('/dist/redux.js'), H = await import('/helpers.mjs');
  H.assert(self.crossOriginIsolated, 'Page must be isolated');
  const numeric = Array.from({ length: 1025 }, (_, i) => [i < 6 ? [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE][i] : i / 4, i < 4 ? [-0, 0, -Infinity, Infinity][i] : (i * 73) % 127 - 63]);
  const boolean = Array.from({ length: 65 }, (_, i) => [i % 3 === 0, i % 5]);
  let min = new S.SharedPriorityQueue('number'), max = new S.SharedPriorityQueue('boolean', { maxHeap: true });
  for (const [value, priority] of numeric) min = min.enqueue(value, priority);
  for (const [value, priority] of boolean) max = max.enqueue(value, priority);
  const original = { min, max };
  const expected = { min: H.envelope(numeric, 'number', false), max: H.envelope(boolean, 'boolean', true) };
  H.verify(R, original, expected);
  let serial = 0;
  function receive(worker, predicate, send) {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => finish(new Error('Browser heap worker timed out')), 15000);
      const message = event => { if (predicate(event.data)) finish(event.data.ok === false ? new Error(event.data.error) : null); };
      const error = event => finish(new Error(event.message || 'Worker error'));
      function finish(failure) {
        clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error);
        if (failure) reject(failure); else done();
      }
      worker.addEventListener('message', message); worker.addEventListener('error', error); send?.();
    });
  }
  const checks = ['independent full numeric/boolean wire oracle with topology, ties and special values'];
  for (const copy of [false, true]) {
    const worker = new Worker('/worker.mjs', { type: 'module' });
    const send = async (snapshots, expected) => {
      const packet = S.getWorkerData(snapshots, { copy }), id = ++serial;
      await receive(worker, result => result.id === id, () => worker.postMessage({ packet, expected, id },
        packet.arenas.flatMap(arena => arena.copy ? [arena.copy.buffer] : [])));
    };
    try {
      await receive(worker, result => result.ready === true);
      await send(original, expected);
      const before = S.getWorkerData(original, { copy: true });
      for (const arena of S.getWorkerData(original, { copy: false }).arenas) {
        const buffer = arena.memory.buffer;
        H.assert(buffer instanceof SharedArrayBuffer, 'Expected shared WASM memory');
        arena.memory.grow(2); H.assert(buffer !== arena.memory.buffer, 'Growth must expose a new buffer');
      }
      const updated = { min: min.enqueue(-999, -Infinity), max: max.enqueue(false, Infinity) };
      const nextExpected = { min: H.envelope([...numeric, [-999, -Infinity]], 'number', false), max: H.envelope([...boolean, [false, Infinity]], 'boolean', true) };
      H.verify(R, original, expected); H.verify(R, updated, nextExpected);
      const after = S.getWorkerData(original, { copy: true });
      for (let i = 0; i < before.arenas.length; i++) {
        const first = before.arenas[i], next = after.arenas[i];
        H.assert(first.id === next.id, 'Source arena changed');
        for (let p = 65536; p < first.used; p++) H.assert(first.copy[p] === next.copy[p], 'Published source byte changed');
      }
      await send(updated, nextExpected);
      checks.push(`${copy ? 'copy' : 'shared'} real worker: read-only old/new heaps after owner edits and growth`);
    } finally { worker.terminate(); }
  }
  return { crossOriginIsolated: self.crossOriginIsolated, checks };
}

const workerSource = 'await (' + browserWorker.toString() + ')();';
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Redux heap correctness proof</title>'); return; }
    response.setHeader('Content-Type', 'text/javascript');
    if (pathname === '/helpers.mjs') { response.end(helpers); return; }
    if (pathname === '/worker.mjs') { response.end(workerSource); return; }
    if (pathname.startsWith('/dist/')) {
      const path = resolve(repository, pathname.slice(1));
      if (path.startsWith(join(repository, 'dist') + sep)) { response.end(readFileSync(path)); return; }
    }
    response.statusCode = 404; response.end('Not found');
  } catch { response.statusCode = 404; response.end('Not found'); }
});
let browser;
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
  const result = await page.evaluate(browserProof);
  assert(!errors.length, 'Browser errors: ' + errors.join('; '));
  console.log(JSON.stringify({ browser: browser.version(), ...result, timingMeasurements: false }, null, 2));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections?.();
  await new Promise(done => server.close(done));
}
