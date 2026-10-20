import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// This suite checks correctness only. It collects no performance samples.
const root = resolve(process.env.RETAINED_DIR ?? process.argv[2] ?? '.');
const hashes = {
  'stage10-simd.wasm': '94c1c2849be996188673cecded3d3107c71b903b4780d7d73c46798d58b7b219',
  'stage14-simd.wasm': 'f6b02c82ea39c9f9092dc72955faf8aefb370e5747220e237c6baed64c8b7109',
  'stage14-scalar.wasm': '5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95',
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modules = Object.entries(hashes).map(([name, expected]) => {
  const bytes = readFileSync(resolve(root, name));
  assert.equal(hash(bytes), expected, `Wrong binary: ${name}`);
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [{module:'env',name:'memory',kind:'memory'}]);
  return { name, module };
});
const bounds = [[-Infinity, Infinity], [-0, 0], [-Number.MIN_VALUE, Number.MIN_VALUE],
  [Infinity, Infinity], [-Infinity, -Infinity], [-1000, 1000], [1, 1],
  [Number.MAX_VALUE, Infinity], [-Infinity, -Number.MAX_VALUE], [NaN, 1], [0, NaN], [1, -1]];
const edge = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE,
  Number.MAX_VALUE, -Number.MAX_VALUE, 1, -1, 1001, -1001];
let oracleChecks = 0, fixtures = 0, maxArenaBytes = 0;
const check = (actual, expected, message) => { assert.equal(actual, expected, message); oracleChecks++; };
const reference = (values, lo, hi) => values.reduce((sum, x) => sum + Number(x >= lo && x <= hi), 0);

// All pointer nodes have 32 slots. Unused slots point outside memory.
// The final visible leaf or tail ends exactly at the memory boundary.
function fixture(treeCount, tailCount, boundary = 'leaf') {
  assert.ok(treeCount >= 32 && treeCount % 32 === 0);
  assert.ok(tailCount >= 1 && tailCount <= 32);
  const leafCount = treeCount / 32;
  let n = leafCount, nodeBytes = 0;
  while (n > 1) { n = Math.ceil(n / 32); nodeBytes += n * 128; }
  const pages = Math.max(2, Math.ceil((treeCount * 8 + tailCount * 8 + nodeBytes + 4096) / 65536));
  const memory = new WebAssembly.Memory({initial:pages,maximum:pages,shared:true});
  assert.ok(memory.buffer.byteLength <= 64 * 1024 * 1024);
  maxArenaBytes = Math.max(maxArenaBytes, memory.buffer.byteLength);
  new Uint8Array(memory.buffer).fill(0xa5);
  const view = new DataView(memory.buffer), bad = 0xffffff00;
  let pos = 256;
  const reserved = boundary === 'leaf' ? 256 : tailCount * 8;
  const alloc = bytes => { const p = pos; pos += bytes; assert.ok(pos <= memory.buffer.byteLength - reserved); return p; };
  let state = 0x9e3779b9;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const values = [];
  function writeValue(p, index) {
    if (index % 3 === 0) view.setFloat64(p, edge[Math.floor(index / 3) % edge.length], true);
    else { view.setUint32(p, random(), true); view.setUint32(p + 4, random(), true); }
    values.push(view.getFloat64(p, true));
  }
  let nodes = [];
  for (let leaf = 0; leaf < leafCount; leaf++) {
    const p = boundary === 'leaf' && leaf === leafCount - 1 ? memory.buffer.byteLength - 256 : alloc(256);
    nodes.push(p);
    for (let j = 0; j < 32; j++) writeValue(p + j * 8, leaf * 32 + j);
  }
  let depth = 0;
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 32) {
      const p = alloc(128);
      for (let j = 0; j < 32; j++) view.setUint32(p + j * 4, j + i < nodes.length ? nodes[i + j] : bad, true);
      next.push(p);
    }
    nodes = next; depth++;
  }
  const tail = boundary === 'tail' ? memory.buffer.byteLength - tailCount * 8 : alloc(tailCount * 8);
  for (let i = 0; i < tailCount; i++) writeValue(tail + i * 8, treeCount + i);
  return {memory,root:nodes[0],depth,tail,size:treeCount + tailCount,values};
}
function verifyFixture(treeCount, tailCount, boundary) {
  const f = fixture(treeCount, tailCount, boundary);
  const before = Buffer.from(new Uint8Array(f.memory.buffer));
  const expected = bounds.map(([lo, hi]) => reference(f.values, lo, hi));
  for (const {name, module} of modules) {
    const {countInRange} = new WebAssembly.Instance(module, {env:{memory:f.memory}}).exports;
    bounds.forEach(([lo, hi], i) => check(countInRange(f.root,f.depth,f.tail,f.size,lo,hi), expected[i], `${name}/${f.size}/${boundary}/${i}`));
    assert.equal(f.memory.buffer.byteLength, before.length);
    assert.ok(Buffer.from(f.memory.buffer).equals(before), `${name}: changed snapshot bytes`);
  }
  fixtures++;
}

