import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, release, platform, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CASES, ROWS, fixture } from './fixtures.mjs';

const FIXED_BASE = '501b73819ed7e9bbf7adbb74b03df01045701973';
const PAIRS = 6, WARMUP = 5, SAMPLES = 9;
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >>> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function subject(entry, reverse) {
  const { SharedList, resetSharedList, getWorkerData } = await import(pathToFileURL(resolve(entry)).href);
  const records = [];
  for (const spec of reverse ? [...CASES].reverse() : CASES) {
    resetSharedList();
    const { values, matches, checksum } = fixture(spec);
    const list = new SharedList('string').pushMany(values);
    const check = list.compileTextSearch(spec.term, { caseSensitive: spec.caseSensitive });
    for (let index = 0; index < ROWS; index++) assert.equal(check(index), matches[index]);
    const expected = checksum * spec.repetitions;
    const run = () => {
      let sum = 0;
      for (let repeat = 0; repeat < spec.repetitions; repeat++) {
        const match = list.compileTextSearch(spec.term, { caseSensitive: spec.caseSensitive });
        for (let index = 0; index < ROWS; index++) if (match(index)) sum += index + ROWS + 1;
      }
      return sum;
    };
    const warmupMs = [], samplesMs = [];
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      const start = performance.now(), actual = run(), elapsed = performance.now() - start;
      assert.equal(actual, expected, `${spec.name}: checksum changed`);
      (i < WARMUP ? warmupMs : samplesMs).push(elapsed / spec.repetitions);
    }
    records.push({ name: spec.name, role: spec.role, rows: ROWS, queryBytes: new TextEncoder().encode(spec.term).length,
      caseSensitive: spec.caseSensitive, repetitions: spec.repetitions, checksum,
      payloadBytes: getWorkerData({ list }, { copy: false }).arenas[0].used,
      warmupMs, samplesMs, medianMs: median(samplesMs) });
  }
  return { runtime: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node,
    platform: process.platform, arch: process.arch, reverse, records };
}

function identity(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = ['text-search.ts', 'shared-list.ts', 'arena.ts', 'persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'];
  const source = Object.fromEntries(files.map(path => [path, sha256(readFileSync(resolve(root, path)))]));
  const build = Object.fromEntries(readdirSync(resolve(root, 'dist')).filter(name => name.endsWith('.js')).sort()
    .map(name => [name, sha256(readFileSync(resolve(root, 'dist', name)))]));
  return { root, head, source, build };
}

function interval(ratios) {
  let seed = 0x5eed2026;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const estimates = [];
  for (let repeat = 0; repeat < 10000; repeat++) {
    let log = 0;
    for (let i = 0; i < ratios.length; i++) log += Math.log(ratios[Math.floor(random() * ratios.length)]);
    estimates.push(Math.exp(log / ratios.length));
  }
  estimates.sort((a, b) => a - b);
  return [estimates[249], estimates[9749]];
}

function summarize(runs) {
  const results = [];
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const points = [];
    for (let pair = 0; pair < PAIRS; pair++) {
      const run = variant => runs.find(r => r.runtime === runtime && r.pair === pair && r.variant === variant);
      const before = run('before')?.records.find(r => r.name === spec.name);
      const after = run('after')?.records.find(r => r.name === spec.name);
      if (before && after) points.push({ before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    if (!points.length) continue;
    const ratio = Math.exp(points.reduce((sum, p) => sum + Math.log(p.ratio), 0) / points.length);
    results.push({ runtime, name: spec.name, role: spec.role, pairs: points.length,
      beforeMs: median(points.map(p => p.before)), afterMs: median(points.map(p => p.after)),
      ratio, speedup: 1 / ratio, ratio95CI: interval(points.map(p => p.ratio)), points });
  }
  return results;
}

if (process.argv[2] === '--child') {
  console.log(JSON.stringify(await subject(process.argv[3], process.argv[4] === 'reverse')));
} else {
  const [beforeRoot, afterRoot, bunPath, outputPath] = process.argv.slice(2).map(value => resolve(value));
  if (!beforeRoot || !afterRoot || !bunPath || !outputPath) throw Error('Usage: node benchmark.mjs BEFORE_ROOT AFTER_ROOT BUN_PATH OUTPUT_JSON');
  assert.ok(!existsSync(outputPath), 'The output already exists; retain it and use a new output path');
  const before = identity(beforeRoot), after = identity(afterRoot);
  assert.equal(before.head, FIXED_BASE, 'Use the fixed baseline commit for this comparison');
  for (const path of ['shared-list.ts', 'arena.ts', 'persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm']) {
    assert.equal(before.source[path], after.source[path], `Unrelated source changed: ${path}`);
  }
  const script = fileURLToPath(import.meta.url);
  const data = {
    schema: 'zerocopy-long-text-search/v1', status: 'running', startedAt: new Date().toISOString(),
    hardware: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    method: { pairs: PAIRS, samples: SAMPLES, warmup: WARMUP, rows: ROWS, order: 'AB, BA, AB, BA, AB, BA per runtime; case order alternates by pair',
      timed: 'Compile one predicate and scan every index per repetition; accumulate and check index-weighted checksums after timing',
      excluded: 'Data generation, collection construction, and full per-row correctness checks precede warmup',
      estimate: 'Per-process medians, paired after/before ratios, geometric mean; deterministic 10000-resample percentile bootstrap over process pairs',
      source: sha256(readFileSync(script)), fixtures: sha256(readFileSync(new URL('./fixtures.mjs', import.meta.url))),
      cases: CASES.map(({ make, ...spec }) => spec) },
    before, after, runs: [], summary: [],
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  const save = () => writeFileSync(outputPath, JSON.stringify(data, null, 2) + '\n');
  save();
  for (const runtime of ['node', 'bun']) for (let pair = 0; pair < PAIRS; pair++) {
    for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
      const start = new Date().toISOString();
      const entry = resolve(variant === 'before' ? beforeRoot : afterRoot, 'dist/shared.js');
      const result = JSON.parse(execFileSync(runtime === 'node' ? process.execPath : bunPath,
        [script, '--child', entry, pair % 2 ? 'reverse' : 'forward'], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }));
      assert.equal(result.runtime, runtime); assert.equal(result.arch, arch());
      data.runs.push({ pair, variant, start, ...result }); data.summary = summarize(data.runs); save();
      console.error(`${runtime} pair ${pair + 1}/${PAIRS} ${variant}: ${result.records.length} verified cases`);
    }
  }
  assert.deepEqual(identity(beforeRoot), before, 'Baseline source/build changed during the comparison');
  assert.deepEqual(identity(afterRoot), after, 'Candidate source/build changed during the comparison');
  assert.equal(sha256(readFileSync(script)), data.method.source, 'Benchmark changed during the comparison');
  assert.equal(sha256(readFileSync(new URL('./fixtures.mjs', import.meta.url))), data.method.fixtures, 'Fixtures changed during the comparison');
  data.status = 'complete'; data.completedAt = new Date().toISOString(); save();
  for (const row of data.summary) console.log(`${row.runtime} ${row.name}: ${row.beforeMs.toFixed(4)} -> ${row.afterMs.toFixed(4)} ms, ${row.speedup.toFixed(2)}x, after/before CI ${row.ratio95CI.map(n => n.toFixed(3)).join('..')}`);
}
