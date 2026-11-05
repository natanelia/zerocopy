import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = '77599337867dbf785a5f0311d34637d0b36678fc';
const CASES = [
  { name: 'encode-tiny', kind: 'tiny', repetitions: 256, role: 'small-input control' },
  { name: 'encode-array', kind: 'array', count: 8192, repetitions: 4, role: 'array target' },
  { name: 'encode-frozen-array', kind: 'array', frozen: true, count: 8192, repetitions: 4, role: 'frozen array target' },
  { name: 'encode-record', kind: 'record', count: 4096, repetitions: 4, role: 'record target' },
  { name: 'encode-frozen-record', kind: 'record', frozen: true, count: 4096, repetitions: 4, role: 'frozen record target' },
  { name: 'stringify-mixed', kind: 'mixed', stringify: true, count: 256, repetitions: 4, role: 'full string serialization target' },
  { name: 'encode-collection', kind: 'collection', count: 1024, repetitions: 16, role: 'unchanged shared-collection control' },
  { name: 'decode-record', kind: 'record', decode: true, count: 4096, repetitions: 4, role: 'unchanged decode control' },
];
const median = values => { const a = [...values].sort((x, y) => x - y), i = a.length >>> 1; return a.length & 1 ? a[i] : (a[i - 1] + a[i]) / 2; };
const digest = value => createHash('sha256').update(value).digest('hex');

