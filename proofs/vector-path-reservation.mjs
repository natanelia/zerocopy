import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_FLAGS, BASELINE_COMMIT } from './noop-sequence-source.mjs';

// Deterministic correctness and separately instrumented mechanism evidence.
// No wall-clock measurements, calibration, benchmark launch, or publication.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(process.argv[2] ?? '/tmp/zerocopy-vector-path-reservation-proof');
mkdirSync(output, { recursive: true });
const historical = '1bf473e03803b1ca15e8e87d0100f3c62055fdcb';
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['persistent-core.as.ts', 'shared-runtime.as.ts', 'shared-hash-reader.as.ts', 'shared-text-reader.as.ts'];
const sources = Object.fromEntries(['baseline', 'historical', 'candidate'].map(role => [role,
  Object.fromEntries(files.map(file => [file, role === 'candidate' ? readFileSync(join(root, file), 'utf8') : git('show', `${role === 'baseline' ? BASELINE_COMMIT : historical}:${file}`).toString()]))]));
const split = source => {
  const start = source.indexOf('function vecSetAt('), end = source.indexOf('// Shared accessors', start);
  assert(start >= 0 && end > start);
  return [source.slice(0, start), source.slice(start, end), source.slice(end)];
};
const baselineParts = split(sources.baseline[files[0]]), candidateParts = split(sources.candidate[files[0]]);
assert.equal(candidateParts[0], baselineParts[0]);
assert.equal(candidateParts[2], baselineParts[2], 'All code after vecSet, including tailSet, must equal exact main');
for (const file of files.slice(1)) assert.equal(sources.candidate[file], sources.baseline[file]);
const frozenProofFiles = ['noop-sequence-workloads.mjs', 'noop-sequence-stats.mjs', 'noop-sequence-case.mjs', 'noop-sequence-performance.mjs', 'noop-sequence-source.mjs'];
for (const file of frozenProofFiles) assert.equal(readFileSync(join(root, 'proofs', file), 'utf8'), git('show', `${historical}:proofs/${file}`).toString(), 'Historical workload/statistical rules stay frozen');

function instrument(source) {
  const [prefix, vector, suffix] = split(source);
  const declarations = `@external("proof", "event") declare function proofEvent(kind: u32, address: u32, detail: u32): void;
@inline function proofPointer(address: u32): u32 { proofEvent(2, address, 4); return load<u32>(address); }
@inline function proofBits(address: u32): u64 { proofEvent(3, address, 8); return load<u64>(address); }
@inline function proofCopy(to: u32, from: u32, bytes: u32): void { proofEvent(4, from, bytes); memory.copy(to, from, bytes); }
@inline function proofFill(to: u32, byte: u8, bytes: u32): void { proofEvent(5, to, bytes); memory.fill(to, byte, bytes); }
`;
  return declarations + prefix.replace('export function alloc(bytes: u32): u32 {', 'export function alloc(bytes: u32): u32 { proofEvent(1, heapEnd, bytes);') +
    vector.replaceAll('load<u32>(root + off)', 'proofPointer(root + off)').replaceAll('load<u64>(root + off)', 'proofBits(root + off)')
      .replaceAll('memory.copy(', 'proofCopy(').replaceAll('memory.fill(', 'proofFill(') + suffix;
}
const modules = {}, instrumented = {}, receipts = [];
for (const role of Object.keys(sources)) for (const traced of [false, true]) {
  const dir = join(output, 'builds', `${role}${traced ? '-instrumented' : ''}`); mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), traced && file === files[0] ? instrument(sources[role][file]) : sources[role][file]);
  const args = [join(root, 'node_modules/assemblyscript/bin/asc.js'), join(dir, 'shared-runtime.as.ts'), '-o', join(dir, 'core.wasm'), '--textFile', join(dir, 'core.wat'), ...BUILD_FLAGS];
  execFileSync(process.execPath, args, { cwd: root, timeout: 120000, stdio: ['ignore', 'ignore', 'pipe'] });
  const bytes = readFileSync(join(dir, 'core.wasm'));
  (traced ? instrumented : modules)[role] = new WebAssembly.Module(bytes);
  receipts.push({ role, instrumented: traced, compiler: JSON.parse(readFileSync(join(root, 'node_modules/assemblyscript/package.json'))).version, flags: BUILD_FLAGS,
    sourceSha256: hash(readFileSync(join(dir, files[0]))), wasmSha256: hash(bytes) });
}
assert.equal(hash(readFileSync(join(root, 'persistent-core.wasm'))), receipts.find(row => row.role === 'candidate' && !row.instrumented).wasmSha256, 'Proof and shipped build must match');
const abi = module => ({ imports: WebAssembly.Module.imports(module), exports: WebAssembly.Module.exports(module) });
assert.deepEqual(abi(modules.candidate), abi(modules.baseline));

