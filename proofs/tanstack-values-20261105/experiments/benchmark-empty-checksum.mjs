import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { CASES, makeRows, oracle, verify } from './fixtures.mjs';

const BASE = '09b1a385a7c2ac9b027a4055335ae2f9449abe6e';
const SETTINGS = Object.freeze({ samples: 9, targetBatchMs: 12, maxOutputRows: 131072, maxFreshReaders: 64, maxRepeat: 32768 });
const median = values => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
const hash = value => createHash('sha256').update(value).digest('hex');
const capFor = spec => Math.max(1, Math.min(SETTINGS.maxRepeat, Math.floor(SETTINGS.maxOutputRows / Math.max(1, spec.size)), spec.fresh ? SETTINGS.maxFreshReaders : Infinity));

async function subject() {
  const [slot, name, mode, repetitions] = process.argv.slice(3);
  const spec = CASES.find(value => value.name === name); assert.ok(spec);
  const api = await import(pathToFileURL(join(slot, 'dist/shared.js')).href);
  const { SharedCollection } = await import(pathToFileURL(join(slot, 'dist/tanstack-db-collection.js')).href);
  const Arena = new api.SharedMap('object').arena.constructor, arena = new Arena();
  const rows = makeRows(spec);
  const map = new api.SharedMap('object', 0, 0, arena).setMany(rows.map(row => [row.id, row]));
  // Both builds enumerate keys identically. This writer is distinct from every fresh reader.
  const keys = [...map.keys()], expected = oracle(rows, keys), collection = new SharedCollection('rows', map);
  // Prime both key and object caches symmetrically, including the overflow case.
  assert.deepEqual([...map.entries()], keys.map((key, index) => [key, expected[index]]));
  for (const value of map.values()) {
    assert.equal(Object.isFrozen(value), true);
    if (spec.nested) {
      assert.equal(Object.isFrozen(value.details), true); assert.equal(Object.isFrozen(value.details.tags), true);
      assert.equal(Object.isFrozen(value.details.coordinates), true);
      for (const pair of value.details.coordinates) assert.equal(Object.isFrozen(pair), true);
    }
  }
  const payload = api.getWorkerData({ map }, { copy: false });
  const initialUsed = arena.used, initialBacking = arena.memory.buffer.byteLength;
  const initialBytes = hash(new Uint8Array(arena.memory.buffer, 0, initialUsed));
  const operation = spec.op === 'array' ? col => col.toArray() : spec.op === 'entries' ? col => [...col.entries()]
    : col => ({ values: col.toArray(), entries: [...col.entries()] });
  const cap = capFor(spec), repeat = mode === 'calibrate' ? cap : Number(repetitions);
  assert.ok(Number.isInteger(repeat) && repeat > 0 && repeat <= cap);
  async function batch() {
    const readers = spec.fresh ? new Array(repeat) : undefined;
    if (readers) for (let i = 0; i < repeat; i++) readers[i] = new SharedCollection('rows', (await api.initWorker(payload)).map);
    const outputs = new Array(repeat);
    const start = performance.now();
    for (let i = 0; i < repeat; i++) outputs[i] = operation(readers ? readers[i] : collection);
    const ms = performance.now() - start;
    let checksum = 0, checkedRows = 0;
    for (const output of outputs) {
      const checked = verify(output, expected, keys, spec); checksum += checked.sum; checkedRows += checked.checkedRows;
    }
    assert.equal(checkedRows, repeat * spec.size * (spec.op === 'both' ? 2 : 1));
    assert.equal(checksum, repeat * spec.size * (spec.size - 1) / 2 * (spec.op === 'both' ? 2 : 1));
    assert.equal(arena.used, initialUsed); assert.equal(arena.memory.buffer.byteLength, initialBacking);
    return { ms, msPerOperation: ms / repeat, repeat, checkedRows, checksum };
  }
  const warmup = [], samples = [], minimumMs = mode === 'formal' ? 500 : 100, minimumBatches = mode === 'formal' ? 8 : 5;
  let warmupTimedMs = 0;
  while (warmupTimedMs < minimumMs || warmup.length < minimumBatches) {
    const row = await batch(); warmup.push(row); warmupTimedMs += row.ms;
  }
  for (let i = 0; i < SETTINGS.samples; i++) samples.push(await batch());
  assert.equal(hash(new Uint8Array(arena.memory.buffer, 0, initialUsed)), initialBytes);
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, arch: process.arch, name, mode, cap, repeat,
    keysHash: hash(JSON.stringify(keys)), oracleHash: hash(JSON.stringify(expected)), sharedUsed: initialUsed, backingBytes: initialBacking,
    warmupTimedMs, warmup, samples, measuredTimedMs: samples.reduce((sum, row) => sum + row.ms, 0),
    medianMsPerOperation: median(samples.map(row => row.msPerOperation)) };
}

