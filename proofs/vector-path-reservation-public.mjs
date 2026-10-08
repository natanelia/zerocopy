import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkFixtures } from './noop-sequence-workloads.mjs';
import { checkNoopSequenceInvariants } from './noop-sequence-invariants.mjs';

// Run after vector-path-reservation.mjs and build:browser. All payload checks
// use Node strict assertions; no measurements or benchmark driver are invoked.
const output = resolve(process.argv[2] ?? '/tmp/zerocopy-vector-path-reservation-proof');
// An optional package directory verifies the exact packed/extracted artifact.
const packageRoot = resolve(process.argv[3] ?? '.');
const portableRoot = join(packageRoot, 'dist');
const moduleURL = pathToFileURL(join(portableRoot, 'shared.js')).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
const receipt = manifest.receipts.find(row => row.role === 'candidate' && !row.instrumented);
assert.equal(hash(readFileSync('persistent-core.as.ts')), receipt.sourceSha256, 'Source must match the raw proof');
assert.equal(hash(readFileSync(join(packageRoot, 'persistent-core.wasm'))), receipt.wasmSha256, 'Root WASM must match the raw proof');
assert.equal(hash(readFileSync(join(output, 'builds/candidate/core.wasm'))), receipt.wasmSha256);
const portableFiles = Object.fromEntries(readdirSync(portableRoot).filter(name => name.endsWith('.js')).sort()
  .map(name => [name, hash(readFileSync(join(portableRoot, name)))]));
// Capture the bytes actually compiled while importing the public package. A
// raw-WASM oracle alone could pass against stale historical portable modules.
const compiledWasm = [], OriginalModule = WebAssembly.Module;
let S, R, W;
try {
  WebAssembly.Module = new Proxy(OriginalModule, { construct(target, args) {
    compiledWasm.push(hash(Buffer.from(args[0])));
    return Reflect.construct(target, args);
  } });
  S = await import(moduleURL);
  R = await import(pathToFileURL(join(portableRoot, 'redux.js')).href);
  W = await import(pathToFileURL(join(portableRoot, 'worker.js')).href);
} finally { WebAssembly.Module = OriginalModule; }
assert.deepEqual(compiledWasm, [receipt.wasmSha256], 'The imported portable package must compile exactly the candidate core');
const embeddedCoreFiles = readdirSync(portableRoot).filter(name => name.endsWith('.js') &&
  readFileSync(join(portableRoot, name), 'utf8').includes(readFileSync(join(packageRoot, 'persistent-core.wasm')).toString('base64')));
assert.equal(embeddedCoreFiles.length, 1, 'Exactly one portable chunk must embed the root core');
const modules = Object.fromEntries(['baseline', 'candidate'].map(role => [role,
  new WebAssembly.Module(readFileSync(join(output, 'builds', role, 'core.wasm')))]));
