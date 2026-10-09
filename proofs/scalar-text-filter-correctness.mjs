/** Untimed exact-return, memory-boundary, and artifact checks for this experiment. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Bun's node:test shim requires its separate runner. These synchronous proofs
// can execute directly under Bun while Node retains its standard test runner.
const test = globalThis.Bun ? (name, check) => { check(); console.log(JSON.stringify({ test: name, ok: true })); }
  : (await import('node:test')).default;
const root = new URL('../', import.meta.url);
const files = ['build/scalar-text-filter/baseline-core.wasm', 'persistent-core.wasm'];
const binaries = files.map(file => readFileSync(new URL(file, root)));
const modules = binaries.map(binary => new WebAssembly.Module(binary));
const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
const kernels = modules.map(module => new WebAssembly.Instance(module, { env: { memory } }).exports);
const guarded = new WebAssembly.Module(readFileSync(new URL('build/scalar-text-filter/guarded-reader.wasm', root)));
kernels.push(new WebAssembly.Instance(guarded, { env: { memory, abort() { throw new Error('String-bounds assertion failed'); } } }).exports);
const bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer), encoder = new TextEncoder();
let exactCases = 0, batchCases = 0;
function packed(query, masks, insensitive) {
  const q = new Uint32Array(4), m = new Uint32Array(4);
  for (let i = 0; i < query.length; i++) {
    q[i >>> 2] |= query[i] << ((i & 3) * 8);
    m[i >>> 2] |= masks[i] << ((i & 3) * 8);
  }
  return [query.length, ...q, ...m, insensitive];
}
function oracle(data, query, masks, insensitive) {
  starts: for (let i = 0; i + query.length <= data.length; i++) {
    for (let j = 0; j < query.length; j++) if ((data[i + j] | masks[j]) !== query[j]) continue starts;
    return 1;
  }
  return insensitive && data.some(byte => byte > 127) ? -1 : 0;
}
function check(data, query, masks, insensitive, gap) {
  const raw = bytes.length - gap - data.length - 4;
  view.setUint32(raw, data.length, true); bytes.set(data, raw + 4);
  const before = bytes.slice(raw), args = packed(query, masks, insensitive), expected = oracle(data, query, masks, insensitive);
  for (let i = 0; i < kernels.length; i++) assert.equal(kernels[i].textContains16(raw, ...args), expected,
    JSON.stringify({ arm: i, size: query.length, data: [...data], query: [...query], masks: [...masks], insensitive, gap }));
  assert.deepEqual(bytes.subarray(raw), before);
  exactCases++;
}
function leb(binary, cursor) {
  let result = 0, shift = 0, byte;
  do { byte = binary[cursor.i++]; result += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
  return result;
}
function sections(binary) {
  const cursor = { i: 8 }, result = new Map();
  while (cursor.i < binary.length) {
    const id = binary[cursor.i++], size = leb(binary, cursor), start = cursor.i;
    assert.ok(!result.has(id) || id === 0); result.set(id, binary.subarray(start, start + size)); cursor.i += size;
  }
  return result;
}
function exportsByIndex(binary) {
  const cursor = { i: 0 }, result = new Map(), count = leb(binary, cursor);
  for (let i = 0; i < count; i++) {
    const n = leb(binary, cursor), name = binary.subarray(cursor.i, cursor.i + n).toString(); cursor.i += n;
    const kind = binary[cursor.i++], index = leb(binary, cursor);
    if (kind === 0) result.set(index, name);
  }
  return result;
}
function bodies(binary) {
  const cursor = { i: 0 }, count = leb(binary, cursor), result = [];
  for (let i = 0; i < count; i++) { const size = leb(binary, cursor); result.push(binary.subarray(cursor.i, cursor.i + size)); cursor.i += size; }
  assert.equal(cursor.i, binary.length); return result;
}
test('core imports, exports, all non-code sections, and unrelated functions are unchanged', () => {
  assert.deepEqual(WebAssembly.Module.imports(modules[1]), WebAssembly.Module.imports(modules[0]));
  assert.deepEqual(WebAssembly.Module.exports(modules[1]), WebAssembly.Module.exports(modules[0]));
  assert.ok(!WebAssembly.Module.imports(modules[0]).some(item => item.kind === 'function'));
  const base = sections(binaries[0]), next = sections(binaries[1]);
  assert.deepEqual([...next.keys()], [...base.keys()]);
  for (const [id, data] of base) if (id !== 0 && id !== 10) assert.deepEqual(next.get(id), data, `section ${id}`);
  const names = exportsByIndex(base.get(7)), a = bodies(base.get(10)), b = bodies(next.get(10));
  assert.equal(a.length, b.length);
  const changed = a.flatMap((body, i) => body.equals(b[i]) ? [] : [{ index: i, name: names.get(i), baselineBytes: body.length, candidateBytes: b[i].length }]);
  assert.deepEqual(changed.map(item => item.name).sort(), ['textContains16']);
  console.log(JSON.stringify({ unchangedFunctions: a.length - changed.length, changed, baselineBytes: binaries[0].length, candidateBytes: binaries[1].length }));
});
test('boundaries, dense prefixes, ASCII fold masks, and Unicode fallback agree with a byte oracle', () => {
  for (let size = 1; size <= 16; size++) for (const insensitive of [false, true]) {
    const query = encoder.encode('a'.repeat(size - 1) + 'b'), masks = new Uint8Array(size).fill(insensitive ? 32 : 0);
    for (const starts of [0, 1, 7, 8, 9, 15, 16, 17, 23, 24, 25, 31, 32, 33, 47, 48, 49]) {
      const length = size - 1 + starts;
      const inputs = ['x'.repeat(length), 'a'.repeat(length)];
      for (const hit of [0, 1, 6, 7, 8, 14, 15, 16, 17, 23, 24, 31, 32, starts - 1]) if (hit >= 0 && hit < starts) {
        for (const padding of ['x', 'a']) for (const needle of [new TextDecoder().decode(query), new TextDecoder().decode(query).toUpperCase()]) {
          inputs.push(padding.repeat(hit) + needle + padding.repeat(starts - hit - 1));
        }
      }
      for (const prefix of [0, 7, 8, 15, 16, 17, 23, 24, 31, 32, length]) inputs.push('a'.repeat(prefix) + '中');
      inputs.push('K', 'İ', '\ufeff', '\0', '中' + new TextDecoder().decode(query), new TextDecoder().decode(query) + '中');
      for (let gap = 0; gap < 16; gap++) for (const input of inputs) check(encoder.encode(input), query, masks, insensitive, gap);
    }
  }
});
test('all byte values at every query position include punctuation, zero, and SWAR borrow cases', () => {
  for (let size = 2; size <= 16; size++) for (let at = 0; at < size; at++) for (let code = 0; code < 256; code++) for (const insensitive of [false, true]) {
    const query = new Uint8Array(size).fill(97), masks = new Uint8Array(size).fill(insensitive ? 32 : 0);
    query[size - 1] = 98; query[at] = code;
    // Actual API only folds a query's ASCII letters.
    for (let j = 0; j < size; j++) masks[j] = insensitive && query[j] >= 97 && query[j] <= 122 ? 32 : 0;
    const data = new Uint8Array(size + 24).fill(97);
    data.set(query, code & 15);
    for (let j = 0; j < size; j++) if (masks[j] && (code & 1)) data[(code & 15) + j] -= 32;
    check(data, query, masks, insensitive, code & 15);
    data[(code & 15) + at] ^= 1; // Neighboring-byte borrow can set a false candidate bit.
    check(data, query, masks, insensitive, code & 15);
  }
});
test('seeded arbitrary byte data and independent masks preserve exact return values', () => {
  let seed = 0x1ad219d; const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let n = 0; n < 40000; n++) {
    const size = 1 + random() % 16, length = random() % 160, data = Uint8Array.from({ length }, () => random() & 255);
    const masks = Uint8Array.from({ length: size }, () => random() % 2 ? 32 : 0);
    const query = Uint8Array.from({ length: size }, (_, i) => (random() & 255) | masks[i]);
    if (n % 2 && length >= size) data.set(query, random() % (length - size + 1));
    check(data, query, masks, !!(n & 2), random() % 16);
  }
});
test('batch flags and invalid inputs preserve exact results without writing memory', () => {
  for (let size = 1; size <= 16; size++) for (const insensitive of [false, true]) {
    const query = encoder.encode('a'.repeat(size - 1) + 'b'), masks = new Uint8Array(size).fill(insensitive ? 32 : 0), args = packed(query, masks, insensitive);
    const needle = new TextDecoder().decode(query);
    const inputs = [needle, '', '中', 'a'.repeat(7) + needle, 'a'.repeat(8) + needle, 'a'.repeat(9) + needle,
      'a'.repeat(15) + needle, 'a'.repeat(16) + needle, 'a'.repeat(17) + needle, 'a'.repeat(80), 'x'.repeat(48) + '中',
      needle.toUpperCase(), 'a'.repeat(33) + '中', 'K', '中' + needle, 'a'.repeat(47) + '中'].map(input => encoder.encode(input));
    let pointer = 65536;
    const pointers = inputs.map(data => { const raw = pointer; view.setUint32(raw, data.length, true); bytes.set(data, raw + 4); pointer += data.length + 4; return raw; });
    for (let count = 1; count <= 16; count++) {
      const address = bytes.length - count * 8; let expected = 0;
      for (let i = 0; i < count; i++) {
        view.setFloat64(address + i * 8, pointers[i], true);
        const result = oracle(inputs[i], query, masks, insensitive);
        if (result > 0) expected |= 1 << i; else if (result < 0) expected |= 1 << (i + 16);
      }
      const before = bytes.slice();
      for (const kernel of kernels) assert.equal(kernel.textContainsBlock16(address, count, ...args) >>> 0, expected >>> 0);
      assert.deepEqual(bytes, before); batchCases++;
    }
  }
  for (const kernel of kernels) for (const size of [0, 17, 0xffffffff]) {
    assert.equal(kernel.textContains16(bytes.length, size, 0,0,0,0, 0,0,0,0, true), -1);
    assert.equal(kernel.textContainsBlock16(bytes.length, 16, size, 0,0,0,0, 0,0,0,0, true), 0);
  }
  for (const kernel of kernels) for (const count of [0, 17, 0xffffffff]) assert.equal(kernel.textContainsBlock16(bytes.length, count, 1, 0,0,0,0, 0,0,0,0, true), 0);
  console.log(JSON.stringify({ exactCases, batchCases, arms: [...files, 'guarded-reader.wasm'], independentByteOracle: true, logicalBoundsAssertions: true, memoryBytes: bytes.length }));
});
