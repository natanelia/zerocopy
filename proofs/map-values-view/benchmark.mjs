import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
const median = values => {
  assert.ok(values.length);
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// A fixed, paired study: each fresh process has separate lexical scan/timer
// functions for baseline and candidate. Import, warmup and timing order alternate.
// The independent units in the confidence interval are processes, not batches.
const CASES = [
  ...['number', 'boolean'].flatMap(type => [4096, 65536].map(size => ({ type, size, operation: 'values' }))),
  ...['string', 'object'].flatMap(type => [1024, 4096].map(size => ({ type, size, operation: 'values' }))),
  ...['number', 'boolean'].map(type => ({ type, size: 4096, operation: 'get' })),
].map(row => ({ ...row, name: `${row.type}/${row.size}/${row.operation}` }));
const CONFIG = Object.freeze({ rounds: 6, aaRounds: 4, samples: 12, warmupMsPerVariant: 500, minimumWarmupPairs: 8,
  targetBatchMs: 12, aaCases: ['number/65536/values', 'object/1024/values', 'number/4096/get', 'boolean/4096/get'] });
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function measure() {
  const [leftEntry, rightEntry, name, phaseText] = process.argv.slice(3);
  const workload = CASES.find(row => row.name === name), phase = Number(phaseText);
  assert.ok(workload);
  const { type, size, operation } = workload;
  let baselineApi, candidateApi;
  if (phase % 2) { candidateApi = await import(pathToFileURL(rightEntry).href); baselineApi = await import(pathToFileURL(leftEntry).href); }
  else { baselineApi = await import(pathToFileURL(leftEntry).href); candidateApi = await import(pathToFileURL(rightEntry).href); }
  const makeValue = i => type === 'number' ? i + 0.25 : type === 'boolean' ? i % 3 === 0
    : type === 'string' ? `value-${i}` : { n: i, tags: [i & 7, 5] };
  const entries = Array.from({ length: size }, (_, i) => [`key-${i}`, makeValue(i)]), model = new Map(entries), keys = [...model.keys()];
  let baseline, candidate;
  if (phase % 2) { candidate = new candidateApi.SharedMap(type).setMany(entries); baseline = new baselineApi.SharedMap(type).setMany(entries); }
  else { baseline = new baselineApi.SharedMap(type).setMany(entries); candidate = new candidateApi.SharedMap(type).setMany(entries); }
  // Key decoding shares the bounded string cache with value decoding. Both
  // builds must perform the same key reads before validating or warming values.
  const baselineKeys = [...baseline.keys()], candidateKeys = [...candidate.keys()];
  assert.deepEqual(candidateKeys, baselineKeys, 'Both builds have the same iteration order');
  const oracle = baselineKeys.map(key => model.get(key));
  assert.deepEqual([...baseline.values()], oracle); assert.deepEqual([...candidate.values()], oracle);
  const capture = (api, map) => {
    const source = api.getWorkerData({ map }, { copy: false }).arenas[0];
    return { used: source.used, bytes: sha256(new Uint8Array(source.memory.buffer, 65536, source.used - 65536)) };
  };
  const before = { baseline: capture(baselineApi, baseline), candidate: capture(candidateApi, candidate) };
  const expected = entries.reduce((s, [, value]) => s + (type === 'number' || type === 'boolean' ? +value
    : type === 'string' ? value.length : value.n + value.tags[0] + value.tags[1]), 0);

  // Deliberately distinct lexical functions: neither the map method call site
  // nor generator iteration feedback ever alternates between two libraries.
  function scanBaseline(repeat) {
    let sum = 0, count = 0;
    if (operation === 'get') for (let r = 0; r < repeat; r++) for (const key of keys) { sum += baseline.get(key); count++; }
    else if (type === 'number' || type === 'boolean') for (let r = 0; r < repeat; r++) for (const value of baseline.values()) { sum += +value; count++; }
    else if (type === 'string') for (let r = 0; r < repeat; r++) for (const value of baseline.values()) { sum += value.length; count++; }
    else for (let r = 0; r < repeat; r++) for (const value of baseline.values()) { sum += value.n + value.tags[0] + value.tags[1]; count++; }
    return { sum, count };
  }
  function scanCandidate(repeat) {
    let sum = 0, count = 0;
    if (operation === 'get') for (let r = 0; r < repeat; r++) for (const key of keys) { sum += candidate.get(key); count++; }
    else if (type === 'number' || type === 'boolean') for (let r = 0; r < repeat; r++) for (const value of candidate.values()) { sum += +value; count++; }
    else if (type === 'string') for (let r = 0; r < repeat; r++) for (const value of candidate.values()) { sum += value.length; count++; }
    else for (let r = 0; r < repeat; r++) for (const value of candidate.values()) { sum += value.n + value.tags[0] + value.tags[1]; count++; }
    return { sum, count };
  }
  function timeBaseline(repeat) {
    const start = performance.now(), result = scanBaseline(repeat), elapsed = performance.now() - start;
    assert.equal(result.sum, expected * repeat); assert.equal(result.count, size * repeat);
    return elapsed;
  }
  function timeCandidate(repeat) {
    const start = performance.now(), result = scanCandidate(repeat), elapsed = performance.now() - start;
    assert.equal(result.sum, expected * repeat); assert.equal(result.count, size * repeat);
    return elapsed;
  }
  function pair(repeat, index) {
    let a, b;
    if ((index + phase) % 2) { b = timeCandidate(repeat); a = timeBaseline(repeat); }
    else { a = timeBaseline(repeat); b = timeCandidate(repeat); }
    return { baselineMs: a, candidateMs: b, order: (index + phase) % 2 ? 'BA' : 'AB' };
  }
  let repeat = Math.max(1, Math.ceil(32768 / size)), warmA = 0, warmB = 0, pairIndex = 0;
  const warmup = [], calibration = [];
  while (Math.min(warmA, warmB) < CONFIG.warmupMsPerVariant || warmup.length < CONFIG.minimumWarmupPairs) {
    const row = pair(repeat, pairIndex++); warmA += row.baselineMs; warmB += row.candidateMs; warmup.push(row);
  }
  for (let step = 0; step < 12; step++) {
    const trials = Array.from({ length: 3 }, () => pair(repeat, pairIndex++));
    calibration.push({ repeat, trials });
    const faster = Math.min(median(trials.map(row => row.baselineMs)), median(trials.map(row => row.candidateMs)));
    if (faster >= CONFIG.targetBatchMs * 1.25) break;
    repeat = Math.ceil(repeat * Math.min(8, Math.max(1.1, CONFIG.targetBatchMs * 1.5 / Math.max(faster, 0.001))));
    assert.ok(repeat <= 10000000);
  }
  const last = calibration.at(-1);
  assert.equal(last.repeat, repeat, 'Calibration finished at the measured repeat count');
  assert.ok(Math.min(median(last.trials.map(row => row.baselineMs)), median(last.trials.map(row => row.candidateMs))) >= CONFIG.targetBatchMs * 1.25, 'Calibration reached the batch target');
  const samples = Array.from({ length: CONFIG.samples }, (_, i) => pair(repeat, i));
  assert.deepEqual([...baseline.values()], oracle); assert.deepEqual([...candidate.values()], oracle);
  assert.deepEqual(capture(baselineApi, baseline), before.baseline, 'Baseline reads allocate no shared memory and preserve published bytes');
  assert.deepEqual(capture(candidateApi, candidate), before.candidate, 'Candidate reads allocate no shared memory and preserve published bytes');
  const baselines = samples.map(row => row.baselineMs / repeat), candidates = samples.map(row => row.candidateMs / repeat);
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, arch: process.arch, name, phase,
    expectedSum: expected, expectedCount: size, symmetricKeyReads: true, keyOrderDigest: sha256(JSON.stringify(baselineKeys)),
    zeroSharedAllocation: true, immutableBytes: before, repeat, warmupRepeat: Math.max(1, Math.ceil(32768 / size)), warmup, calibration, samples,
    medianBaselineMs: median(baselines), medianCandidateMs: median(candidates),
    pairedRatio: Math.exp(samples.reduce((s, row) => s + Math.log(row.candidateMs / row.baselineMs), 0) / samples.length) };
}

