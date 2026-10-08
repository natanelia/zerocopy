// Fresh-process, single-build comparisons. Raw data are diagnostic, never a CI
// speed gate. No instrumented allocation code is used in the timing process.
// TRIE_BASE=<checkout> TRIE_OUTPUT=<file> [TRIE_CASES=...] [TRIE_BLOCKS=4] node ...
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, lstatSync, mkdtempSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const sha = data => createHash('sha256').update(data).digest('hex');
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const cases = {
  'empty-keys': { shape: 'canonical', size: 0, operation: 'keys' },
  'singleton-values': { shape: 'canonical', size: 1, operation: 'values' },
  'canonical32-keys': { shape: 'canonical', size: 32, operation: 'keys' },
  'canonical4096-values': { shape: 'canonical', size: 4096, operation: 'values' },
  'collision2-entries': { shape: 'collision', size: 2, operation: 'entries' },
  'journal32-keys': { shape: 'journal', size: 32, operation: 'keys' },
  'patched32-keys': { shape: 'patched', size: 32, operation: 'keys' },
  'patched4096-values': { shape: 'patched', size: 4096, operation: 'values' },
  'canonical4096-get': { shape: 'canonical', size: 4096, operation: 'get' },
  'canonical32-set-noop': { shape: 'canonical', size: 32, operation: 'set-noop' },
};

