import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const BASE = '09b1a385a7c2ac9b027a4055335ae2f9449abe6e';
const CONFIG = Object.freeze({ pairs: 6, samples: 9, coarseWarmupMs: 100, fixedWarmupMs: 150,
  subjectWarmupMs: 500, minimumWarmupBatches: 8, emptyWarmupBatchCap: 256, targetBatchMs: 12,
  maxRepeat: 1048576, maxOutputValues: 524288, maxObjectValues: 131072 });
const CASES = [
  { name: 'linked-empty', collection: 'SharedLinkedList', type: 'number', size: 0, operation: 'forEach', role: 'empty control' },
  { name: 'linked-tail', collection: 'SharedLinkedList', type: 'number', size: 32, operation: 'forEach', role: 'tail-only control' },
  { name: 'linked-first-block', collection: 'SharedLinkedList', type: 'number', size: 33, operation: 'forEach', role: 'first block boundary' },
  { name: 'linked-large', collection: 'SharedLinkedList', type: 'number', size: 65537, operation: 'forEach', role: 'main target' },
  { name: 'doubly-forward', collection: 'SharedDoublyLinkedList', type: 'number', size: 4097, operation: 'forEach', role: 'forward second wrapper' },
  { name: 'doubly-reverse', collection: 'SharedDoublyLinkedList', type: 'boolean', size: 4097, operation: 'forEachReverse', role: 'reverse primitive' },
  { name: 'string-uncached', collection: 'SharedLinkedList', type: 'string', size: 4097, operation: 'forEach', role: 'beyond bounded string cache' },
  { name: 'object-uncached', collection: 'SharedDoublyLinkedList', type: 'object', size: 4097, operation: 'forEachReverse', role: 'JSON fallback' },
  { name: 'edited-array', collection: 'SharedLinkedList', type: 'number', size: 4097, operation: 'toArray', edited: true, role: 'downstream materialization' },
  { name: 'unchanged-values', collection: 'SharedList', type: 'number', size: 4097, operation: 'values', role: 'unchanged generator control' },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };

