import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';

// Experiment only. No production source is changed by this script.
const base = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const out = '.simd-lab';
mkdirSync(out, { recursive: true });
const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
const baseline = readFileSync('persistent-core.as.ts', 'utf8');
const reader = readFileSync('shared-hash-reader.as.ts', 'utf8');
const entry = readFileSync('shared-runtime.as.ts', 'utf8');

export const bytesSource = `// Valid, stable byte spans only. Never read beyond either logical span.
@inline
export function bytesEqual(a: usize, b: usize, n: usize): bool {
  if (a == b) return true;
  if (ASC_FEATURE_SIMD) {
    while (n >= 16) {
      if (v128.any_true(v128.xor(v128.load(a), v128.load(b)))) return false;
      a += 16; b += 16; n -= 16;
    }
  }
  while (n >= 8) {
    if (load<u64>(a) != load<u64>(b)) return false;
    a += 8; b += 8; n -= 8;
  }
  if (n >= 4) { if (load<u32>(a) != load<u32>(b)) return false; a += 4; b += 4; n -= 4; }
  if (n >= 2) { if (load<u16>(a) != load<u16>(b)) return false; a += 2; b += 2; n -= 2; }
  return !n || load<u8>(a) == load<u8>(b);
}
@inline
export function commonPrefix(a: usize, b: usize, n: usize): usize {
  if (a == b) return n;
  let i: usize = 0;
  if (ASC_FEATURE_SIMD) {
    while (n - i >= 16) {
      const mismatch = i8x16.bitmask(i8x16.ne(v128.load(a + i), v128.load(b + i)));
      if (mismatch) return i + <usize>ctz<u32>(mismatch);
      i += 16;
    }
  }
  while (n - i >= 8) {
    const mismatch = load<u64>(a + i) ^ load<u64>(b + i);
    if (mismatch) return i + <usize>(ctz<u64>(mismatch) >> 3);
    i += 8;
  }
  while (i < n && load<u8>(a + i) == load<u8>(b + i)) i++;
  return i;
}
@inline
export function compareBytes(a: usize, b: usize, n: usize): i32 {
  const i = commonPrefix(a, b, n);
  return i == n ? 0 : <i32>load<u8>(a + i) - <i32>load<u8>(b + i);
}
`;
const oldBytes = `export function bytesEqual(a: usize, b: usize, n: usize): bool { return memory.compare(a, b, n) == 0; }
export function compareBytes(a: usize, b: usize, n: usize): i32 { return memory.compare(a, b, n); }
export function commonPrefix(a: usize, b: usize, n: usize): usize {
 let i: usize = 0;
 while (i + 8 <= n && load<u64>(a + i) == load<u64>(b + i)) i += 8;
 while (i < n && load<u8>(a + i) == load<u8>(b + i)) i++;
 return i;
}
`;
const copyFunction = `@inline function copyWords(to: u32, from: u32, bytes: u32): void {
  let i: u32 = 0;
  if (ASC_FEATURE_SIMD) {
    while (bytes - i >= 16) { v128.store(to + i, v128.load(from + i)); i += 16; }
  }
  while (i + 8 <= bytes) { store<u64>(to + i, load<u64>(from + i)); i += 8; }
  if (i < bytes) store<u32>(to + i, load<u32>(from + i));
}`;
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected exactly one patch site: ${before.slice(0, 80)}`);
  return source.replace(before, after);
}
export function patchBytes(source) {
  source = replaceOnce(source,
    'if (count > 16) return memory.compare(a, b, count) == 0;',
    'if (count > 16) return bytesEqual(a, b, count);');
  source = source.replaceAll('memory.compare(', 'compareBytes(');
  source = replaceOnce(source,
    'const limit = min(len, oldLen); let i: u32 = 0;\n  while (i + 8 <= limit && load<u64>(leaf + 16 + i) == load<u64>(old + 16 + i)) i += 8;\n  while (i < limit && load<u8>(leaf + 16 + i) == load<u8>(old + 16 + i)) i++;',
    'const limit = min(len, oldLen), i = <u32>commonPrefix(leaf + 16, old + 16, limit);');
  return "import { bytesEqual, compareBytes, commonPrefix } from './byte-kernels.as';\n" + source;
}
export const numericSource = `// Read-only kernels. No allocator, scratch writes, callbacks, or output buffers.
function spanCount(p: u32, count: u32, lo: f64, hi: f64): u32 {
  let i: u32 = 0, total: u32 = 0;
  if (ASC_FEATURE_SIMD) {
    const lower = f64x2.splat(lo), upper = f64x2.splat(hi);
    let sums = i64x2.splat(0);
    while (count - i >= 2) {
      const values = v128.load(p + i * 8);
      sums = i64x2.sub(sums, v128.and(f64x2.ge(values, lower), f64x2.le(values, upper)));
      i += 2;
    }
    total = <u32>i64x2.extract_lane(sums, 0) + <u32>i64x2.extract_lane(sums, 1);
  }
  for (; i < count; i++) {
    const value = load<f64>(p + i * 8);
    total += <u32>(value >= lo) & <u32>(value <= hi);
  }
  return total;
}
function treeCount(root: u32, depth: u32, count: u32, lo: f64, hi: f64): u32 {
  if (!depth) return spanCount(root, count, lo, hi);
  const capacity: u32 = 1 << (depth * 5);
  let total: u32 = 0, child: u32 = 0;
  while (count) {
    const take = min(count, capacity);
    total += treeCount(load<u32>(root + child * 4), depth - 1, take, lo, hi);
    count -= take; child++;
  }
  return total;
}
export function countInRange(root: u32, depth: u32, tail: u32, size: u32, lo: f64, hi: f64): u32 {
  if (!size || lo > hi || isNaN(lo) || isNaN(hi)) return 0;
  const treeSize = (size - 1) & ~31;
  return (treeSize ? treeCount(root, depth, treeSize, lo, hi) : 0) + spanCount(tail, size - treeSize, lo, hi);
}
export function countSpan(p: u32, count: u32, lo: f64, hi: f64): u32 { return spanCount(p, count, lo, hi); }
`;
const names = ['baseline', 'bytes-scalar', 'bytes-simd', 'copy-scalar', 'copy-simd'];
for (const name of names) {
  const dir = `${out}/${name}`;
  mkdirSync(dir, { recursive: true });
  let source = baseline;
  if (name.startsWith('bytes')) source = patchBytes(source);
  if (name.startsWith('copy')) {
    const old = source.match(/@inline function copyWords\([\s\S]*?\n}/)[0];
    source = replaceOnce(source, old, copyFunction);
    source = source.replaceAll('memory.copy(p, root, bytes)', 'copyWords(p, root, bytes)')
      .replaceAll('memory.copy(p, root, 128)', 'copyWords(p, root, 128)')
      .replaceAll('memory.copy(p, tail, length * 8)', 'copyWords(p, tail, length * 8)');
  }
  const probe = '\nexport function copyProbe(to: u32, from: u32, bytes: u32): void { copyWords(to, from, bytes); }\n';
  writeFileSync(`${dir}/persistent-core.as.ts`, source + probe);
  writeFileSync(`${dir}/shared-hash-reader.as.ts`, reader);
  writeFileSync(`${dir}/byte-kernels.as.ts`, name.startsWith('bytes') ? bytesSource : oldBytes);
  writeFileSync(`${dir}/shared-runtime.as.ts`, entry + "\nexport { bytesEqual, compareBytes, commonPrefix } from './byte-kernels.as';\n");
  execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', `${dir}/shared-runtime.as.ts`, '-o', `${dir}/core.wasm`, '-t', `${dir}/core.wat`, ...flags, ...(name.endsWith('simd') ? ['--enable', 'simd'] : [])], { stdio: 'inherit' });
}
for (const simd of [false, true]) {
  writeFileSync(`${out}/numeric.as.ts`, numericSource);
  execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', `${out}/numeric.as.ts`, '-o', `${out}/numeric-${simd ? 'simd' : 'scalar'}.wasm`, '-t', `${out}/numeric-${simd ? 'simd' : 'scalar'}.wat`, ...flags, ...(simd ? ['--enable', 'simd'] : [])], { stdio: 'inherit' });
}
const modules = Object.fromEntries(names.map(name => [name, new WebAssembly.Module(readFileSync(`${out}/${name}/core.wasm`))]));
function instance(name, memory = new WebAssembly.Memory({ initial: 512, maximum: 65536, shared: true })) {
  const w = new WebAssembly.Instance(modules[name], { env: { memory, abort() { throw new Error('WASM abort'); } } }).exports;
  return { w, memory, bytes: new Uint8Array(memory.buffer), view: new DataView(memory.buffer) };
}
const contexts = Object.fromEntries(names.map(name => [name, instance(name)]));
let checks = 0;
// Exhaustive byte alignments and boundary lengths, with exact first-mismatch checks.
for (const name of names.slice(0, 3)) {
  const { w, bytes } = contexts[name];
  for (let aa = 0; aa < 16; aa++) for (let bb = 0; bb < 16; bb++) {
    for (const n of [0, 1, 2, 3, 4, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 257]) {
      const a = 16384 + aa, b = 18000 + bb;
      for (let i = 0; i < n; i++) bytes[a + i] = bytes[b + i] = (i * 37 + 129) & 255;
      assert.equal(w.bytesEqual(a, b, n), 1); assert.equal(w.compareBytes(a, b, n), 0); assert.equal(w.commonPrefix(a, b, n), n); checks += 3;
      for (const at of new Set([0, n >>> 1, n - 1])) if (at >= 0 && at < n) {
        const before = bytes[b + at]; bytes[b + at] ^= 255;
        assert.equal(w.bytesEqual(a, b, n), 0);
        assert.equal(Math.sign(w.compareBytes(a, b, n)), Math.sign(bytes[a + at] - bytes[b + at]));
        assert.equal(w.commonPrefix(a, b, n), at); bytes[b + at] = before; checks += 3;
      }
    }
  }
  // Last valid bytes of the actual Wasm memory: any vector overread must trap.
  for (let n = 0; n <= 65; n++) {
    const a = bytes.length - n, b = 16384;
    for (let i = 0; i < n; i++) bytes[a + i] = bytes[b + i] = i;
    assert.equal(w.bytesEqual(a, b, n), 1); assert.equal(w.commonPrefix(a, b, n), n); checks += 2;
  }
}
for (const name of ['baseline', 'copy-scalar', 'copy-simd']) {
  const { w, bytes } = contexts[name];
  for (let n = 0; n <= 256; n += 4) for (let offset = 0; offset < 16; offset += 4) {
    const from = 16384 + offset, to = 18000 + offset;
    for (let i = 0; i < n; i++) bytes[from + i] = (i * 13) & 255;
    bytes.fill(231, to - 1, to + n + 1); w.copyProbe(to, from, n);
    assert.deepEqual(bytes.slice(to, to + n), bytes.slice(from, from + n));
    assert.equal(bytes[to - 1], 231); assert.equal(bytes[to + n], 231); checks += 3;
  }
}
console.log('CORRECTNESS_BYTE_COPY', checks);
const median = a => [...a].sort((x, y) => x - y)[a.length >>> 1];
const results = [];
let sink = 0;
function bench(label, candidates, iterations) {
  const entries = Object.entries(candidates), samples = Object.fromEntries(entries.map(([n]) => [n, []]));
  for (let warm = 0; warm < 4; warm++) for (const [, fn] of entries) sink ^= fn(iterations);
  for (let round = 0; round < 13; round++) {
    const order = round % 2 ? [...entries].reverse() : entries;
    for (const [name, fn] of order) {
      const start = performance.now(); const value = fn(iterations); const time = performance.now() - start;
      sink ^= value; samples[name].push(time);
    }
  }
  const medians = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)]));
  const result = { label, iterations, ms: medians, samples };
  results.push(result); console.log('BENCH', JSON.stringify({ label, iterations, ms: medians }));
}
for (const length of [8, 16, 36, 128, 512]) for (const mismatch of ['equal', 'first', 'last']) {
  const candidates = {};
  for (const name of names.slice(0, 3)) {
    const { w, bytes } = contexts[name];
    const a = 16384, b = 18004;
    for (let i = 0; i < length; i++) bytes[a + i] = bytes[b + i] = (i * 37) & 255;
    if (mismatch !== 'equal') bytes[b + (mismatch === 'first' ? 0 : length - 1)] ^= 255;
    candidates[name] = n => { let sum = 0; for (let i = 0; i < n; i++) sum += w.compareBytes(a, b, length); return sum; };
  }
  bench(`compare/${length}/${mismatch}/different-alignments`, candidates, 150000);
}
function hash(bytes) { let h = 2166136261; for (const b of bytes) h = Math.imul(h ^ b, 16777619); return h >>> 0; }
function mapFixture(name, length) {
  const c = instance(name), { w, bytes, view } = c, count = 4096;
  const input = w.alloc(count * 4), queries = [], hashes = [];
  for (let i = 0; i < count; i++) {
    const data = new TextEncoder().encode('lane/'.padEnd(length - 8, 'x') + i.toString(16).padStart(8, '0'));
    const p = w.mapLeaf(data.length, 8); bytes.set(data, p + 16); view.setUint32(p + 4, hash(data), true); view.setFloat64(p + 16 + data.length, i, true); view.setUint32(input + i * 4, p, true);
    const q = w.alloc(data.length + 4) + 4; bytes.set(data, q); queries.push(q); hashes.push(hash(data));
  }
  const root = w.mapBatch(0, input, count);
  for (let i = 0; i < count; i++) { assert.notEqual(w.mapFind(root, queries[i], length, hashes[i]), 0); checks++; }
  return { ...c, root, queries, hashes };
}
for (const length of [16, 36, 128, 512]) {
  const candidates = {};
  for (const name of names.slice(0, 3)) {
    const { w, root, queries, hashes } = mapFixture(name, length);
    candidates[name] = n => { let sum = 0; for (let i = 0; i < n; i++) { const j = (i * 101) & 4095; sum ^= w.mapFind(root, queries[j], length, hashes[j]); } return sum; };
  }
  bench(`mapFind/prepared-copied-keys/${length}`, candidates, 100000);
}
for (const size of [12, 32, 64, 128, 256]) {
  const candidates = {};
  for (const name of ['baseline', 'copy-scalar', 'copy-simd']) {
    const { w, bytes } = contexts[name]; bytes.fill(77, 16384, 16640);
    candidates[name] = n => { for (let i = 0; i < n; i++) w.copyProbe(18000 + ((i & 15) * 256), 16384, size); return bytes[18000 + size - 1]; };
  }
  bench(`copyWords/${size}`, candidates, 200000);
}
function vectorFixture(size, name = 'baseline') {
  const c = instance(name), { w, view } = c;
  const p = w.alloc(size * 8), treeSize = size ? (size - 1) & ~31 : 0;
  let depth = 0, capacity = 32; while (treeSize > capacity) { depth++; capacity *= 32; }
  for (let i = 0; i < size; i++) view.setFloat64(p + i * 8, (i * 7919) % 10007 - 5000, true);
  const root = w.vecLink(0, 0, depth, 0, p, treeSize);
  return { ...c, root, p, depth, tail: p + treeSize * 8, size };
}
for (const size of [32, 1024, 32768]) {
  const candidates = {};
  for (const name of ['baseline', 'copy-scalar', 'copy-simd']) {
    const c = vectorFixture(size, name), { w, root, depth, tail } = c, mark = w.getHeapEnd();
    candidates[name] = n => { let sum = 0; for (let i = 0; i < n; i++) { if (!(i & 255)) w.setHeapEnd(mark); const p = size === 32 ? w.tailSet(tail, 32, i & 31, i) : w.vecSet(root, depth, (i * 17) & (size - 33), i); sum ^= p; } return sum; };
  }
  bench(`immutable-vector-set/${size}`, candidates, 100000);
}
const numericModules = Object.fromEntries(['scalar', 'simd'].map(name => [name, new WebAssembly.Module(readFileSync(`${out}/numeric-${name}.wasm`))]));
function numeric(name, memory) { return new WebAssembly.Instance(numericModules[name], { env: { memory } }).exports; }
for (const size of [0, 1, 2, 3, 15, 16, 17, 31, 32, 33, 63, 65, 1023, 1024, 1025, 32769]) {
  const f = vectorFixture(size);
  if (size) f.view.setFloat64(f.p, NaN, true);
  if (size > 1) f.view.setFloat64(f.p + 8, Infinity, true);
  if (size > 2) f.view.setFloat64(f.p + 16, -Infinity, true);
  for (const lo of [-Infinity, -5000, -0, 100, Infinity, NaN]) for (const hi of [-Infinity, 0, 100, 5000, Infinity, NaN]) {
    let expected = 0; for (let i = 0; i < size; i++) { const v = f.view.getFloat64(f.p + i * 8, true); expected += Number(v >= lo && v <= hi); }
    for (const name of ['scalar', 'simd']) { assert.equal(numeric(name, f.memory).countInRange(f.root, f.depth, f.tail, size, lo, hi), expected); checks++; }
  }
}
for (const size of [32, 1024, 32768, 262144]) {
  const f = vectorFixture(size), { memory, root, depth, tail, p } = f;
  const candidates = {};
  for (const name of ['scalar', 'simd']) {
    const w = numeric(name, memory);
    candidates[name] = n => { let sum = 0; for (let i = 0; i < n; i++) sum += w.countInRange(root, depth, tail, size, -1000 + (i & 7), 1000); return sum; };
  }
  const values = new Float64Array(memory.buffer, p, size);
  candidates['js-contiguous'] = n => { let sum = 0; for (let i = 0; i < n; i++) { const lo = -1000 + (i & 7); for (let j = 0; j < size; j++) sum += Number(values[j] >= lo && values[j] <= 1000); } return sum; };
  bench(`numeric-count-range/${size}`, candidates, Math.max(64, Math.floor(2000000 / size)));
}
const report = { base, runtime: process.version, v8: process.versions.v8, arch: process.arch, platform: process.platform, cpu: cpus()[0].model, checks, sink, results };
writeFileSync(`${out}/results-${process.arch}.json`, JSON.stringify(report, null, 2));
console.log('FINAL', JSON.stringify({ ...report, results: undefined }));
