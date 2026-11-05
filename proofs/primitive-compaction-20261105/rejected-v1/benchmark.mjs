import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = '77599337867dbf785a5f0311d34637d0b36678fc';
const CASES = [
  { name: 'list-number-large', type: 'number', size: 131073, consumed: 0, repetitions: 4, role: 'large edited vector target' },
  { name: 'list-number-small', type: 'number', size: 33, consumed: 0, repetitions: 16, role: 'small target' },
  { name: 'list-boolean', type: 'boolean', size: 8193, consumed: 0, repetitions: 8, role: 'boolean vector target' },
  { name: 'queue-number', type: 'number', size: 8193, consumed: 47, repetitions: 8, role: 'unaligned queue target' },
  { name: 'queue-boolean', type: 'boolean', size: 4097, consumed: 31, repetitions: 8, role: 'boolean queue target' },
  { name: 'list-empty', type: 'number', size: 0, consumed: 0, repetitions: 16, role: 'empty overhead control' },
  { name: 'list-string', type: 'string', size: 1025, consumed: 0, repetitions: 8, role: 'unchanged string relocation control' },
  { name: 'list-object', type: 'object', size: 129, consumed: 0, repetitions: 8, role: 'unchanged JSON relocation control' },
];
const median = values => { const a = [...values].sort((x, y) => x - y), i = a.length >>> 1; return a.length & 1 ? a[i] : (a[i - 1] + a[i]) / 2; };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const special = (i) => [NaN, -0, Infinity, -Infinity, i + 0.25, -i - 0.5, i / 8192][i % 7];
function valuesOf(item) {
  if (typeof item.toArray === 'function') return item.toArray();
  const values = [];
  for (let current = item; current.size; current = current.dequeue()) values.push(current.peek());
  return values;
}
async function subject(directory, caseName) {
  const S = await import(pathToFileURL(resolve(directory, 'shared.js')).href);
  S.configureMemory({ maximumBytes: 8 * 1024 * 1024 });
  const spec = CASES.find(c => c.name === caseName); assert.ok(spec);
  const queue = spec.name.startsWith('queue-');
  const all = Array.from({ length: spec.size + spec.consumed }, (_, i) => spec.type === 'number' ? special(i)
    : spec.type === 'boolean' ? i % 3 === 0
    : spec.type === 'string' ? `value/${i}/界🙂/${'sample'.repeat(i % 5)}`
    : { i, path: [i, i + 1], nested: { text: `界🙂:${i}` } });
  let source;
  if (queue) {
    source = new S.SharedQueue(spec.type);
    for (const value of all) source = source.enqueue(value);
    for (let i = 0; i < spec.consumed; i++) source = source.dequeue();
  } else {
    source = new S.SharedList(spec.type).pushMany(all);
    if (spec.name === 'list-number-large') for (const i of [31, 32, 1023, 1024, 32767, 32768, 131072]) {
      all[i] = i % 2 ? -i - 0.125 : -0; source = source.set(i, all[i]);
    }
  }
  const expected = all.slice(spec.consumed);
  assert.deepEqual(valuesOf(source), expected);
  const owner = S.getWorkerData({ source }, { copy: false }).arenas[0];
  const sourceBytes = digest(new Uint8Array(owner.memory.buffer, 65536, owner.used - 65536));
  const reference = S.compact(source);
  assert.deepEqual(valuesOf(reference), expected);
  const referenceData = S.getWorkerData({ item: reference }, { copy: false });
  assert.equal(referenceData.arenas.length, 1);
  const arena = referenceData.arenas[0], targetUsed = arena.used;
  const resultBytes = digest(new Uint8Array(arena.memory.buffer, 65536, targetUsed - 65536));
  const layoutDigest = digest(JSON.stringify({ descriptor: reference.toWorkerData(), resultBytes, targetUsed }));
  let verifiedOutputs = 0;
  const batch = () => {
    const output = new Array(spec.repetitions);
    const start = performance.now();
    for (let i = 0; i < spec.repetitions; i++) output[i] = S.compact(source);
    const elapsed = performance.now() - start;
    for (const result of output) {
      assert.ok(Object.isFrozen(result)); assert.deepEqual(valuesOf(result), expected);
      const record = S.getWorkerData({ result }, { copy: false }).arenas[0];
      assert.equal(record.used, targetUsed);
      assert.equal(digest(new Uint8Array(record.memory.buffer, 65536, record.used - 65536)), resultBytes);
      assert.deepEqual(result.toWorkerData(), reference.toWorkerData());
      verifiedOutputs++;
    }
    assert.equal(S.getWorkerData({ source }, { copy: false }).arenas[0].used, owner.used);
    assert.equal(digest(new Uint8Array(owner.memory.buffer, 65536, owner.used - 65536)), sourceBytes);
    return elapsed;
  };
  const warmupBatchMs = [], sampleBatchMs = []; let warmupMs = 0;
  while (warmupMs < 500 || warmupBatchMs.length < 8) {
    const elapsed = batch(); warmupMs += elapsed; warmupBatchMs.push(elapsed);
  }
  for (let i = 0; i < 9; i++) sampleBatchMs.push(batch());
  const extra = spec.type === 'number' ? 42 : spec.type === 'boolean' ? true : spec.type === 'string' ? 'new' : { added: true };
  const updated = queue ? reference.enqueue(extra) : reference.push(extra);
  assert.deepEqual(valuesOf(updated), [...expected, extra]);
  assert.deepEqual(valuesOf(reference), expected); assert.deepEqual(valuesOf(source), expected);
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, caseName,
    records: [{ ...spec, fixtureDigest: digest(JSON.stringify(expected, (_, v) => typeof v === 'number' && (Number.isNaN(v) || !Number.isFinite(v) || Object.is(v, -0)) ? `number:${Object.is(v, -0) ? '-0' : String(v)}` : v)),
      sourceBytes, sourceUsed: owner.used, targetUsed, layoutDigest, warmupBatchMs, sampleBatchMs, verifiedOutputs,
      medianMs: median(sampleBatchMs) / spec.repetitions }] };
}

