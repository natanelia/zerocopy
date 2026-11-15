// Deterministic format/behavior proof; this is intentionally not a benchmark.
// Build both checkouts first, then:
// node proofs/rust-migration-20261115/parity.mjs [AS_CHECKOUT] [RUST_CHECKOUT]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const candidateRoot = resolve(process.argv[3] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const baselineRoot = resolve(process.argv[2] ?? resolve(candidateRoot, '../zerocopy-rust-baseline'));
const baselineCommit = 'b4c08def84b905026632bfd27612da4efef0a3f0';
const seed = 0x61b4c08d;
let randomState = seed;
function random() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return randomState >>> 0;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const checks = { equal: 0, directCalls: 0, byteComparisons: 0, immutablePrefixes: 0, readOnlyMemories: 0, crossAttachments: 0 };
const groups = [];
function equal(actual, expected, label) { checks.equal++; assert.deepStrictEqual(actual, expected, label); }
function bytesEqual(actual, expected, label) {
  checks.byteComparisons++;
  equal(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength), label);
}
function hashBytes(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}
function normalize(key) { return decoder.decode(encoder.encode(key)); }
function byteOrder(a, b) { return Buffer.compare(encoder.encode(a), encoder.encode(b)); }
function orderedEntries(model) { return [...model].sort((a, b) => byteOrder(a[0], b[0])); }
function depthFor(size) { let depth = 0, capacity = 32; while (size > capacity) { capacity *= 32; depth++; } return depth; }
function numericValue(i) {
  return [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, -1.25, i * 0.125][i % 9];
}

const moduleFiles = ['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'];
const modules = [baselineRoot, candidateRoot].map(root => Object.fromEntries(moduleFiles.map(file => {
  const bytes = readFileSync(resolve(root, file));
  return [file, { module: new WebAssembly.Module(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }];
})));
equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baselineRoot, encoding: 'utf8' }).trim(), baselineCommit, 'baseline source commit');
for (const file of moduleFiles) {
  const existing = WebAssembly.Module.exports(modules[0][file].module).map(item => [item.name, item.kind]);
  const migrated = new Map(WebAssembly.Module.exports(modules[1][file].module).map(item => [item.name, item.kind]));
  for (const [name, kind] of existing) equal(migrated.get(name), kind, `${file}: retained export ${name}`);
}

class Pair {
  constructor() {
    this.memories = [0, 1].map(() => new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true }));
    this.exports = this.memories.map((memory, side) => new WebAssembly.Instance(modules[side]['persistent-core.wasm'].module, { env: { memory } }).exports);
    this.overlays = 0;
  }
  view(side) { return new DataView(this.memories[side].buffer); }
  bytes(side) { return new Uint8Array(this.memories[side].buffer); }
  call(name, ...args) {
    checks.directCalls++;
    const results = this.exports.map(exports => exports[name](...args));
    equal(results[1], results[0], `${name}(${args.map(String).join(',')})`);
    return results[0];
  }
  trap(name, ...args) {
    for (const exports of this.exports) assert.throws(() => exports[name](...args), WebAssembly.RuntimeError, `${name} must trap`);
  }
  u32(address, value) { for (let side = 0; side < 2; side++) this.view(side).setUint32(address, value, true); }
  f64(address, value) { for (let side = 0; side < 2; side++) this.view(side).setFloat64(address, value, true); }
  put(address, bytes) { for (let side = 0; side < 2; side++) this.bytes(side).set(bytes, address); }
  stage(key, value) {
    const bytes = typeof key === 'string' ? encoder.encode(key) : key;
    this.put(16384, bytes);
    if (value !== undefined) this.f64(16376, value);
    return bytes;
  }
  leaf(key, value, hash) {
    const bytes = typeof key === 'string' ? encoder.encode(key) : key;
    const leaf = this.call('mapLeaf', bytes.length, 8) >>> 0;
    this.u32(leaf + 4, hash ?? hashBytes(bytes));
    this.put(leaf + 16, bytes);
    this.f64(leaf + 16 + bytes.length, value);
    return leaf;
  }
  payload(label) {
    const end = this.call('getHeapEnd') >>> 0;
    bytesEqual(this.bytes(1).subarray(65536, end), this.bytes(0).subarray(65536, end), `${label}: exact published byte layout`);
    return end;
  }
  protect() {
    const end = this.call('getHeapEnd') >>> 0;
    const old = this.memories.map((_, side) => this.bytes(side).slice(65536, end));
    return label => {
      checks.immutablePrefixes++;
      for (let side = 0; side < 2; side++) bytesEqual(this.bytes(side).subarray(65536, end), old[side], `${label}: old published bytes side ${side}`);
    };
  }
  markOverlay(root) {
    const tag = root ? this.view(0).getUint32(root, true) : 0;
    if (tag !== 0xffffffff && (tag & 0x80000000)) this.overlays++;
  }
}