const bitModule = new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 17, 2, 96, 4, 127, 127, 127, 124, 1, 127, 96, 4, 127, 127, 127, 126, 1, 127,
  2, 11, 1, 3, 101, 110, 118, 3, 115, 101, 116, 0, 0, 3, 2, 1, 1, 7, 7, 1, 3, 115, 101, 116, 0, 1,
  10, 15, 1, 13, 0, 32, 0, 32, 1, 32, 2, 32, 3, 191, 16, 0, 11,
]));
function storage(list) {
  const packet = S.getWorkerData({ list }, { copy: false });
  return packet.arenas.find(a => a.id === packet.structures.list.arena);
}
function leaf(arena, list, index) {
  let p = list.root; const view = new DataView(arena.memory.buffer);
  for (let d = list.depth; d > 0; d--) p = view.getUint32(p + ((index >>> (d * 5)) & 31) * 4, true);
  return p;
}
const rows = [];
for (const type of ['number', 'boolean', 'string', 'object', 'SharedList<number>']) {
  S.resetSharedList();
  const children = type === 'SharedList<number>' ? [new S.SharedList('number').push(71), new S.SharedList('number').push(99)] : undefined;
  const pair = type === 'number' ? [0, -0] : type === 'boolean' ? [false, true] : type === 'string' ? ['first', 'second'] : type === 'object' ? [{ x: [1] }, { x: [2] }] : children;
  const source = new S.SharedList(type).pushMany(Array.from({ length: 1057 }, (_, n) => pair[n & 1]));
  const arena = storage(source), view = new DataView(arena.memory.buffer), target = 1024;
  const raw = view.getBigUint64(leaf(arena, source, 1) + 8, true), oldRaw = view.getBigUint64(leaf(arena, source, target), true);
  assert.notEqual(raw, oldRaw);
  const initial = new Uint8Array(arena.memory.buffer, 0, arena.used).slice();
  const results = [];
  for (const role of ['baseline', 'candidate']) {
    const memory = new WebAssembly.Memory({ initial: Math.ceil(arena.used / 65536), maximum: 64, shared: true });
    new Uint8Array(memory.buffer).set(initial);
    const api = new WebAssembly.Instance(modules[role], { env: { memory, abort() { throw new Error('abort'); } } }).exports;
    api.setHeapEnd(arena.used);
    const set = new WebAssembly.Instance(bitModule, { env: { set: api.vecSet } }).exports.set;
    const root = set(source.root, source.depth, target, raw) >>> 0;
    results.push({ root, used: api.getHeapEnd(), bytes: new Uint8Array(memory.buffer, 0, api.getHeapEnd()).slice() });
  }
  assert.deepEqual(results[1], results[0], `${type}: actual encoded raw pointers and all used bytes match main`);
  const replacement = pair[1], next = source.set(target, replacement);
  const actualArena = storage(next), pathBytes = 256 + source.depth * 128;
  const reservationStart = actualArena.used - pathBytes;
  assert.equal(next.root, reservationStart, `${type}: the actual public write has main's parent-first root address`);
  // Object/nested writes encode a fresh record before vecSet. Seed main with
  // that exact prefix and the actual encoded value, then compare every byte.
  const actualBytes = new Uint8Array(actualArena.memory.buffer, 0, actualArena.used).slice();
  const actualRaw = new DataView(actualBytes.buffer).getBigUint64(leaf(actualArena, next, target), true);
  const publicMemory = new WebAssembly.Memory({ initial: Math.ceil(actualArena.used / 65536), maximum: 64, shared: true });
  new Uint8Array(publicMemory.buffer).set(actualBytes.subarray(0, reservationStart));
  const publicBaseline = new WebAssembly.Instance(modules.baseline, { env: { memory: publicMemory } }).exports;
  publicBaseline.setHeapEnd(reservationStart);
  const publicSet = new WebAssembly.Instance(bitModule, { env: { set: publicBaseline.vecSet } }).exports.set;
  assert.equal(publicSet(source.root, source.depth, target, actualRaw) >>> 0, next.root);
  assert.equal(publicBaseline.getHeapEnd(), actualArena.used);
  assert.deepEqual(new Uint8Array(publicMemory.buffer, 0, actualArena.used), actualBytes, `${type}: actual public allocation matches main byte for byte`);
  const expected = source.toArray(); expected[target] = replacement;
  const values = value => type.startsWith('SharedList') ? value.map(child => child.toArray()) : value;
  assert.deepEqual(values(next.toArray()), values(expected));
  assert.deepEqual(new Uint8Array(arena.memory.buffer, 0, arena.used), initial);
  const same = next.set(target, replacement);
  // JSON and nested descriptors still encode fresh records, even for the same
  // JS input; only raw representation equality permits reuse.
  assert.equal(same.root === next.root, ['number', 'boolean', 'string'].includes(type));
  const old = source.toArray(), pushed = next.push(pair[0]), popped = next.pop(), bulk = next.pushMany(Array(64).fill(pair[1]));
  assert.deepEqual(values(source.toArray()), values(old));
  assert.deepEqual(values(pushed.toArray()), values([...expected, pair[0]]));
  assert.deepEqual(values(popped.toArray()), values(expected.slice(0, -1)));
  assert.deepEqual(values(bulk.toArray()), values([...expected, ...Array(64).fill(pair[1])]));
  const compacted = S.compactMany({ source, next, same });
  const restored = R.deserializeZerocopyState(R.serializeZerocopyState({ source, next, same }));
  for (const group of [compacted, restored]) {
    assert.deepEqual(values(group.source.toArray()), values(old));
    assert.deepEqual(values(group.next.toArray()), values(expected));
    assert.equal(group.next === group.same, ['number', 'boolean', 'string'].includes(type));
  }
  const state = W.createSharedState(next, { publish: { strategy: 'immediate' } });
  try {
    state.update(() => same);
    assert.equal(state.version, ['number', 'boolean', 'string'].includes(type) ? 0 : 1);
    state.update(list => list.set(target, pair[0]));
    assert.equal(state.version, ['number', 'boolean', 'string'].includes(type) ? 1 : 2);
  } finally { state.dispose(); }
  rows.push({ type, raw: raw.toString(16), depth: source.depth, exactMainBytes: true, publicRoot: next.root,
    publicPathBytes: pathBytes, publicMainBytes: true, snapshots: true, forks: true, appendPopPushMany: true, compactionCheckpointIdentity: true, state: true });
}
const result = { noTimings: true, node: process.version, bun: process.versions.bun ?? null,
  buildBinding: { sourceSha256: receipt.sourceSha256, rootWasmSha256: receipt.wasmSha256, compiledWasm, embeddedCoreFiles, portableFiles },
  typedRows: rows, historicalWorkloads: checkFixtures(S, true), invariants: await checkNoopSequenceInvariants(moduleURL, true) };
assert.equal(result.historicalWorkloads.length, 16);
writeFileSync(join(output, `public${process.argv[3] ? '-packed' : ''}${process.versions.bun ? '-bun' : ''}.json`), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ typedCases: rows.length, historicalWorkloads: result.historicalWorkloads.length, invariants: result.invariants.rows.length, noTimings: true }));