function identity(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(p =>
    (p.endsWith('.ts') && !p.includes('/') && !p.endsWith('.test.ts')) || ['scripts/build-browser.ts', 'scripts/build-wasm.mjs', 'package.json', 'bun.lock'].includes(p));
  names.push(...readdirSync(root).filter(p => p.endsWith('.wasm')));
  return { root, head,
    source: Object.fromEntries(names.sort().map(p => [p, digest(readFileSync(resolve(root, p)))])),
    bundle: Object.fromEntries(readdirSync(resolve(root, 'dist')).filter(p => p.endsWith('.js')).sort().map(p => [p, digest(readFileSync(resolve(root, 'dist', p)))])) };
}

function summarize(runs, formal) {
  const result = [];
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const points = [];
    for (let pair = 0; pair < (formal ? 6 : 2); pair++) {
      const a = runs.find(r => r.runtime === runtime && r.pair === pair && r.variant === 'before' && r.caseName === spec.name)?.records[0];
      const b = runs.find(r => r.runtime === runtime && r.pair === pair && r.variant === 'after' && r.caseName === spec.name)?.records[0];
      if (!a || !b) continue;
      assert.equal(a.fixtureDigest, b.fixtureDigest);
      assert.equal(a.layoutDigest, b.layoutDigest);
      assert.equal(a.targetUsed, b.targetUsed);
      assert.equal(a.repetitions, b.repetitions);
      points.push({ before: a.medianMs, after: b.medianMs, ratio: b.medianMs / a.medianMs });
    }
    if (!points.length) continue;
    const logs = points.map(p => Math.log(p.ratio)), mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const error = logs.length > 1 ? Math.sqrt(logs.reduce((n, x) => n + (x - mean) ** 2, 0) / (logs.length - 1) / logs.length) : null;
    result.push({ runtime, name: spec.name, role: spec.role, beforeMs: median(points.map(p => p.before)), afterMs: median(points.map(p => p.after)),
      pairedRatio: Math.exp(mean), interval95: formal && logs.length === 6 ? [Math.exp(mean - 2.570582 * error), Math.exp(mean + 2.570582 * error)] : null, points });
  }
  return result;
}

