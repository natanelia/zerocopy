import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixture, study } from './workloads.mjs';

// Secondary comparison: complete immutable batch deletion, with the exact
// fixtures used by the before/after study. Each implementation retains source.
// Native Map copies once per batch request; Immutable.js uses withMutations
// inside one request. These strategies are intentionally recorded explicitly.
const SCRIPT = fileURLToPath(import.meta.url), LOCK = '/tmp/zerocopy-perf-20261108.lock';
const LIBRARIES = ['shared', 'immutable', 'native'];
const CASES = ['delete-100-of-4096', 'delete-1000-of-8192', 'delete-4096-of-8192'];
const median = values => {
  const ordered = [...values].sort((a, b) => a - b), middle = (ordered.length - 1) / 2;
  return (ordered[Math.floor(middle)] + ordered[Math.ceil(middle)]) / 2;
};
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Number.isNaN(value) ? ['NaN'] : Object.is(value, -0) ? ['-0']
  : value === Infinity ? ['+Infinity'] : value === -Infinity ? ['-Infinity'] : value;
const affinity = () => readFileSync('/proc/self/status', 'utf8').split('\n')
  .find(line => line.startsWith('Cpus_allowed_list:'))?.split(':')[1].trim();

async function subject(root, caseName, library, smoke) {
  assert.ok(LIBRARIES.includes(library));
  const spec = study.cases.find(item => item.name === caseName);
  assert.ok(spec && CASES.includes(caseName));
  const { initial, keys, expected } = makeFixture(spec), model = new Map(expected), original = new Map(initial);
  const S = library === 'shared' ? await import(pathToFileURL(join(root, 'dist/shared.js'))) : null;
  const require = createRequire(join(root, 'package.json'));
  const I = library === 'immutable' ? require('immutable') : null;
  let source, sourceBytes, sourcePacket;
  function prepare() {
    if (S) {
      S.resetMap(); source = new S.SharedMap('number').setMany(initial);
      sourcePacket = S.getWorkerData({ source }, { copy: false });
      const arena = sourcePacket.arenas[0];
      sourceBytes = digest(new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536));
    } else source = I ? I.Map(initial) : new Map(initial);
  }
  function operation() {
    if (S) return source.deleteMany(keys);
    if (I) return source.withMutations(draft => { for (const key of keys) draft.delete(key); });
    const next = new Map(source);
    for (const key of keys) next.delete(key);
    return next;
  }
  function verify(value, oracle = model) {
    assert.equal(value.size, oracle.size);
    let count = 0;
    for (const [key, item] of value.entries()) {
      assert.ok(oracle.has(key)); assert.ok(Object.is(item, oracle.get(key)), `Mismatch for ${key}`); count++;
    }
    assert.equal(count, oracle.size);
  }
  function checkSource() {
    verify(source, original);
    if (S) {
      const arena = sourcePacket.arenas[0];
      assert.equal(digest(new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536)), sourceBytes);
    }
  }
  prepare(); verify(operation()); checkSource();
  const output = new Array(spec.repetitions), warmupBatchMs = [], sampleBatchMs = [];
  function batch() {
    prepare();
    const start = performance.now();
    for (let i = 0; i < spec.repetitions; i++) output[i] = operation();
    const elapsed = performance.now() - start;
    for (const result of output) { assert.notStrictEqual(result, source); verify(result); }
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
    strategy: S ? 'SharedMap.deleteMany(keys)' : I ? 'source.withMutations(draft => keys.forEach(k => draft.delete(k)))'
      : 'one new Map(source), followed by every requested delete',
    expectedDigest: digest(JSON.stringify(expected.map(([key, value]) => [key, canonical(value)]))),
    warmupBatchMs, sampleBatchMs, medianMs: smoke ? null : median(sampleBatchMs) / spec.repetitions,
    fullResultAndRetainedSourceVerified: true, smoke };
}

async function coordinator(args) {
  const [rootArg, bunArg, outputArg, mode = 'measure'] = args.filter(arg => arg !== '--locked');
  assert.ok(rootArg && bunArg && outputArg && ['measure', 'smoke'].includes(mode),
    'Usage: taskset -c CPU node compare.mjs CANDIDATE_ROOT BUN OUTPUT.json [measure|smoke]');
  const root = resolve(rootArg), bun = resolve(bunArg), output = resolve(outputArg), smoke = mode === 'smoke';
  assert.ok(!existsSync(output), 'Use a new path; never overwrite recorded evidence');
  if (!smoke) assert.match(affinity(), /^\d+$/, 'Pin the coordinator to one CPU');
  if (!smoke && !args.includes('--locked')) {
    const child = spawnSync('flock', [LOCK, process.execPath, SCRIPT, ...args, '--locked'], { stdio: 'inherit' });
    assert.equal(child.status, 0); return;
  }
  const sources = Object.fromEntries(study.changedSources.map(name => [name, digest(readFileSync(join(root, name)))]));
  const data = { schema: 'zerocopy-map-delete-comparison/v1', recordedAt: new Date().toISOString(), mode,
    method: { rounds: smoke ? 1 : 3, warmupMs: 250, minimumWarmupBatches: 8, samples: 9,
      cases: CASES, libraries: LIBRARIES, fixture: 'makeFixture shared with before/after workloads.mjs',
      timed: 'complete public batch operation and retained output assignment',
      excluded: 'source construction before each batch and complete source/result verification after timing',
      nativeCopy: 'one full new Map(source) per deletion request, included in timing',
      immutableCopy: 'withMutations batches all deletes before returning an immutable result, included in timing',
      sourcePolicy: 'each batch uses one freshly built source; operations repeatedly fork the same source' },
    host: { cpu: cpus()[0]?.model, platform: platform(), arch: arch(), affinity: affinity() },
    sources, wasm: digest(readFileSync(join(root, 'persistent-core.wasm'))), runs: [], summary: [] };
  for (let round = 0; round < data.method.rounds; round++) {
    for (const runtime of round % 2 ? ['bun', 'node'] : ['node', 'bun']) {
      for (const caseName of round % 2 ? [...CASES].reverse() : CASES) {
        for (let position = 0; position < LIBRARIES.length; position++) {
          const library = LIBRARIES[(round + position) % LIBRARIES.length];
          const child = spawnSync(runtime === 'node' ? process.execPath : bun,
            [SCRIPT, '--subject', root, caseName, library, smoke ? 'smoke' : 'measure'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
          assert.equal(child.status, 0, child.stderr || child.stdout);
          const run = JSON.parse(child.stdout);
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
      data.summary.push({ runtime, caseName, library, medianMs: smoke ? null : median(runs.map(run => run.medianMs)),
        processEstimates: runs.map(run => run.medianMs), processes: runs.length });
    }
  }
  writeFileSync(output, JSON.stringify({ ...data, status: 'complete' }, null, 2) + '\n');
  console.log(JSON.stringify({ output, status: 'complete', subjects: data.runs.length, summary: data.summary }, null, 2));
}

if (process.argv[2] === '--subject') {
  const [root, caseName, library, mode] = process.argv.slice(3);
  console.log(JSON.stringify(await subject(root, caseName, library, mode === 'smoke')));
} else await coordinator(process.argv.slice(2));
