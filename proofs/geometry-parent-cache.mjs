// Untimed mechanism and exactness proof. Production and instrumented modules are separate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import turfBBox from '@turf/bbox';
import { SharedList, resetSharedList, getWorkerData, initWorker } from '../dist/shared.js';
import { bboxXY } from '../dist/geometry.js';
import { coordinates, bboxReference, pairs, exact, random } from './geometry-fixtures.mjs';

const baseline = '3773c6e519c7c0958da13727ed1082f449f3ee25';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const call = (k, p) => {
  k.bboxXY(p.root, p.depth, p.tail, p.size);
  return [k.bboxMinX(), k.bboxMinY(), k.bboxMaxX(), k.bboxMaxY()];
};
const descriptor = p => getWorkerData({ points: p }, { copy: false }).arenas[0];
const moduleAt = path => new WebAssembly.Module(readFileSync(path));
const kernelFor = (module, memory, probe) => new WebAssembly.Instance(module, { env: { memory }, ...(probe ? { probe } : {}) }).exports;

if (!isMainThread) {
  const { points } = await initWorker(workerData.data);
  const arena = descriptor(points), memory = arena.memory;
  const oldView = new Uint8Array(memory.buffer);
  const before = oldView.slice(), used = arena.used;
  const expected = workerData.expected;
  const gate = new Int32Array(workerData.gate);
  const kernels = [kernelFor(moduleAt(workerData.baselineWasm), memory), kernelFor(moduleAt(workerData.candidateWasm), memory), kernelFor(moduleAt(workerData.candidateWasm), memory)];
  const scan = () => {
    exact(bboxXY(points), expected, 'worker public');
    for (const kernel of kernels) exact(call(kernel, points), expected, 'worker separate instance');
  };
  scan();
  parentPort.postMessage({ kind: 'ready' });
  parentPort.once('message', () => {
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    let beforeCompletion = 0, spanningVisibleGrowth = 0;
    do {
      const bytesBeforeScan = memory.buffer.byteLength;
      scan(); beforeCompletion++;
      if (memory.buffer.byteLength > bytesBeforeScan) spanningVisibleGrowth++;
    } while (Atomics.load(gate, 1) === 0);
    scan();
    assert.equal(descriptor(points).used, used, 'reader allocator state changed');
    assert.deepEqual(oldView.subarray(0, used), before.subarray(0, used), 'retained bytes changed during owner growth');
    const stable = new Uint8Array(memory.buffer).slice(), stableUsed = descriptor(points).used;
    scan();
    assert.equal(descriptor(points).used, stableUsed);
    assert.deepEqual(new Uint8Array(memory.buffer), stable, 'worker scan wrote memory');
    parentPort.postMessage({ kind: 'complete', scansBeforeOwnerCompletionObserved: beforeCompletion, scansSpanningVisibleGrowth: spanningVisibleGrowth, checks: (beforeCompletion + 3) * 4, visibleBytesBefore: before.length, visibleBytesAfter: memory.buffer.byteLength });
  });
} else {
  const output = resolve(process.env.GEOMETRY_PROOF_OUTPUT || '/tmp/zerocopy-geometry-parent-cache-proof');
  mkdirSync(output, { recursive: true });
  const original = execFileSync('git', ['show', `${baseline}:geometry-kernels.as.ts`], { encoding: 'utf8' });
  const candidate = readFileSync('geometry-kernels.as.ts', 'utf8');
  const unchangedSuffix = original.slice(original.indexOf('    const end = p +'));
  assert.equal(candidate.slice(candidate.indexOf('    const end = p +')), unchangedSuffix, 'point loop/result transfer changed');
  assert.equal(candidate.slice(0, candidate.indexOf('export function bboxXY')), original.slice(0, original.indexOf('export function bboxXY')), 'exports/xyLeaf changed');
  for (const file of ['numeric-kernels.as.ts', 'numeric-spatial.as.ts']) assert.equal(readFileSync(file, 'utf8'), execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }));
  const flags = ['--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'];
  function compile(name, source) {
    const path = resolve(output, `${name}.as.ts`), wasm = resolve(output, `${name}.wasm`), wat = resolve(output, `${name}.wat`);
    writeFileSync(path, source);
    execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', path, '-o', wasm, '--textFile', wat, ...flags], { stdio: 'inherit' });
    return { module: moduleAt(wasm), wasm, wat, source: path };
  }
  // Calls here are instrumentation only. The production WAT must contain no calls in bboxXY.
  function instrument(source) {
    source = source.replaceAll('load<u32>(', 'pointer(').replaceAll('load<f64>(', 'coordinate(');
    const replacements = [
      ['if (index >= ((size - 1) & ~31))', 'if (condition(0, index >= ((size - 1) & ~31)))'],
      ['d > 0;', 'condition(1, d > 0);'],
      ['if (base >= ((size - 1) & ~31))', 'if (condition(0, base >= ((size - 1) & ~31)))'],
      ['if (depth == 0)', 'if (condition(2, depth == 0))'],
      ['if ((base & 1023) == 0)', 'if (condition(3, (base & 1023) == 0))'],
      ['d > 1;', 'condition(1, d > 1);'],
      ['base < size;', 'condition(4, base < size);'], ['q < end;', 'condition(5, q < end);'],
      ['if (size & 1)', 'if (condition(6, (size & 1) != 0))'],
      ...['x < lx', 'y < ly', 'x > hx', 'y > hy'].map(c => [`if (${c})`, `if (condition(7, ${c}))`]),
      ['    const end = p +', '    event(1, p, base);\n    const end = p +'],
      ['index: u32): u32 {', 'index: u32): u32 {\n  event(8, 0, 0);'],
    ];
    for (const [from, to] of replacements) source = source.replace(from, to);
    return `@external("probe", "event") declare function event(kind: u32, address: u32, value: u32): void;
@external("probe", "condition") declare function observed(kind: u32, value: bool): void;
@inline function condition(kind: u32, value: bool): bool { observed(kind, value); return value; }
@inline function pointer(p: u32): u32 { const value = load<u32>(p); event(0, p, value); return value; }
@inline function coordinate(p: u32): f64 { event(2, p, 0); return load<f64>(p); }
` + source;
  }
  const baseBuild = compile('baseline', original), candidateBuild = compile('candidate', candidate);
  const probes = [compile('baseline-mechanism', instrument(original)), compile('candidate-mechanism', instrument(candidate))];
  function inspect(build) {
    const wat = readFileSync(build.wat, 'utf8');
    const body = wat.split(/\n (?=\(func )/).find(part => /^\(func \$[^ ]*\/bboxXY /m.test(part));
    assert(body, 'bboxXY WAT body missing');
    const ops = Object.create(null);
    for (const line of body.split('\n')) {
      const opcode = line.trim().match(/^(?:[a-z][a-z0-9]*\.[a-z0-9_]+|call|call_indirect|if|else|end|loop|br|return|select|unreachable)\b/)?.[0];
      if (opcode) ops[opcode] = (ops[opcode] || 0) + 1;
    }
    assert(!/\b(?:i32|i64|f32|f64|v128)\.store/.test(wat), 'geometry module stores to memory');
    assert(!/v128|f64x2/.test(wat), 'geometry module gained SIMD');
    assert.equal(ops.call || 0, 0); assert.equal(ops.call_indirect || 0, 0);
    assert.equal(ops['global.get'] || 0, 0); assert.equal(ops['global.set'], 4);
    assert.equal(ops['f64.load'], 2); assert.equal((ops['f64.lt'] || 0) + (ops['f64.gt'] || 0), 4);
    return { moduleBytes: readFileSync(build.wasm).length, locals: [...body.matchAll(/\(local \$\d+ ([^)]+)\)/g)].map(m => m[1]), opcodes: ops };
  }
  const emitted = { baseline: inspect(baseBuild), candidate: inspect(candidateBuild) };
  // The generated candidate is byte-identical to the public package's module.
  assert.deepEqual(readFileSync(candidateBuild.wasm), readFileSync('geometry-kernels.wasm'));
  const probeState = () => ({ pointers: [], leaves: [], coordinates: [], conditions: Array(8).fill(0), sourceLeafCalls: 0 });
  function runProbe(module, memory, points, onCoordinate) {
    const state = probeState();
    const kernel = kernelFor(module, memory, {
      event(kind, address, value) {
        if (kind === 0) state.pointers.push([address >>> 0, value >>> 0]);
        else if (kind === 1) state.leaves.push([address >>> 0, value >>> 0]);
        else if (kind === 2) { state.coordinates.push(address >>> 0); onCoordinate?.(state.coordinates.length); }
        else if (kind === 8) state.sourceLeafCalls++;
        else throw new Error(`Unexpected event ${kind}`);
      },
      condition(kind) { state.conditions[kind]++; },
    });
    state.bounds = call(kernel, points);
    return state;
  }
  const rows = [];
  let checks = 0, tracedCases = 0, tracedCoordinates = 0;
  const readOnlyChecks = [];
  function verify(points, values, label, traced = true, suppliedMemory) {
    const arena = suppliedMemory ? null : descriptor(points), memory = suppliedMemory || arena.memory;
    const before = new Uint8Array(memory.buffer).slice();
    const expected = bboxReference(values);
    const kernels = [kernelFor(baseBuild.module, memory), kernelFor(candidateBuild.module, memory)];
    for (const k of kernels) { exact(call(k, points), expected, `${label} raw`); checks++; }
    exact(turfBBox({ type: 'MultiPoint', coordinates: pairs(values) }, { recompute: true }), expected, `${label} Turf`); checks++;
    if (arena) { exact(bboxXY(points), expected, `${label} public`); checks++; }
    if (traced) {
      const [a, b] = probes.map(p => runProbe(p.module, memory, points));
      exact(a.bounds, expected, `${label} baseline probe`); exact(b.bounds, expected, `${label} candidate probe`); checks += 2;
      assert.deepEqual(b.leaves, a.leaves, `${label} leaf visitation`);
      assert.deepEqual(b.coordinates, a.coordinates, `${label} coordinate load order`);
      assert.equal(b.coordinates.length, values.length);
      assert.equal(b.conditions[7], values.length * 2);
      assert.equal(a.conditions[7], b.conditions[7]);
      assert.equal(b.conditions[0], a.conditions[0]);
      // Every remaining structural load retains its original relative order.
      let cursor = 0;
      for (const entry of b.pointers) {
        while (cursor < a.pointers.length && (a.pointers[cursor][0] !== entry[0] || a.pointers[cursor][1] !== entry[1])) cursor++;
        assert(cursor < a.pointers.length, `${label} structural load subsequence`); cursor++;
      }
      const summarize = s => ({ pointerLoads: s.pointers.length, tailChecks: s.conditions[0], traversalTests: s.conditions[1], depthTests: s.conditions[2], maskTests: s.conditions[3], addressConditionsExcludingTail: s.conditions[1] + s.conditions[2] + s.conditions[3], leafVisits: s.leaves.length, coordinateLoads: s.coordinates.length, extremaComparisons: s.conditions[7], sourceLeafCalls: s.sourceLeafCalls, leafTraceSha256: hash(JSON.stringify(s.leaves)), coordinateTraceSha256: hash(JSON.stringify(s.coordinates)) });
      rows.push({ label, points: points.size / 2, depth: points.depth, baseline: summarize(a), candidate: summarize(b) });
      tracedCases++; tracedCoordinates += b.coordinates.length;
    }
    assert.equal(memory.buffer.byteLength, before.length, `${label} memory grew during scan`);
    assert.deepEqual(new Uint8Array(memory.buffer), before, `${label} memory changed during scan`);
    if (arena) assert.equal(descriptor(points).used, arena.used, `${label} allocator changed`);
    readOnlyChecks.push(label);
  }
  const counts = [0,1,2,15,16,17,31,32,33,511,512,513,527,528,529,530,16383,16384,16385,16399,16400,16401,16402,131072];
  for (const count of counts) {
    resetSharedList();
    const values = coordinates(913, count);
    const canonical = new SharedList('number').pushMany(values);
    verify(canonical, values, `canonical/${count}`);
    const expectedDepth = count <= 32 ? 0 : count <= 528 ? 1 : count <= 16400 ? 2 : 3;
    assert.equal(canonical.depth, expectedDepth, `actual depth at ${count} points`);
    let fragmented = new SharedList('number');
    for (let offset = 0, step = 0; offset < values.length; step++) {
      const width = [2,30,66,14][step % 4], end = Math.min(values.length, offset + width);
      if (width === 2) for (; offset < end; offset++) fragmented = fragmented.push(values[offset]);
      else { fragmented = fragmented.pushMany(values.slice(offset, end)); offset = end; }
    }
    for (let i = 0; i < values.length; i += 32) fragmented = fragmented.set(i, values[i] + 1).set(i, values[i]);
    verify(fragmented, values, `fragmented-set-push/${count}`);
    const popped = fragmented.pushMany([NaN, Infinity, -Infinity, NaN]).pop().pop().pop().pop();
    verify(popped, values, `popped/${count}`);
    const newer = fragmented.pushMany([1000000, -1000000]).set(0, -1000000);
    verify(fragmented, values, `retained/${count}`);
    const nextValues = [...values, 1000000, -1000000]; nextValues[0] = -1000000;
    verify(newer, nextValues, `fork/${count}`, false);
  }
  // Preserve the full original 4096-seed binary64/reference/Turf input family, untimed.
  resetSharedList();
  for (let seed = 1; seed <= 4096; seed++) {
    const values = coordinates(seed, seed % 257, seed & 1 ? 'random' : 'road');
    if (!(seed % 4)) {
      const rng = random(seed), bytes = new DataView(new ArrayBuffer(8));
      for (let i = 0; i < values.length; i++) { bytes.setUint32(0, rng() * 4294967296, true); bytes.setUint32(4, rng() * 4294967296, true); values[i] = bytes.getFloat64(0, true); }
    }
    verify(new SharedList('number').pushMany(values), values, `seed/${seed}`, false);
    if (!(seed % 256)) resetSharedList();
  }
  for (const values of [[-0,0,0,-0], [0,-0,-0,0], [NaN,1,2,NaN], [Infinity,-Infinity,-Infinity,Infinity], [Number.MIN_VALUE,-Number.MIN_VALUE], [NaN,NaN]]) verify(new SharedList('number').pushMany(values), values, 'special');
  for (const count of [17,33,513,529,16401,131072]) for (const first of [0,15,16,31,511,512,16383,16384]) {
    if (first >= count - 1) continue;
    for (const sign of [1,-1]) {
      const values = Array(count * 2).fill(sign);
      values[first * 2] = -0 * sign; values[(count - 1) * 2] = 0 * sign;
      values[first * 2 + 1] = 0 * sign; values[(count - 1) * 2 + 1] = -0 * sign;
      verify(new SharedList('number').pushMany(values), values, `zero-tie/${count}/${first}/${sign}`, false);
    }
    if (count === 131072) resetSharedList();
  }
  for (const count of [...Array.from({ length: 16 }, (_, i) => i + 1),17,33,513,529,16401]) {
    resetSharedList();
    const values = coordinates(count, count), points = new SharedList('number').pushMany(values), source = descriptor(points);
    const memory = new WebAssembly.Memory({ initial: Math.ceil(source.used / 65536) + 1, maximum: 65536, shared: true });
    new Uint8Array(memory.buffer).set(new Uint8Array(source.memory.buffer, 0, source.used));
    const tailCount = ((points.size - 1) & 31) + 1, tail = memory.buffer.byteLength - tailCount * 8;
    new Uint8Array(memory.buffer, tail, tailCount * 8).set(new Uint8Array(source.memory.buffer, points.tail, tailCount * 8));
    verify({ ...points.toWorkerData(), tail }, values, `last-visible-byte/${count}`, true, memory);
  }
  // The separate probe can deterministically pause before a coordinate load and
  // grow/edit the owner. This checks resume-after-growth without a scheduling claim.
  const midScanGrowth = [];
  for (let variant = 0; variant < probes.length; variant++) {
    resetSharedList();
    const values = coordinates(951, 16401), retained = new SharedList('number').pushMany(values), arena = descriptor(retained);
    const before = new Uint8Array(arena.memory.buffer, 0, arena.used).slice(), bytesBefore = arena.memory.buffer.byteLength;
    let newer, fired = false;
    const result = runProbe(probes[variant].module, arena.memory, retained, loaded => {
      if (loaded !== 1025) return;
      fired = true;
      newer = retained.pushMany(coordinates(952, 131072)).set(0, -1e12);
      assert(arena.memory.buffer.byteLength > bytesBefore);
    });
    assert(fired);
    exact(result.bounds, bboxReference(values), 'deterministic mid-scan growth');
    assert.deepEqual(new Uint8Array(arena.memory.buffer, 0, arena.used), before, 'retained prefix changed');
    exact(bboxXY(retained), bboxReference(values), 'mid-scan retained snapshot');
    assert.equal(bboxXY(newer)[0], -1e12);
    midScanGrowth.push({ variant: variant ? 'candidate' : 'baseline', coordinateLoad: 1025, bytesBefore, bytesAfter: arena.memory.buffer.byteLength });
    checks += 2;
  }
  const oddMemory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
  for (const module of [baseBuild.module, candidateBuild.module]) assert.throws(() => kernelFor(module, oddMemory).bboxXY(0, 0, 131064, 1), WebAssembly.RuntimeError);
  // Calls on different module instances cannot overwrite one another's result globals.
  resetSharedList();
  const a = new SharedList('number').pushMany([-0,0,0,-0]), aMemory = descriptor(a).memory;
  resetSharedList();
  const b = new SharedList('number').pushMany([-9,-8,7,6]), bMemory = descriptor(b).memory;
  const ka = kernelFor(candidateBuild.module, aMemory), kb = kernelFor(candidateBuild.module, bMemory), ka2 = kernelFor(candidateBuild.module, aMemory);
  exact(call(ka, a), [-0,0,-0,0], 'instance a'); exact(call(kb,b), [-9,-8,7,6], 'instance b');
  exact(call(ka2,a), [-0,0,-0,0], 'instance a2');
  exact([ka.bboxMinX(),ka.bboxMinY(),ka.bboxMaxX(),ka.bboxMaxY()], [-0,0,-0,0], 'instance a globals');
  exact(bboxXY(a), [-0,0,-0,0], 'old public arena'); exact(bboxXY(b), [-9,-8,7,6], 'new public arena'); checks += 6;

  function response(worker) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clean(); reject(new Error('Worker response timeout')); }, 30000);
      const message = value => { clean(); resolve(value); }, error = reason => { clean(); reject(reason); }, exit = code => { clean(); reject(new Error(`Worker exited: ${code}`)); };
      function clean() { clearTimeout(timer); worker.off('message',message); worker.off('error',error); worker.off('exit',exit); }
      worker.once('message',message); worker.once('error',error); worker.once('exit',exit);
    });
  }
  const workers = [];
  for (const copy of [false,true]) for (const count of [513,529,16401,131072]) {
    resetSharedList();
    const values = coordinates(951, count), retained = new SharedList('number').pushMany(values), arena = descriptor(retained);
    const gate = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker(new URL(import.meta.url), { workerData: { data: getWorkerData({ points: retained }, { copy }), expected: bboxReference(values), gate: gate.buffer, baselineWasm: baseBuild.wasm, candidateWasm: candidateBuild.wasm } });
    try {
      assert.equal((await response(worker)).kind, 'ready');
      const finished = response(worker); worker.postMessage('scan');
      assert.notEqual(Atomics.wait(gate,0,0,10000), 'timed-out');
      const beforeBytes = arena.memory.buffer.byteLength;
      const newer = retained.pushMany(coordinates(952, 131072)).set(0,-1e12);
      assert(arena.memory.buffer.byteLength > beforeBytes, 'owner did not grow memory');
      Atomics.store(gate,1,1);
      const result = await finished;
      assert.equal(result.kind,'complete'); assert(result.scansBeforeOwnerCompletionObserved > 0);
      if (copy) assert.equal(result.visibleBytesAfter, result.visibleBytesBefore, 'copy reader memory grew');
      else assert(result.visibleBytesAfter > result.visibleBytesBefore, 'shared reader did not observe growth');
      exact(bboxXY(retained), bboxReference(values), 'owner retained');
      assert.equal(bboxXY(newer)[0], -1e12);
      workers.push({ copy, points: count, depth: retained.depth, ownerBytesBefore: beforeBytes, ownerBytesAfter: arena.memory.buffer.byteLength, ...result });
      checks += result.checks + 2;
    } finally { Atomics.store(gate,1,1); await worker.terminate(); }
  }
  const small = rows.find(row => row.label === 'canonical/512'), large = rows.find(row => row.label === 'canonical/131072');
  assert.equal(small.baseline.pointerLoads,31); assert.equal(small.candidate.pointerLoads,31);
  assert.equal(small.baseline.addressConditionsExcludingTail,62); assert.equal(small.candidate.addressConditionsExcludingTail,63);
  assert.equal(large.baseline.pointerLoads,24573); assert.equal(large.candidate.pointerLoads,8703);
  assert.equal(large.baseline.addressConditionsExcludingTail,32764); assert.equal(large.candidate.addressConditionsExcludingTail,17150);
  assert.equal(large.candidate.coordinateLoads,262144); assert.equal(large.candidate.extremaComparisons,524288);
  const report = { baseline, runtime: process.versions, arch: process.arch, timed: false, comparison: 'Object.is', proofSha256: hash(readFileSync(new URL(import.meta.url))), sourceSha256: { baseline: hash(original), candidate: hash(candidate) }, moduleSha256: { baseline: hash(readFileSync(baseBuild.wasm)), candidate: hash(readFileSync(candidateBuild.wasm)) }, checks, tracedCases, tracedCoordinates, readOnlyCases: readOnlyChecks.length, randomSeeds: 4096, rows, workers, midScanGrowth, emitted, limits: ['Untimed mechanism counts are instrumented source evaluations, not optimized machine instructions or throughput.', 'Native actual-worker transport only; no browser or ARM execution in this proof.', 'Worker before-completion scan counts describe a coordinated window. Visible-growth spans are observed separately; precise overlap with an individual Wasm load is not asserted.', 'No exhaustive enumeration of all valid snapshots or input bit patterns.'] };
  writeFileSync(resolve(output, `report-${process.versions.bun ? 'bun' : 'node'}-${process.arch}.json`), JSON.stringify(report,null,2));
  console.log(JSON.stringify({ output, checks, tracedCases, tracedCoordinates, readOnlyCases: readOnlyChecks.length, randomSeeds: 4096, workers: workers.length, small, large },null,2));
}