// WASM-to-WASM reinterpretation preserves signaling/quiet NaN payloads.
const bitArgumentModule = new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 17, 2, 96, 4, 127, 127, 127, 124, 1, 127, 96, 4, 127, 127, 127, 126, 1, 127,
  2, 11, 1, 3, 101, 110, 118, 3, 115, 101, 116, 0, 0, 3, 2, 1, 1, 7, 7, 1, 3, 115, 101, 116, 0, 1,
  10, 15, 1, 13, 0, 32, 0, 32, 1, 32, 2, 32, 3, 191, 16, 0, 11,
]));
const PAGE = 65536;
function instance(module, initial = 2, maximum = 8, bytes, used = PAGE) {
  const memory = new WebAssembly.Memory({ initial, maximum, shared: true }), events = [];
  const api = new WebAssembly.Instance(module, { env: { memory, abort() { throw new Error('abort'); } }, proof: { event(kind, address, detail) { events.push({ kind, address: address >>> 0, detail: detail >>> 0 }); } } }).exports;
  if (bytes) new Uint8Array(memory.buffer).set(bytes);
  api.setHeapEnd(used);
  const set = new WebAssembly.Instance(bitArgumentModule, { env: { set: api.vecSet } }).exports.set;
  return { api, memory, events, set };
}
const u8 = item => new Uint8Array(item.memory.buffer);
const dv = item => new DataView(item.memory.buffer);
const path = (item, rootPointer, depth, index) => {
  const nodes = [rootPointer];
  for (let d = depth; d > 0; d--) nodes.push(rootPointer = dv(item).getUint32(rootPointer + ((index >>> ((d * 5) & 31)) & 31) * 4, true));
  return nodes;
};
const patterns = [0n, 0x8000000000000000n, 0x3ff0000000000000n, 0x405ec00000000000n, 0x7ff8000000000001n, 0x7ff8000000000002n,
  0xfff8000000000001n, 0x7ff0000000000001n, 0xfff0000000000001n, 1n, 0x8000000000000001n, 0x40f0010000000000n];
