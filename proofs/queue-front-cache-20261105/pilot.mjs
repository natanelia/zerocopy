import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const BASE = '77599337867dbf785a5f0311d34637d0b36678fc';
const CONFIG = Object.freeze({ pairs: 2, samples: 7, coarseWarmupMs: 100, fixedWarmupMs: 150,
  subjectWarmupMs: 150, minimumWarmupBatches: 8, emptyWarmupBatchCap: 256, targetBatchMs: 8,
  maxRepeat: 1048576, maxOutputValues: 524288, maxObjectValues: 131072 });
const CASES = [
  { name: 'empty-peek', type: 'number', size: 0, operation: 'peek', reads: 1, role: 'empty control' },
  { name: 'tail-drain', type: 'number', size: 32, operation: 'drain', role: 'unchanged tail path' },
  { name: 'first-block-drain', type: 'number', size: 33, operation: 'drain', role: 'first committed block' },
  { name: 'tree-drain', type: 'number', size: 4097, operation: 'drain', role: 'normal FIFO target' },
  { name: 'deep-drain', type: 'number', size: 65537, operation: 'drain', role: 'deeper FIFO target' },
  { name: 'repeat-peek', type: 'number', size: 4097, operation: 'peek', reads: 256, role: 'repeated front target' },
  { name: 'alternating-roots', type: 'number', size: 1025, operation: 'interleaved', roots: 4, role: 'cache miss adverse control' },
  { name: 'string-drain', type: 'string', size: 4097, operation: 'drain', role: 'decode cache overflow' },
  { name: 'object-drain', type: 'object', size: 1057, operation: 'drain', role: 'warm generic decode' },
  { name: 'unchanged-stack', type: 'number', size: 4097, operation: 'stack', role: 'unchanged collection control' },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };

