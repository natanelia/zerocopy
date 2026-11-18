import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, release, platform, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CASES, ROWS, fixture } from './fixtures.mjs';

const FIXED_BASE = '09b1a385a7c2ac9b027a4055335ae2f9449abe6e';
const STUDIES = {
  pilot: { pairs: 2, warmupBatches: 5, minimumWarmupMs: 0, samples: 9 },
  primary: { pairs: 6, warmupBatches: 8, minimumWarmupMs: 500, samples: 12 },
  control: { pairs: 4, warmupBatches: 8, minimumWarmupMs: 500, samples: 12 },
};
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function subject(entry, reverse, study) {
  const config = STUDIES[study]; assert.ok(config);
  assert.equal(new TextEncoder().encode(CASES.find(row => row.name === 'immediate-hit-33-bytes').term).length, 33);
  const { SharedList, resetSharedList, getWorkerData } = await import(pathToFileURL(resolve(entry)).href);
  const records = [];
  for (const spec of reverse ? [...CASES].reverse() : CASES) {
    resetSharedList();
    const { values, matches, checksum } = fixture(spec);
    const list = new SharedList('string').pushMany(values);
    const verify = () => {
      const check = list.compileTextSearch(spec.term, { caseSensitive: spec.caseSensitive });
      for (let index = 0; index < ROWS; index++) assert.equal(check(index), matches[index], `${spec.name}: row ${index}`);
    };
    verify();
    const capture = () => {
      const source = getWorkerData({ list }, { copy: false }).arenas[0];
      return { used: source.used, bytes: sha256(new Uint8Array(source.memory.buffer, 65536, source.used - 65536)) };
    };
    const before = capture(), expected = checksum * spec.repetitions;
    const run = () => {
      let sum = 0;
      for (let repeat = 0; repeat < spec.repetitions; repeat++) {
        const match = list.compileTextSearch(spec.term, { caseSensitive: spec.caseSensitive });
        for (let index = 0; index < ROWS; index++) if (match(index)) sum += index + ROWS + 1;
      }
      return sum;
    };
    const batch = () => {
      const start = performance.now(), actual = run(), elapsed = performance.now() - start;
      assert.equal(actual, expected, `${spec.name}: checksum changed`);
      return elapsed;
    };
    const warmupBatchMs = [], sampleBatchMs = [];
    let warmedMs = 0;
    while (warmupBatchMs.length < config.warmupBatches || warmedMs < config.minimumWarmupMs) {
      const elapsed = batch(); warmedMs += elapsed; warmupBatchMs.push(elapsed);
    }
    for (let i = 0; i < config.samples; i++) sampleBatchMs.push(batch());
    verify();
    assert.deepEqual(capture(), before, `${spec.name}: searches changed published bytes or allocated shared memory`);
    records.push({ name: spec.name, role: spec.role, rows: ROWS, queryBytes: new TextEncoder().encode(spec.term).length,
      caseSensitive: spec.caseSensitive, repetitions: spec.repetitions, checksum, immutableBytes: before,
      fixtureDigest: sha256(JSON.stringify({ values, matches })), warmupBatchMs, sampleBatchMs,
      medianMs: median(sampleBatchMs) / spec.repetitions });
  }
  return { runtime: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node,
    versions: process.versions, platform: process.platform, arch: process.arch, reverse, records };
}

