import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Workload modules export a JSON-serializable study plus createWorkload(root, spec).
// The root is a neutral package directory; portable bundles live in root/dist.
// A workload returns { operation, verify, expectedDigest, checkInvariant?, fixture? }.
// The whole public operation and output retention are timed; setup and complete
// output verification are outside the timer. Callers must pin this process to
// one available CPU. The driver holds the common flock for the entire study.
const SCRIPT = fileURLToPath(import.meta.url);
const LOCK = '/tmp/zerocopy-perf-20261108.lock';
const SETTINGS = {
  pilot: { pairs: 2, minimumWarmupMs: 500 },
  formal: { pairs: 6, minimumWarmupMs: 500 },
  aa: { pairs: 4, minimumWarmupMs: 500 },
};
const SAMPLES = 9, MINIMUM_WARMUP_BATCHES = 8;
const CRITICAL95 = { 4: 3.182446305284263, 6: 2.5705818356363155 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => hash(readFileSync(path));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const affinity = () => readFileSync('/proc/self/status', 'utf8')
  .split('\n').find(line => line.startsWith('Cpus_allowed_list:'))?.split(':')[1].trim();
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function identity(root) {
  // Include untracked/new runtime helpers, not just files returned by git ls-files.
  const sources = readdirSync(root).filter(name =>
    (name.endsWith('.ts') && !name.endsWith('.test.ts')) || /^tsconfig.*\.json$/.test(name));
  sources.push('package.json', 'scripts/build-browser.ts', 'scripts/build-wasm.mjs');
  const wasm = readdirSync(root).filter(name => name.endsWith('.wasm')).sort();
  const bundles = readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js')).sort();
  assert.ok(wasm.length && bundles.length, 'Build WASM and portable bundles before benchmarking');
  const hashes = (names, base) => Object.fromEntries(names.sort().map(name => [name, fileHash(join(base, name))]));
  return { root, commit: git(root, ['rev-parse', 'HEAD']),
    sources: hashes(sources, root), wasm: hashes(wasm, root), bundles: hashes(bundles, join(root, 'dist')) };
}

function differences(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(name => before[name] !== after[name]).sort();
}

function summarize(data) {
  const rows = [];
  for (const runtime of ['node', 'bun']) for (const spec of data.method.cases) {
    const points = [];
    for (let pair = 0; pair < data.method.pairs; pair++) {
      const selected = data.runs.filter(run => run.runtime === runtime && run.caseName === spec.name && run.pair === pair);
      const before = selected.find(run => run.variant === 'before'), after = selected.find(run => run.variant === 'after');
      if (!before || !after) continue;
      assert.equal(before.expectedDigest, after.expectedDigest);
      assert.deepEqual(before.versions, after.versions);
      assert.deepEqual(before.fixture, after.fixture);
      assert.equal(before.affinity, after.affinity);
      points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    if (!points.length) continue;
    const logs = points.map(point => Math.log(point.ratio));
    const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    let interval95 = null;
    if (points.length === data.method.pairs && CRITICAL95[points.length]) {
      const se = Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logs.length - 1) / logs.length);
      interval95 = [Math.exp(mean - CRITICAL95[points.length] * se), Math.exp(mean + CRITICAL95[points.length] * se)];
    }
    rows.push({ runtime, name: spec.name, role: spec.role,
      beforeMs: median(points.map(point => point.before)), afterMs: median(points.map(point => point.after)),
      pairedRatio: Math.exp(mean), interval95, fasterPairs: points.filter(point => point.ratio < 1).length, points });
  }
  return rows;
}

async function subject(moduleName, directory, caseName, mode) {
  assert.ok(SETTINGS[mode]);
  const { study, createWorkload } = await import(pathToFileURL(moduleName));
  const spec = study.cases.find(item => item.name === caseName);
  assert.ok(spec);
  assert.ok(Number.isSafeInteger(spec.repetitions) && spec.repetitions > 0);
  const workload = await createWorkload(directory, spec);
  assert.equal(typeof workload.operation, 'function');
  assert.equal(typeof workload.verify, 'function');
  assert.match(workload.expectedDigest, /^[a-f0-9]{64}$/);
  await workload.prepareBatch?.(1);
  workload.checkInvariant?.();
  workload.verify(workload.operation());
  const output = new Array(spec.repetitions);
  let verifiedOutputs = 0;
  async function batch() {
    // Cold-reader fixtures may attach fresh readers asynchronously. This work,
    // like all fixture creation and verification, stays outside the timer.
    await workload.prepareBatch?.(spec.repetitions);
    const start = performance.now();
    for (let i = 0; i < spec.repetitions; i++) output[i] = workload.operation();
    const elapsed = performance.now() - start;
    assert.ok(Number.isFinite(elapsed) && elapsed > 0);
    for (const result of output) { workload.verify(result); verifiedOutputs++; }
    workload.checkInvariant?.();
    return elapsed;
  }
  const warmupBatchMs = [], sampleBatchMs = [];
  let warmedMs = 0;
  while (warmedMs < SETTINGS[mode].minimumWarmupMs || warmupBatchMs.length < MINIMUM_WARMUP_BATCHES) {
    const elapsed = await batch(); warmupBatchMs.push(elapsed); warmedMs += elapsed;
  }
  for (let i = 0; i < SAMPLES; i++) sampleBatchMs.push(await batch());
  await workload.prepareBatch?.(1);
  workload.verify(workload.operation());
  workload.checkInvariant?.();
  return {
    runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions,
    executable: process.execPath, affinity: affinity(), caseName, spec,
    expectedDigest: workload.expectedDigest, fixture: workload.fixture ?? null,
    warmupBatchMs, sampleBatchMs, verifiedOutputs,
    batchTiming: {
      minimumObservedMs: Math.min(...warmupBatchMs, ...sampleBatchMs),
      minimumMeasuredMs: Math.min(...sampleBatchMs),
      measuredBelow2ms: sampleBatchMs.filter(value => value < 2).length,
      warmupBelow2ms: warmupBatchMs.filter(value => value < 2).length,
    },
    medianMs: median(sampleBatchMs) / spec.repetitions,
  };
}