function summarize(runs) {
  const result = [];
  for (const runtime of ['node', 'bun']) for (const mode of ['ab', 'aa']) for (const workload of CASES) {
    const rows = runs.filter(row => row.runtime === runtime && row.mode === mode && row.name === workload.name);
    if (rows.length !== (mode === 'ab' ? CONFIG.rounds : CONFIG.aaRounds)) continue;
    const logs = rows.map(row => Math.log(row.pairedRatio)), mean = logs.reduce((s, n) => s + n, 0) / logs.length;
    const se = Math.sqrt(logs.reduce((s, n) => s + (n - mean) ** 2, 0) / (logs.length - 1) / logs.length);
    const t = logs.length === 6 ? 2.570581835636 : 3.182446305284;
    result.push({ runtime, mode, ...workload, independentProcesses: rows.length,
      baselineMs: median(rows.map(row => row.medianBaselineMs)), candidateMs: median(rows.map(row => row.medianCandidateMs)),
      ratio: Math.exp(mean), lower95: Math.exp(mean - t * se), upper95: Math.exp(mean + t * se),
      processRatios: rows.map(row => row.pairedRatio) });
  }
  return result;
}

function manifest(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter(file => (file.endsWith('.ts') && !file.includes('/') && !file.endsWith('.test.ts'))
      || ['scripts/build-browser.ts', 'package.json', 'bun.lock'].includes(file)).sort();
  return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedSources: Object.fromEntries(files.map(file => [file, sha256(readFileSync(join(root, file)))])),
    source: sha256(readFileSync(join(root, 'shared-map.ts'))), arena: sha256(readFileSync(join(root, 'arena.ts'))), wasm: sha256(readFileSync(join(root, 'persistent-core.wasm'))),
    bundles: Object.fromEntries(readdirSync(join(root, 'dist')).filter(file => file.endsWith('.js')).sort()
      .map(file => [file, sha256(readFileSync(join(root, 'dist', file)))])) };
}