function identity(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(path =>
    (path.endsWith('.ts') && !path.includes('/') && !path.endsWith('.test.ts'))
    || ['scripts/build-browser.ts', 'scripts/build-wasm.mjs', 'package.json', 'bun.lock'].includes(path));
  files.push(...readdirSync(root).filter(name => name.endsWith('.wasm')));
  const source = Object.fromEntries(files.sort().map(path => [path, sha256(readFileSync(resolve(root, path)))]));
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

function summarize(runs, pairs, study) {
  const results = [];
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const points = [];
    for (let pair = 0; pair < pairs; pair++) {
      const run = variant => runs.find(r => r.runtime === runtime && r.pair === pair && r.variant === variant);
      const before = run('before')?.records.find(r => r.name === spec.name);
      const after = run('after')?.records.find(r => r.name === spec.name);
      if (before && after) {
        assert.equal(before.fixtureDigest, after.fixtureDigest, 'Paired processes used different input');
        assert.equal(before.repetitions, after.repetitions, 'Paired processes performed different work');
        points.push({ before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
      }
    }
    if (!points.length) continue;
    const ratio = Math.exp(points.reduce((sum, p) => sum + Math.log(p.ratio), 0) / points.length);
    results.push({ runtime, name: spec.name, role: spec.role, pairs: points.length,
      beforeMs: median(points.map(p => p.before)), afterMs: median(points.map(p => p.after)), ratio, speedup: 1 / ratio,
      ratio95CI: points.length === pairs && study !== 'pilot' ? interval(points.map(p => p.ratio)) : null, points });
  }
  return results;
}

if (process.argv[2] === '--child') {
  process.stdout.write(JSON.stringify(await subject(process.argv[3], process.argv[4] === 'reverse', process.argv[5])));
} else {
  const [beforeArg, afterArg, bunArg, outputArg, study = 'pilot'] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outputArg && STUDIES[study],
    'Usage: node benchmark.mjs BEFORE_ROOT AFTER_ROOT BUN_PATH NEW_OUTPUT_JSON [pilot|primary|control]');
  const [beforeRoot, afterRoot, bunPath, outputPath] = [beforeArg, afterArg, bunArg, outputArg].map(value => resolve(value));
  const config = STUDIES[study];
  assert.ok(!existsSync(outputPath), 'The output already exists; retain it and use a new output path');
  const before = identity(beforeRoot), after = identity(afterRoot);
  assert.equal(before.head, FIXED_BASE, 'Use the fixed current-main baseline for this comparison');
  assert.deepEqual(Object.keys(before.source), Object.keys(after.source));
  assert.deepEqual(Object.keys(before.source).filter(path => before.source[path] !== after.source[path]),
    study === 'control' ? [] : ['text-search.ts'], 'Only the long-text-search source may differ');
  const script = fileURLToPath(import.meta.url), fixtures = new URL('./fixtures.mjs', import.meta.url);
  const data = {
    schema: 'zerocopy-long-search-loops/v1', study, status: 'running', startedAt: new Date().toISOString(),
    hardware: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
      affinity: platform() === 'linux' ? readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Cpus_allowed_list:')) : null },
    method: { ...config, rows: ROWS, order: 'AB, BA per runtime; case order alternates by pair; one build per fresh process',
      timed: 'Compile one predicate and scan every index per repetition; accumulate and check index-weighted checksums after timing',
      excluded: 'Data generation, collection construction, per-row oracle checks and shared-memory digests',
      estimate: 'Per-process medians, paired after/before ratios, geometric mean; primary/control deterministic 10000-resample percentile bootstrap over whole process pairs',
      source: sha256(readFileSync(script)), fixtures: sha256(readFileSync(fixtures)), cases: CASES.map(({ make, ...spec }) => spec) },
    before, after, runs: [], summary: [],
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  const save = () => { data.summary = summarize(data.runs, config.pairs, study); writeFileSync(outputPath, JSON.stringify(data, null, 2) + '\n'); };
  save();
  try {
    for (const runtime of ['node', 'bun']) for (let pair = 0; pair < config.pairs; pair++) {
      for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        const start = new Date().toISOString(), entry = resolve(variant === 'before' ? beforeRoot : afterRoot, 'dist/shared.js');
        const result = JSON.parse(execFileSync(runtime === 'node' ? process.execPath : bunPath,
          [script, '--child', entry, pair % 2 ? 'reverse' : 'forward', study],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 }));
        assert.equal(result.runtime, runtime); assert.equal(result.arch, arch());
        data.runs.push({ pair, variant, start, ...result }); save();
        console.error(`${study}: ${runtime} pair ${pair + 1}/${config.pairs} ${variant}: ${result.records.length} verified cases`);
      }
    }
    assert.deepEqual(identity(beforeRoot), before, 'Baseline source/build changed during the comparison');
    assert.deepEqual(identity(afterRoot), after, 'Candidate source/build changed during the comparison');
    assert.equal(sha256(readFileSync(script)), data.method.source, 'Benchmark changed during the comparison');
    assert.equal(sha256(readFileSync(fixtures)), data.method.fixtures, 'Fixtures changed during the comparison');
    data.status = 'complete'; data.completedAt = new Date().toISOString(); save();
  } catch (error) {
    data.status = 'failed'; data.failure = String(error); save(); throw error;
  }
  for (const row of data.summary) console.log(`${row.runtime} ${row.name}: ${row.beforeMs.toFixed(4)} -> ${row.afterMs.toFixed(4)} ms, ${row.speedup.toFixed(2)}x`);
}