async function coordinator(args) {
  const [moduleArg, beforeArg, afterArg, bunArg, outputArg, mode = 'pilot'] = args;
  assert.ok(moduleArg && beforeArg && afterArg && bunArg && outputArg && SETTINGS[mode],
    'Usage: taskset -c CPU node paired-benchmark.mjs CASE_MODULE BEFORE_DIR AFTER_DIR BUN OUTPUT_JSON [pilot|formal|aa]');
  const [moduleName, beforeRoot, afterRoot, bun, output] = [moduleArg, beforeArg, afterArg, bunArg, outputArg].map(path => resolve(path));
  assert.ok(!existsSync(output), 'Never overwrite a recorded study; choose a new output path');
  assert.match(affinity(), /^\d+$/, 'Pin to one available CPU with taskset before starting');
  const { study } = await import(pathToFileURL(moduleName));
  assert.match(study.id, /^[a-z0-9-]+$/);
  assert.match(study.baseline, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(study.changedSources) && study.changedSources.length);
  assert.ok(Array.isArray(study.cases) && study.cases.length);
  assert.equal(new Set(study.cases.map(spec => spec.name)).size, study.cases.length);
  for (const spec of study.cases) {
    assert.match(spec.name, /^[a-z0-9-]+$/); assert.equal(typeof spec.role, 'string');
    assert.ok(Number.isSafeInteger(spec.repetitions) && spec.repetitions > 0);
  }
  const before = identity(beforeRoot), after = identity(mode === 'aa' ? beforeRoot : afterRoot);
  assert.equal(before.commit, study.baseline, 'Use the declared baseline commit');
  for (const [name, digest] of Object.entries(before.sources)) {
    const recorded = execFileSync('git', ['-C', beforeRoot, 'show', `${study.baseline}:${name}`]);
    assert.equal(hash(recorded), digest, `Baseline source differs from its commit: ${name}`);
  }
  assert.deepEqual(differences(before.sources, after.sources), mode === 'aa' ? [] : [...study.changedSources].sort());
  const coreWasm = ['persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm',
    'linked-list.wasm', 'singly-linked-list.wasm', 'doubly-linked-list.wasm',
    'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm'];
  const expectedWasm = study.changedWasm ?? coreWasm;
  assert.deepEqual(differences(before.wasm, after.wasm), mode === 'aa' ? [] : [...expectedWasm].sort(),
    'Only the declared WASM modules may differ');
  for (const identity of [before, after]) for (const name of coreWasm) {
    assert.equal(identity.wasm[name], identity.wasm['persistent-core.wasm'], 'Legacy filenames must contain the same core');
  }
  const caseFilter = mode === 'aa' ? study.aaCases : mode === 'pilot' ? study.pilotCases : null;
  const selectedCases = caseFilter ? study.cases.filter(spec => caseFilter.includes(spec.name)) : study.cases;
  assert.ok(selectedCases.length);
  if (mode === 'aa') assert.ok(caseFilter, 'Declare representative same-build controls in study.aaCases');
  if (caseFilter) assert.deepEqual(selectedCases.map(spec => spec.name).sort(), [...caseFilter].sort());
  const snapshots = Object.fromEntries(study.changedSources.map(name => [name, {
    before: existsSync(join(before.root, name)) ? readFileSync(join(before.root, name), 'utf8') : null,
    after: existsSync(join(after.root, name)) ? readFileSync(join(after.root, name), 'utf8') : null,
  }]));
  const data = {
    schema: 'zerocopy-paired-public-operation/v1', study, mode, status: 'running', startedAt: new Date().toISOString(),
    source: { before, after }, snapshots,
    driver: { name: SCRIPT, sha256: fileHash(SCRIPT) }, workload: { name: moduleName, sha256: fileHash(moduleName) },
    host: { arch: arch(), platform: platform(), release: release(), cpu: cpus()[0]?.model, affinity: affinity() },
    method: {
      ...SETTINGS[mode], cases: selectedCases, samples: SAMPLES, minimumWarmupBatches: MINIMUM_WARMUP_BATCHES,
      lock: LOCK, runtimes: { node: process.execPath, bun },
      order: 'AB/BA alternate by pair; runtime and case orders reverse by pair; one build and case per fresh process; identical import path',
      estimate: 'geometric mean paired after/before ratios; unadjusted Student-t intervals on paired log ratios (formal/AA only)',
      timed: 'complete public operation and assignment into a preallocated retention array',
      excluded: 'imports, fixture/oracle creation and optional per-batch reset, retention array allocation, full output and invariant verification',
    }, runs: [], summary: [],
  };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => {
    data.summary = summarize(data);
    writeFileSync(`${output}.partial`, JSON.stringify(data, null, 2) + '\n');
    renameSync(`${output}.partial`, output);
  };
  const neutral = mkdtempSync(join(tmpdir(), `${study.id}-`));
  writeFileSync(join(neutral, 'package.json'), '{"type":"module"}\n');
  save();
  try {
    for (let pair = 0; pair < data.method.pairs; pair++) {
      const runtimes = pair % 2 ? ['bun', 'node'] : ['node', 'bun'];
      const cases = pair % 2 ? [...selectedCases].reverse() : selectedCases;
      for (const runtime of runtimes) for (const spec of cases) {
        for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
          const selected = variant === 'before' ? before : after;
          rmSync(join(neutral, 'dist'), { recursive: true, force: true });
          mkdirSync(join(neutral, 'dist'));
          for (const name of Object.keys(selected.bundles)) cpSync(join(selected.root, 'dist', name), join(neutral, 'dist', name));
          const startedAt = new Date().toISOString();
          const child = spawnSync(data.method.runtimes[runtime], [SCRIPT, '--subject', moduleName, neutral, spec.name, mode],
            { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
          let result;
          try {
            assert.equal(child.status, 0, `Subject ${runtime}/${spec.name}/${variant} failed: ${child.error ?? ''}`);
            result = JSON.parse(child.stdout);
            assert.equal(result.runtime, runtime); assert.equal(result.affinity, data.host.affinity);
            assert.deepEqual(result.spec, spec);
          } catch (error) {
            data.failure = { pair, variant, runtime, caseName: spec.name, startedAt,
              completedAt: new Date().toISOString(), exitCode: child.status, signal: child.signal,
              processError: child.error ? String(child.error) : null,
              stdout: child.stdout, stderr: child.stderr, error: String(error?.stack ?? error) };
            throw error;
          }
          data.runs.push({ pair, variant, startedAt, completedAt: new Date().toISOString(), stderr: child.stderr, ...result });
          save();
          const short = result.batchTiming.measuredBelow2ms;
          console.log(`${mode}: ${runtime} ${spec.name} pair ${pair + 1}/${data.method.pairs} ${variant}: ${(result.medianMs * 1000).toFixed(3)} us, verified${short ? `; ${short}/${SAMPLES} measured batches <2 ms (retained)` : ''}`);
        }
      }
    }
    assert.deepEqual(identity(beforeRoot), before);
    assert.deepEqual(identity(mode === 'aa' ? beforeRoot : afterRoot), after);
    assert.equal(fileHash(SCRIPT), data.driver.sha256); assert.equal(fileHash(moduleName), data.workload.sha256);
    data.status = 'complete'; data.completedAt = new Date().toISOString(); save();
  } catch (error) {
    data.status = 'failed'; data.error = String(error?.stack ?? error); data.completedAt = new Date().toISOString(); save(); throw error;
  } finally { rmSync(neutral, { recursive: true, force: true }); }
  for (const row of data.summary) console.log(`${row.runtime} ${row.name}: ${(row.beforeMs * 1000).toFixed(3)} -> ${(row.afterMs * 1000).toFixed(3)} us, paired ratio ${row.pairedRatio.toFixed(3)}${row.interval95 ? ` (${row.interval95.map(x => x.toFixed(3)).join('-')})` : ''}`);
}

if (process.argv[2] === '--subject') {
  process.stdout.write(JSON.stringify(await subject(...process.argv.slice(3))));
} else if (process.argv[2] === '--locked') {
  await coordinator(process.argv.slice(3));
} else {
  // A single common advisory lock prevents our studies from running together.
  // Do not wrap this driver in another flock for the same path.
  const child = spawnSync('flock', ['--nonblock', LOCK, process.execPath, SCRIPT, '--locked', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
