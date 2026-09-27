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
  const { p } = await initWorker(workerData);
  parentPort.on('message', () => parentPort.postMessage(bboxXY(p)));
} else {
  const modules = ['geometry-kernels.wasm', 'geometry-kernels-simd.wasm'].map(file => new WebAssembly.Module(readFileSync(file)));
  const memory = getWorkerData({ p: new SharedList('number') }, { copy: false }).arenas[0].memory;
  const kernels = modules.map(module => new WebAssembly.Instance(module, { env: { memory } }).exports);
  const call = (kernel, p) => { kernel.bboxXY(p.root, p.depth, p.tail, p.size); return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()]; };
  let checks = 0;
  function verify(values, label) {
    const p = new SharedList('number').pushMany(values);
    const expected = bboxReference(values);
    exact(turfBBox({ type: 'MultiPoint', coordinates: pairs(values) }, { recompute: true }), expected, `Turf ${label}`);
    exact(call(kernels[0], p), expected, `scalar ${label}`);
    exact(call(kernels[1], p), expected, `SIMD ${label}`);
    exact(bboxXY(p), expected, `public ${label}`);
    checks += 4;
  }
  for (let seed = 1; seed <= 4096; seed++) {
    const count = seed % 257, values = coordinates(seed, count, seed & 1 ? 'random' : 'road');
    // Random binary64 patterns include subnormals, large exponents, infinities,
    // and NaN, rather than only easy uniformly distributed finite coordinates.
    if (!(seed % 4)) {
      const rng = random(seed), bytes = new DataView(new ArrayBuffer(8));
      for (let i = 0; i < values.length; i++) {
        bytes.setUint32(0, rng() * 4294967296, true); bytes.setUint32(4, rng() * 4294967296, true);
        values[i] = bytes.getFloat64(0, true);
      }
    }
    verify(values, `seed=${seed} count=${count}`);
  }
  for (const count of [0,1,2,15,16,17,31,32,33,511,512,513,16383,16384,16385,32769]) verify(coordinates(77, count), `boundary=${count}`);
  for (const values of [[-0,0,0,-0], [0,-0,-0,0], [NaN,1,2,NaN], [Infinity,-Infinity,-Infinity,Infinity], [Number.MIN_VALUE,-Number.MIN_VALUE], [NaN,NaN]]) verify(values, 'special');
  // A complete point can end at the last addressable byte. No padded load.
  const edgeMemory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
  for (const module of modules) {
    const k = new WebAssembly.Instance(module, { env: { memory: edgeMemory } }).exports;
    for (let count = 1; count <= 16; count++) {
      const values = coordinates(count, count), tail = edgeMemory.buffer.byteLength - count * 16;
      new Float64Array(edgeMemory.buffer, tail, count * 2).set(values);
      exact(call(k, { root: 0, depth: 0, tail, size: count * 2 }), bboxReference(values), `memory-boundary=${count}`); checks++;
    }
    assert.throws(() => k.bboxXY(0, 0, 131064, 1));
  }
  // A real worker retains a snapshot while the owner appends and grows memory.
  const old = new SharedList('number').pushMany([0,0,2,3]);
  const worker = new Worker(new URL(import.meta.url), { workerData: getWorkerData({ p: old }, { copy: false }) });
  try {
    const query = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker timeout')), 10000);
      worker.once('error', reject); worker.once('message', value => { clearTimeout(timer); resolve(value); }); worker.postMessage('scan');
    });
    exact(await query(), [0,0,2,3], 'worker original');
    const next = old.pushMany(coordinates(9, 65536)).set(0, -99999);
    exact(await query(), [0,0,2,3], 'worker retained');
    assert.equal(bboxXY(next)[0], -99999);
  } finally { await worker.terminate(); }
  const scalarWat = readFileSync('geometry-kernels.wat', 'utf8');
  const simdWat = readFileSync('geometry-kernels-simd.wat', 'utf8');
  assert(!/v128|f64x2/.test(scalarWat), 'scalar build contains SIMD');
  assert(/f64x2.pmin/.test(simdWat), 'SIMD build lacks vector bounds');
  assert(!/\b(?:i32|i64|f32|f64|v128)\.store/.test(simdWat), 'bounds kernel writes shared memory');
  console.log(`BBOX EXACT: ${checks} exact differential checks; 4096 seeds; Turf 7.4.0; real worker; no epsilon.`);

  const rows = [], median = a => [...a].sort((a,b) => a-b)[a.length >> 1];
  let sink = 0;
  for (const count of [16, 512, 16384, 131072]) for (const kind of ['random', 'road']) {
    const values = coordinates(913, count, kind), p = new SharedList('number').pushMany(values);
    const geojson = { type: 'MultiPoint', coordinates: pairs(values) }, expected = bboxReference(values);
    const functions = {
      'turf-recompute': () => turfBBox(geojson, { recompute: true }),
      'js-flat': () => bboxReference(values),
      'scalar-wasm': () => call(kernels[0], p),
      'simd-wasm': () => call(kernels[1], p),
      'public': () => bboxXY(p),
    };
    for (const [name, fn] of Object.entries(functions)) exact(fn(), expected, `${name} benchmark`);
    const iterations = Math.max(32, Math.floor(2000000 / count)), samples = Object.fromEntries(Object.keys(functions).map(name => [name, []]));
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
    const row = { count, kind, iterations, ms, simdOverScalar: ms['scalar-wasm'] / ms['simd-wasm'], publicOverTurf: ms['turf-recompute'] / ms.public, samples };
    rows.push(row); console.log('BBOX BENCH', JSON.stringify({ ...row, samples: undefined }));
  }
  const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), runtime: process.versions, arch: process.arch, cpu: cpus()[0]?.model, date: new Date().toISOString(), checks, seeds: 4096, warmup: 8, rounds: 21, sourceSha256: createHash('sha256').update(readFileSync('geometry-kernels.as.ts')).digest('hex'), sink, rows };
  mkdirSync('proofs/results', { recursive: true });
  writeFileSync(`proofs/results/geometry-bbox-${process.versions.bun ? 'bun' : 'node'}-${process.arch}.json`, JSON.stringify(report, null, 2));
  if (process.env.PERF_GATE === '1') for (const row of rows.filter(r => r.count >= 16384)) {
    assert(row.simdOverScalar > 1.05, `SIMD gain below 5%: ${row.kind}/${row.count}`);
    assert(row.publicOverTurf > 1.05, `Public gain below 5%: ${row.kind}/${row.count}`);
  }
}