async function subject() {
  const [entry, name, mode, repeatText] = process.argv.slice(3);
  const spec = CASES.find(row => row.name === name); assert.ok(spec);
  const api = await import(pathToFileURL(entry).href);
  const Arena = new api.SharedQueue('number').arena.constructor, a = new Arena();
  const native = Array.from({ length: spec.roots ?? 1 }, (_, root) => Array.from({ length: spec.size }, (_, i) =>
    spec.type === 'number' ? root * 10000 + (i % 257) - 128 + .25
      : spec.type === 'string' ? `value-${i}-界🙂` : { id: i, tag: `row-${i}`, nested: [i % 7, i % 3 === 0] }));
  const fixtures = native.map(values => {
    let value = spec.operation === 'stack' ? new api.SharedStack(spec.type, 0, 0, undefined, a)
      : new api.SharedQueue(spec.type, 0, 0, 0, undefined, a);
    for (const item of values) value = spec.operation === 'stack' ? value.push(item) : value.enqueue(item);
    return value;
  });
  const descriptors = fixtures.map(item => item.toWorkerData());
  const expected = spec.operation === 'peek' ? Array.from({ length: spec.reads }, () => native[0][0])
    : spec.operation === 'stack' ? [...native[0]].reverse()
      : spec.operation === 'interleaved' ? Array.from({ length: spec.size }, (_, i) => native.map(row => row[i])).flat()
        : native[0];
  const valuesPerOperation = expected.length, outputHash = hash(JSON.stringify(expected));
  const cap = Math.max(1, Math.min(CONFIG.maxRepeat, Math.floor((spec.type === 'object'
    ? CONFIG.maxObjectValues : CONFIG.maxOutputValues) / Math.max(1, valuesPerOperation))));
  let prepared;
  function batch(repeat) {
    if (prepared?.repeat !== repeat) prepared = { repeat, outputs: new Array(repeat * valuesPerOperation),
      oracle: Array.from({ length: repeat * valuesPerOperation }, (_, i) => expected[i % valuesPerOperation]),
      counts: new Uint32Array(repeat), cursors: new Array(fixtures.length) };
    const { outputs, oracle, counts, cursors } = prepared;
    counts.fill(0);
    const usedBefore = a.used, start = performance.now();
    if (spec.operation === 'peek') for (let r = 0; r < repeat; r++) {
      const offset = r * valuesPerOperation;
      for (let i = 0; i < spec.reads; i++) { outputs[offset + i] = fixtures[0].peek(); counts[r]++; }
    } else if (spec.operation === 'drain') for (let r = 0; r < repeat; r++) {
      const offset = r * valuesPerOperation; let item = fixtures[0], count = 0;
      while (item.size) { outputs[offset + count++] = item.peek(); item = item.dequeue(); }
      counts[r] = count;
    } else if (spec.operation === 'stack') for (let r = 0; r < repeat; r++) {
      const offset = r * valuesPerOperation; let item = fixtures[0], count = 0;
      while (item.size) { outputs[offset + count++] = item.peek(); item = item.pop(); }
      counts[r] = count;
    } else for (let r = 0; r < repeat; r++) {
      const offset = r * valuesPerOperation; let count = 0;
      for (let i = 0; i < fixtures.length; i++) cursors[i] = fixtures[i];
      while (cursors[0].size) for (let i = 0; i < cursors.length; i++) {
        outputs[offset + count++] = cursors[i].peek(); cursors[i] = cursors[i].dequeue();
      }
      counts[r] = count;
    }
    const ms = performance.now() - start, usedAfter = a.used;
    assert.equal(usedAfter, usedBefore, 'Read-only operation allocated shared storage');
    for (const count of counts) assert.equal(count, valuesPerOperation, 'Stale output must not hide skipped work');
    assert.deepEqual(outputs, oracle);
    if (spec.type === 'object') for (const value of outputs) {
      assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.nested));
    }
    assert.equal(a.used, usedAfter);
    return { ms, msPerOperation: ms / repeat, repeat, checkedValues: repeat * valuesPerOperation,
      sharedAllocatedBytes: usedAfter - usedBefore };
  }
  const warmup = [], calibration = [], samples = [];
  let repeat = Number(repeatText);
  if (mode === 'coarse') {
    repeat = Math.max(1, Math.min(cap, Math.ceil(16384 / Math.max(1, valuesPerOperation))));
    let elapsed = 0;
    while (elapsed < CONFIG.coarseWarmupMs || warmup.length < 5) {
      const row = batch(repeat); warmup.push(row); elapsed += row.ms;
    }
    repeat = Math.max(1, Math.min(cap, Math.ceil(CONFIG.targetBatchMs / median(warmup.slice(-5).map(row => row.msPerOperation)))));
    for (let step = 0; step < 2; step++) {
      const trials = Array.from({ length: 3 }, () => batch(repeat)); calibration.push({ repeat, trials });
      const duration = median(trials.map(row => row.ms));
      if (duration >= CONFIG.targetBatchMs || repeat === cap || step === 1) break;
      repeat = Math.min(cap, Math.ceil(repeat * CONFIG.targetBatchMs / duration));
    }
  } else {
    assert.ok(Number.isInteger(repeat) && repeat > 0 && repeat <= cap);
    if (mode === 'fixed') {
      let elapsed = 0;
      while (elapsed < CONFIG.fixedWarmupMs || warmup.length < 5) {
        const row = batch(repeat); warmup.push(row); elapsed += row.ms;
      }
      calibration.push({ repeat, trials: Array.from({ length: 3 }, () => batch(repeat)) });
    } else {
      assert.equal(mode, 'measure');
      let elapsed = 0;
      while ((elapsed < CONFIG.subjectWarmupMs || warmup.length < CONFIG.minimumWarmupBatches)
        && (spec.size !== 0 || warmup.length < CONFIG.emptyWarmupBatchCap)) {
        const row = batch(repeat); warmup.push(row); elapsed += row.ms;
      }
      for (let i = 0; i < CONFIG.samples; i++) samples.push(batch(repeat));
    }
  }
  assert.deepEqual(fixtures.map(item => item.toWorkerData()), descriptors);
  const trials = mode === 'measure' ? samples : calibration.at(-1).trials;
  const warmupTimedMs = warmup.reduce((sum, row) => sum + row.ms, 0);
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, arch: process.arch, name, mode,
    repeat, cap, valuesPerOperation, warmupBatches: warmup.length, warmup, calibration, samples, outputHash, fixtureUsed: a.used,
    warmupTimedMs, warmupTargetMet: mode === 'measure' ? warmupTimedMs >= CONFIG.subjectWarmupMs : undefined,
    emptyWarmupCapHit: mode === 'measure' && !spec.size && warmup.length === CONFIG.emptyWarmupBatchCap && warmupTimedMs < CONFIG.subjectWarmupMs,
    measuredTimedMs: samples.reduce((sum, row) => sum + row.ms, 0),
    medianMsPerOperation: median(trials.map(row => row.msPerOperation)) };
}

