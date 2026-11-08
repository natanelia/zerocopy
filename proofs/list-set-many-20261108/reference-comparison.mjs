import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { study, makeFixture } from './workloads.mjs';

const SCRIPT = fileURLToPath(import.meta.url), LOCK = '/tmp/zerocopy-perf-20261108.lock';
const ROUNDS = 3, WARMUP_MS = 250, SAMPLES = 9, MINIMUM_WARMUP_BATCHES = 8;
const IMPLEMENTATIONS = ['zerocopy-before', 'zerocopy-after', 'immutable', 'native'];
const CASES = study.cases.filter(spec => ['batch-number-clustered-256', 'batch-number-scattered-256',
  'batch-number-repeated-256', 'batch-number-scattered-1024'].includes(spec.name));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = name => sha(readFileSync(name));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const affinity = () => readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]?.trim();
const gitHead = root => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
function identity(root) {
  const names = ['package.json', 'shared-list.ts', 'persistent-core.as.ts', 'persistent-core.wasm',
    ...readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js')).map(name => `dist/${name}`)].sort();
  return { root, commit: gitHead(root), hashes: Object.fromEntries(names.map(name => [name, fileHash(join(root, name))])) };
}

async function subject(directory, dependencies, name, implementation) {
  const spec = CASES.find(spec => spec.name === name);
  assert.ok(spec); assert.ok(IMPLEMENTATIONS.includes(implementation));
  const { input, entries } = makeFixture(spec), expected = [...input];
  for (const [index, value] of entries) expected[index] = value;
  const require = createRequire(join(dependencies, 'package.json'));
  const immutablePath = require.resolve('immutable'), immutablePackage = require.resolve('immutable/package.json');
  const immutableIdentity = { version: JSON.parse(readFileSync(immutablePackage, 'utf8')).version,
    moduleSha256: fileHash(immutablePath), packageSha256: fileHash(immutablePackage) };
  const S = implementation.startsWith('zerocopy') ? await import(pathToFileURL(join(directory, 'dist/shared.js'))) : null;
  const I = implementation === 'immutable' ? require('immutable') : null;
  if (implementation === 'zerocopy-before') assert.equal(typeof S.SharedList.prototype.setMany, 'undefined');
  if (implementation === 'zerocopy-after') assert.equal(typeof S.SharedList.prototype.setMany, 'function');
  // The native arm keeps whole arrays. Bound retained payload to 4M values
  // (about32MiB) equally for every library, independently of the A/B repeats.
  const repetitions = Math.max(8, Math.min(128, Math.floor(4194304 / spec.count))), outputs = new Array(repetitions);
  let source, sourceMemory, sourceUsed, sourceHash;
  const flatten = result => Array.isArray(result) ? result : result.toArray();
  function check(actual, model, label) {
    assert.equal(actual.length, model.length, `${label}: size`);
    for (let i = 0; i < model.length; i++) if (!Object.is(actual[i], model[i])) assert.fail(`${label}: value ${i}`);
  }
  function setup() {
    if (S) {
      S.resetSharedList(); source = new S.SharedList('number').pushMany(input);
      const arena = S.getWorkerData({ source }, { copy: false }).arenas[0];
      sourceMemory = arena.memory; sourceUsed = arena.used;
      sourceHash = sha(new Uint8Array(sourceMemory.buffer, 65536, sourceUsed - 65536));
    } else source = I ? I.List(input) : [...input];
  }
  const operation = implementation === 'zerocopy-before' ? () => {
    let result = source;
    for (const [index, value] of entries) result = result.set(index, value);
    return result;
  } : implementation === 'zerocopy-after' ? () => source.setMany(entries)
    : implementation === 'immutable' ? () => source.withMutations(result => {
      for (const [index, value] of entries) result.set(index, value);
    }) : () => {
      // The source and each final result are retained. This private copy can
      // therefore apply all edits in place before the result is exposed.
      const result = source.slice();
      for (const [index, value] of entries) result[index] = value;
      return result;
    };
  function batch() {
    setup();
    const start = performance.now();
    for (let i = 0; i < repetitions; i++) outputs[i] = operation();
    const elapsed = performance.now() - start;
    for (const result of outputs) check(flatten(result), expected, 'final result');
    check(flatten(source), input, 'retained source');
    if (S) assert.equal(sha(new Uint8Array(sourceMemory.buffer, 65536, sourceUsed - 65536)), sourceHash);
    return elapsed;
  }
  let warmed = 0;
  const warmupBatchMs = [], sampleBatchMs = [];
  while (warmed < WARMUP_MS || warmupBatchMs.length < MINIMUM_WARMUP_BATCHES) {
    const elapsed = batch(); warmupBatchMs.push(elapsed); warmed += elapsed;
  }
  for (let sample = 0; sample < SAMPLES; sample++) sampleBatchMs.push(batch());
  return {
    runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, affinity: affinity(),
    implementation, caseName: spec.name, spec, repetitions,
    expectedDigest: sha(JSON.stringify({ input, entries, expected })), immutable: immutableIdentity,
    warmupBatchMs, sampleBatchMs, verifiedFinalSnapshots: (warmupBatchMs.length + sampleBatchMs.length) * repetitions,
    medianMillisecondsPerBatch: median(sampleBatchMs) / repetitions,
    medianMillisecondsPerScalarEditEquivalent: median(sampleBatchMs) / repetitions / spec.edits,
    measuredBatchesBelow2ms: sampleBatchMs.filter(ms => ms < 2).length,
  };
}

async function coordinator(args) {
  assert.equal(args.length, 4, 'Usage: taskset -c CPU node reference-comparison.mjs BEFORE_ROOT AFTER_ROOT BUN OUTPUT_JSON');
  const [beforeRoot, afterRoot, bun, output] = args.map(arg => resolve(arg));
  assert.ok(!existsSync(output), 'Use a new evidence path; existing recordings are immutable');
  assert.match(affinity(), /^\d+$/, 'Pin the comparison to one available CPU');
  const before = identity(beforeRoot), after = identity(afterRoot), harnessHash = fileHash(SCRIPT);
  assert.equal(before.commit, study.baseline);
  const workloadPath = fileURLToPath(new URL('./workloads.mjs', import.meta.url)), workloadHash = fileHash(workloadPath);
  const neutral = mkdtempSync(join(tmpdir(), 'zerocopy-list-batch-reference-'));
  writeFileSync(join(neutral, 'package.json'), '{"type":"module"}\n');
  const data = { schema: 'zerocopy-list-batch-library-comparison/v1', startedAt: new Date().toISOString(), status: 'running',
    source: { before, after }, harnessHash, workloadHash,
    host: { cpu: cpus()[0]?.model, arch: arch(), platform: platform(), affinity: affinity() },
    method: { rounds: ROUNDS, warmupMs: WARMUP_MS, minimumWarmupBatches: MINIMUM_WARMUP_BATCHES, samples: SAMPLES,
      cases: CASES, implementations: IMPLEMENTATIONS, runtimes: { node: process.execPath, bun }, lock: LOCK,
      process: 'One case and implementation per fresh process; runtime/case order reverses and implementation order rotates by round',
      unit: 'milliseconds per complete logical batch; scalar-edit-equivalent divides by the submitted entry count',
      retention: 'Original source and every returned final snapshot remain reachable during each timed batch; intermediate scalar snapshots are not retained',
      strategies: { 'zerocopy-before': 'persistent set loop', 'zerocopy-after': 'one setMany call',
        immutable: 'List.withMutations, one private mutation session per complete batch', native: 'one Array.slice per complete batch, followed by private indexed assignments' },
      excluded: 'imports, source construction/reset, fixture creation, retention array allocation, full result/source checks',
      qualification: 'Supplementary library comparison; the primary paired A/B study carries the optimization claim. Native arrays do not provide worker transport.' },
    runs: [], summary: [] };
  mkdirSync(dirname(output), { recursive: true });
  function save() {
    data.summary = [];
    for (const runtime of ['node', 'bun']) for (const spec of CASES) for (const implementation of IMPLEMENTATIONS) {
      const runs = data.runs.filter(run => run.runtime === runtime && run.caseName === spec.name && run.implementation === implementation);
      if (runs.length) data.summary.push({ runtime, caseName: spec.name, implementation, rounds: runs.length,
        millisecondsPerBatch: median(runs.map(run => run.medianMillisecondsPerBatch)),
        microsecondsPerScalarEditEquivalent: median(runs.map(run => run.medianMillisecondsPerScalarEditEquivalent)) * 1000 });
    }
    writeFileSync(`${output}.partial`, JSON.stringify(data, null, 2) + '\n'); renameSync(`${output}.partial`, output);
  }
  save();
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const runtimes = round % 2 ? ['bun', 'node'] : ['node', 'bun'];
      const cases = round % 2 ? [...CASES].reverse() : CASES;
      for (const runtime of runtimes) for (const spec of cases) {
        const offset = (round + CASES.indexOf(spec) + Number(runtime === 'bun')) % IMPLEMENTATIONS.length;
        const rotated = IMPLEMENTATIONS.slice(offset).concat(IMPLEMENTATIONS.slice(0, offset));
        const order = round % 2 ? rotated.reverse() : rotated;
        for (const implementation of order) {
          const root = implementation === 'zerocopy-before' ? beforeRoot : afterRoot;
          rmSync(join(neutral, 'dist'), { recursive: true, force: true });
          cpSync(join(root, 'dist'), join(neutral, 'dist'), { recursive: true });
          const startedAt = new Date().toISOString();
          const child = spawnSync(data.method.runtimes[runtime], [SCRIPT, '--child', neutral, afterRoot, spec.name, implementation],
            { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
          let result;
          try {
            assert.equal(child.status, 0, child.stderr || String(child.error));
            result = JSON.parse(child.stdout); assert.equal(result.runtime, runtime);
            assert.equal(result.affinity, data.host.affinity); assert.equal(result.implementation, implementation);
            assert.deepEqual(result.spec, spec);
            const previous = data.runs.find(run => run.caseName === spec.name);
            if (previous) assert.equal(result.expectedDigest, previous.expectedDigest);
          } catch (error) {
            data.failure = { round, runtime, caseName: spec.name, implementation, startedAt,
              exitCode: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr,
              error: String(error.stack ?? error) };
            throw error;
          }
          data.runs.push({ round, order, startedAt, completedAt: new Date().toISOString(), ...result });
          save();
          console.log(`${runtime} ${spec.name} ${implementation} round ${round + 1}/${ROUNDS}: ${(result.medianMillisecondsPerBatch * 1000).toFixed(3)} us per complete batch`);
        }
      }
    }
    assert.deepEqual(identity(beforeRoot), before); assert.deepEqual(identity(afterRoot), after);
    assert.equal(fileHash(SCRIPT), harnessHash); assert.equal(fileHash(workloadPath), workloadHash);
    data.status = 'complete'; data.completedAt = new Date().toISOString(); save();
  } catch (error) {
    data.status = 'failed'; data.completedAt = new Date().toISOString(); data.error = String(error.stack ?? error); save(); throw error;
  } finally { rmSync(neutral, { recursive: true, force: true }); }
}

if (process.argv[2] === '--child') process.stdout.write(JSON.stringify(await subject(...process.argv.slice(3))));
else if (process.argv[2] === '--locked') await coordinator(process.argv.slice(3));
else {
  const child = spawnSync('flock', ['--nonblock', LOCK, process.execPath, SCRIPT, '--locked', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