function checkMap(pair, root, model, label) {
  equal(pair.call('mapSize', root), model.size, `${label}: size`);
  for (const [key, value] of model) {
    const bytes = pair.stage(key);
    const hash = hashBytes(bytes);
    const leaf = pair.call('mapFind', root, 16384, bytes.length, hash) >>> 0;
    assert(leaf !== 0, `${label}: present ${JSON.stringify(key)}`);
    equal(pair.call('mapNumber', root, 16384, bytes.length, hash), value, `${label}: value ${JSON.stringify(key)}`);
    equal(pair.view(0).getFloat64(leaf + 16 + bytes.length, true), value, `${label}: leaf value`);
    const candidate = pair.call('mapHashCandidate', root, hash) >>> 0;
    assert(candidate !== 0, `${label}: hash candidate`);
    for (const bits of [0, 4, 8, 32]) {
      const prefix = pair.call('mapHashPrefix', root, hash, bits) >>> 0;
      equal(pair.call('mapHashCandidateFrom', prefix, hash, bits), candidate | 0, `${label}: prefix ${bits}`);
    }
  }
  const absent = pair.stage('absent-' + label);
  equal(pair.call('mapFind', root, 16384, absent.length, hashBytes(absent)), 0, `${label}: miss`);
}

function directMaps() {
  const pair = new Pair();
  equal(pair.call('mapSize', 0), 0, 'empty map');
  equal(pair.call('keyBuf'), 0, 'legacy key scratch');
  equal(pair.call('batchBuf'), 1024, 'legacy batch scratch');
  pair.trap('mapLeaf', 0x7ffe0001, 0);
  pair.trap('alloc', 0x80000000);
  pair.trap('setHeapEnd', 65535);
  pair.trap('setHeapEnd', 0x7fff0001);
  const keys = ['', 'a', 'aa', 'a\0b', 'é', 'עברית', '中文', '🚗', '\ufeffbom', '𐀀', '\ue000', 'long-' + 'x'.repeat(257), ...Array.from({ length: 180 }, (_, i) => `key-${i}`)];
  const versions = [{ root: 0, model: new Map() }, { root: 0, model: new Map() }];
  let protect = pair.protect();
  for (let step = 0; step < 900; step++) {
    const slot = random() % versions.length;
    const previous = versions[slot];
    const model = new Map(previous.model);
    const key = keys[random() % keys.length];
    let root = previous.root;
    const operation = step < keys.length ? 0 : random() % 7;
    if (operation <= 2) {
      const value = numericValue(step);
      const bytes = pair.stage(key, value);
      if (operation === 0) root = (pair.call('mapSetNumber', root, bytes.length, model.size) >>> 0) & 0x7fffffff;
      else if (operation === 1) root = pair.call('writeMapNumber', root, bytes.length) >>> 0;
      else root = pair.call('mapInsert', root, pair.leaf(key, value)) >>> 0;
      model.set(key, value);
    } else if (operation === 3 || operation === 4) {
      const bytes = pair.stage(key);
      if (operation === 3) root = pair.call('mapDeleteBytes', root, bytes.length) >>> 0;
      else {
        const leaf = pair.call('mapFind', root, 16384, bytes.length, hashBytes(bytes)) >>> 0;
        root = pair.call('mapDeleteLeaf', root, leaf) >>> 0;
      }
      model.delete(key);
    } else if (operation === 5) {
      const chosen = new Map();
      for (let i = 0; i < 1 + random() % 30; i++) chosen.set(keys[random() % keys.length], numericValue(random()));
      let position = 0;
      for (const [batchKey, value] of chosen) {
        pair.u32(49152 + position++ * 4, pair.leaf(batchKey, value));
        model.set(batchKey, value);
      }
      root = pair.call('mapBatch', root, 49152, chosen.size) >>> 0;
    } else {
      if (versions.length < 8) versions.push({ root, model: new Map(model) });
      root = pair.call('mapBatch', root, 49152, 0) >>> 0;
    }
    versions[slot] = { root, model };
    pair.markOverlay(root);
    equal(pair.call('mapSize', root), model.size, `random map step ${step}`);
    if (step % 75 === 74) {
      protect(`map checkpoint ${step}`);
      pair.payload(`map checkpoint ${step}`);
      for (let i = 0; i < versions.length; i++) checkMap(pair, versions[i].root, versions[i].model, `map ${step} version ${i}`);
      protect = pair.protect();
    }
  }
  protect('map final');
  assert(pair.overlays > 0, 'random map exercise must produce overlay records');
  // Force exact full-hash collision buckets and seven shared hash nibbles.
  let collision = 0;
  const collisionLeaves = [];
  for (let i = 0; i < 12; i++) {
    const leaf = pair.leaf(`collision-${i}`, i, 0x12345678);
    collisionLeaves.push(leaf);
    collision = pair.call('mapInsert', collision, leaf) >>> 0;
  }
  equal(pair.call('mapSize', collision), 12, 'collision bucket size');
  for (let i = 0; i < 12; i++) {
    const bytes = pair.stage(`collision-${i}`);
    equal(pair.call('mapFind', collision, 16384, bytes.length, 0x12345678) >>> 0, collisionLeaves[i], 'full hash collision lookup');
  }
  const collisionSnapshot = collision;
  for (const leaf of collisionLeaves) collision = pair.call('mapDeleteLeaf', collision, leaf) >>> 0;
  equal(collision, 0, 'collision bucket collapses to empty');
  equal(pair.call('mapSize', collisionSnapshot), 12, 'collision snapshot retained');
  let deep = pair.call('mapInsert', 0, pair.leaf('deep-a', 1, 0x11111111)) >>> 0;
  deep = pair.call('mapInsert', deep, pair.leaf('deep-b', 2, 0x21111111)) >>> 0;
  equal(pair.call('mapSize', deep), 2, 'deep hash prefix');
  const deepKey = pair.stage('deep-a');
  deep = pair.call('mapDelete', deep, 16384, deepKey.length, 0x11111111) >>> 0;
  equal(pair.call('mapSize', deep), 1, 'deep path collapses');
  // Full collision batch exercises the shift >= 32 path.
  for (let i = 0; i < 20; i++) pair.u32(49152 + i * 4, pair.leaf(`batch-collision-${i}`, i, 0xdeadbeef));
  const collisionBatch = pair.call('mapBatch', 0, 49152, 20) >>> 0;
  equal(pair.call('mapSize', collisionBatch), 20, 'bulk collision size');
  // Legacy address-zero ABI and empty keys are legal Wasm byte addresses.
  const legacyKey = encoder.encode('legacy\0é');
  const legacy = pair.call('mapInsert', 0, pair.leaf(legacyKey, 42)) >>> 0;
  pair.put(0, legacyKey);
  const legacyLeaf = pair.call('getInfo', legacy, legacyKey.length) >>> 0;
  equal(pair.view(0).getUint32(1024, true), legacyKey.length, 'legacy key length');
  equal(pair.view(0).getUint32(1032, true), legacyLeaf + 16, 'legacy key pointer');
  // Byte commands retain arbitrary payload bytes and unaligned f64 values.
  for (let keyLength = 0; keyLength <= 40; keyLength++) {
    const key = Uint8Array.from({ length: keyLength }, (_, i) => 65 + i % 26);
    const value = Uint8Array.from({ length: keyLength + 3 }, (_, i) => (i * 83) & 255);
    pair.put(16384, key); pair.put(16384 + keyLength, value);
    const packed = pair.call('mapSetBytes', 0, keyLength, value.length, 0) >>> 0;
    equal(packed >>> 31, 1, 'packed inserted flag');
    const leaf = pair.call('mapFind', packed & 0x7fffffff, 16384, keyLength, hashBytes(key)) >>> 0;
    bytesEqual(pair.bytes(0).subarray(leaf + 16 + keyLength, leaf + 16 + keyLength + value.length), value, 'byte payload');
  }
  // Preserve the exact AS u32 saturation followed by low-byte store semantics.
  const castValues = [0, -0, 1, 1.9, -1, -0.5, 255, 255.9, 256, 257, 65535, 4294967295, 4294967296, NaN, Infinity, -Infinity];
  for (const value of castValues) {
    const root = pair.call('stagedWrite', 0, 0, 1, 2166136261, value, 1, 0, 0, 0) >>> 0;
    const saturated = Number.isNaN(value) || value < 0 ? 0 : value > 0xffffffff ? 0xffffffff : Math.trunc(value);
    equal(pair.bytes(0)[root + 16], saturated & 255, 'staged bool conversion parity');
  }
  const final = versions[0];
  const before = pair.memories.map((_, side) => pair.bytes(side).slice());
  const opposite = pair.memories.map((memory, side) => new WebAssembly.Instance(modules[1 - side]['persistent-core.wasm'].module, { env: { memory } }).exports);
  for (let side = 0; side < 2; side++) bytesEqual(pair.bytes(side), before[side], 'instantiation leaves existing memory unchanged');
  for (let side = 0; side < 2; side++) {
    const queries = [];
    for (const [key, value] of final.model) {
      const bytes = encoder.encode(key), hash = hashBytes(bytes);
      // Resolve query addresses with the writer. The cross reader will use
      // immutable leaf bytes after this staging ends.
      pair.stage(key);
      const leaf = pair.exports[side].mapFind(final.root, 16384, bytes.length, hash) >>> 0;
      queries.push([leaf + 16, bytes.length, hash, value]);
    }
    // Owner staging above ends before the cold reader's captured memory check.
    const snapshot = pair.bytes(side).slice();
    equal(opposite[side].mapSize(final.root), final.model.size, 'reader size');
    for (const [address, length, hash, value] of queries) equal(opposite[side].mapNumber(final.root, address, length, hash), value, 'cross-module leaf read');
    opposite[side].mapHashPrefix(final.root, 0x12345678, 8);
    bytesEqual(pair.bytes(side), snapshot, 'cross reader leaves all memory unchanged');
    checks.readOnlyMemories++;
  }
  // Resume each format with the opposite compiler, synchronously and at the
  // recorded frontier. Old reader instances remain valid after this handoff.
  const end = pair.payload('map pre-handoff');
  const unchanged = pair.protect();
  pair.exports = opposite;
  pair.call('setHeapEnd', end);
  const key = pair.stage('cross-writer-added', 918.5);
  const next = (pair.call('mapSetNumber', final.root, key.length, final.model.size) >>> 0) & 0x7fffffff;
  equal(pair.call('mapSize', next), final.model.size + 1, 'opposite compiler append');
  unchanged('cross compiler append');
  pair.payload('map cross compiler append');
  groups.push({ name: 'direct maps', randomizedUpdates: 900, retainedVersions: versions.length, overlayRoots: pair.overlays, forcedCollisionKeys: 32, stagedCastCases: castValues.length });
}

