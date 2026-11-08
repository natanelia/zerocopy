import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixture, study } from './workloads.mjs';

// Secondary context only: all three strategies append the same boolean Array,
// retain the complete result, and preserve the original source.
// Native Array includes one full concat in each timed call, without freezing.
const SCRIPT = fileURLToPath(import.meta.url), LOCK = '/tmp/zerocopy-perf-20261108.lock';
const LIBRARIES = ['shared', 'immutable', 'native'];
const CASES = ['boolean-1024-control', 'boolean-32768', 'boolean-262144', 'boolean-prefix-65'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
};
const affinity = () => readFileSync('/proc/self/status', 'utf8').split('\n')
  .find(line => line.startsWith('Cpus_allowed_list:'))?.split(':')[1].trim();

async function subject(root, caseName, library, smoke) {
  assert.ok(LIBRARIES.includes(library));
  const spec = study.cases.find(item => item.name === caseName);
  assert.ok(spec && CASES.includes(caseName));
  const { prefix, input, expected } = makeFixture(spec);
  const S = library === 'shared' ? await import(pathToFileURL(join(root, 'dist/shared.js'))) : null;
  const require = createRequire(join(root, 'package.json'));
  const I = library === 'immutable' ? require('immutable') : null;
  let source, sourceArena, sourceBytes;
  function prepare() {
    if (S) {
      S.resetSharedList(); source = new S.SharedList('boolean').pushMany(prefix);
      sourceArena = S.getWorkerData({ source }, { copy: false }).arenas[0];
      sourceBytes = hash(new Uint8Array(sourceArena.memory.buffer, 65536, sourceArena.used - 65536));
    } else source = I ? I.List(prefix) : [...prefix];
  }
  function operation() {
    return S ? source.pushMany(input) : source.concat(input);
  }
  function verify(result, oracle = expected) {
    assert.equal(S || I ? result.size : result.length, oracle.length);
    assert.deepEqual(S || I ? result.toArray() : [...result], oracle);
    if (S) assert.ok(Object.isFrozen(result));
  }
  function checkSource() {
    verify(source, prefix);
    if (S) assert.equal(hash(new Uint8Array(sourceArena.memory.buffer, 65536, sourceArena.used - 65536)), sourceBytes);
  }
  prepare(); verify(operation()); checkSource();
  const output = new Array(spec.repetitions), warmupBatchMs = [], sampleBatchMs = [];
  let verifiedResults = 1;
  function batch() {
    prepare();
    const start = performance.now();
    for (let i = 0; i < spec.repetitions; i++) output[i] = operation();
    const elapsed = performance.now() - start;
    assert.ok(Number.isFinite(elapsed) && elapsed > 0);
    for (const result of output) {
      assert.notStrictEqual(result, source); verify(result); verifiedResults++;
    }
    checkSource(); return elapsed;
  }
  if (!smoke) {
    let warmed = 0;
    while (warmupBatchMs.length < 8 || warmed < 250) {
      const elapsed = batch(); warmupBatchMs.push(elapsed); warmed += elapsed;
    }
    for (let i = 0; i < 9; i++) sampleBatchMs.push(batch());
  }
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions,
    affinity: affinity(), library, caseName, spec, immutableVersion: I?.version ?? null,
    strategy: S ? 'SharedList.pushMany(input)' : I ? 'Immutable.List.concat(input)' : 'source.concat(input)',
    expectedDigest: hash(JSON.stringify(expected)), warmupBatchMs, sampleBatchMs,
    medianMs: smoke ? null : median(sampleBatchMs) / spec.repetitions,
    minimumMeasuredBatchMs: smoke ? null : Math.min(...sampleBatchMs),
    fullResultAndRetainedSourceVerified: true, verifiedResults, smoke };
}