if (process.argv[2] === '--subject') {
  process.stdout.write(JSON.stringify(await subject(process.argv[3], process.argv[4])));
} else {
  const [beforeArg, afterArg, bunArg, outArg, mode = 'pilot'] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outArg && ['pilot', 'formal'].includes(mode));
  const [beforeRoot, afterRoot, bun, out] = [beforeArg, afterArg, bunArg, outArg].map(p => resolve(p));
  assert.ok(!existsSync(out), 'Keep old recordings; choose a new output path');
  const before = identity(beforeRoot), after = identity(afterRoot);
  assert.equal(before.head, BASE);
  assert.deepEqual(Object.keys(before.source), Object.keys(after.source));
  assert.deepEqual(Object.keys(before.source).filter(p => before.source[p] !== after.source[p]), ['compaction.ts']);
  const script = fileURLToPath(import.meta.url), neutral = mkdtempSync(resolve(tmpdir(), 'zerocopy-compaction-'));
  const data = { schema: 'zerocopy-compaction-base64/isolated-v1', mode, status: 'running', startedAt: new Date().toISOString(),
    before, after, driver: digest(readFileSync(script)),
    host: { arch: arch(), platform: platform(), release: release(), cpu: cpus()[0]?.model,
      affinity: readFileSync('/proc/self/status', 'utf8').split('\n').find(l => l.startsWith('Cpus_allowed_list:')) },
    method: { pairs: mode === 'formal' ? 6 : 2, cases: CASES, samples: 9, minimumWarmupMs: 500, minimumWarmupBatches: 8,
      order: 'balanced AB/BA per case; cases reversed each pair; one build and one case per fresh process; identical import path',
      estimate: 'geometric mean paired ratios; unadjusted Student-t interval of log ratios, df5',
      timed: 'complete compact(source) including new Arena/instance, allocation, relocation/copy, index construction and frozen result',
      excluded: 'imports, fixture and reference construction, complete output/source verification, preallocated outer output array' }, runs: [], summary: [] };
  mkdirSync(dirname(out), { recursive: true });
  const save = () => { data.summary = summarize(data.runs, mode === 'formal'); writeFileSync(out, JSON.stringify(data, null, 2) + '\n'); };
  save();
  try {
    for (const runtime of ['node', 'bun']) for (let pair = 0; pair < data.method.pairs; pair++) {
      for (const spec of pair % 2 ? [...CASES].reverse() : CASES) for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        for (const name of readdirSync(neutral)) rmSync(resolve(neutral, name), { recursive: true, force: true });
        const source = variant === 'before' ? beforeRoot : afterRoot;
        for (const name of Object.keys((variant === 'before' ? before : after).bundle)) cpSync(resolve(source, 'dist', name), resolve(neutral, name));
        const result = JSON.parse(execFileSync(runtime === 'node' ? process.execPath : bun,
          [script, '--subject', neutral, spec.name], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 }));
        assert.equal(result.runtime, runtime);
        data.runs.push({ pair, variant, ...result }); save();
        console.error(`${mode}: ${runtime} pair ${pair + 1}/${data.method.pairs} ${variant}, ${spec.name} verified`);
      }
    }
    assert.deepEqual(identity(beforeRoot), before);
    assert.deepEqual(identity(afterRoot), after);
    assert.equal(digest(readFileSync(script)), data.driver);
    data.status = 'complete'; data.completedAt = new Date().toISOString(); save();
  } catch (e) { data.status = 'failed'; data.error = String(e); save(); throw e; }
  finally { rmSync(neutral, { recursive: true, force: true }); }
  for (const s of data.summary) console.log(`${s.runtime} ${s.name}: ${s.beforeMs.toFixed(4)} -> ${s.afterMs.toFixed(4)} ms, ratio ${s.pairedRatio.toFixed(3)}`);
}