export function subject(config) {
  return (async () => {
    const api = await import(pathToFileURL(config.module).href), spec = cases[config.name];
    assert.ok(spec);
    const entries = spec.shape === 'collision' ? [['costarring', 1], ['liquid', 2]] : Array.from({ length: spec.size }, (_, i) => [`key${i}`, i]);
    const model = new Map(entries);
    let map = new api.SharedMap('number').setMany(entries);
    if (spec.shape === 'patched') for (let i = 0; i < Math.min(17, spec.size); i++) { map = map.set(`key${i}`, -i - 1); model.set(`key${i}`, -i - 1); }
    if (spec.shape === 'journal') {
      // The legacy v4 journal reader has no public constructor. Build a valid
      // descriptor in a private copied payload; no published writer bytes change.
      const payload = api.getWorkerData({ map }, { copy: true });
      assert.equal(payload.version, 4); assert.equal(payload.arenas.length, 1);
      const source = payload.arenas[0], edits = [['key0', -1], ['journal-new', 1001]];
      const bytes = new Uint8Array(source.used + 256); bytes.set(source.copy);
      const view = new DataView(bytes.buffer), pointers = []; let end = source.used;
      for (const [key, value] of edits) {
        const encoded = new TextEncoder().encode(key), p = end; let hash = 2166136261;
        for (const byte of encoded) hash = Math.imul(hash ^ byte, 16777619);
        view.setUint32(p, 0, true); view.setUint32(p + 4, hash >>> 0, true);
        view.setUint32(p + 8, encoded.length, true); view.setUint32(p + 12, 8, true);
        bytes.set(encoded, p + 16); view.setFloat64(p + 16 + encoded.length, value, true);
        end = (p + 16 + encoded.length + 8 + 3) & ~3; pointers.push(p); model.set(key, value);
      }
      const root = (end + 7) & ~7; end = root + 16 + pointers.length * 4;
      view.setUint32(root, 0xffffffff, true); view.setUint32(root + 4, map.root, true);
      view.setUint32(root + 8, model.size, true); view.setUint32(root + 12, pointers.length, true);
      pointers.forEach((p, i) => view.setUint32(root + 16 + i * 4, p, true));
      ({ map } = await api.initWorker({ ...payload, arenas: [{ id: source.id, used: end, copy: bytes.slice(0, end) }],
        structures: { map: { ...payload.structures.map, data: { root, size: model.size, valueType: 'number' } } } }));
    }
    assert.deepEqual(new Map(map.entries()), model);
    const keys = [...model.keys()];
    // Existing no-op writes use the read cache; initialize it outside timing.
    if (spec.operation === 'set-noop') for (const [key, value] of entries) assert.equal(map.get(key), value);
    let scan;
    if (spec.operation === 'keys') scan = () => { let sum = 1; for (const key of map.keys()) sum += key.length; return sum; };
    else if (spec.operation === 'values') scan = () => { let sum = 1; for (const value of map.values()) sum += value; return sum; };
    else if (spec.operation === 'entries') scan = () => { let sum = 1; for (const [key, value] of map.entries()) sum += key.length + value; return sum; };
    else if (spec.operation === 'set-noop') scan = () => { let sum = 1; for (const [key, value] of entries) sum += Number(map.set(key, value) === map); return sum; };
    else scan = () => { let sum = 1; for (const key of keys) sum += map.get(key); return sum; };
    const expected = [...model].reduce((sum, [key, value]) => sum + (spec.operation === 'set-noop' ? 1 : spec.operation === 'keys' ? key.length : spec.operation === 'entries' ? key.length + value : value), 1);
    assert.equal(scan(), expected);
    if (config.mode === 'checks') return { name: config.name, size: map.size, checksum: scan(), expected };
    const batch = iterations => {
      let checksum = 0;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) checksum += scan();
      const ms = performance.now() - start;
      assert.equal(checksum, expected * iterations);
      return { ms, checksum };
    };
    const warmStart = performance.now(); let warmScans = 0;
    while (config.mode === 'pilot' ? performance.now() - warmStart < config.warmMs || warmScans < 128 : warmScans < config.warmIterations) { batch(32); warmScans += 32; }
    const warmElapsedMs = performance.now() - warmStart;
    if (config.mode === 'pilot') {
      let iterations = 1; const calibration = [];
      for (let i = 0; i < 24; i++) {
        const result = batch(iterations); calibration.push({ iterations, ...result });
        if (result.ms >= config.floorMs * 1.5) return { mode: 'pilot', iterations, calibration, warmScans, warmElapsedMs };
        iterations = Math.max(iterations + 1, Math.ceil(iterations * Math.min(8, Math.max(1.2, config.floorMs * 1.7 / Math.max(result.ms, 0.01)))));
      }
      throw new Error('Calibration failed');
    }
    const samples = Array.from({ length: config.samples }, () => batch(config.iterations));
    return { mode: 'measure', iterations: config.iterations, samples, medianMs: median(samples.map(s => s.ms)), warmScans, warmElapsedMs,
      shortBatchCount: samples.filter(s => s.ms < config.floorMs).length, warmFloorMet: warmElapsedMs >= config.warmMs, runtime: process.versions };
  })();
}
// Student t critical values for two-sided 95% intervals, df=1..11. The
// experimental units are ABBA/BAAB quartets, never their pairs or timed batches.
export function summarizeQuartets(rows, subjects, margin = 0.02) {
  const quartets = new Map();
  for (const row of rows) {
    assert.ok(Number.isInteger(row.block) && [0, 1].includes(row.pair));
    const pair = quartets.get(row.block) ?? [];
    assert.ok(!pair.some(previous => previous.pair === row.pair)); pair.push(row); quartets.set(row.block, pair);
  }
  assert.ok(quartets.size >= 2 && quartets.size <= 12);
  assert.ok([...quartets.values()].every(pair => pair.length === 2));
  const t95 = [null, 12.7062047364, 4.30265272975, 3.18244630528, 2.7764451052, 2.57058183564, 2.44691185114, 2.36462425101, 2.3060041352, 2.26215716285, 2.22813885196, 2.20098516008];
  const logs = [...quartets.values()].map(pair => pair.reduce((sum, row) => sum + Math.log(1 / row.speedup), 0) / 2), n = logs.length;
  const mean = logs.reduce((sum, value) => sum + value, 0) / n;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const halfWidth = t95[n - 1] * Math.sqrt(variance / n);
  const lower = Math.exp(mean - halfWidth), upper = Math.exp(mean + halfWidth), ratio = Math.exp(mean);
  const intervalClassification = lower > 1 + margin ? 'detected material loss' : upper <= 1 + margin ? 'within declared margin' : 'inconclusive';
  const baselineMs = subjects.filter(s => s.label === 'left').map(s => s.result.medianMs);
  const candidateMs = subjects.filter(s => s.label === 'right').map(s => s.result.medianMs);
  assert.equal(baselineMs.length, n * 2); assert.equal(candidateMs.length, n * 2);
  const scansPerBatch = subjects[0].result.iterations;
  assert.ok(Number.isInteger(scansPerBatch) && scansPerBatch > 0 && subjects.every(s => s.result.iterations === scansPerBatch));
  const shortBatchCount = subjects.reduce((sum, s) => sum + s.result.shortBatchCount, 0);
  const warmFloorMisses = subjects.filter(s => !s.result.warmFloorMet).length;
  return { independentQuartets: n, descriptiveProcessPairs: rows.length, degreesOfFreedom: n - 1, quartetLatencyRatios: logs.map(Math.exp), latencyRatio: ratio, latencyChangePercent: (ratio - 1) * 100,
    confidenceLevel: 0.95, interval: [lower, upper], nonInferiorityMargin: margin, intervalClassification,
    scansPerBatch, baselineBatchMedianMs: median(baselineMs), candidateBatchMedianMs: median(candidateMs),
    baselineNsPerScan: median(baselineMs) * 1e6 / scansPerBatch, candidateNsPerScan: median(candidateMs) * 1e6 / scansPerBatch,
    batchMedianDifferenceMs: median(candidateMs) - median(baselineMs), shortBatchCount, warmFloorMisses,
    inferenceUsable: shortBatchCount === 0 && warmFloorMisses === 0,
    conclusion: shortBatchCount || warmFloorMisses ? 'inconclusive (timing flags)' : intervalClassification };
}
if (process.argv[2] === '--subject') {
  console.log(JSON.stringify(await subject(JSON.parse(process.argv[3]))));
} else if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..'), baseline = resolve(process.env.TRIE_BASE ?? join(root, '.proof-baseline'));
  const candidate = resolve(process.env.TRIE_CANDIDATE ?? root), expectedBase = '3773c6e519c7c0958da13727ed1082f449f3ee25';
  const output = resolve(process.env.TRIE_OUTPUT ?? join(root, 'proofs/results/trie-iterator-local.json'));
  const names = (process.env.TRIE_CASES ?? Object.keys(cases).join(',')).split(',');
  const blocks = Number(process.env.TRIE_BLOCKS ?? 4), samples = Number(process.env.TRIE_SAMPLES ?? 11);
  assert.ok(names.every(n => cases[n]) && new Set(names).size === names.length);
  assert.ok(Number.isInteger(blocks) && blocks >= 2 && blocks <= 12 && blocks % 2 === 0);
  assert.ok(Number.isInteger(samples) && samples >= 5 && samples <= 51 && samples % 2 === 1);
  const floorMs = Number(process.env.TRIE_FLOOR_MS ?? 10), warmMs = Number(process.env.TRIE_WARM_MS ?? 150);
  assert.ok(floorMs >= 5 && warmMs >= 100);
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), expectedBase);
  assert.equal(git(candidate, 'merge-base', expectedBase, 'HEAD'), expectedBase);
  const paths = new Set([...git(baseline, 'ls-files').split('\n'), ...git(candidate, 'ls-files').split('\n')].filter(p => /\.ts$/.test(p) && !p.endsWith('.test.ts') && !p.startsWith('proofs/') && !p.startsWith('type-tests/') && !p.startsWith('website/') && !p.startsWith('demo/') || p.startsWith('scripts/build-') || p === 'package.json' || p.startsWith('tsconfig')));
  const differences = [], manifests = { baseline: {}, candidate: {} };
  for (const path of [...paths].sort()) {
    const a = readFileSync(join(baseline, path)), b = readFileSync(join(candidate, path));
    assert.equal(sha(a), sha(execFileSync('git', ['-C', baseline, 'show', `${expectedBase}:${path}`])), `Dirty baseline: ${path}`);
    manifests.baseline[path] = sha(a); manifests.candidate[path] = sha(b);
    if (!a.equals(b)) differences.push(path);
  }
  assert.deepEqual(differences, ['arena.ts']);
  const withoutLeaves = text => {
    const start = text.indexOf('  *leaves(root: number): Generator<number> {'), end = text.indexOf('  bulk(type:', start);
    assert.ok(start >= 0 && end > start); return text.slice(0, start) + text.slice(end);
  };
  assert.equal(withoutLeaves(readFileSync(join(baseline, 'arena.ts'), 'utf8')), withoutLeaves(readFileSync(join(candidate, 'arena.ts'), 'utf8')), 'Only Arena.leaves may change');
  for (const file of ['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm']) {
    const a = sha(readFileSync(join(baseline, file))), b = sha(readFileSync(join(candidate, file)));
    assert.equal(a, b, file); manifests.baseline[file] = a; manifests.candidate[file] = b;
  }
  function buildManifest(dir) {
    const result = {};
    for (const file of readdirSync(join(dir, 'dist')).filter(p => p.endsWith('.js')).sort()) result[file] = sha(readFileSync(join(dir, 'dist', file)));
    assert.ok(result['shared.js']); return result;
  }
  const builds = { baseline: buildManifest(baseline), candidate: buildManifest(candidate) };
  const staging = mkdtempSync(join(tmpdir(), 'trie-iterator-')), neutral = join(staging, 'dist');
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ type: 'module' }));
  const report = { schema: 1, date: new Date().toISOString(), platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model,
    baseline: git(baseline, 'rev-parse', 'HEAD'), candidate: git(candidate, 'rev-parse', 'HEAD'), candidateStatus: git(candidate, 'status', '--short'),
    sourceManifests: manifests, buildManifests: builds, proofSha256: sha(readFileSync(import.meta.filename)),
    config: { names, blocks, samples, floorMs, warmMs, nonInferiorityMargin: 0.02, uncertainty: 'Two-sided 95% Student t interval on independent quartet-mean log latency ratios; per-workload, unadjusted; no batch pooling or A/A subtraction', neutralModule: join(neutral, 'shared.js'), executable: process.execPath }, pilots: [], subjects: [], comparisons: [], summaries: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2)); renameSync(`${output}.tmp`, `${output}.partial`); };
  function run(build, config) {
    assert.deepEqual(buildManifest(build === 'baseline' ? baseline : candidate), builds[build]);
    rmSync(neutral, { force: true, recursive: true }); cpSync(join(build === 'baseline' ? baseline : candidate, 'dist'), neutral, { recursive: true });
    assert.ok(!lstatSync(neutral).isSymbolicLink());
    for (const [file, hash] of Object.entries(builds[build])) { assert.ok(!lstatSync(join(neutral, file)).isSymbolicLink()); assert.equal(sha(readFileSync(join(neutral, file))), hash); }
    const child = spawnSync(process.execPath, [import.meta.filename, '--subject', JSON.stringify({ module: join(neutral, 'shared.js'), samples, floorMs, warmMs, ...config })], { encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message || child.stdout);
    for (const [file, hash] of Object.entries(builds[build])) assert.equal(sha(readFileSync(join(neutral, file))), hash);
    return JSON.parse(child.stdout);
  }
  try {
    for (const name of names) {
      const pilots = ['baseline', 'candidate'].map(build => ({ build, name, result: run(build, { name, mode: 'pilot' }) }));
      report.pilots.push(...pilots); const iterations = Math.max(...pilots.map(p => p.result.iterations)), warmIterations = Math.max(...pilots.map(p => p.result.warmScans)) * 2; save();
      for (let block = 0; block < blocks; block++) {
        // Alternate comparison and lexical label order. All labels use one module
        // URL, one matched operation count, and independent engine processes.
        const protocols = block % 2 ? ['AB', 'AA'] : ['AA', 'AB'];
        for (const protocol of protocols) {
          // Each quartet has two adjacent pairs, ABBA or BAAB. Its mean log
          // ratio is one inferential unit; pairs/batches remain descriptive.
          for (let pair = 0; pair < 2; pair++) {
            const members = [];
            for (const label of (block + pair) % 2 ? ['right', 'left'] : ['left', 'right']) {
              const build = protocol === 'AB' && label === 'right' ? 'candidate' : 'baseline';
              const result = run(build, { mode: 'measure', name, iterations, warmIterations });
              const record = { name, block, pair, protocol, label, build, result }; report.subjects.push(record); members.push(record); save();
            }
            const left = members.find(s => s.label === 'left').result, right = members.find(s => s.label === 'right').result;
            report.comparisons.push({ name, block, pair, protocol, speedup: left.medianMs / right.medianMs, shortBatchCount: left.shortBatchCount + right.shortBatchCount }); save();
          }
        }
      }
      for (const protocol of ['AA', 'AB']) {
        const rows = report.comparisons.filter(r => r.name === name && r.protocol === protocol);
        const summary = summarizeQuartets(rows, report.subjects.filter(s => s.name === name && s.protocol === protocol));
        report.summaries.push({ name, protocol, ...summary }); save();
        console.log(`${name} ${protocol}: latency ${summary.latencyRatio.toFixed(3)}x [${summary.interval.map(v => v.toFixed(3)).join(', ')}]; ${summary.conclusion}; baseline/candidate batches ${summary.baselineBatchMedianMs.toFixed(3)}/${summary.candidateBatchMedianMs.toFixed(3)}ms; flags ${summary.shortBatchCount} short, ${summary.warmFloorMisses} warm`);
      }
    }
    for (const [label, dir] of [['baseline', baseline], ['candidate', candidate]]) for (const [file, hash] of Object.entries(manifests[label])) assert.equal(sha(readFileSync(join(dir, file))), hash, `Source changed during run: ${label}/${file}`);
    report.completed = new Date().toISOString(); save(); renameSync(`${output}.partial`, output);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
