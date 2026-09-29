import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import turfBBox from '@turf/bbox';
import { SharedList, getWorkerData, initWorker } from '../dist/shared.js';
import { bboxXY } from '../dist/geometry.js';
import { coordinates, bboxReference, pairs, exact, random } from './geometry-fixtures.mjs';

if (!isMainThread) {
  const { points } = await initWorker(workerData);
  parentPort.on('message', () => parentPort.postMessage(bboxXY(points)));
} else {
  const module = new WebAssembly.Module(readFileSync('geometry-kernels.wasm'));
  const memory = getWorkerData({ points: new SharedList('number') }, { copy: false }).arenas[0].memory;
  const kernel = new WebAssembly.Instance(module, { env: { memory } }).exports;
  function call(k, points) {
    k.bboxXY(points.root, points.depth, points.tail, points.size);
    return [k.bboxMinX(), k.bboxMinY(), k.bboxMaxX(), k.bboxMaxY()];
  }
  let checks = 0;
  function verify(values, label) {
    const p = new SharedList('number').pushMany(values);
    const expected = bboxReference(values);
    exact(turfBBox({ type: 'MultiPoint', coordinates: pairs(values) }, { recompute: true }), expected, `Turf ${label}`);
    exact(call(kernel, p), expected, `Wasm ${label}`);
    exact(bboxXY(p), expected, `public ${label}`);
    checks += 3;
  }
  for (let seed = 1; seed <= 4096; seed++) {
    const count = seed % 257, values = coordinates(seed, count, seed & 1 ? 'random' : 'road');
    if (!(seed % 4)) {
      const rng = random(seed), bytes = new DataView(new ArrayBuffer(8));
      for (let i = 0; i < values.length; i++) {
        bytes.setUint32(0, rng() * 4294967296, true);
        bytes.setUint32(4, rng() * 4294967296, true);
        values[i] = bytes.getFloat64(0, true);
      }
    }
    verify(values, `seed=${seed} count=${count}`);
  }
  for (const count of [0,1,2,15,16,17,31,32,33,511,512,513,16383,16384,16385,32769]) verify(coordinates(77, count), `boundary=${count}`);
  for (const values of [[-0,0,0,-0], [0,-0,-0,0], [NaN,1,2,NaN], [Infinity,-Infinity,-Infinity,Infinity], [Number.MIN_VALUE,-Number.MIN_VALUE], [NaN,NaN]]) verify(values, 'special');
  for (const count of [17,33,513,16385]) for (let first = 0; first < 16; first++) {
    const values = Array.from({ length: count * 2 }, () => 1);
    values[first * 2] = -0; values[(count - 1) * 2] = 0;
    values[first * 2 + 1] = 0; values[(count - 1) * 2 + 1] = -0;
    verify(values, `zero-min first=${first} count=${count}`);
    verify(values.map(v => -v), `zero-max first=${first} count=${count}`);
  }
  const edgeMemory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
  const edgeKernel = new WebAssembly.Instance(module, { env: { memory: edgeMemory } }).exports;
  for (let count = 1; count <= 16; count++) {
    const values = coordinates(count, count), tail = edgeMemory.buffer.byteLength - count * 16;
    new Float64Array(edgeMemory.buffer, tail, count * 2).set(values);
    exact(call(edgeKernel, { root: 0, depth: 0, tail, size: count * 2 }), bboxReference(values), `memory-boundary=${count}`);
    checks++;
  }
  assert.throws(() => edgeKernel.bboxXY(0, 0, 131064, 1));
  const old = new SharedList('number').pushMany([0,0,2,3]);
  const worker = new Worker(new URL(import.meta.url), { workerData: getWorkerData({ points: old }, { copy: false }) });
  try {
    const query = () => new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); worker.off('error', onError); worker.off('message', onMessage); worker.off('exit', onExit); };
      const onError = error => { clean(); reject(error); };
      const onMessage = value => { clean(); resolve(value); };
      const onExit = code => { clean(); reject(new Error(`Worker exited before its response: ${code}`)); };
      const timer = setTimeout(() => { clean(); reject(new Error('Worker timeout')); }, 10000);
      worker.once('error', onError); worker.once('message', onMessage); worker.once('exit', onExit);
      worker.postMessage('scan');
    });
    exact(await query(), [0,0,2,3], 'worker original');
    const newer = old.pushMany(coordinates(9, 65536)).set(0, -99999);
    exact(await query(), [0,0,2,3], 'worker retained');
    assert.equal(bboxXY(newer)[0], -99999);
  } finally { await worker.terminate(); }
  const wat = readFileSync('geometry-kernels.wat', 'utf8');
  assert(!/v128|f64x2/.test(wat), 'Accepted bounds implementation must be scalar');
  assert(!/\b(?:i32|i64|f32|f64|v128)\.store/.test(wat), 'Bounds kernel writes shared memory');
  console.log('BBOX BULK EXACT', JSON.stringify({ checks, seeds: 4096, turf: '7.4.0', comparison: 'Object.is', realWorker: true }));

  const rows = [], median = a => [...a].sort((a,b) => a-b)[a.length >> 1];
  let sink = 0;
  for (const count of [16, 512, 16384, 131072]) for (const kind of ['random', 'road', 'late-zero']) {
    const values = kind === 'late-zero' ? Array.from({ length: count * 2 }, (_, i) => i + 1) : coordinates(913, count, kind);
    if (kind === 'late-zero') { values[values.length - 2] = -0; values[values.length - 1] = 0; }
    const p = new SharedList('number').pushMany(values);
    const geojson = { type: 'MultiPoint', coordinates: pairs(values) }, expected = bboxReference(values);
    function sharedIteration() {
      const result = [Infinity, Infinity, -Infinity, -Infinity];
      p.forEach((value, i) => { const axis = i & 1; if (value < result[axis]) result[axis] = value; if (value > result[axis + 2]) result[axis + 2] = value; });
      return result;
    }
    const functions = { turf: () => turfBBox(geojson, { recompute: true }), 'js-flat': () => bboxReference(values), 'shared-forEach': sharedIteration, 'scalar-kernel': () => call(kernel, p), public: () => bboxXY(p) };
    for (const [name, fn] of Object.entries(functions)) exact(fn(), expected, `${name} benchmark`);
    const iterations = Math.max(32, Math.floor(2000000 / count));
    const samples = Object.fromEntries(Object.keys(functions).map(name => [name, []]));
    for (let round = -8; round < 21; round++) {
      const order = Object.keys(functions); if (round & 1) order.reverse();
      for (const name of order) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) sink += functions[name]()[0];
        const elapsed = performance.now() - start;
        if (round >= 0) samples[name].push(elapsed);
      }
    }
    const ms = Object.fromEntries(Object.entries(samples).map(([name, data]) => [name, median(data)]));
    const row = { count, kind, iterations, ms, publicOverTurf: ms.turf / ms.public, publicOverSharedIteration: ms['shared-forEach'] / ms.public, samples };
    rows.push(row); console.log('BBOX BULK BENCH', JSON.stringify({ ...row, samples: undefined }));
  }
  const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), runtime: process.versions, arch: process.arch, cpu: cpus()[0]?.model, date: new Date().toISOString(), checks, seeds: 4096, warmup: 8, rounds: 21, sourceSha256: createHash('sha256').update(readFileSync('geometry-kernels.as.ts')).digest('hex'), sink, rows };
  mkdirSync('proofs/results', { recursive: true });
  writeFileSync(`proofs/results/geometry-bbox-bulk-${process.versions.bun ? 'bun' : 'node'}-${process.arch}.json`, JSON.stringify(report, null, 2));
  // Separate bulk-operation gate. This does not approve the rejected SIMD paths.
  if (process.env.PERF_GATE === '1') for (const row of rows) {
    assert(row.publicOverTurf > 1.05, `Public/Turf gain below 5%: ${row.kind}/${row.count}`);
    assert(row.publicOverSharedIteration > 1.05, `Public/shared iteration gain below 5%: ${row.kind}/${row.count}`);
  }
}
