/** Exact scalar/SIMD differential and emitted-code inspection; no timings. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const arms = ['scalar', 'simd'];
const modules = arms.map(arm => new WebAssembly.Module(readFileSync(new URL(`../text-aux-${arm}.wasm`, import.meta.url))));
const original = new WebAssembly.Module(readFileSync(new URL('../persistent-core.wasm', import.meta.url)));
const encoder = new TextEncoder();
function pack(term, insensitive) {
  const data = encoder.encode(term), words = new Uint32Array(4), masks = new Uint32Array(4);
  for (let i = 0; i < data.length; i++) {
    words[i >>> 2] |= data[i] << ((i & 3) * 8);
    if (insensitive && data[i] >= 97 && data[i] <= 122) masks[i >>> 2] |= 32 << ((i & 3) * 8);
  }
  return [data.length, ...words, ...masks, insensitive];
}

test('emitted auxiliary modules import only memory and cannot initialize, store, or grow it', () => {
  assert.deepEqual(readFileSync(new URL('../text-aux-scalar.wasm', import.meta.url)),
    readFileSync(new URL('../build/text-aux-experiment/original-reader.wasm', import.meta.url)),
    'The scalar auxiliary control must be byte-identical to the original reader');
  for (let i = 0; i < arms.length; i++) {
    const wat = readFileSync(new URL(`../text-aux-${arms[i]}.wat`, import.meta.url), 'utf8');
    assert.deepEqual(WebAssembly.Module.imports(modules[i]), [{ module: 'env', name: 'memory', kind: 'memory' }]);
    assert.deepEqual(WebAssembly.Module.exports(modules[i]), [
      { name: 'textContains16', kind: 'function' }, { name: 'textContainsBlock16', kind: 'function' }, { name: 'memory', kind: 'memory' },
    ]);
    assert.match(wat, /\(import "env" "memory" \(memory \$0 2 65536 shared\)\)/);
    assert.doesNotMatch(wat, /\((?:start|data|global)\b|\b(?:[if]\d+|v128)\.(?:store\w*|atomic[\w.]*)\b|\bmemory\.(?:grow|fill|copy|init)\b/);
    if (arms[i] === 'simd') {
      for (const instruction of ['v128.load', 'i8x16.eq', 'i8x16.bitmask']) assert.ok(wat.includes(instruction));
    } else assert.doesNotMatch(wat, /\bv128\b|\bi8x16\b/);
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 3, shared: true });
    const bytes = new Uint8Array(memory.buffer); bytes.fill(0xa5);
    const before = bytes.slice(), extent = memory.buffer.byteLength;
    assert.equal(new WebAssembly.Instance(modules[i], { env: { memory } }).exports.memory, memory);
    assert.equal(memory.buffer.byteLength, extent);
    assert.deepEqual(bytes, before, 'Instantiation must not write imported memory');
  }
});

test('exact return values agree at 15/16/17 starts, alignments, residual loops, and Unicode tails', () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const kernels = [original, ...modules].map(module => new WebAssembly.Instance(module, { env: { memory } }).exports);
  const bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
  let checks = 0;
  for (let size = 1; size <= 16; size++) for (const insensitive of [false, true]) {
    const needle = 'a'.repeat(size - 1) + 'b', args = pack(needle, insensitive);
    for (const starts of [0, 1, 7, 8, 9, 15, 16, 17, 23, 24, 25, 31, 32, 33, 47, 48, 49]) {
      const length = size - 1 + starts;
      const cases = ['x'.repeat(length), 'a'.repeat(length)];
      for (const hit of [0, 7, 8, 14, 15, 16, 17, 23, 24, 31, 32, starts - 1]) {
        if (hit < 0 || hit >= starts) continue;
        for (const found of [needle, needle.toUpperCase()]) cases.push('x'.repeat(hit) + found + 'x'.repeat(starts - hit - 1));
      }
      // Non-ASCII only in the final verifier-only tail, vector prefix, or
      // scalar remainder must all request -1 after an insensitive miss.
      for (const prefix of [0, 7, 15, 16, 17, 23, 24, 31, 32, length]) cases.push('x'.repeat(prefix) + '中');
      cases.push('中' + needle, needle + '中', 'K', 'İ', '\ufeff', '\0');
      for (let gap = 0; gap < 16; gap++) for (const input of cases) {
        const data = encoder.encode(input), raw = bytes.length - gap - data.length - 4;
        view.setUint32(raw, data.length, true); bytes.set(data, raw + 4);
        const before = bytes.slice(raw), expected = kernels[0].textContains16(raw, ...args);
        for (const kernel of kernels.slice(1)) assert.equal(kernel.textContains16(raw, ...args), expected,
          JSON.stringify({ size, insensitive, starts, gap, input }));
        assert.deepEqual(bytes.subarray(raw), before);
        checks++;
      }
    }
  }
  for (const kernel of kernels) for (const size of [0, 17, 0xffffffff]) {
    assert.equal(kernel.textContains16(bytes.length, size, 0,0,0,0, 0,0,0,0, true), -1);
  }
  assert.ok(checks > 200000);
  console.log(JSON.stringify({ exactReturnCases: checks, arms: ['core', ...arms] }));
});

test('full batch flags equal core for all short counts, including the final row-address byte', () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const kernels = [original, ...modules].map(module => new WebAssembly.Instance(module, { env: { memory } }).exports);
  const bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
  for (let size = 1; size <= 16; size++) for (const insensitive of [false, true]) {
    const needle = 'a'.repeat(size - 1) + 'b', args = pack(needle, insensitive);
    const strings = [needle, '', '中', 'x'.repeat(15) + needle, 'x'.repeat(16) + needle, 'x'.repeat(17) + needle,
      'x'.repeat(23) + needle, 'x'.repeat(24) + needle, 'x'.repeat(25) + needle, 'a'.repeat(80), 'x'.repeat(48) + '中',
      needle.toUpperCase(), 'x'.repeat(33) + '中', 'K', '中' + needle, 'x'.repeat(47) + '中'];
    let pointer = 65536;
    const pointers = strings.map(input => {
      const data = encoder.encode(input), raw = pointer;
      view.setUint32(raw, data.length, true); bytes.set(data, raw + 4); pointer += 4 + data.length;
      return raw;
    });
    for (let count = 1; count <= 16; count++) {
      const address = bytes.length - count * 8;
      for (let i = 0; i < count; i++) view.setFloat64(address + i * 8, pointers[i], true);
      const before = bytes.slice(), expected = kernels[0].textContainsBlock16(address, count, ...args) >>> 0;
      for (const kernel of kernels.slice(1)) assert.equal(kernel.textContainsBlock16(address, count, ...args) >>> 0, expected);
      assert.deepEqual(bytes, before);
    }
  }
  for (const kernel of kernels) {
    for (const count of [0, 17, 0xffffffff]) assert.equal(kernel.textContainsBlock16(bytes.length, count, 1, 0,0,0,0, 0,0,0,0, true), 0);
    for (const size of [0, 17, 0xffffffff]) assert.equal(kernel.textContainsBlock16(bytes.length, 16, size, 0,0,0,0, 0,0,0,0, true), 0);
  }
});
