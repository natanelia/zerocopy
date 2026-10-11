import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Untimed equivalence and allocation census. Inputs must be independently built
// baseline/candidate shared-runtime WASM, with the same compiler and flags.
const paths = process.argv.slice(2);
assert.equal(paths.length, 2, 'usage: node proofs/heap-insert-correctness.mjs baseline.wasm candidate.wasm');
const binaries = paths.map(p => readFileSync(p));
const modules = binaries.map(bytes => new WebAssembly.Module(bytes));
const start = 65536;
function arena(module, copy, used) {
  const memory = new WebAssembly.Memory({ initial: Math.max(2, Math.ceil((copy?.length ?? 0) / start)), maximum: 1024, shared: true });
  if (copy) new Uint8Array(memory.buffer).set(copy);
  const wasm = new WebAssembly.Instance(module, { env: { memory } }).exports;
  if (used !== undefined) wasm.setHeapEnd(used);
  return { memory, wasm };
}
function view(a) { return new DataView(a.memory.buffer); }
function bytes(a, end = a.wasm.getHeapEnd()) { return Buffer.from(new Uint8Array(a.memory.buffer, start, end - start)); }
function topology(a, root, allocationStart = Infinity) {
  const d = view(a), pending = [root], nodes = [], fresh = new Set();
  while (pending.length) {
    const p = pending.pop();
    if (!p) { nodes.push(null); continue; }
    const left = d.getUint32(p + 16, true), right = d.getUint32(p + 20, true);
    const rank = d.getUint32(p + 24, true), size = d.getUint32(p + 28, true);
    const lr = left ? d.getUint32(left + 24, true) : 0, rr = right ? d.getUint32(right + 24, true) : 0;
    const ls = left ? d.getUint32(left + 28, true) : 0, rs = right ? d.getUint32(right + 28, true) : 0;
    assert(lr >= rr); assert.equal(rank, rr + 1); assert.equal(size, ls + rs + 1);
    // Compare the actual f64 bits: signed zeros, infinities and raw NaN values.
    nodes.push([d.getBigUint64(p, true).toString(16), d.getBigUint64(p + 8, true).toString(16), rank, size]);
    if (p >= allocationStart) fresh.add(p);
    pending.push(right, left);
  }
  return { nodes, fresh: fresh.size };
}
function promotes(a, root, priority, max) {
  const d = view(a);
  while (root) {
    const existing = d.getFloat64(root, true);
    if (max ? priority > existing : priority < existing) return true;
    root = d.getUint32(root + 20, true);
  }
  return false;
}
const rows = [];
let operations = 0, retainedChecks = 0, promoted = 0, importChecks = 0;
for (const max of [false, true]) for (const kind of ['better', 'worse', 'ties', 'special', 'forks']) {
  const pair = modules.map(m => arena(m));
  const versions = [[0, 0]];
  let seed = 0x12574;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const totals = [0, 0];
  let wins = 0;
  const specials = [-Infinity, Infinity, -0, 0, -1, 1, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE];
  for (let i = 0; i < 512; i++) {
    const parent = kind === 'forks' ? versions[rand() % versions.length] : versions.at(-1);
    const pop = kind === 'forks' && i % 5 === 0;
    const priority = kind === 'better' ? (max ? i : -i) : kind === 'worse' ? (max ? -i : i) : kind === 'ties' ? 0 : specials[rand() % specials.length];
    const value = i % 29 === 0 ? -0 : i % 31 === 0 ? NaN : i;
    const before = pair.map(a => a.wasm.getHeapEnd());
    const old = pair.map(a => bytes(a));
    const win = !pop && promotes(pair[0], parent[0], priority, max);
    const roots = pair.map((a, j) => pop ? a.wasm.heapPop(parent[j], max) : a.wasm.heapInsert(parent[j], priority, value, max));
    const after = pair.map(a => a.wasm.getHeapEnd());
    const allocations = after.map((end, j) => end - before[j]);
    assert.equal(allocations[0] - allocations[1], win ? 32 : 0, `${kind}/${max}/${i}: allocation delta`);
    const shapes = pair.map((a, j) => topology(a, roots[j], before[j]));
    assert.deepEqual(shapes[1].nodes, shapes[0].nodes, `${kind}/${max}/${i}: shape`);
    if (!pop) assert.equal(shapes[1].fresh * 32, allocations[1], 'all new candidate nodes are reachable');
    for (let j = 0; j < 2; j++) {
      assert(bytes(pair[j], before[j]).equals(old[j]), `${kind}/${max}/${i}: published bytes`);
      totals[j] += allocations[j]; retainedChecks++;
    }
    if (win) { wins++; promoted++; }
    operations++;
    versions.push(roots);
  }
  // All retained versions, including old forks, keep their exact shape.
  for (const roots of versions) assert.deepEqual(topology(pair[0], roots[0]).nodes, topology(pair[1], roots[1]).nodes);
  // Read and update both directions with the other version's module and image.
  for (let j = 0; j < 2; j++) {
    const source = pair[j], used = source.wasm.getHeapEnd();
    const copy = new Uint8Array(source.memory.buffer, 0, used).slice();
    const native = arena(modules[j], copy, used), foreign = arena(modules[1 - j], copy, used);
    const root = versions.at(-1)[j], expected = topology(native, root).nodes;
    assert.deepEqual(topology(foreign, root).nodes, expected);
    for (const priority of [-Infinity, -0, Infinity]) {
      const nr = native.wasm.heapInsert(root, priority, 9000, max), fr = foreign.wasm.heapInsert(root, priority, 9000, max);
      assert.deepEqual(topology(foreign, fr).nodes, topology(native, nr).nodes);
      assert.deepEqual(topology(foreign, foreign.wasm.heapPop(fr, max)).nodes, topology(native, native.wasm.heapPop(nr, max)).nodes);
      importChecks++;
    }
  }
  rows.push({ max, kind, operations: 512, promotedInsertions: wins, baselineAllocatedBytes: totals[0], candidateAllocatedBytes: totals[1], savedBytes: totals[0] - totals[1], baselineCapacityBytes: pair[0].memory.buffer.byteLength, candidateCapacityBytes: pair[1].memory.buffer.byteLength });
}
const capacityRows = [];
for (const max of [false, true]) for (const interior of [false, true]) {
  const sign = max ? -1 : 1, available = interior ? 64 : 32;
  const outcomes = modules.map(module => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const wasm = new WebAssembly.Instance(module, { env: { memory } }).exports;
    const a = { memory, wasm };
    let root = wasm.heapInsert(0, 0, 0, max);
    if (interior) { root = wasm.heapInsert(root, sign, 1, max); root = wasm.heapInsert(root, 2 * sign, 2, max); }
    const oldShape = topology(a, root).nodes;
    wasm.setHeapEnd(memory.buffer.byteLength - available);
    const mark = wasm.getHeapEnd(), oldBytes = bytes(a);
    let succeeded = false;
    try { wasm.heapInsert(root, interior ? 1.5 * sign : -sign, 3, max); succeeded = true; }
    catch (e) { assert(e instanceof WebAssembly.RuntimeError); }
    assert(bytes(a, mark).equals(oldBytes));
    assert.deepEqual(topology(a, root).nodes, oldShape);
    assert.equal(wasm.getHeapEnd(), memory.buffer.byteLength);
    return { succeeded, consumedBytes: wasm.getHeapEnd() - mark };
  });
  assert.equal(outcomes[0].succeeded, false);
  assert.equal(outcomes[1].succeeded, true);
  capacityRows.push({ max, interior, availableBytes: available, baseline: outcomes[0], candidate: outcomes[1] });
}
console.log(JSON.stringify({ passed: true, runtime: process.version, bun: process.versions.bun ?? null, wasmSha256: binaries.map(b => createHash('sha256').update(b).digest('hex')), operations, retainedByteChecks: retainedChecks, promotedInsertions: promoted, crossVersionInsertPopChecks: importChecks, rows, capacityRows }, null, 2));