function directRadix() {
  const pair = new Pair();
  const keys = ['', 'a', 'aa', 'aaa', 'a\0', 'é', 'É', '中', '🚙', '𐀀', '\ue000', ...Array.from({ length: 90 }, (_, i) => `prefix-${i.toString(36).padStart(3, '0')}`)];
  let root = 0, model = new Map(), journals = 0;
  const snapshots = [];
  for (let step = 0; step < 500; step++) {
    const key = keys[step < keys.length ? step : random() % keys.length];
    const bytes = pair.stage(key, numericValue(step));
    if (step >= keys.length && random() % 4 === 0) {
      root = pair.call('radixDelete', root, 16384, bytes.length) >>> 0;
      model.delete(key);
    } else {
      root = step & 1 ? pair.call('writeSortedNumber', root, bytes.length) >>> 0
        : pair.call('radixInsert', root, pair.leaf(key, numericValue(step))) >>> 0;
      model.set(key, numericValue(step));
    }
    if (root && pair.view(0).getUint32(root, true) === 0xffffffff) journals++;
    equal(pair.call('radixSize', root), model.size, `radix step ${step} size`);
    if (step % 50 === 49) {
      snapshots.push([root, new Map(model)]);
      for (const [snapshotRoot, snapshotModel] of snapshots) {
        for (const [snapshotKey, value] of snapshotModel) {
          const bytes = pair.stage(snapshotKey);
          const leaf = pair.call('radixFind', snapshotRoot, 16384, bytes.length) >>> 0;
          assert(leaf !== 0, `radix snapshot contains ${snapshotKey}`);
          equal(pair.view(0).getFloat64(leaf + 16 + bytes.length, true), value, 'radix retained value');
        }
      }
      pair.payload(`radix checkpoint ${step}`);
    }
  }
  assert(journals > 0, 'radix updates exercise journals');
  const leaves = keys.map((key, i) => pair.leaf(key, i));
  for (let i = 0; i < leaves.length; i++) pair.u32(49152 + i * 4, leaves[i]);
  const built = pair.call('radixBuild', 49152, leaves.length) >>> 0;
  equal(pair.call('radixSize', built), keys.length, 'radix bulk build');
  for (let i = 0; i < leaves.length; i++) {
    const a = i, b = random() % leaves.length;
    const comparison = pair.call('compareLeaves', leaves[a], leaves[b]);
    equal(Math.sign(comparison), Math.sign(byteOrder(keys[a], keys[b])), 'leaf byte order');
  }
  const protect = pair.protect();
  for (const key of keys) { const bytes = pair.stage(key); root = pair.call('radixDelete', root, 16384, bytes.length) >>> 0; }
  equal(root, 0, 'radix delete to empty');
  protect('radix deletion preserves snapshots');
  pair.payload('radix final');
  groups.push({ name: 'direct radix', randomizedUpdates: 500, retainedVersions: snapshots.length, journalRoots: journals, bulkKeys: leaves.length });
}

