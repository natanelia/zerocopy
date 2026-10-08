// Fresh-process, single-build comparisons. Raw data are diagnostic, never a CI
// speed gate. No instrumented allocation code is used in the timing process.
// POINTER_BASE=<checkout> POINTER_OUTPUT=<file> [POINTER_CASES=...] [POINTER_BLOCKS=4] node ...
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
export const cases = {
  'empty-number-list': { kind: 'list', type: 'number', size: 0 },
  'number-list32': { kind: 'list', type: 'number', size: 32 },
  'boolean-list4096': { kind: 'list', type: 'boolean', size: 4096 },
  'string-list1': { kind: 'list', type: 'string', size: 1 },
  'object-list1': { kind: 'list', type: 'object', size: 1 },
  'string-list32': { kind: 'list', type: 'string', size: 32 },
  'string-list4096': { kind: 'list', type: 'string', size: 4096 },
  'object-list4096': { kind: 'list', type: 'object', size: 4096 },
  'string-map1': { kind: 'map', type: 'string', size: 1 },
  'string-map4096': { kind: 'map', type: 'string', size: 4096 },
  'object-map4096': { kind: 'map', type: 'object', size: 4096 },
  'object-sorted4096': { kind: 'sorted', type: 'object', size: 4096 },
  'string-stack1': { kind: 'stack', type: 'string', size: 1 },
  'string-stack4096': { kind: 'stack', type: 'string', size: 4096 },
  'object-heap1': { kind: 'heap', type: 'object', size: 1 },
  'object-heap4096': { kind: 'heap', type: 'object', size: 4096 },
  'string-ordered32': { kind: 'ordered', type: 'string', size: 32 },
  'nested-list128': { kind: 'nested', type: 'SharedList<string>', size: 128 },
  'attached-forks4096': { kind: 'attached', type: 'string', size: 4096 },
  'tiny-three-kinds1': { kind: 'many', size: 1 },
  'tiny-three-kinds32': { kind: 'many', size: 32 },
  'tiny-three-kinds128': { kind: 'many', size: 128 },
};

export function assertSameLogicalIntegrity(initial, final) {
  // Fresh target IDs are serialized into nested descriptors. A wider ID can
  // change byte lengths/alignment even when all logical values are identical.
  const { compactedBytes: initialBytes, ...before } = initial;
  const { compactedBytes: finalBytes, ...after } = final;
  assert.deepEqual(after, before);
}

