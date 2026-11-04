import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const BASE = '09b1a385a7c2ac9b027a4055335ae2f9449abe6e';
const CONFIG = Object.freeze({ pairs: 4, samples: 7, pilotWarmupMs: 80, warmupMs: 120,
  targetBatchMs: 8, maxSharedBytes: 8 * 1024 * 1024, maxRepeat: 64 });
const CASES = [
  ...[1, 4, 8, 16, 31, 32, 33].map(batch => ({ name: `number/${batch}`, type: 'number', size: 4096, batch,
    role: batch < 31 ? 'small-batch target' : 'boundary control' })),
  { name: 'number/interleaved', type: 'number', size: 4096, batch: 8, interleaved: true, role: 'nonfrontier control' },
  { name: 'number/large', type: 'number', size: 65536, batch: 65536, role: 'large empty-prefix control' },
  { name: 'boolean/8', type: 'boolean', size: 4096, batch: 8, role: 'primitive encoding' },
  { name: 'string/repeated', type: 'string', size: 4096, batch: 8, repeated: true, role: 'interned-string path' },
  { name: 'string/unique', type: 'string', size: 4096, batch: 8, role: 'string allocation control' },
  { name: 'object/8', type: 'object', size: 1024, batch: 8, role: 'serialization control' },
  { name: 'number/forks', type: 'number', size: 1024, batch: 1, forks: true, role: 'retained-root control' },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };

async function subject() {
  const [entry, name, repeatText, warmupText] = process.argv.slice(3);
  const spec = CASES.find(row => row.name === name); assert.ok(spec);
  const api = await import(pathToFileURL(entry).href);
  const Arena = new api.SharedList('number').arena.constructor;
  const values = Array.from({ length: spec.size }, (_, i) => spec.type === 'number' ? (i % 257) - 128 + .25
    : spec.type === 'boolean' ? i % 3 === 0 : spec.type === 'string' ? `value-${spec.repeated ? i % 7 : i}-界`
      : { id: i, tags: [i & 7, `label-${i}`] });
  const chunks = [];
  for (let i = 0; i < values.length; i += spec.batch) chunks.push(values.slice(i, i + spec.batch));
  const forkPrefix = Array.from({ length: 31 }, (_, i) => i + .5);
  const sideValues = Array.from({ length: chunks.length }, (_, i) => i + .125);

  function operation(a, seed) {
    if (spec.forks) {
      const forks = new Array(spec.size);
      for (let i = 0; i < spec.size; i++) forks[i] = seed.pushMany(chunks[i]);
      return { seed, forks };
    }
    let list = new api.SharedList(spec.type, 0, 0, 0, a), side = spec.interleaved ? new api.SharedList('number', 0, 0, 0, a) : undefined;
    let first, middle;
    for (let i = 0; i < chunks.length; i++) {
      list = list.pushMany(chunks[i]);
      if (side) side = side.push(sideValues[i]);
      if (i === 0) first = list;
      if (i === (chunks.length >>> 1)) middle = list;
    }
    return { list, side, first, middle };
  }

  function batch(repeat) {
    const a = new Arena(), seed = spec.forks ? new api.SharedList('number', 0, 0, 0, a).pushMany(forkPrefix) : undefined;
    const outputs = new Array(repeat), usedBefore = a.used;
    const start = performance.now();
    for (let i = 0; i < repeat; i++) outputs[i] = operation(a, seed);
    const ms = performance.now() - start, usedAfter = a.used;
    let checked = 0;
    for (const output of outputs) {
      if (spec.forks) {
        assert.deepEqual(output.seed.toArray(), forkPrefix); checked += forkPrefix.length;
        for (let i = 0; i < output.forks.length; i++) {
          assert.deepEqual(output.forks[i].toArray(), [...forkPrefix, values[i]]); checked += forkPrefix.length + 1;
        }
      } else {
        assert.deepEqual(output.list.toArray(), values); checked += values.length;
        for (const retained of [output.first, output.middle]) if (retained && retained !== output.list) {
          assert.deepEqual(retained.toArray(), values.slice(0, retained.size)); checked += retained.size;
        }
        if (output.side) { assert.deepEqual(output.side.toArray(), sideValues); checked += sideValues.length; }
        if (spec.type === 'object') {
          assert.equal(Object.isFrozen(output.list.get(0)), true);
          assert.equal(Object.isFrozen(output.list.get(0).tags), true);
        }
      }
    }
    assert.equal(a.used, usedAfter, 'Validation must not allocate shared storage');
    return { ms, msPerOperation: ms / repeat, allocatedBytes: usedAfter - usedBefore,
      backingBytes: a.memory.buffer.byteLength, checkedValues: checked, repeat };
  }

  const warmup = [], calibration = [], repeatArg = Number(repeatText);
  let repeat = repeatArg;
  if (!repeat) {
    let elapsed = 0;
    while (elapsed < CONFIG.pilotWarmupMs || warmup.length < 5) {
      const row = batch(1); warmup.push(row); elapsed += row.ms;
    }
    const bytes = Math.max(...warmup.map(row => row.allocatedBytes));
    const cap = Math.max(1, Math.min(CONFIG.maxRepeat, Math.floor(CONFIG.maxSharedBytes / Math.max(1, bytes))));
    repeat = Math.max(1, Math.min(cap, Math.ceil(CONFIG.targetBatchMs / median(warmup.slice(-5).map(row => row.ms)))));
    for (let step = 0; step < 3; step++) {
      const trials = Array.from({ length: 3 }, () => batch(repeat)); calibration.push({ repeat, trials });
      const duration = median(trials.map(row => row.ms));
      if (duration >= CONFIG.targetBatchMs || repeat === cap || step === 2) break;
      repeat = Math.min(cap, Math.ceil(repeat * CONFIG.targetBatchMs / duration));
    }
    return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, arch: process.arch, name,
      pilot: true, repeat, cap, warmup, calibration,
      medianMsPerOperation: median(calibration.at(-1).trials.map(row => row.msPerOperation)) };
  }
  assert.ok(Number.isInteger(repeat) && repeat > 0);
  const warmupBatches = Number(warmupText); assert.ok(Number.isInteger(warmupBatches) && warmupBatches >= 5);
  for (let i = 0; i < warmupBatches; i++) warmup.push(batch(repeat));
  const samples = Array.from({ length: CONFIG.samples }, () => batch(repeat));
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, arch: process.arch, name,
    pilot: false, repeat, warmupBatches, warmup, samples,
    medianMsPerOperation: median(samples.map(row => row.msPerOperation)),
    medianSharedBytesPerOperation: median(samples.map(row => row.allocatedBytes / repeat)) };
}