function rawList(pair, values) {
  if (!values.length) return { root: 0, depth: 0, tail: 0, size: 0 };
  const input = pair.call('alloc', values.length * 8) >>> 0;
  values.forEach((value, index) => pair.f64(input + index * 8, value));
  const treeSize = (values.length - 1) & ~31, depth = depthFor(treeSize);
  const root = pair.call('vecLink', 0, 0, depth, 0, input, treeSize) >>> 0;
  return { root, depth, tail: input + treeSize * 8, size: values.length };
}

function directNumericAndGeometry() {
  const pair = new Pair();
  const instances = ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'].map(file => pair.memories.map((memory, side) => new WebAssembly.Instance(modules[side][file].module, { env: { memory } }).exports));
  const compare = (exports, name, ...args) => {
    const values = exports.map(instance => instance[name](...args));
    equal(values[1], values[0], `optional ${name}`); return values[0];
  };
  for (const [index, expected] of [[0, Infinity], [1, Infinity], [2, -Infinity], [3, -Infinity]]) {
    equal(compare(instances[2], ['bboxMinX', 'bboxMinY', 'bboxMaxX', 'bboxMaxY'][index]), expected, 'initial bbox state');
  }
  for (const size of [0, 1, 2, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 2048]) {
    const values = Array.from({ length: size }, (_, i) => i % 11 === 0 ? numericValue(i) : (i % 49) - 24.25);
    const list = rawList(pair, values);
    const before = pair.memories.map((_, side) => pair.bytes(side).slice());
    for (const bounds of [[-Infinity, Infinity], [-10, 10], [0, 0], [10, -10], [NaN, 1], [-1, NaN]]) {
      const expected = values.filter(value => value >= bounds[0] && value <= bounds[1]).length;
      for (const exports of instances.slice(0, 2)) equal(compare(exports, 'countInRange', list.root, list.depth, list.tail, list.size, ...bounds), expected, 'range model');
    }
    if (size % 2 === 0) {
      for (const bounds of [[-Infinity, -Infinity, Infinity, Infinity], [-10, -10, 10, 10], [1, 1, -1, -1], [NaN, 0, 10, 10]]) {
        let expected = 0;
        for (let i = 0; i < size; i += 2) expected += +(values[i] >= bounds[0] && values[i] <= bounds[2] && values[i + 1] >= bounds[1] && values[i + 1] <= bounds[3]);
        for (const exports of instances.slice(0, 2)) equal(compare(exports, 'countPointsInBox', list.root, list.depth, list.tail, list.size, ...bounds), expected, 'spatial model');
      }
      compare(instances[2], 'bboxXY', list.root, list.depth, list.tail, list.size);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < size; i += 2) {
        if (values[i] < minX) minX = values[i]; if (values[i + 1] < minY) minY = values[i + 1];
        if (values[i] > maxX) maxX = values[i]; if (values[i + 1] > maxY) maxY = values[i + 1];
      }
      for (const [name, expected] of [['bboxMinX', minX], ['bboxMinY', minY], ['bboxMaxX', maxX], ['bboxMaxY', maxY]]) equal(compare(instances[2], name), expected, `bbox model ${name}`);
      for (let index = 0; index < size; index += 32) compare(instances[2], 'xyLeaf', list.root, list.depth, list.tail, list.size, index);
    } else {
      for (const exports of instances[2]) assert.throws(() => exports.bboxXY(list.root, list.depth, list.tail, list.size), WebAssembly.RuntimeError);
      for (const exports of instances.slice(0, 2).flat()) assert.throws(() => exports.countPointsInBox(list.root, list.depth, list.tail, list.size, 0, 0, 1, 1), WebAssembly.RuntimeError);
    }
    for (let side = 0; side < 2; side++) { bytesEqual(pair.bytes(side), before[side], 'optional readers never write shared memory'); checks.readOnlyMemories++; }
  }
  pair.payload('numeric source vectors');
  groups.push({ name: 'numeric scalar/SIMD and geometry', listSizes: 13, invalidOddCoordinateCases: 7 });
}

