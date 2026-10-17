import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLAN = Object.freeze({
  version: 1, blocks: 4, warmup: 7, samples: 21, work: 8_000_000,
  sizes: Object.freeze([1, 2, 31, 32, 33, 1024, 1057, 32768, 32801, 262144, 1048609]),
  regressionFloor: 0.95, improvementFloor: 1.05, aaCeiling: 1 / 0.95,
  childTimeoutMs: 240_000,
});
const self = fileURLToPath(import.meta.url);
export const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function median(values) {
  assert.ok(values.length && values.every(n => Number.isFinite(n) && n > 0), 'Invalid timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length >>> 1;
  return sorted.length & 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}
export function endpoints(sizes = PLAN.sizes) {
  return sizes.flatMap(size => [
    ...['range-simd', 'range-scalar', 'range-public'].map(name => ({ name, size })),
    ...(!(size & 1) ? ['point-scalar-control', 'point-simd-control', 'point-public-control'].map(name => ({ name, size })) : []),
  ]);
}
export function schedule() {
  return Array.from({ length: PLAN.blocks }, (_, block) =>
    [...(block & 1 ? 'BAAB' : 'ABBA')].map((role, position) => ({ block, position, role }))).flat();
}
export function interval(logs) {
  assert.equal(logs.length, PLAN.blocks, 'All four blocks are required');
  assert.ok(logs.every(Number.isFinite));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((n, x) => n + (x - mean) ** 2, 0) / (logs.length - 1);
  // Two-sided 95% Student-t interval, 3 degrees of freedom. Blocks, not
  // within-child timer samples, are the independent replication unit.
  const radius = 3.182446305284263 * Math.sqrt(variance / logs.length);
  return { speedup: Math.exp(mean), lower: Math.exp(mean - radius), upper: Math.exp(mean + radius) };
}
export function summarize(children, kind, sizes = PLAN.sizes) {
  assert.ok(['aa', 'ab'].includes(kind));
  const expected = schedule();
  assert.equal(children.length, expected.length, 'Missing child');
  const keys = endpoints(sizes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    assert.deepEqual(child.assignment, expected[i], 'Child order or role changed');
    assert.equal(child.status, 0, 'Failed child cannot be excluded');
    assert.ok(!child.error && !child.signal, 'Child failure');
    assert.equal(child.report.results.length, keys.length, 'Missing or extra endpoint');
    assert.deepEqual(child.report.plan, { ...PLAN, sizes }, 'Child plan changed');
    assert.equal(child.report.driver, children[0].report.driver, 'Different drivers');
    assert.deepEqual(child.report.runtime, children[0].report.runtime, 'Different runtime or host');
    child.report.results.forEach((row, j) => {
      assert.equal(row.name, keys[j].name); assert.equal(row.size, keys[j].size);
      assert.equal(row.iterations, Math.min(1_000_000, Math.max(8, Math.ceil(PLAN.work / row.size))));
      assert.equal(row.samples.length, PLAN.samples);
      assert.equal(row.warmup.length, PLAN.warmup);
      median(row.warmup); median(row.samples);
    });
  }
  return keys.map(({ name, size }, index) => {
    const blockLogs = [];
    const pairedRatios = [];
    for (let block = 0; block < PLAN.blocks; block++) {
      const group = children.slice(block * 4, block * 4 + 4);
      const pairLogs = [];
      for (const offset of [0, 2]) {
        const pair = group.slice(offset, offset + 2);
        const a = pair.find(c => c.assignment.role === 'A').report.results[index];
        const b = pair.find(c => c.assignment.role === 'B').report.results[index];
        const ratio = median(a.samples) / median(b.samples);
        pairedRatios.push(ratio); pairLogs.push(Math.log(ratio));
      }
      blockLogs.push((pairLogs[0] + pairLogs[1]) / 2);
    }
    const stats = interval(blockLogs);
    const target = kind === 'ab' && size >= 1024 && ['range-simd', 'range-public'].includes(name);
    const pointPass = stats.speedup >= PLAN.regressionFloor && (kind !== 'aa' || stats.speedup <= PLAN.aaCeiling) && (!target || stats.speedup > PLAN.improvementFloor);
    const confidencePass = stats.lower >= PLAN.regressionFloor && (kind !== 'aa' || stats.upper <= PLAN.aaCeiling) && (!target || stats.lower > PLAN.improvementFloor);
    return { name, size, ...stats, pairedRatios, blockRatios: blockLogs.map(Math.exp), pointPass, confidencePass, pass: pointPass && confidencePass };
  });
}
function bundleManifest(dir) {
  const files = ['package.json', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm',
    ...readdirSync(resolve(dir, 'dist')).filter(n => n.endsWith('.js')).sort().map(n => `dist/${n}`)];
  return Object.fromEntries(files.map(name => [name, digest(resolve(dir, name))]));
}
export function sourceManifest(dir) {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' });
  assert.equal(tracked.status, 0, 'A Git source index is required');
  const files = tracked.stdout.split('\0').filter(Boolean).filter(name => !name.startsWith('proofs/'));
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return { commit: head.status === 0 ? head.stdout.trim() : null,
    files: Object.fromEntries(files.map(name => [name, digest(resolve(dir, name))])), bundle: bundleManifest(dir) };
}
async function subject(configPath) {
  const { moduleDir, output, sizes } = JSON.parse(readFileSync(configPath, 'utf8'));
  const plan = { ...PLAN, sizes };
  const before = bundleManifest(moduleDir);
  const driver = digest(self);
  const shared = await import(pathToFileURL(resolve(moduleDir, 'dist/shared.js')).href);
  const numeric = await import(pathToFileURL(resolve(moduleDir, 'dist/numeric.js')).href);
  const modules = Object.fromEntries(['scalar', 'simd'].map(k => [k, new WebAssembly.Module(readFileSync(resolve(moduleDir, `numeric-kernels${k === 'simd' ? '-simd' : ''}.wasm`)))]));
  const results = []; let sink = 0; let maximumArenaBytes = 0;
  const raw = `${output}.samples.ndjson`; writeFileSync(raw, '', { flag: 'wx' });
  function measure(name, size, fn, expected, iterations) {
    assert.equal(fn(1), expected);
    const samples = []; const warmup = [];
    for (let r = -plan.warmup; r < plan.samples; r++) {
      const start = performance.now(); const answer = fn(iterations); const elapsed = performance.now() - start;
      assert.equal(answer, expected * iterations, `${name}/${size}`); sink ^= answer;
      assert.ok(Number.isFinite(elapsed) && elapsed > 0);
      (r < 0 ? warmup : samples).push(elapsed);
    }
    const row = { name, size, iterations, expected, warmup, samples };
    results.push(row); appendFileSync(raw, JSON.stringify(row) + '\n');
  }
  for (const size of sizes) {
    shared.resetSharedList();
    const values = Array.from({ length: size }, (_, i) => (i * 7919) % 10007 - 5000);
    const list = new shared.SharedList('number').pushMany(values);
    const memory = shared.getWorkerData({ list }, { copy: false }).arenas[0].memory;
    maximumArenaBytes = Math.max(maximumArenaBytes, memory.buffer.byteLength);
    assert.ok(memory.buffer.byteLength <= 64 * 1024 * 1024, 'Fixture exceeded its 64 MiB arena bound');
    const kernels = Object.fromEntries(Object.entries(modules).map(([k, m]) => [k, new WebAssembly.Instance(m, { env: { memory } }).exports]));
    const savedBytes = Buffer.from(new Uint8Array(memory.buffer));
    const expected = values.reduce((n, x) => n + Number(x >= -1000 && x <= 1000), 0);
    const iterations = Math.min(1_000_000, Math.max(8, Math.ceil(plan.work / size)));
    for (const k of ['simd', 'scalar']) {
      const fn = kernels[k].countInRange; const { root, depth, tail } = list;
      measure(`range-${k}`, size, n => { let total = 0; for (let i = 0; i < n; i++) total += fn(root, depth, tail, size, -1000, 1000); return total; }, expected, iterations);
    }
    measure('range-public', size, n => { let total = 0; for (let i = 0; i < n; i++) total += numeric.countInRange(list, -1000, 1000); return total; }, expected, iterations);
    if (!(size & 1)) {
      const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
      let box = 0;
      for (let i = 0; i < size; i += 2) box += Number(values[i] >= -1000 && values[i] <= 1000 && values[i + 1] >= -1000 && values[i + 1] <= 1000);
      for (const k of ['scalar', 'simd']) {
        const fn = kernels[k].countPointsInBox; const { root, depth, tail } = list;
        measure(`point-${k}-control`, size, n => { let total = 0; for (let i = 0; i < n; i++) total += fn(root, depth, tail, size, -1000, -1000, 1000, 1000); return total; }, box, iterations);
      }
      measure('point-public-control', size, n => { let total = 0; for (let i = 0; i < n; i++) total += numeric.countPointsInBox(list, bounds); return total; }, box, iterations);
    }
    assert.equal(memory.buffer.byteLength, savedBytes.length, 'Read changed arena length');
    assert.ok(Buffer.from(memory.buffer).equals(savedBytes), 'Read changed snapshot bytes');
  }
  assert.deepEqual(bundleManifest(moduleDir), before); assert.equal(digest(self), driver);
  writeFileSync(output, JSON.stringify({ plan, driver, runtime: { node: process.version, bun: process.versions.bun ?? null, v8: process.versions.v8, arch: process.arch, cpu: cpus()[0].model }, bundle: before, maximumArenaBytes, sink, results }, null, 2) + '\n', { flag: 'wx' });
}
export function runCohort({ baseDir, candidateDir, outDir, runtime, kind, sizes = PLAN.sizes, expectedSources = null }) {
  assert.ok(['aa', 'ab'].includes(kind));
  assert.ok(sizes.length && new Set(sizes).size === sizes.length && sizes.every(s => PLAN.sizes.includes(s)));
  assert.ok(!existsSync(outDir), 'Refuse to overwrite a prior cohort'); mkdirSync(outDir, { recursive: true });
  const base = sourceManifest(baseDir); const candidate = sourceManifest(candidateDir);
  if (expectedSources) assert.deepEqual({ baseline: base, candidate }, expectedSources, 'Inputs changed since the full-run plan');
  const sources = { A: kind === 'aa' ? candidate : base, B: candidate };
  const directories = { A: kind === 'aa' ? candidateDir : baseDir, B: candidateDir };
  const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-numeric-process-'));
  const moduleDir = resolve(temporary, 'subject'); const configPath = resolve(temporary, 'job.json');
  const childOutput = resolve(temporary, 'result.json');
  const driver = digest(self); const fixedSchedule = schedule(); const children = [];
  const plan = { ...PLAN, sizes };
  writeFileSync(resolve(outDir, 'plan.json'), JSON.stringify({ created: new Date().toISOString(), kind, plan, runtime, driver, source: { baseline: base, candidate }, schedule: fixedSchedule, limits: 'Warm scans only. Each child loads one variant at the same path. Startup, copying, compilation, checks and process transport are excluded. Four independent balanced blocks. No child or sample may be excluded. This remains a diagnostic until cross-runtime and cross-architecture checks pass.' }, null, 2) + '\n', { flag: 'wx' });
  try {
    for (const [index, assignment] of fixedSchedule.entries()) {
      rmSync(moduleDir, { recursive: true, force: true }); mkdirSync(resolve(moduleDir, 'dist'), { recursive: true });
      for (const name of Object.keys(sources[assignment.role].bundle)) copyFileSync(resolve(directories[assignment.role], name), resolve(moduleDir, name));
      assert.deepEqual(bundleManifest(moduleDir), sources[assignment.role].bundle, 'Wrong build copied');
      for (const path of [childOutput, `${childOutput}.samples.ndjson`]) rmSync(path, { force: true });
      writeFileSync(configPath, JSON.stringify({ moduleDir, output: childOutput, sizes }));
      const prefix = resolve(outDir, String(index + 1).padStart(2, '0'));
      const fd = openSync(`${prefix}.log`, 'wx'); let child;
      try {
        child = spawnSync(runtime, [self, '--child', configPath], { cwd: temporary,
          env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
          stdio: ['ignore', fd, fd], timeout: PLAN.childTimeoutMs, killSignal: 'SIGKILL' });
      } finally { closeSync(fd); }
      const record = { assignment, status: child.status, signal: child.signal, error: child.error ? String(child.error) : null };
      for (const suffix of ['', '.samples.ndjson']) if (existsSync(childOutput + suffix)) copyFileSync(childOutput + suffix, prefix + '.json' + suffix);
      try {
        assert.equal(child.status, 0); assert.ok(!child.error && !child.signal);
        record.report = JSON.parse(readFileSync(childOutput, 'utf8'));
        assert.equal(record.report.driver, driver);
        assert.deepEqual(record.report.bundle, sources[assignment.role].bundle, 'Measured build mismatch');
      } catch (error) { record.error = String(error); }
      children.push(record);
      writeFileSync(`${prefix}.status.json`, JSON.stringify({ ...record, report: undefined }, null, 2) + '\n', { flag: 'wx' });
      console.log('NUMERIC-PROCESS-CHILD', JSON.stringify({ kind, index: index + 1, ...assignment, status: record.status, error: record.error }));
    }
    assert.deepEqual(sourceManifest(baseDir), base); assert.deepEqual(sourceManifest(candidateDir), candidate); assert.equal(digest(self), driver);
    let rows = []; let error = null;
    try { rows = summarize(children, kind, sizes); } catch (failure) { error = String(failure); }
    const report = { kind, plan, driver, runtime: children[0]?.report?.runtime ?? null, fullCoverage: JSON.stringify(sizes) === JSON.stringify(PLAN.sizes), complete: children.length === fixedSchedule.length, error, pass: !error && rows.length === endpoints(sizes).length && rows.every(r => r.pass), rows };
    writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('NUMERIC-PROCESS-SUMMARY', JSON.stringify(report)); return report;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--child') await subject(process.argv[3]);
  else {
    const report = runCohort({ baseDir: resolve(process.env.BASE_DIR ?? '../zerocopy-base'), candidateDir: resolve(process.env.CANDIDATE_DIR ?? '.'), outDir: resolve(process.env.OUT_DIR ?? 'proofs/results/numeric-tree-process'), runtime: process.env.RUNTIME_BIN ?? process.execPath, kind: process.env.KIND ?? 'aa', sizes: process.env.DIAGNOSTIC_SIZES ? process.env.DIAGNOSTIC_SIZES.split(',').map(Number) : PLAN.sizes });
    if (!report.pass) process.exitCode = 1;
  }
}