async function subject() {
  const [entry, name, mode, repeatText] = process.argv.slice(3);
  const spec = CASES.find(row => row.name === name); assert.ok(spec);
  const api = await import(pathToFileURL(entry).href);
  const Arena = new api.SharedList('number').arena.constructor;
  const a = new Arena();
  const initial = Array.from({ length: spec.size }, (_, i) => spec.type === 'number' ? (i % 257) - 128 + .25
    : spec.type === 'boolean' ? i % 3 === 0 : spec.type === 'string' ? `value-${i}-界🙂`
      : { id: i, tags: [i % 7, `label-${i}`], nested: { active: i % 3 === 0 } });
  let item = new api[spec.collection](spec.type, 0, 0, 0, a);
  if (spec.collection === 'SharedList') item = item.pushMany(initial);
  else for (const value of initial) item = item.append(value);
  const retained = item, edited = [...initial];
  if (spec.edited) for (let step = 0; step < 16; step++) {
    const index = 17 + 37 * step, value = -1000 - step;
    item = item.insertAfter(index, value).removeFirst();
    edited.splice(index + 1, 0, value); edited.shift();
  }
  const reverse = spec.operation === 'forEachReverse';
  const expected = reverse ? [...edited].reverse() : edited;
  const expectedIndices = Array.from({ length: spec.size }, (_, i) => reverse ? spec.size - i - 1 : i);
  assert.equal(item.size, spec.size);
  const outputHash = hash(JSON.stringify({ values: expected, indices: expectedIndices }));

  let prepared;
  function prepare(repeat) {
    const outputs = spec.size ? new Array(repeat) : [];
    const callbackOperation = spec.operation === 'forEach' || reverse;
    const indices = callbackOperation && spec.size ? new Array(repeat) : [];
    const callbacks = callbackOperation && spec.size ? new Array(repeat) : [];
    const reset = [], counts = [], yieldCounts = spec.operation === 'values' ? new Array(repeat).fill(0) : [];
    if (spec.size && spec.operation !== 'toArray') for (let r = 0; r < repeat; r++) {
      const values = outputs[r] = new Array(spec.size);
      if (callbackOperation) {
        const positions = indices[r] = new Array(spec.size);
        let cursor = 0;
        callbacks[r] = (value, index) => { values[cursor] = value; positions[cursor++] = index; };
        reset[r] = () => { cursor = 0; };
        counts[r] = () => cursor;
      }
    }
    return { repeat, outputs, callbackOperation, indices, callbacks, reset, counts, yieldCounts };
  }
  function batch(repeat) {
    if (prepared?.repeat !== repeat) prepared = prepare(repeat);
    const { outputs, callbackOperation, indices, callbacks, reset, counts, yieldCounts } = prepared;
    for (const resetCursor of reset) resetCursor();
    yieldCounts.fill(0);
    let unexpectedCalls = 0;
    const emptyCallback = () => { unexpectedCalls++; };
    const usedBefore = a.used, started = performance.now();
    if (!spec.size) for (let r = 0; r < repeat; r++) item.forEach(emptyCallback);
    else if (spec.operation === 'forEach') for (let r = 0; r < repeat; r++) item.forEach(callbacks[r]);
    else if (reverse) for (let r = 0; r < repeat; r++) item.forEachReverse(callbacks[r]);
    else if (spec.operation === 'toArray') for (let r = 0; r < repeat; r++) outputs[r] = item.toArray();
    else for (let r = 0; r < repeat; r++) {
      let i = 0;
      for (const value of item.values()) outputs[r][i++] = value;
      yieldCounts[r] = i;
    }
    const ms = performance.now() - started, usedAfter = a.used;
    assert.equal(usedAfter, usedBefore, 'Read-only scan allocated shared memory');
    assert.equal(unexpectedCalls, 0);
    for (let r = 0; r < outputs.length; r++) {
      assert.deepEqual(outputs[r], expected);
      if (callbackOperation) {
        assert.equal(counts[r](), spec.size, 'Every operation must visit every value exactly once');
        assert.deepEqual(indices[r], expectedIndices);
      }
      if (yieldCounts.length) assert.equal(yieldCounts[r], spec.size, 'Stale output must not hide missing generator values');
      if (spec.type === 'object') for (const value of outputs[r]) {
        assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.tags)); assert.ok(Object.isFrozen(value.nested));
      }
    }
    assert.equal(a.used, usedAfter, 'Validation allocated shared memory');
    return { ms, msPerOperation: ms / repeat, repeat, checkedValues: repeat * spec.size,
      checkedIndices: callbackOperation ? repeat * spec.size : 0, sharedAllocatedBytes: usedAfter - usedBefore };
  }
  const cap = Math.max(1, Math.min(CONFIG.maxRepeat, Math.floor((spec.type === 'object'
    ? CONFIG.maxObjectValues : CONFIG.maxOutputValues) / Math.max(1, spec.size))));
  const warmup = [], calibration = [], samples = [];
  let repeat = Number(repeatText);
  if (mode === 'coarse') {
    repeat = Math.max(1, Math.min(cap, Math.ceil(16384 / Math.max(1, spec.size))));
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
  if (spec.edited) assert.deepEqual(retained.toArray(), initial);
  const trials = mode === 'measure' ? samples : calibration.at(-1).trials;
  const warmupTimedMs = warmup.reduce((sum, row) => sum + row.ms, 0);
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, arch: process.arch, name, mode,
    repeat, cap, warmupBatches: warmup.length, warmup, calibration, samples, outputHash, fixtureUsed: a.used,
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
    'Usage: node benchmark.mjs BEFORE AFTER BUN OUTPUT node|bun');
  const roots = { before: resolve(beforeArg), after: resolve(afterArg) }, output = resolve(outputArg);
  assert.ok(!existsSync(output), 'Keep old records; choose a new output path');
  const source = { before: manifest(roots.before), after: manifest(roots.after), driver: hash(readFileSync(import.meta.filename)) };
  assert.equal(source.before.commit, BASE);
  assert.deepEqual(Object.keys(source.before.files).filter(name => !name.startsWith('dist/')),
    Object.keys(source.after.files).filter(name => !name.startsWith('dist/')));
  const changed = ['arena.ts', 'shared-linked-list.ts', 'shared-doubly-linked-list.ts'];
  for (const name of Object.keys(source.before.files).filter(name => !changed.includes(name) && !name.startsWith('dist/'))) {
    assert.equal(source.before.files[name], source.after.files[name], `Unrelated production source changed: ${name}`);
  }
  const record = { schema: 'zerocopy-block-callback-study/v1', status: 'running', startedAt: new Date().toISOString(), selectedRuntime, source,
    candidatePatch: execFileSync('git', ['diff', BASE, '--', ...changed], { cwd: roots.after, encoding: 'utf8' }),
    method: { ...CONFIG, independentUnits: 'One workload and one build in each fresh process; balanced AB/BA process pairs',
      warmup: 'Disposable coarse probes choose a common repetition count; a second calibration warms at that count. Every nonempty measured subject then performs at least 500 ms of timed warm-up and eight batches at its final repetition count. Empty control has a 256-batch cap. Actual counts, durations, and cap hits are recorded.',
      summary: 'Geometric mean of paired after/before process-median ratios; unadjusted 95% Student-t intervals on paired log ratios. Process pairs, not batches, are independent observations.',
      timed: 'Complete public scan, caller value/index writes, and library output allocations for toArray; generator fully consumed',
      excluded: 'Fixture construction, caller output/callback preparation, cursor reset, full-content validation. Caller output buffers and callbacks are reused across batches; every operation remains completely verified.',
      allocation: 'Shared used-byte delta must be zero; JS allocation and GC remain within their natural timing boundaries',
      cache: 'Repeated reads of one immutable fixture; normal bounded decode caches, no reset between batches' },
    hardware: { cpu: os.cpus()[0].model, platform: process.platform, kernel: os.release(), arch: process.arch,
      cpuQuota: existsSync('/sys/fs/cgroup/cpu.max') ? readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() : undefined,
      affinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Cpus_allowed_list:')) : undefined },
    cases: CASES, calibrations: [], pairs: [], summary: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { record.summary = summaries(record.pairs); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); };
  const slot = mkdtempSync(join(os.tmpdir(), 'block-callback-'));
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
      console.log(`${runtime}: complete formal round ${round + 1}/${CONFIG.pairs}`);
    }
    assert.deepEqual(manifest(roots.before), source.before); assert.deepEqual(manifest(roots.after), source.after);
    assert.equal(hash(readFileSync(import.meta.filename)), source.driver);
    record.status = 'complete'; record.completedAt = new Date().toISOString(); save();
    for (const row of record.summary) console.log(JSON.stringify(row));
  } finally { rmSync(slot, { recursive: true, force: true }); }
}
if (process.argv[2] === '--child') console.log(JSON.stringify(await subject()));
else await main();