function manifest(root) {
  const sources = readdirSync(root).filter(name => (name.endsWith('.ts') && !name.endsWith('.test.ts')) || name.endsWith('.wasm'));
  const files = [...sources, 'package.json', 'scripts/build-browser.ts', 'scripts/build-wasm.mjs',
    ...readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js')).map(name => `dist/${name}`)].sort();
  return { root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    files: Object.fromEntries(files.map(name => [name, hash(readFileSync(join(root, name)))])) };
}
function summaries(pairs) {
  return CASES.flatMap(spec => {
    const rows = pairs.filter(row => row.name === spec.name);
    if (!rows.length) return [];
    const ratios = rows.map(row => row.after.medianMsPerOperation / row.before.medianMsPerOperation);
    const logs = ratios.map(Math.log), mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    const t95 = [undefined, 12.7062047364, 4.30265272975, 3.18244630528, 2.7764451052, 2.57058183564];
    const standardError = logs.length > 1 ? Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0)
      / (logs.length - 1) / logs.length) : undefined;
    const margin = standardError === undefined ? undefined : t95[logs.length - 1] * standardError;
    return [{ runtime: rows[0].runtime, ...spec, pairs: rows.length,
      beforeMs: median(rows.map(row => row.before.medianMsPerOperation)), afterMs: median(rows.map(row => row.after.medianMsPerOperation)),
      ratio: Math.exp(mean), ratios, ratioRange: [Math.min(...ratios), Math.max(...ratios)],
      ratioCI95: margin === undefined ? undefined : [Math.exp(mean - margin), Math.exp(mean + margin)] }];
  });
}
async function main() {
  const [beforeArg, afterArg, bunArg, outputArg, selectedRuntime] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outputArg && ['node', 'bun'].includes(selectedRuntime),
    'Usage: node pilot.mjs BEFORE AFTER BUN OUTPUT node|bun');
  const roots = { before: resolve(beforeArg), after: resolve(afterArg) }, output = resolve(outputArg);
  assert.ok(!existsSync(output), 'Keep old records; choose a new output path');
  const source = { before: manifest(roots.before), after: manifest(roots.after), driver: hash(readFileSync(import.meta.filename)) };
  assert.equal(source.before.commit, BASE);
  assert.deepEqual(Object.keys(source.before.files).filter(name => !name.startsWith('dist/')),
    Object.keys(source.after.files).filter(name => !name.startsWith('dist/')));
  const changed = ['shared-queue.ts'];
  for (const name of Object.keys(source.before.files).filter(name => !changed.includes(name) && !name.startsWith('dist/'))) {
    assert.equal(source.before.files[name], source.after.files[name], `Unrelated production source changed: ${name}`);
  }
  const record = { schema: 'zerocopy-queue-front-cache-screen/v1', status: 'running', startedAt: new Date().toISOString(), selectedRuntime, source,
    candidatePatch: execFileSync('git', ['diff', BASE, '--', ...changed], { cwd: roots.after, encoding: 'utf8' }),
    method: { ...CONFIG, independentUnits: 'One workload and one build in each fresh process; balanced AB/BA process pairs',
      warmup: 'Disposable coarse probes choose a common repetition count; a second calibration warms at that count. Every nonempty measured subject then performs at least 150 ms of timed warm-up and eight batches at its final repetition count. Empty control has a 256-batch cap. Actual counts, durations, and cap hits are recorded.',
      summary: 'Two-pair screening estimates and observed ranges only; any computed t interval is exploratory, not confirmation. No workload exclusions.',
      timed: 'Complete peek/dequeue FIFO drains, repeated peeks, round-robin drains or unchanged stack peek/pop; all snapshot wrappers and caller value writes are timed',
      excluded: 'Fixture construction, caller output/oracle/counter/cursor-array preparation, counter reset, full-content validation. Buffers are reused and actual counts plus all output values are checked; round-robin cursor initialization remains timed.',
      allocation: 'Shared used-byte delta must be zero; JS allocation and GC remain within their natural timing boundaries',
      cache: 'Every operation starts from retained immutable fixtures; normal per-arena vector and bounded decode caches are active, no reset between batches' },
    hardware: { cpu: os.cpus()[0].model, platform: process.platform, kernel: os.release(), arch: process.arch,
      cpuQuota: existsSync('/sys/fs/cgroup/cpu.max') ? readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() : undefined,
      affinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Cpus_allowed_list:')) : undefined },
    cases: CASES, calibrations: [], pairs: [], summary: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { record.summary = summaries(record.pairs); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); };
  const slot = mkdtempSync(join(os.tmpdir(), 'queue-front-cache-'));
  const runtime = selectedRuntime, executable = runtime === 'node' ? process.execPath : resolve(bunArg);
  function run(variant, name, mode, repeat = 0) {
    rmSync(join(slot, 'dist'), { recursive: true, force: true });
    cpSync(join(roots[variant], 'dist'), join(slot, 'dist'), { recursive: true });
    cpSync(join(roots[variant], 'package.json'), join(slot, 'package.json'));
    const child = spawnSync(executable, [import.meta.filename, '--child', join(slot, 'dist/shared.js'), name, mode, String(repeat)],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    if (child.status !== 0) {
      record.status = 'failed'; record.failure = { runtime, variant, name, mode, repeat, status: child.status,
        stdout: child.stdout, stderr: child.stderr, error: String(child.error ?? '') }; save(); throw new Error(child.stderr);
    }
    const value = JSON.parse(child.stdout); assert.equal(value.runtime, runtime); assert.equal(value.arch, process.arch);
    assert.equal(value.name, name); assert.equal(value.mode, mode);
    return value;
  }
  save();
  try {
    const controls = new Map();
    for (const spec of CASES) {
      const before = run('before', spec.name, 'coarse'), after = run('after', spec.name, 'coarse');
      const repeat = Math.min(before.cap, after.cap, Math.max(before.repeat, after.repeat));
      record.calibrations.push({ runtime, name: spec.name, stage: 'coarse', repeat, before, after }); save();
      const fixedBefore = run('before', spec.name, 'fixed', repeat), fixedAfter = run('after', spec.name, 'fixed', repeat);
      assert.equal(before.outputHash, after.outputHash); assert.equal(fixedBefore.outputHash, fixedAfter.outputHash);
      controls.set(spec.name, { repeat });
      record.calibrations.push({ runtime, name: spec.name, stage: 'fixed', repeat, before: fixedBefore, after: fixedAfter }); save();
    }
    for (let round = 0; round < CONFIG.pairs; round++) {
      const cases = [...CASES.slice(round % CASES.length), ...CASES.slice(0, round % CASES.length)];
      for (const spec of cases) {
        const { repeat } = controls.get(spec.name), order = round % 2 ? ['after', 'before'] : ['before', 'after'];
        const pair = { runtime, name: spec.name, round, order };
        for (const variant of order) pair[variant] = run(variant, spec.name, 'measure', repeat);
        assert.equal(pair.before.outputHash, pair.after.outputHash); record.pairs.push(pair); save();
      }
      console.log(`${runtime}: complete screen round ${round + 1}/${CONFIG.pairs}`);
    }
    assert.deepEqual(manifest(roots.before), source.before); assert.deepEqual(manifest(roots.after), source.after);
    assert.equal(hash(readFileSync(import.meta.filename)), source.driver);
    record.status = 'complete'; record.completedAt = new Date().toISOString(); save();
    for (const row of record.summary) console.log(JSON.stringify(row));
  } finally { rmSync(slot, { recursive: true, force: true }); }
}
if (process.argv[2] === '--child') console.log(JSON.stringify(await subject()));
else await main();