test('depth-two dispatch: below, at and above 2048 published tree values', () => {
  for (const count of [2016, 2048, 2080]) for (let tail = 1; tail <= 32; tail++)
    for (const boundary of ['leaf','tail']) verifyFixture(count, tail, boundary);
});
test('new depth-two branch: every partial final group and every tail length', () => {
  for (let leaves = 1; leaves <= 32; leaves++) for (let tail = 1; tail <= 32; tail++)
    verifyFixture(2048 + leaves * 32, tail, 'leaf');
  for (let groups = 3; groups <= 32; groups++)
    verifyFixture((groups - 1) * 1024 + 32, 1, 'tail');
});
test('deeper recursion: partial depth-two children and depth transitions', () => {
  const counts = [32736,32768,32800,32768+2016,32768+2048,32768+2080,
    65536+2016,65536+2048,65536+2080,1048576,1048576+2016,1048576+2048,1048576+2080];
  for (const count of counts) for (const tail of [1,32]) verifyFixture(count, tail, 'leaf');
});
test('invalid bounds and empty snapshots return before dereferencing poison', () => {
  const memory = new WebAssembly.Memory({initial:2,maximum:2,shared:true});
  const before = Buffer.from(new Uint8Array(memory.buffer));
  for (const {name,module} of modules) {
    const {countInRange} = new WebAssembly.Instance(module,{env:{memory}}).exports;
    for (const [lo,hi] of [[NaN,1],[0,NaN],[1,-1]]) check(countInRange(0xffffff00,2,0xffffff00,2049,lo,hi),0,name);
    check(countInRange(0xffffff00,2,0xffffff00,0,-Infinity,Infinity),0,name);
    assert.ok(Buffer.from(memory.buffer).equals(before));
  }
});
test('public snapshots: dispatch boundaries, read-only attachments and retained forks', {skip:!process.env.MODULE_DIR}, async () => {
  const dir = resolve(process.env.MODULE_DIR);
  const shared = await import(pathToFileURL(resolve(dir,'dist/shared.js')).href);
  const numeric = await import(pathToFileURL(resolve(dir,'dist/numeric.js')).href);
  for (const size of [2047,2048,2049,2050,2079,2080,2081,32768+2017,32768+2049,32768+2081,1048576+2049]) {
    shared.resetSharedList();
    const values = Array.from({length:size},(_,i)=> i % 31 === 0 ? edge[Math.floor(i/31)%edge.length] : (i*7919)%10007-5000);
    const original = new shared.SharedList('number').pushMany(values);
    const data = shared.getWorkerData({original},{copy:false});
    const memory = data.arenas[0].memory;
    maxArenaBytes = Math.max(maxArenaBytes,memory.buffer.byteLength);
    assert.ok(memory.buffer.byteLength <= 64*1024*1024);
    const before = Buffer.from(new Uint8Array(memory.buffer));
    const {original:attached} = await shared.initWorker(data);
    for (const [lo,hi] of bounds) {
      const expected = reference(values,lo,hi);
      check(numeric.countInRange(original,lo,hi),expected,`public/${size}`);
      check(numeric.countInRange(attached,lo,hi),expected,`attached/${size}`);
    }
    assert.ok(Buffer.from(memory.buffer).equals(before));
    assert.throws(()=>attached.push(9999));
    const changed = original.set(0,9999), fork = changed.pop();
    check(numeric.countInRange(original,9999,9999),0);
    check(numeric.countInRange(attached,9999,9999),0);
    check(numeric.countInRange(changed,9999,9999),1);
    check(numeric.countInRange(fork,9999,9999),1);
  }
});
after(()=>console.log('STAGE14-BOUNDARIES',JSON.stringify({oracleChecks,fixtures,maxArenaBytes,binaries:hashes,publicOverlay:!!process.env.MODULE_DIR})));
