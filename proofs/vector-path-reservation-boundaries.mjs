import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Supplemental review checks, without timing or changing the frozen workload
// screen: partially missing paths and caller-supplied public depths above five.
const output = resolve(process.argv[2] ?? '/tmp/zerocopy-vector-path-reservation-proof');
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
const receipts = Object.fromEntries(manifest.receipts.filter(row => !row.instrumented).map(row => [row.role, row]));
assert.equal(hash(readFileSync('persistent-core.as.ts')), receipts.candidate.sourceSha256);
const modules = Object.fromEntries(['baseline', 'candidate'].map(role => {
  const bytes = readFileSync(join(output, 'builds', role, 'core.wasm'));
  assert.equal(hash(bytes), receipts[role].wasmSha256);
  return [role, new WebAssembly.Module(bytes)];
}));
function instance(role, bytes, used = 65536) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
  const api = new WebAssembly.Instance(modules[role], { env: { memory } }).exports;
  if (bytes) new Uint8Array(memory.buffer).set(bytes);
  api.setHeapEnd(used);
  return { memory, api };
}
const missingPaths = [];
for (const depth of [1, 2, 3, 5, 6]) for (let missingLevel = 1; missingLevel <= depth; missingLevel++) {
  const seed = instance('baseline');
  const root = seed.api.vecSet(0, depth, 0, 13) >>> 0;
  const bytes = new Uint8Array(seed.memory.buffer).slice();
  const index = 32 ** missingLevel;
  for (const used of [seed.api.getHeapEnd(), seed.api.getHeapEnd() + 4, 131072 - 128]) for (const value of [0, 19]) {
    const result = ['baseline', 'candidate'].map(role => {
      const item = instance(role, bytes, used);
      const next = item.api.vecSet(root, depth, index, value) >>> 0;
      assert.equal(next, Math.ceil(used / 8) * 8);
      assert.equal(item.api.vecGet(root, depth, 0), 13);
      assert.equal(item.api.vecGet(next, depth, 0), 13);
      assert.equal(item.api.vecGet(next, depth, index), value);
      assert.deepEqual(new Uint8Array(item.memory.buffer, 0, used), bytes.subarray(0, used));
      const end = item.api.getHeapEnd();
      if (role === 'candidate') {
        assert.equal(item.api.vecSet(next, depth, index, value) >>> 0, next);
        assert.equal(item.api.getHeapEnd(), end);
      }
      return { root: next, used: end, backingBytes: item.memory.buffer.byteLength,
        bytes: new Uint8Array(item.memory.buffer, 0, end).slice() };
    });
    assert.deepEqual(result[1], result[0], 'Missing children under existing ancestors preserve main layout and old bytes');
    missingPaths.push({ depth, missingLevel, index, value, used, allocated: result[1].used - used });
  }
}

const OriginalModule = WebAssembly.Module, compiledWasm = [];
let S;
try {
  WebAssembly.Module = new Proxy(OriginalModule, { construct(target, args) {
    compiledWasm.push(hash(Buffer.from(args[0])));
    return Reflect.construct(target, args);
  } });
  S = await import(pathToFileURL(resolve('dist/shared.js')).href);
} finally { WebAssembly.Module = OriginalModule; }
assert.deepEqual(compiledWasm, [receipts.candidate.wasmSha256]);
const customPublicDepths = [];
for (const depth of [6, 8, 32]) {
  S.resetSharedList();
  const seed = new S.SharedList('number').push(17);
  // owner is inherited from Snapshot. This deliberately exercises the existing
  // low-level constructor/source parameter, not generated push/pushMany depth.
  const arena = S.SharedList.owner(seed);
  const root = arena.wasm.vecSet(0, depth, 0, 13) >>> 0;
  const descriptor = { root, depth, size: 33, type: 'number', tail: seed.tail };
  for (const factory of ['constructor', 'fromWorkerData']) {
    const source = factory === 'constructor'
      ? new S.SharedList('number', root, depth, 33, arena, seed.tail)
      : S.SharedList.fromWorkerData(descriptor, arena);
    const used = arena.used, before = arena.buf.slice(0, used);
    // Only assert the selected index-zero path. Arbitrary depths above six
    // wrap WASM shifts into low index bits and are not ordinary public vectors.
    const next = source.set(0, 19);
    assert.equal(next.depth, depth);
    assert.equal(next.root, Math.ceil(used / 8) * 8);
    assert.equal(arena.used - used, 256 + depth * 128);
    assert.equal(source.get(0), 13); assert.equal(source.get(32), 17);
    assert.equal(next.get(0), 19); assert.equal(next.get(32), 17);
    assert.deepEqual(arena.buf.subarray(0, used), before);
    const main = instance('baseline', before, used);
    assert.equal(main.api.vecSet(root, depth, 0, 19) >>> 0, next.root);
    assert.equal(main.api.getHeapEnd(), arena.used);
    assert.deepEqual(new Uint8Array(main.memory.buffer, 0, arena.used), arena.buf.subarray(0, arena.used));
    const mark = arena.used, same = next.set(0, 19);
    assert.notEqual(same, next); assert.equal(same.root, next.root); assert.equal(arena.used, mark);
    customPublicDepths.push({ depth, factory, root: next.root, allocated: mark - used, exactMainBytes: true, retainedSnapshots: true });
  }
}
const result = { noTimings: true, node: process.version, bun: process.versions.bun ?? null,
  coreWasmSha256: receipts.candidate.wasmSha256, compiledWasm, missingPaths, customPublicDepths };
writeFileSync(join(output, `boundaries${process.versions.bun ? '-bun' : ''}.json`), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ missingPathCases: missingPaths.length, publicCustomDepthCases: customPublicDepths.length, noTimings: true }));