function fixture(depth, index, mode = 'existing') {
  const item = instance(modules.baseline);
  if (mode === 'absent') return { root: 0, used: PAGE, bytes: u8(item).slice() };
  const rootPointer = item.set(0, depth, index, 0x402a000000000000n) >>> 0;
  const leaf = item.api.vecLeaf(rootPointer, depth, index) >>> 0;
  for (let i = 0; i < 32; i++) dv(item).setBigUint64(leaf + i * 8, patterns[i % patterns.length], true);
  return { root: rootPointer, used: item.api.getHeapEnd(), bytes: u8(item).slice() };
}
const layout = [];
for (const depth of [0, 1, 2, 3, 4, 5, 6, 8, 32]) for (const index of [0, 0xffffffff]) for (const mode of ['existing', 'absent']) {
  const seed = fixture(depth, index, mode);
  for (const offset of ['aligned', 'four-byte', 0, 4, 128, 256, 384, 512]) {
    const used = offset === 'aligned' ? seed.used : offset === 'four-byte' ? seed.used + 4 : 2 * PAGE - offset;
    const initialBytes = seed.bytes.slice(); initialBytes.fill(0xa5, seed.used, used);
    const oldBits = mode === 'existing' ? new DataView(initialBytes.buffer).getBigUint64(path(instance(modules.baseline, 2, 8, initialBytes, used), seed.root, depth, index).at(-1) + (index & 31) * 8, true) : undefined;
    for (const bits of patterns) {
      if (bits === oldBits) continue;
      const baseline = instance(modules.baseline, 2, 8, initialBytes, used), candidate = instance(modules.candidate, 2, 8, initialBytes, used);
      const roots = [baseline, candidate].map(item => item.set(seed.root, depth, index, bits) >>> 0);
      const expectedRoot = (used + 7) & ~7, expectedEnd = expectedRoot + 256 + depth * 128;
      assert.deepEqual(roots, [expectedRoot, expectedRoot]);
      assert.equal(baseline.api.getHeapEnd(), expectedEnd); assert.equal(candidate.api.getHeapEnd(), expectedEnd);
      assert.equal(candidate.memory.buffer.byteLength, baseline.memory.buffer.byteLength);
      assert.deepEqual(u8(candidate).subarray(0, expectedEnd), u8(baseline).subarray(0, expectedEnd), 'Every used byte equals exact main');
      assert.deepEqual(u8(candidate).subarray(0, used), initialBytes.subarray(0, used), 'Old bytes stay unchanged');
      const pointers = path(candidate, roots[1], depth, index);
      assert.deepEqual(pointers, Array.from({ length: depth + 1 }, (_, n) => expectedRoot + n * 128));
      assert.equal(dv(candidate).getBigUint64(pointers.at(-1) + (index & 31) * 8, true), bits);
      const mark = candidate.api.getHeapEnd(), before = u8(candidate).slice();
      assert.equal(candidate.set(roots[1], depth, index, bits) >>> 0, roots[1]);
      assert.equal(candidate.api.getHeapEnd(), mark); assert.deepEqual(u8(candidate), before);
      layout.push({ depth, index, mode, offset, bits: bits.toString(16), root: roots[1], allocated: expectedEnd - used });
    }
  }
}

// Separate traces count executed operations, not elapsed time or machine instructions.
const mechanism = [];
for (const depth of [0, 1, 2, 3, 4, 5, 6]) for (const mode of ['existing', 'absent']) for (const operation of ['changed', 'same']) {
  if (mode === 'absent' && operation === 'same') continue;
  const index = 31, seed = fixture(depth, index, mode), oldBits = mode === 'existing' ? new DataView(seed.bytes.buffer).getBigUint64(path(instance(modules.baseline, 2, 8, seed.bytes, seed.used), seed.root, depth, index).at(-1) + 31 * 8, true) : undefined;
  for (const role of Object.keys(instrumented)) {
    const item = instance(instrumented[role], 2, 8, seed.bytes, seed.used), value = operation === 'same' ? oldBits : 0x40f86a0000000000n;
    const pointer = item.set(seed.root, depth, index, value) >>> 0, events = item.events;
    const counts = Object.fromEntries([['allocCalls', 1], ['pointerLoads', 2], ['valueLoads', 3], ['copies', 4], ['fills', 5]].map(([name, kind]) => [name, events.filter(e => e.kind === kind).length]));
    const reused = role !== 'baseline' && operation === 'same';
    assert.equal(counts.allocCalls, reused ? 0 : role === 'candidate' ? 1 : depth + 1);
    assert.equal(counts.pointerLoads, mode === 'existing' ? depth : 0);
    assert.equal(counts.valueLoads, role !== 'baseline' && mode === 'existing' ? 1 : 0);
    assert.equal(counts.copies, mode === 'existing' && !reused ? depth + 1 : 0);
    assert.equal(counts.fills, mode === 'absent' ? depth + 1 : 0);
    const copiedBytes = events.filter(e => e.kind === 4 || e.kind === 5).reduce((sum, e) => sum + e.detail, 0);
    assert.equal(copiedBytes, reused ? 0 : 256 + depth * 128);
    if (mode === 'existing' && !reused) {
      const sourcePath = path(instance(modules.baseline, 2, 8, seed.bytes, seed.used), seed.root, depth, index);
      assert.deepEqual(events.filter(e => e.kind === 4).map(e => e.address), role === 'baseline' ? sourcePath : sourcePath.toReversed());
    }
    mechanism.push({ role, depth, mode, operation, pointer, allocated: item.api.getHeapEnd() - seed.used, ...counts, copiedOrFilledBytes: copiedBytes, events });
  }
}