function manifest(root) {
  const files = [...readdirSync(root).filter(name => (name.endsWith('.ts') && !name.endsWith('.test.ts')) || name.endsWith('.wasm')),
    'package.json', 'tsconfig.json', 'scripts/build-browser.ts', 'scripts/build-wasm.mjs',
    ...readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js') || name.endsWith('.wasm')).map(name => `dist/${name}`)].sort();
  const optional = Object.fromEntries(['bun.lock', 'bun.lockb'].map(name => [name, existsSync(join(root, name)) ? hash(readFileSync(join(root, name))) : null]));
  return { root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), optional,
    files: Object.fromEntries(files.map(name => [name, hash(readFileSync(join(root, name)))])) };
}
function summarize(pairs) {
  return ['node', 'bun'].flatMap(runtime => CASES.flatMap(spec => {
    const rows = pairs.filter(pair => pair.runtime === runtime && pair.name === spec.name);
    if (!rows.length) return [];
    const ratios = rows.map(pair => pair.after.medianMsPerOperation / pair.before.medianMsPerOperation), logs = ratios.map(Math.log);
    const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    const critical = [undefined, 12.7062047364, 4.30265272975, 3.18244630528, 2.7764451052, 2.57058183564];
    const standardError = logs.length > 1 ? Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logs.length - 1) / logs.length) : undefined;
    const margin = standardError === undefined ? undefined : critical[logs.length - 1] * standardError;
    return [{ runtime, ...spec, pairs: rows.length, ratios, ratio: Math.exp(mean), ratioCI95: margin === undefined ? undefined : [Math.exp(mean - margin), Math.exp(mean + margin)],
      beforeMs: median(rows.map(pair => pair.before.medianMsPerOperation)), afterMs: median(rows.map(pair => pair.after.medianMsPerOperation)) }];
  }));
}
async function main() {
  const [beforeArg, afterArg, bunArg, outputArg, mode] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outputArg && ['pilot', 'formal'].includes(mode),
    'Usage: node benchmark.mjs BEFORE AFTER BUN OUTPUT pilot|formal');
  const roots = { before: resolve(beforeArg), after: resolve(afterArg) }, output = resolve(outputArg);
  assert.ok(!existsSync(output), 'Use a new output path; retain previous evidence');
  const source = { before: manifest(roots.before), after: manifest(roots.after), driver: hash(readFileSync(import.meta.filename)),
    fixtures: hash(readFileSync(new URL('./fixtures.mjs', import.meta.url))) };
  assert.equal(source.before.commit, BASE);
  assert.deepEqual(source.before.optional, source.after.optional);
  assert.deepEqual(Object.keys(source.before.files).filter(name => !name.startsWith('dist/')), Object.keys(source.after.files).filter(name => !name.startsWith('dist/')));
  for (const name of Object.keys(source.before.files).filter(name => name !== 'tanstack-db-collection.ts' && !name.startsWith('dist/'))) {
    assert.equal(source.before.files[name], source.after.files[name], `Unrelated source changed: ${name}`);
  }
  const record = { schema: 'zerocopy-tanstack-values-study/v1', status: 'running', startedAt: new Date().toISOString(), mode, source,
    candidatePatch: execFileSync('git', ['diff', BASE, '--', 'tanstack-db-collection.ts'], { cwd: roots.after, encoding: 'utf8' }),
    settings: { ...SETTINGS, pairs: mode === 'formal' ? 6 : 2, warmupTimedMs: mode === 'formal' ? 500 : 100, minimumWarmupBatches: mode === 'formal' ? 8 : 5 },
    method: { independentUnits: 'One workload and one build per fresh subject process; alternating paired AB/BA order',
      cache: 'Warm cases symmetrically prime writer key and object caches; fresh cases construct a new attached reader outside timing before each operation',
      timed: 'Complete SharedCollection.toArray and result allocation; complete entries materialization where specified',
      excluded: 'Input/writer construction, oracle preparation, transport attachment, outer result retention array, complete correctness validation',
      confidence: 'Unadjusted two-sided 95% Student-t interval on paired log process-median ratios; batches are not independent observations' },
    hardware: { cpu: os.cpus()[0].model, platform: process.platform, kernel: os.release(), arch: process.arch,
      cpuQuota: existsSync('/sys/fs/cgroup/cpu.max') ? readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() : undefined,
      affinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Cpus_allowed_list:')) : undefined },
    cases: CASES, calibration: [], pairs: [], summary: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { record.summary = summarize(record.pairs); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); };
  const slot = mkdtempSync(join(os.tmpdir(), 'tanstack-values-'));
  function run(executable, runtime, variant, spec, childMode, repeat = 0) {
    rmSync(join(slot, 'dist'), { recursive: true, force: true });
    cpSync(join(roots[variant], 'dist'), join(slot, 'dist'), { recursive: true });
    cpSync(join(roots[variant], 'package.json'), join(slot, 'package.json'));
    const child = spawnSync(executable, [import.meta.filename, '--child', slot, spec.name, childMode, String(repeat)], { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    if (child.status !== 0) {
      record.status = 'failed'; record.failure = { runtime, variant, name: spec.name, childMode, repeat, status: child.status, stdout: child.stdout, stderr: child.stderr, error: String(child.error ?? '') }; save();
      throw new Error(child.stderr || String(child.error));
    }
    const value = JSON.parse(child.stdout); assert.equal(value.runtime, runtime); assert.equal(value.arch, process.arch); assert.equal(value.name, spec.name);
    return value;
  }
  save();
  try {
    for (const [runtime, executable] of [['node', process.execPath], ['bun', resolve(bunArg)]]) {
      const controls = new Map();
      for (const spec of CASES) {
        const before = run(executable, runtime, 'before', spec, 'calibrate'), after = run(executable, runtime, 'after', spec, 'calibrate');
        assert.equal(before.keysHash, after.keysHash); assert.equal(before.oracleHash, after.oracleHash);
        const repeat = Math.max(1, Math.min(before.cap, after.cap, Math.ceil(SETTINGS.targetBatchMs / Math.min(before.medianMsPerOperation, after.medianMsPerOperation))));
        controls.set(spec.name, repeat); record.calibration.push({ runtime, name: spec.name, repeat, before, after }); save();
      }
      for (let round = 0; round < record.settings.pairs; round++) {
        const cases = [...CASES.slice(round % CASES.length), ...CASES.slice(0, round % CASES.length)];
        for (const spec of cases) {
          const order = round % 2 ? ['after', 'before'] : ['before', 'after'], repeat = controls.get(spec.name);
          const pair = { runtime, name: spec.name, round, order, repeat };
          for (const variant of order) pair[variant] = run(executable, runtime, variant, spec, mode, repeat);
          assert.equal(pair.before.keysHash, pair.after.keysHash); assert.equal(pair.before.oracleHash, pair.after.oracleHash);
          assert.equal(pair.before.sharedUsed, pair.after.sharedUsed); assert.equal(pair.before.backingBytes, pair.after.backingBytes);
          record.pairs.push(pair); save();
        }
        console.log(`${runtime}: completed ${mode} round ${round + 1}/${record.settings.pairs}`);
      }
    }
    assert.deepEqual(manifest(roots.before), source.before); assert.deepEqual(manifest(roots.after), source.after);
    assert.equal(hash(readFileSync(import.meta.filename)), source.driver); assert.equal(hash(readFileSync(new URL('./fixtures.mjs', import.meta.url))), source.fixtures);
    record.status = 'complete'; record.completedAt = new Date().toISOString(); save();
    for (const row of record.summary) console.log(JSON.stringify(row));
  } finally { rmSync(slot, { recursive: true, force: true }); }
}
if (process.argv[2] === '--child') console.log(JSON.stringify(await subject()));
else await main();