async function main() {
  const [baseArg, nextArg, bunArg, outputArg] = process.argv.slice(2);
  assert.ok(baseArg && nextArg && bunArg && outputArg, 'Usage: node benchmark.mjs BASELINE CANDIDATE BUN OUTPUT.json');
  const baseline = resolve(baseArg), candidate = resolve(nextArg), output = resolve(outputArg);
  assert.ok(!existsSync(output), 'Choose a new result path; never overwrite evidence');
  mkdirSync(dirname(output), { recursive: true });
  const source = { baseline: manifest(baseline), candidate: manifest(candidate), harness: sha256(readFileSync(import.meta.filename)) };
  assert.equal(source.baseline.wasm, source.candidate.wasm);
  assert.deepEqual(Object.keys(source.baseline.trackedSources), Object.keys(source.candidate.trackedSources));
  assert.deepEqual(Object.keys(source.baseline.trackedSources).filter(file =>
    source.baseline.trackedSources[file] !== source.candidate.trackedSources[file]), ['arena.ts', 'shared-map.ts'],
  'Only the intended runtime files may differ');
  const record = { schema: 1, status: 'running', createdAt: new Date().toISOString(), config: CONFIG, cases: CASES, source,
    hardware: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, availableParallelism: os.availableParallelism(),
      affinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Cpus_allowed_list:'))?.split('\t').at(-1) : null }, runs: [], summary: [] };
  const save = () => { record.summary = summarize(record.runs); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); };
  const temporary = mkdtempSync(join(os.tmpdir(), 'map-values-paired-'));
  try {
    for (const [label, root] of [['left', baseline], ['right', candidate], ['control', baseline]]) {
      mkdirSync(join(temporary, label)); cpSync(join(root, 'dist'), join(temporary, label, 'dist'), { recursive: true });
      cpSync(join(root, 'package.json'), join(temporary, label, 'package.json'));
    }
    save();
    for (const [runtime, executable] of [['node', process.execPath], ['bun', resolve(bunArg)]]) for (const mode of ['ab', 'aa']) {
      const cases = mode === 'ab' ? CASES : CASES.filter(row => CONFIG.aaCases.includes(row.name));
      for (let round = 0; round < (mode === 'ab' ? CONFIG.rounds : CONFIG.aaRounds); round++) {
        const ordered = [...cases.slice(round % cases.length), ...cases.slice(0, round % cases.length)];
        for (const workload of ordered) {
          const args = [import.meta.filename, '--child', join(temporary, 'left/dist/shared.js'),
            join(temporary, mode === 'ab' ? 'right/dist/shared.js' : 'control/dist/shared.js'), workload.name, String(round)];
          const child = spawnSync(executable, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
          if (child.status !== 0) { record.status = 'failed'; record.failure = { runtime, mode, workload, round, stderr: child.stderr, stdout: child.stdout, error: String(child.error ?? '') }; save(); throw new Error(child.stderr); }
          const row = JSON.parse(child.stdout); assert.equal(row.runtime, runtime); assert.equal(row.arch, process.arch);
          record.runs.push({ mode, ...row }); save();
        }
        console.log(`${runtime} ${mode} paired study round ${round + 1} complete`);
      }
    }
    assert.deepEqual(manifest(baseline), source.baseline); assert.deepEqual(manifest(candidate), source.candidate);
    assert.equal(sha256(readFileSync(import.meta.filename)), source.harness, 'Benchmark driver changed during the run');
    record.status = 'complete'; record.completedAt = new Date().toISOString(); save();
    for (const row of record.summary) console.log(JSON.stringify(row));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[2] === '--child') process.stdout.write(JSON.stringify(await measure()));
else await main();
