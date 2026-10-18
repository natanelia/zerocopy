import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';

export const METHOD = Object.freeze({ version: 'paired-diagnostic-1', sizes: [2, 1024, 32768], blocks: 4,
  warmup: 7, samples: 21, work: 8_000_000, regressionFloor: 0.95,
  improvementFloor: 1.05, aaCeiling: 1 / 0.95, arenaLimitPerArm: 64 * 1024 * 1024 });
export const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function median(xs) {
  assert.ok(xs.length && xs.every(x => Number.isFinite(x) && x > 0));
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
  return a.length & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function interval(logs) {
  assert.equal(logs.length, METHOD.blocks); assert.ok(logs.every(Number.isFinite));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1);
  const radius = 3.182446305284263 * Math.sqrt(variance / logs.length);
  return { speedup: Math.exp(mean), lower: Math.exp(mean - radius), upper: Math.exp(mean + radius) };
}
export function endpointNames(size) {
  return ['range-simd', 'range-scalar', 'range-public', ...(!(size & 1) ?
    ['point-scalar-control', 'point-simd-control', 'point-public-control', 'point-scalar-mixed', 'point-simd-mixed', 'point-public-mixed'] : [])];
}
export function order(block, round) { return (block + round) & 1 ? ['B', 'A'] : ['A', 'B']; }
export function expectedCount(name, size) {
  let n = 0;
  for (let i = 0; i < size; i += name.startsWith('range') ? 1 : 2) {
    const x = (i * 7919) % 10007 - 5000, y = ((i + 1) * 7919) % 10007 - 5000;
    n += Number(name.startsWith('range') ? x >= -1000 && x <= 1000 :
      name.endsWith('mixed') ? x >= -5000 && x <= -2500 && y >= 2000 && y <= 5000 :
      x >= -1000 && x <= 1000 && y >= -1000 && y <= 1000);
  }
  return n;
}
export function manifest(dir) {
  return Object.fromEntries(['package.json', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm',
    ...readdirSync(resolve(dir, 'dist')).filter(x => x.endsWith('.js')).sort().map(x => `dist/${x}`)]
    .map(name => [name, hash(resolve(dir, name))]));
}
async function fixture(dir, size) {
  const shared = await import(pathToFileURL(resolve(dir, 'dist/shared.js')).href);
  const numeric = await import(pathToFileURL(resolve(dir, 'dist/numeric.js')).href);
  shared.resetSharedList();
  const values = Array.from({ length: size }, (_, i) => (i * 7919) % 10007 - 5000);
  const list = new shared.SharedList('number').pushMany(values);
  const memory = shared.getWorkerData({ list }, { copy: false }).arenas[0].memory;
  assert.ok(memory.buffer.byteLength <= METHOD.arenaLimitPerArm);
  const bytes = Buffer.from(new Uint8Array(memory.buffer));
  const kernels = Object.fromEntries(['scalar', 'simd'].map(key => [key, new WebAssembly.Instance(
    new WebAssembly.Module(readFileSync(resolve(dir, `numeric-kernels${key === 'simd' ? '-simd' : ''}.wasm`))),
    { env: { memory } }).exports]));
  const { root, depth, tail } = list, operations = {};
  for (const key of ['simd', 'scalar']) {
    const fn = kernels[key].countInRange;
    operations[`range-${key}`] = n => { let total = 0; for (let i = 0; i < n; i++) total += fn(root, depth, tail, size, -1000, 1000); return total; };
  }
  operations['range-public'] = n => { let total = 0; for (let i = 0; i < n; i++) total += numeric.countInRange(list, -1000, 1000); return total; };
  if (!(size & 1)) for (const type of ['control', 'mixed']) {
    const bounds = type === 'control' ? { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 } :
      { minX: -5000, minY: 2000, maxX: -2500, maxY: 5000 };
    for (const key of ['scalar', 'simd']) {
      const fn = kernels[key].countPointsInBox;
      operations[`point-${key}-${type}`] = n => { let total = 0; for (let i = 0; i < n; i++)
        total += fn(root, depth, tail, size, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY); return total; };
    }
    operations[`point-public-${type}`] = n => { let total = 0; for (let i = 0; i < n; i++) total += numeric.countPointsInBox(list, bounds); return total; };
  }
  return { operations, memory, list, arenaBytes: bytes.length, check() {
    assert.equal(memory.buffer.byteLength, bytes.length); assert.ok(Buffer.from(memory.buffer).equals(bytes), 'Snapshot changed');
  } };
}
export async function child(config) {
  const { aDir, bDir, size, block, output, kind } = config;
  assert.ok(['aa', 'ab', 'slow-control'].includes(kind));
  assert.ok(METHOD.sizes.includes(size)); assert.ok(Number.isInteger(block) && block >= 0 && block < METHOD.blocks);
  assert.notEqual(resolve(aDir), resolve(bDir), 'Arms must have distinct module paths');
  const sources = { A: manifest(aDir), B: manifest(bDir) };
  if (kind !== 'ab') assert.deepEqual(sources.A, sources.B);
  // Reverse construction order across independent blocks; timing order is also balanced.
  const subjects = {};
  for (const role of order(block, 0)) subjects[role] = await fixture(role === 'A' ? aDir : bDir, size);
  assert.notEqual(subjects.A.memory, subjects.B.memory, 'Arms share memory');
  assert.notEqual(subjects.A.memory.buffer, subjects.B.memory.buffer, 'Arms share backing buffer');
  const journal = `${output}.ndjson`; writeFileSync(journal, '', { flag: 'wx' });
  const rows = [], iterations = Math.min(1_000_000, Math.max(8, Math.ceil(METHOD.work / size)));
  let sink = 0;
  for (const name of kind === 'slow-control' ? ['range-public'] : endpointNames(size)) {
    const expected = expectedCount(name, size), warmup = [], samples = [];
    for (const role of ['A', 'B']) assert.equal(subjects[role].operations[name](1), expected);
    for (let r = 0; r < METHOD.warmup + METHOD.samples; r++) {
      const phase = r < METHOD.warmup ? 'warmup' : 'sample', round = phase === 'warmup' ? r : r - METHOD.warmup;
      const record = { name, size, phase, round, order: order(block, round), timings: {}, answers: {} };
      for (const role of record.order) {
        const fn = subjects[role].operations[name], repeats = kind === 'slow-control' && role === 'B' ? 2 : 1;
        const start = performance.now(); let answer = fn(iterations);
        if (repeats === 2) answer += fn(iterations);
        const elapsed = performance.now() - start;
        assert.equal(answer, expected * iterations * repeats); assert.ok(elapsed > 0 && Number.isFinite(elapsed));
        sink ^= answer; record.timings[role] = elapsed; record.answers[role] = answer;
      }
      (phase === 'warmup' ? warmup : samples).push(record);
      appendFileSync(journal, JSON.stringify(record) + '\n');
    }
    rows.push({ name, size, expected, iterations, warmup, samples });
    subjects.A.check(); subjects.B.check();
  }
  assert.deepEqual(manifest(aDir), sources.A); assert.deepEqual(manifest(bDir), sources.B);
  const report = { method: METHOD, kind, block, size, source: sources, driver: hash(fileURLToPath(import.meta.url)),
    runtime: { execPath: process.execPath, binarySha256: hash(process.execPath), version: process.version,
      versions: process.versions, arch: process.arch, cpu: cpus()[0].model, execArgv: process.execArgv },
    arenaBytes: { A: subjects.A.arenaBytes, B: subjects.B.arenaBytes },
    resources: process.resourceUsage(), memory: process.memoryUsage(), sink, rows };
  writeFileSync(output, JSON.stringify(report) + '\n', { flag: 'wx' });
}
export function summarize(children, kind) {
  assert.equal(children.length, METHOD.blocks);
  const size = children[0].size, names = kind === 'slow-control' ? ['range-public'] : endpointNames(size);
  children.forEach((c, block) => {
    assert.deepEqual(c.method, METHOD); assert.equal(c.kind, kind); assert.equal(c.block, block); assert.equal(c.size, size);
    assert.equal(c.driver, children[0].driver); assert.deepEqual(c.source, children[0].source);
    assert.deepEqual(c.runtime, children[0].runtime); assert.deepEqual(c.rows.map(r => r.name), names);
    for (const role of ['A', 'B']) assert.ok(c.arenaBytes[role] > 0 && c.arenaBytes[role] <= METHOD.arenaLimitPerArm);
    c.rows.forEach(row => {
      assert.equal(row.size, size); assert.equal(row.expected, expectedCount(row.name, size));
      assert.equal(row.iterations, Math.min(1_000_000, Math.max(8, Math.ceil(METHOD.work / size))));
      for (const phase of ['warmup', 'sample']) {
        const records = phase === 'warmup' ? row.warmup : row.samples;
        assert.equal(records.length, phase === 'warmup' ? METHOD.warmup : METHOD.samples);
        records.forEach((record, round) => {
          assert.equal(record.name, row.name); assert.equal(record.size, size); assert.equal(record.phase, phase); assert.equal(record.round, round);
          assert.deepEqual(record.order, order(block, round));
          assert.deepEqual(Object.keys(record.timings).sort(), ['A', 'B']);
          assert.deepEqual(Object.keys(record.answers).sort(), ['A', 'B']);
          for (const role of ['A', 'B']) {
            assert.ok(Number.isFinite(record.timings[role]) && record.timings[role] > 0);
            assert.equal(record.answers[role], row.expected * row.iterations * (kind === 'slow-control' && role === 'B' ? 2 : 1));
          }
        });
      }
    });
  });
  return names.map((name, index) => {
    const ratios = children.map(c => median(c.rows[index].samples.map(r => r.timings.A / r.timings.B)));
    const stats = interval(ratios.map(Math.log));
    const target = kind === 'ab' && size >= 1024 && ['range-simd', 'range-public'].includes(name);
    const pointPass = stats.speedup >= METHOD.regressionFloor && (kind !== 'aa' || stats.speedup <= METHOD.aaCeiling) && (!target || stats.speedup > METHOD.improvementFloor);
    const confidencePass = stats.lower >= METHOD.regressionFloor && (kind !== 'aa' || stats.upper <= METHOD.aaCeiling) && (!target || stats.lower > METHOD.improvementFloor);
    return { name, size, ...stats, blockRatios: ratios, pointPass, confidencePass, pass: pointPass && confidencePass };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await child(JSON.parse(readFileSync(process.argv[2], 'utf8')));