function reference(input) {
  if (input === null || typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') return input;
  if (Array.isArray(input)) return ['a', input.map(reference)];
  return ['o', Object.keys(input).map(key => [key, reference(input[key])])];
}
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function subject(directory, caseName, mode) {
  const redux = await import(pathToFileURL(resolve(directory, 'redux.js')).href);
  const shared = await import(pathToFileURL(resolve(directory, 'shared.js')).href);
  const spec = CASES.find(item => item.name === caseName);
  assert.ok(spec);
  let input;
  if (spec.kind === 'tiny') input = { selected: 7, title: '道路🙂', visible: true, mode: null };
  else if (spec.kind === 'array') input = Array.from({ length: spec.count }, (_, i) => i + 0.25);
  else if (spec.kind === 'record') input = Object.fromEntries(Array.from({ length: spec.count }, (_, i) => [`key${i}`, i + 0.25]));
  else if (spec.kind === 'mixed') input = freeze({ rows: Array.from({ length: spec.count }, (_, i) => ({ id: i, name: `道路-${i}`, enabled: i % 2 === 0, coords: [i / 7, i / 9], metadata: { version: 1, label: 'item' } })), selected: 7 });
  else input = new shared.SharedMap('number').setMany(Array.from({ length: spec.count }, (_, i) => [`key${i}`, i + 0.25]));
  if (spec.frozen) freeze(input);
  const envelope = { $zerocopyRedux: 1, value: spec.kind === 'collection'
    ? ['c', 'SharedMap', 'number', null, Array.from(input.entries())]
    : reference(input) };
  const expected = spec.stringify ? JSON.stringify(envelope) : spec.decode ? input : envelope;
  const codec = redux.createZerocopyCodec();
  const operation = spec.stringify ? () => codec.stringify(input) : spec.decode ? () => codec.decode(envelope) : () => codec.encode(input);
  assert.deepEqual(operation(), expected);
  const output = new Array(spec.repetitions);
  let verifiedOutputs = 0;
  function batch() {
    const start = performance.now();
    for (let i = 0; i < spec.repetitions; i++) output[i] = operation();
    const elapsed = performance.now() - start;
    for (const result of output) {
      assert.deepEqual(result, expected);
      if (!spec.stringify && !spec.decode) assert.ok(Object.isFrozen(result));
      verifiedOutputs++;
    }
    return elapsed;
  }
  const warmupBatchMs = [], sampleBatchMs = [];
  let warmupMs = 0;
  const minimumWarmupMs = mode === 'formal' ? 500 : 150;
  while (warmupMs < minimumWarmupMs || warmupBatchMs.length < 8) {
    const elapsed = batch(); warmupMs += elapsed; warmupBatchMs.push(elapsed);
  }
  for (let i = 0; i < 9; i++) sampleBatchMs.push(batch());
  assert.deepEqual(operation(), expected);
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, caseName, ...spec,
    expectedDigest: digest(JSON.stringify(envelope)), warmupBatchMs, sampleBatchMs, verifiedOutputs,
    medianMs: median(sampleBatchMs) / spec.repetitions };
}
function identity(root) {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(path =>
    (path.endsWith('.ts') && !path.includes('/') && !path.endsWith('.test.ts')) || ['scripts/build-browser.ts', 'scripts/build-wasm.mjs', 'package.json'].includes(path));
  names.push(...readdirSync(root).filter(path => path.endsWith('.wasm')));
  return { root, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source: Object.fromEntries(names.sort().map(path => [path, digest(readFileSync(resolve(root, path)))])),
    bundle: Object.fromEntries(readdirSync(resolve(root, 'dist')).filter(path => path.endsWith('.js')).sort().map(path => [path, digest(readFileSync(resolve(root, 'dist', path)))])) };
}
function summarize(runs, pairs) {
  const summaries = [];
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const points = [];
    for (let pair = 0; pair < pairs; pair++) {
      const a = runs.find(run => run.runtime === runtime && run.caseName === spec.name && run.pair === pair && run.variant === 'before');
      const b = runs.find(run => run.runtime === runtime && run.caseName === spec.name && run.pair === pair && run.variant === 'after');
      if (!a || !b) continue;
      assert.equal(a.expectedDigest, b.expectedDigest);
      points.push({ before: a.medianMs, after: b.medianMs, ratio: b.medianMs / a.medianMs });
    }
    if (!points.length) continue;
    const logs = points.map(point => Math.log(point.ratio)), mean = logs.reduce((a, b) => a + b) / logs.length;
    const se = logs.length > 1 ? Math.sqrt(logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (logs.length - 1) / logs.length) : null;
    summaries.push({ runtime, name: spec.name, role: spec.role, beforeMs: median(points.map(point => point.before)), afterMs: median(points.map(point => point.after)),
      pairedRatio: Math.exp(mean), interval95: pairs === 6 && logs.length === 6 ? [Math.exp(mean - 2.570582 * se), Math.exp(mean + 2.570582 * se)] : null, points });
  }
  return summaries;
}
if (process.argv[2] === '--subject') {
  process.stdout.write(JSON.stringify(await subject(process.argv[3], process.argv[4], process.argv[5])));
} else {
  const [beforeArg, afterArg, bunArg, outputArg, mode = 'pilot'] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outputArg && ['pilot', 'formal'].includes(mode));
  const [beforeRoot, afterRoot, bun, output] = [beforeArg, afterArg, bunArg, outputArg].map(path => resolve(path));
  assert.ok(!existsSync(output), 'Choose a new output path; recordings are immutable');
  const before = identity(beforeRoot), after = identity(afterRoot), script = fileURLToPath(import.meta.url);
  assert.equal(before.head, BASE);
  assert.deepEqual(Object.keys(before.source), Object.keys(after.source));
  assert.deepEqual(Object.keys(before.source).filter(path => before.source[path] !== after.source[path]), ['redux-codec.ts']);
  const neutral = mkdtempSync(resolve(tmpdir(), 'zerocopy-redux-descriptors-'));
  const data = { schema: 'zerocopy-redux-descriptors/v1', mode, status: 'running', startedAt: new Date().toISOString(), before, after,
    driver: digest(readFileSync(script)),
    host: { arch: arch(), platform: platform(), release: release(), cpu: cpus()[0]?.model,
      affinity: readFileSync('/proc/self/status', 'utf8').split('\n').find(line => line.startsWith('Cpus_allowed_list:')) },
    method: { pairs: mode === 'formal' ? 6 : 2, cases: CASES, samples: 9, minimumWarmupMs: mode === 'formal' ? 500 : 150, minimumWarmupBatches: 8,
      order: 'balanced AB/BA; cases reversed per pair; one build and case per fresh process; identical import path',
      estimate: 'geometric mean paired ratios; unadjusted Student-t interval of log ratios, df5',
      timed: 'entire public codec encode/stringify/decode call and assignment to a preallocated retention array',
      excluded: 'imports, fixture and oracle construction, output verification, retention array allocation' }, runs: [], summary: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { data.summary = summarize(data.runs, data.method.pairs); writeFileSync(output, JSON.stringify(data, null, 2) + '\n'); };
  save();
  try {
    for (const runtime of ['node', 'bun']) for (let pair = 0; pair < data.method.pairs; pair++) {
      for (const spec of pair % 2 ? [...CASES].reverse() : CASES) for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        for (const name of readdirSync(neutral)) rmSync(resolve(neutral, name), { recursive: true, force: true });
        const source = variant === 'before' ? before : after;
        for (const name of Object.keys(source.bundle)) cpSync(resolve(source.root, 'dist', name), resolve(neutral, name));
        const result = JSON.parse(execFileSync(runtime === 'node' ? process.execPath : bun,
          [script, '--subject', neutral, spec.name, mode], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 }));
        assert.equal(result.runtime, runtime);
        data.runs.push({ pair, variant, ...result }); save();
        console.error(`${mode}: ${runtime} pair ${pair + 1}/${data.method.pairs} ${variant} ${spec.name} verified`);
      }
    }
    assert.deepEqual(identity(beforeRoot), before);
    assert.deepEqual(identity(afterRoot), after);
    assert.equal(digest(readFileSync(script)), data.driver);
    data.status = 'complete'; data.completedAt = new Date().toISOString(); save();
  } catch (error) { data.status = 'failed'; data.error = String(error); save(); throw error; }
  finally { rmSync(neutral, { recursive: true, force: true }); }
  for (const result of data.summary) console.log(`${result.runtime} ${result.name}: ${result.beforeMs.toFixed(4)} -> ${result.afterMs.toFixed(4)} ms, ratio ${result.pairedRatio.toFixed(3)}`);
}