async function publicCollections() {
  const apis = await Promise.all([baselineRoot, candidateRoot].map(root => import(pathToFileURL(resolve(root, 'dist/shared.js')).href)));
  for (const api of apis) api.configureMemory({ maximumBytes: 64 * 1024 * 1024 });
  const exportsForTransport = [{}, {}];
  const keyPool = ['', 'a', 'aa', 'a\0b', 'é', 'É', 'עברית', '中文', '🚗', '𐀀', '\ue000', '\ufeff', '\ud800', '\ufffd', 'long'.repeat(80), ...Array.from({ length: 100 }, (_, i) => `row-${i}`)];
  for (const [name, ordered] of [['SharedMap', false], ['SharedOrderedMap', true], ['SharedSortedMap', false]]) {
    let snapshots = apis.map(api => new api[name]('number'));
    let model = new Map();
    const retained = [];
    const verify = (pair, expected, label) => {
      const wanted = ordered ? [...expected] : orderedEntries(expected);
      for (let side = 0; side < 2; side++) {
        let actual = [...pair[side].entries()];
        if (name === 'SharedMap') actual.sort((a, b) => byteOrder(a[0], b[0]));
        equal(actual, wanted, `${label} side ${side}`);
        equal(pair[side].size, expected.size, `${label}: size`);
        for (const key of keyPool) { equal(pair[side].has(key), expected.has(normalize(key)), `${label}: has`); equal(pair[side].get(key), expected.get(normalize(key)), `${label}: get`); }
      }
      equal(pair[1].toWorkerData(), pair[0].toWorkerData(), `${label}: record descriptors`);
    };
    for (let step = 0; step < 550; step++) {
      const key = keyPool[step < keyPool.length ? step : random() % keyPool.length];
      if (step >= keyPool.length && random() % 4 === 0) {
        snapshots = snapshots.map(snapshot => snapshot.delete(key)); model.delete(normalize(key));
      } else {
        const value = numericValue(step);
        snapshots = snapshots.map(snapshot => snapshot.set(key, value)); model.set(normalize(key), value);
      }
      if (step % 55 === 54) {
        retained.push([snapshots, new Map(model)]);
        verify(snapshots, model, `${name} ${step}`);
      }
      if (name === 'SharedMap' && step % 60 === 59) {
        const edits = Array.from({ length: 30 }, (_, i) => [keyPool[(step + i) % keyPool.length], numericValue(step + i)]);
        snapshots = snapshots.map(snapshot => snapshot.setMany(edits));
        edits.forEach(([key, value]) => model.set(normalize(key), value));
      }
    }
    for (const [snapshot, expected] of retained) verify(snapshot, expected, `${name} retained`);
    verify(snapshots, model, `${name} final`);
    exportsForTransport.forEach((out, side) => out[name] = snapshots[side]);
    let empty = snapshots;
    for (const key of model.keys()) empty = empty.map(snapshot => snapshot.delete(key));
    empty.forEach(snapshot => { equal(snapshot.size, 0, `${name} empty`); equal([...snapshot.entries()], [], `${name} empty entries`); });
    empty = empty.map(snapshot => snapshot.set('', 1).delete('').set('again', 2));
    verify(empty, new Map([['again', 2]]), `${name} empty reinsertion`);
    groups.push({ name: `public ${name}`, updates: 550, retainedVersions: retained.length });
  }
  let lists = apis.map(api => new api.SharedList('number'));
  let listModel = [];
  const listVersions = [];
  for (const boundary of [0, 1, 31, 32, 33, 1023, 1024, 1025]) {
    const values = Array.from({ length: boundary - listModel.length }, (_, i) => numericValue(listModel.length + i));
    lists = lists.map(list => list.pushMany(values)); listModel.push(...values);
    listVersions.push([lists, listModel.slice()]);
    lists.forEach(list => equal(list.toArray(), listModel, `list boundary ${boundary}`));
  }
  for (let step = 0; step < 650; step++) {
    const operation = random() % 5;
    if (operation === 0) { const value = numericValue(step); lists = lists.map(list => list.push(value)); listModel.push(value); }
    else if (operation === 1) { const values = Array.from({ length: random() % 40 }, (_, i) => numericValue(step + i)); lists = lists.map(list => list.pushMany(values)); listModel.push(...values); }
    else if (operation === 2) { lists = lists.map(list => list.pop()); listModel.pop(); }
    else if (operation === 3) {
      const index = random() % (listModel.length + 10) - 5, value = numericValue(step);
      lists = lists.map(list => list.set(index, value)); if (index >= 0 && index < listModel.length) listModel[index] = value;
    } else {
      const index = random() % listModel.length;
      const edits = [[0, 123], [31, -5], [32, -6], [1023, 7], [1024, 8], [index, 1], [index, numericValue(step)], [-1, 9], [1.5, 9], [listModel.length, 9], [NaN, 9]];
      lists = lists.map(list => list.setMany(edits));
      for (const [at, value] of edits) if (Number.isInteger(at) && at >= 0 && at < listModel.length) listModel[at] = value;
    }
    if (step % 65 === 64) {
      listVersions.push([lists, listModel.slice()]);
      lists.forEach(list => { equal(list.size, listModel.length, 'list randomized size'); equal(list.toArray(), listModel, 'list randomized contents'); });
      equal(lists[1].toWorkerData(), lists[0].toWorkerData(), 'list descriptor bytes');
    }
  }
  for (const [versions, values] of listVersions) versions.forEach(list => equal(list.toArray(), values, 'retained list version'));
  const forkBase = listVersions[5];
  const forks = forkBase[0].map(list => list.push(901).setMany([[31, 77], [32, 88]]));
  const forkValues = [...forkBase[1], 901]; forkValues[31] = 77; forkValues[32] = 88;
  forks.forEach(list => equal(list.toArray(), forkValues, 'list tail/tree fork'));
  exportsForTransport.forEach((out, side) => out.list = lists[side]);
  groups.push({ name: 'public lists', updates: 650, boundaries: 8, retainedVersions: listVersions.length });

  let linked = apis.map(api => new api.SharedLinkedList('number')), linkedModel = [];
  const linkedSnapshots = [];
  for (let step = 0; step < 450; step++) {
    const operation = linkedModel.length ? random() % 5 : 0;
    const value = numericValue(step);
    if (operation === 0) { linked = linked.map(list => list.append(value)); linkedModel.push(value); }
    else if (operation === 1) { linked = linked.map(list => list.prepend(value)); linkedModel.unshift(value); }
    else if (operation === 2) { linked = linked.map(list => list.removeFirst()); linkedModel.shift(); }
    else {
      const index = random() % linkedModel.length;
      if (operation === 3) { linked = linked.map(list => list.insertAfter(index, value)); linkedModel.splice(index + 1, 0, value); }
      else { linked = linked.map(list => list.removeAfter(index)); if (index + 1 < linkedModel.length) linkedModel.splice(index + 1, 1); }
    }
    if (step % 45 === 44) { linkedSnapshots.push([linked, linkedModel.slice()]); linked.forEach(list => equal(list.toArray(), linkedModel, 'linked randomized contents')); }
  }
  linkedSnapshots.forEach(([versions, model]) => versions.forEach(list => equal(list.toArray(), model, 'linked retained snapshot')));
  exportsForTransport.forEach((out, side) => out.linked = linked[side]);
  groups.push({ name: 'public block lists', updates: 450, retainedVersions: linkedSnapshots.length });

  for (const maxHeap of [false, true]) {
    let heaps = apis.map(api => new api.SharedPriorityQueue('number', { maxHeap }));
    const priorities = [];
    for (let i = 0; i < 300; i++) {
      const priority = i % 31 === 0 ? (i % 2 ? Infinity : -Infinity) : i % 17 === 0 ? -0 : (random() % 51) - 25;
      heaps = heaps.map(heap => heap.enqueue(i, priority)); priorities.push(priority);
      if (i % 30 === 29) equal([...heaps[1].entries()], [...heaps[0].entries()], 'heap topology/values');
    }
    heaps.forEach(heap => assert.throws(() => heap.enqueue(1, NaN), TypeError));
    const originals = heaps;
    const expectedPriorities = priorities.sort((a, b) => maxHeap ? b - a : a - b);
    for (let i = 0; i < 300; i++) {
      equal(heaps[1].peek(), heaps[0].peek(), 'heap equal-priority value behavior');
      equal(heaps[1].peekPriority(), heaps[0].peekPriority(), 'heap exact priority');
      equal(heaps[0].peekPriority() === expectedPriorities[i], true, 'heap priority order model');
      heaps = heaps.map(heap => heap.dequeue());
    }
    heaps.forEach(heap => { equal(heap.size, 0, 'drained heap'); equal(heap.peek(), undefined, 'empty heap peek'); });
    equal([...originals[1].entries()], [...originals[0].entries()], 'retained heap root');
    const key = maxHeap ? 'maxHeap' : 'minHeap';
    exportsForTransport.forEach((out, side) => out[key] = originals[side]);
  }
  groups.push({ name: 'public heaps', inserts: 600, removals: 600, tieAndInfinityCases: true });

  const texts = ['', 'Ascii ONE', 'one-one', 'école', 'CAFÉ', 'עברית', '🚗 route', '\ufeffBOM', 'İstanbul', 'Straße', 'x'.repeat(70) + 'needle', '\ud800'];
  const strings = apis.map(api => new api.SharedList('string').pushMany(Array.from({ length: 96 }, (_, i) => texts[i % texts.length])));
  const textValues = Array.from({ length: 96 }, (_, i) => normalize(texts[i % texts.length]));
  for (const term of ['', 'ONE', 'one', 'é', 'İ', 'straße', '🚗', 'needle', 'x'.repeat(16), 'x'.repeat(17), 'absent']) {
    for (const caseSensitive of [true, false]) {
      const matchers = strings.map(list => list.compileTextSearch(term, { caseSensitive }));
      for (let i = -1; i <= textValues.length; i++) {
        const expected = i >= 0 && i < textValues.length && (caseSensitive ? textValues[i].includes(term) : textValues[i].toLowerCase().includes(term.toLowerCase()));
        matchers.forEach(match => equal(match(i), expected, 'UTF-8 text predicate model'));
      }
    }
  }
  exportsForTransport.forEach((out, side) => out.strings = strings[side]);
  const jsonValues = [{ name: 'é🚗', values: [1, true, null], nested: { a: 'x\ny' } }, [], { '__proto__': null, safe: true }];
  const jsonMaps = apis.map(api => { let map = new api.SharedMap(api.json()); jsonValues.forEach((value, i) => map = map.set(String(i), value)); return map; });
  jsonMaps.forEach(map => jsonValues.forEach((value, i) => equal(map.get(String(i)), JSON.parse(JSON.stringify(value)), 'materialized JSON remains compatible')));
  exportsForTransport.forEach((out, side) => out.json = jsonMaps[side]);
  groups.push({ name: 'public UTF-8 strings and JSON', textPredicates: 22, textRows: 96, jsonRecords: jsonValues.length });

  const summarize = (structures, name) => {
    if (name === 'json') return jsonValues.map((_, i) => structures.json.get(String(i)));
    const value = structures[name];
    if (name === 'list' || name === 'linked' || name === 'strings') return value.toArray();
    const entries = [...value.entries()];
    if (name === 'SharedMap') entries.sort((a, b) => byteOrder(a[0], b[0]));
    return entries;
  };
  for (let source = 0; source < 2; source++) for (const copy of [false, true]) {
    const payload = apis[source].getWorkerData(exportsForTransport[source], { copy });
    const before = payload.arenas.map(arena => new Uint8Array((arena.memory?.buffer ?? arena.copy.buffer), arena.copy?.byteOffset ?? 0, arena.memory ? arena.memory.buffer.byteLength : arena.copy.byteLength).slice());
    const attached = await apis[1 - source].initWorker(structuredClone(payload));
    for (const name of Object.keys(exportsForTransport[source])) equal(summarize(attached, name), summarize(exportsForTransport[source], name), `cross attachment ${source} copy=${copy} ${name}`);
    for (const name of ['SharedMap', 'SharedOrderedMap', 'SharedSortedMap']) assert.throws(() => attached[name].set('reader-write', 1), /read.only/i);
    assert.throws(() => attached.list.push(1), /read.only/i);
    assert.throws(() => attached.minHeap.enqueue(1, 1), /read.only/i);
    if (!copy) {
      for (let i = 0; i < payload.arenas.length; i++) bytesEqual(new Uint8Array(payload.arenas[i].memory.buffer), before[i], 'cross attach + reads leave owner memory unchanged');
      const oldList = summarize(attached, 'list');
      const later = exportsForTransport[source].list.push(999).set(0, 888);
      equal(later.get(0), 888, 'writer advances after reader attachment');
      equal(summarize(attached, 'list'), oldList, 'attached snapshot remains stable after writer advances');
    }
    checks.crossAttachments++;
  }
  groups.push({ name: 'cross-compiler public attachment', directions: 2, transports: ['shared WebAssembly.Memory', 'explicit byte copy'], structuresPerPayload: Object.keys(exportsForTransport[0]).length });
}

directMaps();
directRadix();
directNumericAndGeometry();
await publicCollections();
console.log(JSON.stringify({
  ok: true,
  purpose: 'Correctness, persistent byte layout, and shared-memory reader isolation; no performance claims.',
  node: process.version,
  seed: `0x${seed.toString(16)}`,
  baselineCommit,
  modules: moduleFiles.map(file => ({ file, assemblyScript: { sha256: modules[0][file].sha256, bytes: modules[0][file].bytes }, rust: { sha256: modules[1][file].sha256, bytes: modules[1][file].bytes } })),
  checks,
  groups,
}, null, 2));