// Failure traces distinguish failed request, partially consumed allocations,
// changed unpublished bytes, and backing growth. Successful snapshots survive.
const failures = [];
for (const depth of [0, 1, 2, 3, 5]) for (const remaining of [0, 4, 128, 256, 384, 512, 768]) {
  const seed = fixture(depth, 0), used = 2 * PAGE - remaining;
  if (used + 256 + depth * 128 <= 2 * PAGE) continue;
  for (const role of Object.keys(modules)) {
    const item = instance(modules[role], 2, 2, seed.bytes, used), old = u8(item).slice();
    assert.throws(() => item.set(seed.root, depth, 0, 0x4080000000000000n), WebAssembly.RuntimeError);
    assert.deepEqual(u8(item).subarray(0, used), old.subarray(0, used));
    if (role === 'candidate') { assert.equal(item.api.getHeapEnd(), used); assert.deepEqual(u8(item), old); }
    failures.push({ role, depth, remaining, heapDelta: item.api.getHeapEnd() - used, changedBytes: u8(item).reduce((n, byte, i) => n + (byte !== old[i]), 0), backingBytes: item.memory.buffer.byteLength });
  }
}
// A very deep direct-ABI write can span two new pages; main/historical can grow
// once before a later failure, whereas the single reservation fails unchanged.
for (const role of Object.keys(modules)) {
  const item = instance(modules[role], 2, 3, undefined, 2 * PAGE - 128), before = item.api.getHeapEnd();
  assert.throws(() => item.set(0, 600, 0, 0x3ff0000000000000n), WebAssembly.RuntimeError);
  if (role === 'candidate') { assert.equal(item.api.getHeapEnd(), before); assert.equal(item.memory.buffer.byteLength, 2 * PAGE); }
  failures.push({ role, depth: 600, remaining: 128, maximumPages: 3, heapDelta: item.api.getHeapEnd() - before, backingBytes: item.memory.buffer.byteLength });
}
const arithmetic = [];
for (const depth of [Math.floor((0x7fff0000 - 256) / 128) + 1, 0x02000000, 0xffffffff]) {
  const item = instance(instrumented.candidate);
  assert.throws(() => item.set(0, depth, 0, 0n), WebAssembly.RuntimeError);
  assert.equal(item.api.getHeapEnd(), PAGE); assert.deepEqual(item.events, []);
  arithmetic.push({ depth, earlyTrap: true, allocatorCalls: 0 });
}
const manifest = { schema: 'vector-path-reservation-correctness/v1', baseline: BASELINE_COMMIT, historical, node: process.version,
  noTimings: true, sourceScope: 'vecSetAt and vecSet only; tailSet and all other core bytes equal main', abi: abi(modules.candidate), receipts,
  frozenProofFiles: Object.fromEntries(frozenProofFiles.map(file => [file, hash(readFileSync(join(root, 'proofs', file)))])),
  layoutCases: layout.length, mechanismCases: mechanism.length, failureCases: failures.length, arithmeticCases: arithmetic.length };
for (const [name, value] of Object.entries({ manifest, layout, mechanism, failures, arithmetic })) writeFileSync(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
