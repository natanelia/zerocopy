import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Run after building both checkouts. This driver does not write old evidence.
// BASE_DIR=... OUT_FILE=... node proofs/numeric-tree-benchmark.mjs
// MODE=kernels skips the public wrappers during an initial experiment.
const baseDir = resolve(process.env.BASE_DIR ?? '../zerocopy');
const candidateDir = resolve(process.env.CANDIDATE_DIR ?? '.');
const mode = process.env.MODE ?? 'all';
assert.ok(['all', 'kernels', 'public'].includes(mode), 'Unknown MODE');
const sizes = (process.env.SIZES ?? '32,33,1024,1057,32768,32801,262144,1048609').split(',').map(Number);
const warmup = Number(process.env.WARMUP ?? 7);
const rounds = Number(process.env.SAMPLES ?? 21);
const work = Number(process.env.WORK ?? 8_000_000);
assert.ok(rounds > 0 && warmup >= 0 && work > 0 && sizes.every(n => Number.isSafeInteger(n) && n > 0));
const outFile = resolve(process.env.OUT_FILE ?? `proofs/results/numeric-tree-20261017/${process.versions.bun ? 'bun' : 'node'}-${process.arch}.json`);
const median = values => [...values].sort((a, b) => a - b)[values.length >>> 1];
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function gitHead(dir) {
  const entry = resolve(dir, '.git');
  const gitDir = statSync(entry).isDirectory() ? entry : resolve(dir, readFileSync(entry, 'utf8').trim().replace(/^gitdir: /, ''));
  const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  const ref = head.replace(/^ref: /, '');
  const commonDir = existsSync(resolve(gitDir, 'commondir')) ? resolve(gitDir, readFileSync(resolve(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
  for (const root of [gitDir, commonDir]) {
    if (existsSync(resolve(root, ref))) return readFileSync(resolve(root, ref), 'utf8').trim();
  }
  const packed = readFileSync(resolve(commonDir, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${ref}`));
  assert.ok(packed, `Cannot resolve Git HEAD at ${dir}`);
  return packed.split(' ')[0];
}
function metadata(dir) {
  return {
    commit: gitHead(dir),
    files: Object.fromEntries(['numeric-kernels.as.ts', 'numeric-spatial.as.ts', 'numeric.ts', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm'].map(name => [name, hashFile(resolve(dir, name))])),
  };
}
const sourceBefore = { baseline: metadata(baseDir), candidate: metadata(candidateDir), driver: hashFile(new URL(import.meta.url)) };
const sharedBase = await import(pathToFileURL(resolve(baseDir, 'dist/shared.js')).href);
const publicBase = mode === 'kernels' ? null : await import(pathToFileURL(resolve(baseDir, 'dist/numeric.js')).href);
const sharedCandidate = mode === 'kernels' ? null : await import(pathToFileURL(resolve(candidateDir, 'dist/shared.js')).href);
const publicCandidate = mode === 'kernels' ? null : await import(pathToFileURL(resolve(candidateDir, 'dist/numeric.js')).href);
const compiled = {};
for (const [label, dir] of [['baseline', baseDir], ['candidate', candidateDir]]) {
  compiled[label] = Object.fromEntries(['scalar', 'simd'].map(name => [name, new WebAssembly.Module(readFileSync(resolve(dir, `numeric-kernels${name === 'simd' ? '-simd' : ''}.wasm`)))]));
}
let sink = 0;
const results = [];
function measure(name, size, baseline, candidate, expected, iterations) {
  assert.equal(baseline(1), expected);
  assert.equal(candidate(1), expected);
  const samples = { baseline: [], candidate: [] };
  const fns = { baseline, candidate };
  for (let round = -warmup; round < rounds; round++) {
    const order = round & 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const label of order) {
      const start = performance.now();
      const answer = fns[label](iterations);
      const elapsed = performance.now() - start;
      assert.equal(answer, expected * iterations, `${name}/${size}/${label}`);
      sink ^= answer;
      if (round >= 0) samples[label].push(elapsed);
    }
  }
  const pairedRatios = samples.baseline.map((value, i) => value / samples.candidate[i]);
  const ms = { baseline: median(samples.baseline), candidate: median(samples.candidate) };
  const row = { name, size, iterations, ms, speedup: ms.baseline / ms.candidate, pairedMedian: median(pairedRatios), samples, pairedRatios };
  results.push(row);
  console.log('NUMERIC-TREE', JSON.stringify({ ...row, samples: undefined, pairedRatios: undefined }));
}
for (const size of sizes) {
  sharedBase.resetSharedList();
  sharedCandidate?.resetSharedList();
  const values = Array.from({ length: size }, (_, i) => (i * 7919) % 10007 - 5000);
  const list = new sharedBase.SharedList('number').pushMany(values);
  const memory = sharedBase.getWorkerData({ list }, { copy: false }).arenas[0].memory;
  const listCandidate = sharedCandidate ? new sharedCandidate.SharedList('number').pushMany(values) : null;
  const expected = values.reduce((n, value) => n + Number(value >= -1000 && value <= 1000), 0);
  const iterations = Math.max(8, Math.ceil(work / size));
  const instances = Object.fromEntries(Object.entries(compiled).map(([label, modules]) => [label, Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, new WebAssembly.Instance(module, { env: { memory } }).exports]))]));
  if (mode !== 'public') for (const kernel of ['simd', 'scalar']) {
    const fns = Object.fromEntries(['baseline', 'candidate'].map(label => [label, n => {
      const { root, depth, tail } = list;
      let total = 0;
      for (let i = 0; i < n; i++) total += instances[label][kernel].countInRange(root, depth, tail, size, -1000, 1000);
      return total;
    }]));
    measure(`range-${kernel}`, size, fns.baseline, fns.candidate, expected, iterations);
  }
  if (mode !== 'kernels') {
    const baseline = n => { let total = 0; for (let i = 0; i < n; i++) total += publicBase.countInRange(list, -1000, 1000); return total; };
    const candidate = n => { let total = 0; for (let i = 0; i < n; i++) total += publicCandidate.countInRange(listCandidate, -1000, 1000); return total; };
    measure('range-public', size, baseline, candidate, expected, iterations);
  }
  if (!(size & 1)) {
    const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
    let expectedBox = 0;
    for (let i = 0; i < size; i += 2) expectedBox += Number(values[i] >= -1000 && values[i] <= 1000 && values[i + 1] >= -1000 && values[i + 1] <= 1000);
    if (mode !== 'public') for (const kernel of ['scalar', 'simd']) {
      const fns = Object.fromEntries(['baseline', 'candidate'].map(label => [label, n => {
        const { root, depth, tail } = list;
        let total = 0;
        for (let i = 0; i < n; i++) total += instances[label][kernel].countPointsInBox(root, depth, tail, size, -1000, -1000, 1000, 1000);
        return total;
      }]));
      measure(`point-${kernel}-control`, size, fns.baseline, fns.candidate, expectedBox, iterations);
    }
    if (mode !== 'kernels') {
      const baseline = n => { let total = 0; for (let i = 0; i < n; i++) total += publicBase.countPointsInBox(list, bounds); return total; };
      const candidate = n => { let total = 0; for (let i = 0; i < n; i++) total += publicCandidate.countPointsInBox(listCandidate, bounds); return total; };
      measure('point-public-control', size, baseline, candidate, expectedBox, iterations);
    }
  }
}
const sourceAfter = { baseline: metadata(baseDir), candidate: metadata(candidateDir), driver: hashFile(new URL(import.meta.url)) };
assert.deepEqual(sourceAfter, sourceBefore, 'Sources changed during measurement');
const report = { date: new Date().toISOString(), runtime: process.version, bun: process.versions.bun, v8: process.versions.v8, arch: process.arch, cpu: cpus()[0].model, mode, warmup, rounds, work, timed: 'Warm repeated scans only; allocation, compilation, setup, and correctness assertions are outside the timed region.', source: sourceBefore, sink, results };
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
if (process.env.PERF_GATE === '1') {
  for (const row of results) {
    assert.ok(row.speedup >= 0.95, `${row.name}/${row.size} regressed by more than 5%`);
    if (row.size >= 1024 && ['range-simd', 'range-public'].includes(row.name)) {
      assert.ok(row.speedup > 1.05, `${row.name}/${row.size} did not improve by more than 5%`);
    }
  }
}