function manifest(root) {
  const sources = readdirSync(root).filter(name => (name.endsWith('.ts') && !name.endsWith('.test.ts')) || name.endsWith('.wasm'));
  const files = [...sources, 'package.json', 'scripts/build-browser.ts',
    ...readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js')).map(name => `dist/${name}`)].sort();
  return { root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    files: Object.fromEntries(files.map(name => [name, hash(readFileSync(join(root, name)))])) };
}
function summaries(pairs) {
  return ['node', 'bun'].flatMap(runtime => CASES.flatMap(spec => {
    const rows = pairs.filter(row => row.runtime === runtime && row.name === spec.name);
    if (!rows.length) return [];
    const ratios = rows.map(row => row.after.medianMsPerOperation / row.before.medianMsPerOperation);
    return [{ runtime, ...spec, pairs: rows.length,
      beforeMs: median(rows.map(row => row.before.medianMsPerOperation)), afterMs: median(rows.map(row => row.after.medianMsPerOperation)),
      ratio: Math.exp(ratios.reduce((sum, value) => sum + Math.log(value), 0) / ratios.length), ratios,
      beforeSharedBytes: median(rows.map(row => row.before.medianSharedBytesPerOperation)),
      afterSharedBytes: median(rows.map(row => row.after.medianSharedBytesPerOperation)) }];
  }));
}
async function main() {
  const [beforeArg, afterArg, bunArg, outputArg] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outputArg, 'Usage: node pilot.mjs BEFORE AFTER BUN OUTPUT');
  const roots = { before: resolve(beforeArg), after: resolve(afterArg) }, output = resolve(outputArg);
  const canceled = output.replace(/\.json$/, '-cancelled.json');
  if (existsSync(canceled)) { console.log(readFileSync(canceled, 'utf8')); return; }
  assert.ok(!existsSync(output), 'Keep old records; choose a new output path');
  const source = { before: manifest(roots.before), after: manifest(roots.after), driver: hash(readFileSync(import.meta.filename)) };
  assert.equal(source.before.commit, BASE);
  assert.deepEqual(Object.keys(source.before.files).filter(name => !name.startsWith('dist/')),
    Object.keys(source.after.files).filter(name => !name.startsWith('dist/')));
  const changed = new Set(['arena.ts', 'persistent-core.as.ts', 'persistent-core.wasm',
    ...['shared-map', 'shared-list', 'linked-list', 'singly-linked-list', 'doubly-linked-list',
      'ordered-map', 'sorted-tree', 'priority-queue'].map(name => `${name}.wasm`)]);
  for (const name of Object.keys(source.before.files).filter(name => !changed.has(name) && !name.startsWith('dist/'))) {
    assert.equal(source.before.files[name], source.after.files[name], `Unrelated production source changed: ${name}`);
  }
  const record = { schema: 'zerocopy-list-batch-tail-pilot/v2', status: 'running', startedAt: new Date().toISOString(), source,
    candidatePatch: execFileSync('git', ['diff', BASE, '--', 'arena.ts', 'persistent-core.as.ts'], { cwd: roots.after, encoding: 'utf8' }),
    method: { ...CONFIG, independentUnits: 'Fresh processes; one build and one workload per process; paired AB/BA order',
      timed: 'List construction and all pushMany calls; optional intervening scalar pushes; retained result wrappers',
      excluded: 'Input generation, private Arena initialization, result-array allocation, full content validation',
      allocations: 'Arena used-byte delta during the timed operation; includes retained and unreachable persistent storage, not JS heap or RSS' },
    hardware: { cpu: os.cpus()[0].model, platform: process.platform, arch: process.arch,
      affinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Cpus_allowed_list:')) : undefined },
    cases: CASES, pilots: [], pairs: [], summary: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { record.summary = summaries(record.pairs); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); };
  const slot = mkdtempSync(join(os.tmpdir(), 'list-batch-tail-'));
  function run(executable, runtime, variant, name, repeat = 0, warmupBatches = 0) {
    rmSync(join(slot, 'dist'), { recursive: true, force: true });
    cpSync(join(roots[variant], 'dist'), join(slot, 'dist'), { recursive: true });
    cpSync(join(roots[variant], 'package.json'), join(slot, 'package.json'));
    const child = spawnSync(executable, [import.meta.filename, '--child', join(slot, 'dist/shared.js'), name, String(repeat), String(warmupBatches)],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (child.status !== 0) {
      record.status = 'failed'; record.failure = { runtime, variant, name, repeat, warmupBatches, status: child.status,
        stdout: child.stdout, stderr: child.stderr, error: String(child.error ?? '') }; save(); throw new Error(child.stderr);
    }
    const value = JSON.parse(child.stdout); assert.equal(value.runtime, runtime); assert.equal(value.arch, process.arch); assert.equal(value.name, name);
    return value;
  }
  save();
  try {
    for (const [runtime, executable] of [['node', process.execPath], ['bun', resolve(bunArg)]]) {
      const controls = new Map();
      for (const spec of CASES) {
        const before = run(executable, runtime, 'before', spec.name), after = run(executable, runtime, 'after', spec.name);
        const repeat = Math.min(before.cap, after.cap, Math.max(before.repeat, after.repeat));
        const warmupBatches = Math.max(5, Math.ceil(CONFIG.warmupMs / (Math.min(before.medianMsPerOperation, after.medianMsPerOperation) * repeat)));
        controls.set(spec.name, { repeat, warmupBatches }); record.pilots.push({ runtime, name: spec.name, repeat, warmupBatches, before, after }); save();
      }
      for (let round = 0; round < CONFIG.pairs; round++) {
        const cases = [...CASES.slice(round % CASES.length), ...CASES.slice(0, round % CASES.length)];
        for (const spec of cases) {
          const { repeat, warmupBatches } = controls.get(spec.name), order = round % 2 ? ['after', 'before'] : ['before', 'after'];
          const pair = { runtime, name: spec.name, round, order };
          for (const variant of order) pair[variant] = run(executable, runtime, variant, spec.name, repeat, warmupBatches);
          record.pairs.push(pair); save();
        }
        console.log(`${runtime}: complete paired pilot round ${round + 1}/${CONFIG.pairs}`);
      }
    }
    assert.deepEqual(manifest(roots.before), source.before); assert.deepEqual(manifest(roots.after), source.after);
    assert.equal(hash(readFileSync(import.meta.filename)), source.driver);
    record.status = 'complete'; record.completedAt = new Date().toISOString(); save();
    for (const row of record.summary) console.log(JSON.stringify(row));
  } finally { rmSync(slot, { recursive: true, force: true }); }
}
if (process.argv[2] === '--child') console.log(JSON.stringify(await subject()));
else await main();