export async function subject(config) {
  const api = await import(pathToFileURL(config.module).href), spec = cases[config.name];
  assert.ok(spec);
  const values = Array.from({ length: spec.size }, (_, i) => spec.type === 'number' ? i : spec.type === 'boolean' ? !!(i & 1) : spec.type === 'string' ? `value${i}` : { i, nested: [i] });
  let snapshots;
  if (spec.kind === 'many') {
    snapshots = {};
    for (let i = 0; i < spec.size; i++) {
      // Private source construction is outside timing. Each triple shares one
      // arena, but triples have distinct IDs and independent typed cache groups.
      const group = api.compactMany({ text: new api.SharedList('string').push('value'), object: new api.SharedList('object').push({ i }), map: new api.SharedMap('string').set('key', 'value') });
      for (const [name, snapshot] of Object.entries(group)) snapshots[`${name}${i}`] = snapshot;
    }
  } else if (spec.kind === 'nested') {
    const child = new api.SharedList('string').pushMany(Array.from({ length: 32 }, (_, i) => `child${i}`));
    snapshots = { list: new api.SharedList('SharedList<string>').pushMany(Array.from({ length: spec.size }, () => child)), child };
  } else if (spec.kind === 'attached') {
    const base = new api.SharedList('string').pushMany(values), more = base.push('new');
    const payload = api.getWorkerData({ base, more }, { copy: true });
    const first = await api.initWorker(payload), second = await api.initWorker(payload);
    snapshots = { base: first.base, more: second.more };
  } else {
    let snapshot;
    if (spec.kind === 'list') snapshot = new api.SharedList(spec.type).pushMany(values);
    else if (spec.kind === 'map') snapshot = new api.SharedMap(spec.type).setMany(values.map((value, i) => [`key${i}`, value]));
    else if (spec.kind === 'sorted' || spec.kind === 'ordered') {
      snapshot = new (spec.kind === 'sorted' ? api.SharedSortedMap : api.SharedOrderedMap)(spec.type);
      for (const [i, value] of values.entries()) snapshot = snapshot.set(`key${i}`, value);
    } else if (spec.kind === 'stack') {
      snapshot = new api.SharedStack(spec.type);
      for (const value of values) snapshot = snapshot.push(value);
    } else {
      snapshot = new api.SharedPriorityQueue(spec.type);
      for (const [i, value] of values.entries()) snapshot = snapshot.enqueue(value, i % 17);
    }
    snapshots = { snapshot };
  }
  const names = Object.keys(snapshots), expected = Object.values(snapshots).reduce((sum, snapshot) => sum + snapshot.size, 1);
  const nestedValues = value => value instanceof api.SharedList ? value.toArray().map(nestedValues) : value;
  const inspect = snapshot => {
    if (snapshot instanceof api.SharedList) return snapshot.toArray().map(nestedValues);
    if (snapshot instanceof api.SharedStack) {
      const result = []; while (snapshot.size) { result.push(snapshot.peek()); snapshot = snapshot.pop(); } return result;
    }
    return [...snapshot.entries()];
  };
  const expectedValues = Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) => [name, inspect(snapshot)]));
  const original = api.getWorkerData(snapshots, { copy: true });
  const verify = () => {
    const result = api.compactMany(snapshots);
    for (const name of names) assert.deepEqual(inspect(result[name]), expectedValues[name]);
    const payload = api.getWorkerData(result, { copy: true }); assert.equal(payload.arenas.length, 1);
    return { names, size: expected - 1, compactedBytes: payload.arenas[0].used - 65536 };
  };
  const integrity = verify();
  const scan = () => {
    const result = api.compactMany(snapshots); let checksum = 1;
    for (const name of names) checksum += result[name].size;
    return checksum;
  };
  assert.equal(scan(), expected);
  if (config.mode === 'checks') return { name: config.name, ...integrity, checksum: scan(), expected };
  const batch = iterations => {
    let checksum = 0; const start = performance.now();
    for (let i = 0; i < iterations; i++) checksum += scan();
    const ms = performance.now() - start; assert.equal(checksum, expected * iterations);
    return { ms, checksum };
  };
  const warmStart = performance.now(); let warmScans = 0;
  while (config.mode === 'pilot' ? performance.now() - warmStart < config.warmMs || warmScans < 32 : warmScans < config.warmIterations) { batch(8); warmScans += 8; }
  const warmElapsedMs = performance.now() - warmStart;
  if (config.mode === 'pilot') {
    let iterations = 1; const calibration = [];
    for (let i = 0; i < 24; i++) {
      const result = batch(iterations); calibration.push({ iterations, ...result });
      if (result.ms >= config.floorMs * 1.5) return { mode: 'pilot', iterations, calibration, warmScans, warmElapsedMs, integrity };
      iterations = Math.max(iterations + 1, Math.ceil(iterations * Math.min(8, Math.max(1.2, config.floorMs * 1.7 / Math.max(result.ms, 0.01)))));
    }
    throw new Error('Calibration failed');
  }
  const samples = Array.from({ length: config.samples }, () => batch(config.iterations));
  const finalIntegrity = verify();
  assertSameLogicalIntegrity(integrity, finalIntegrity);
  const after = api.getWorkerData(snapshots, { copy: true });
  assert.equal(after.arenas.length, original.arenas.length);
  after.arenas.forEach((a, i) => assert.equal(Buffer.compare(a.copy, original.arenas[i].copy), 0, 'Published source changed'));
  return { mode: 'measure', iterations: config.iterations, samples, medianMs: median(samples.map(s => s.ms)), warmScans, warmElapsedMs, integrity, finalIntegrity,
    shortBatchCount: samples.filter(s => s.ms < config.floorMs).length, warmFloorMet: warmElapsedMs >= config.warmMs, runtime: process.versions };
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
  const compactionsPerBatch = subjects[0].result.iterations;
  assert.ok(Number.isInteger(compactionsPerBatch) && compactionsPerBatch > 0 && subjects.every(s => s.result.iterations === compactionsPerBatch));
  const shortBatchCount = subjects.reduce((sum, s) => sum + s.result.shortBatchCount, 0);
  const warmFloorMisses = subjects.filter(s => !s.result.warmFloorMet).length;
  return { independentQuartets: n, descriptiveProcessPairs: rows.length, degreesOfFreedom: n - 1, quartetLatencyRatios: logs.map(Math.exp), latencyRatio: ratio, latencyChangePercent: (ratio - 1) * 100,
    confidenceLevel: 0.95, interval: [lower, upper], nonInferiorityMargin: margin, intervalClassification,
    compactionsPerBatch, baselineBatchMedianMs: median(baselineMs), candidateBatchMedianMs: median(candidateMs),
    baselineNsPerCompaction: median(baselineMs) * 1e6 / compactionsPerBatch, candidateNsPerCompaction: median(candidateMs) * 1e6 / compactionsPerBatch,
    batchMedianDifferenceMs: median(candidateMs) - median(baselineMs), shortBatchCount, warmFloorMisses,
    inferenceUsable: shortBatchCount === 0 && warmFloorMisses === 0,
    conclusion: shortBatchCount || warmFloorMisses ? 'inconclusive (timing flags)' : intervalClassification };
}
if (process.argv[2] === '--subject') {
  console.log(JSON.stringify(await subject(JSON.parse(process.argv[3]))));
} else if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..'), baseline = resolve(process.env.POINTER_BASE ?? join(root, '.proof-baseline'));
  const candidate = resolve(process.env.POINTER_CANDIDATE ?? root), expectedBase = '3773c6e519c7c0958da13727ed1082f449f3ee25';
  const output = resolve(process.env.POINTER_OUTPUT ?? join(root, 'proofs/results/compaction-pointer-local.json'));
  const names = (process.env.POINTER_CASES ?? Object.keys(cases).join(',')).split(',');
  const blocks = Number(process.env.POINTER_BLOCKS ?? 4), samples = Number(process.env.POINTER_SAMPLES ?? 11);
  assert.ok(names.every(n => cases[n]) && new Set(names).size === names.length);
  assert.ok(Number.isInteger(blocks) && blocks >= 2 && blocks <= 12 && blocks % 2 === 0);
  assert.ok(Number.isInteger(samples) && samples >= 5 && samples <= 51 && samples % 2 === 1);
  const floorMs = Number(process.env.POINTER_FLOOR_MS ?? 20), warmMs = Number(process.env.POINTER_WARM_MS ?? 150);
  assert.ok(floorMs >= 5 && warmMs >= 100);
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), expectedBase);
  assert.equal(git(candidate, 'merge-base', expectedBase, 'HEAD'), expectedBase);
  assert.equal(sha(readFileSync(import.meta.filename)), sha(execFileSync('git', ['-C', candidate, 'show', 'HEAD:proofs/compaction-pointer-performance.mjs'])), 'Dirty timing driver');
  const paths = new Set([...git(baseline, 'ls-files').split('\n'), ...git(candidate, 'ls-files').split('\n')].filter(p => /\.ts$/.test(p) && !p.endsWith('.test.ts') && !p.startsWith('proofs/') && !p.startsWith('type-tests/') && !p.startsWith('website/') && !p.startsWith('demo/') || p.startsWith('scripts/build-') || p === 'package.json' || p.startsWith('tsconfig')));
  const differences = [], manifests = { baseline: {}, candidate: {} };
  for (const path of [...paths].sort()) {
    const a = readFileSync(join(baseline, path)), b = readFileSync(join(candidate, path));
    assert.equal(sha(a), sha(execFileSync('git', ['-C', baseline, 'show', `${expectedBase}:${path}`])), `Dirty baseline: ${path}`);
    assert.equal(sha(b), sha(execFileSync('git', ['-C', candidate, 'show', `HEAD:${path}`])), `Dirty candidate: ${path}`);
    manifests.baseline[path] = sha(a); manifests.candidate[path] = sha(b);
    if (!a.equals(b)) differences.push(path);
  }
  assert.deepEqual(differences, ['compaction.ts']);
  const vector = text => {
    const start = text.indexOf('  private vector('), end = text.indexOf('  private heap(', start);
    assert.ok(start >= 0 && end > start); return text.slice(start, end);
  };
  assert.equal(vector(readFileSync(join(baseline, 'compaction.ts'), 'utf8')), vector(readFileSync(join(candidate, 'compaction.ts'), 'utf8')), 'Primitive vector path must remain unchanged');
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
  const staging = mkdtempSync(join(tmpdir(), 'compaction-pointer-')), neutral = join(staging, 'dist');
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