async function coordinator(args) {
  const [rootArg, bunArg, outputArg, mode = 'measure'] = args.filter(arg => arg !== '--locked');
  assert.ok(rootArg && bunArg && outputArg && ['measure', 'smoke'].includes(mode),
    'Usage: taskset -c CPU node compare.mjs CANDIDATE_ROOT BUN OUTPUT.json [measure|smoke]');
  const root = resolve(rootArg), bun = resolve(bunArg), output = resolve(outputArg), smoke = mode === 'smoke';
  assert.ok(!existsSync(output), 'Choose a new output path; never overwrite evidence');
  if (!smoke) assert.match(affinity(), /^\d+$/, 'Pin the coordinator to one CPU');
  if (!smoke && !args.includes('--locked')) {
    const child = spawnSync('flock', ['--nonblock', LOCK, process.execPath, SCRIPT, ...args, '--locked'], { stdio: 'inherit' });
    assert.equal(child.status, 0); return;
  }
  const identities = () => ({
    sources: Object.fromEntries(study.changedSources.map(name => [name, hash(readFileSync(join(root, name)))])),
    wasm: hash(readFileSync(join(root, 'persistent-core.wasm'))),
    bundle: hash(readFileSync(join(root, 'dist/shared.js'))),
    workload: hash(readFileSync(new URL('./workloads.mjs', import.meta.url))),
    comparison: hash(readFileSync(SCRIPT)),
  });
  const identity = identities();
  const data = { schema: 'zerocopy-boolean-list-comparison/v1', recordedAt: new Date().toISOString(), mode,
    identity, host: { cpu: cpus()[0]?.model, platform: platform(), arch: arch(), affinity: affinity() },
    method: { rounds: smoke ? 1 : 3, minimumWarmupMs: 250, minimumWarmupBatches: 8, samples: 9,
      cases: CASES, libraries: LIBRARIES, fixture: 'makeFixture shared with before/after workloads.mjs',
      timed: 'complete public append and retained output assignment',
      excluded: 'source creation before each batch and complete source/result verification after timing',
      nativeCopy: 'one full source.concat(input), inside timing; no mutation of the original source and no freezing',
      immutableCopy: 'one persistent Immutable.List.concat(input), inside timing',
      sourcePolicy: 'each batch builds one fresh source; every operation forks that source',
      estimate: 'median of three independent process medians, contextual comparison without confidence interval',
    }, runs: [], summary: [] };
  for (let round = 0; round < data.method.rounds; round++) {
    for (const runtime of round % 2 ? ['bun', 'node'] : ['node', 'bun']) {
      for (const caseName of round % 2 ? [...CASES].reverse() : CASES) {
        for (let position = 0; position < LIBRARIES.length; position++) {
          const library = LIBRARIES[(round + position) % LIBRARIES.length];
          const child = spawnSync(runtime === 'node' ? process.execPath : bun,
            [SCRIPT, '--subject', root, caseName, library, mode],
            { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
          assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error));
          const run = JSON.parse(child.stdout);
          assert.equal(run.runtime, runtime); assert.equal(run.affinity, data.host.affinity);
          assert.equal(run.caseName, caseName); assert.equal(run.library, library);
          data.runs.push({ round, position, ...run });
          writeFileSync(output, JSON.stringify({ ...data, status: 'running' }, null, 2) + '\n');
        }
      }
    }
  }
  for (const runtime of ['node', 'bun']) for (const caseName of CASES) {
    const selected = data.runs.filter(run => run.runtime === runtime && run.caseName === caseName);
    assert.equal(new Set(selected.map(run => run.expectedDigest)).size, 1);
    for (const library of LIBRARIES) {
      const runs = selected.filter(run => run.library === library);
      assert.equal(runs.length, data.method.rounds);
      data.summary.push({ runtime, caseName, library,
        medianMs: smoke ? null : median(runs.map(run => run.medianMs)),
        processEstimates: runs.map(run => run.medianMs), processes: runs.length });
    }
  }
  assert.deepEqual(identities(), identity, 'Compared sources changed during measurement');
  writeFileSync(output, JSON.stringify({ ...data, status: 'complete' }, null, 2) + '\n');
  console.log(JSON.stringify({ output, status: 'complete', subjects: data.runs.length, summary: data.summary }, null, 2));
}

if (process.argv[2] === '--subject') {
  const [root, caseName, library, mode] = process.argv.slice(3);
  console.log(JSON.stringify(await subject(root, caseName, library, mode === 'smoke')));
} else await coordinator(process.argv.slice(2));
