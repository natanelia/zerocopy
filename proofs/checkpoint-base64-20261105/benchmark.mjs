import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = '09b1a385a7c2ac9b027a4055335ae2f9449abe6e';
const CASES = [
  { name: 'plain-state', kind: 'plain', count: 0, repetitions: 128, role: 'unchanged control' },
  { name: 'encode-small', kind: 'encode', count: 32, repetitions: 4, role: 'small checkpoint' },
  { name: 'encode-large', kind: 'encode', count: 32768, repetitions: 2, role: 'native target' },
  { name: 'serialize-large', kind: 'serialize', count: 32768, repetitions: 2, role: 'native target' },
  { name: 'encode-unicode', kind: 'strings', count: 2048, repetitions: 2, role: 'native target' },
  { name: 'decode-large', kind: 'decode', count: 32768, repetitions: 2, role: 'unchanged control' },
];
const median = values => { const a = [...values].sort((x, y) => x - y), i = a.length >>> 1; return a.length & 1 ? a[i] : (a[i - 1] + a[i]) / 2; };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = { ui: { open: true, selected: [1, 4, 9] }, version: 7, text: 'checkpoint' };

async function subject(directory, reversed) {
  const shared = await import(pathToFileURL(resolve(directory, 'shared.js')).href);
  const redux = await import(pathToFileURL(resolve(directory, 'redux.js')).href);
  const records = [];
  for (const spec of reversed ? [...CASES].reverse() : CASES) {
    shared.resetSharedList();
    const values = Array.from({ length: spec.count }, (_, i) => spec.kind === 'strings'
      ? `${i}:道路🙂:${'界'.repeat(24)}:${i * 17}` : i % 2 ? -i - 0.25 : i + 0.5);
    const list = spec.count ? new shared.SharedList(spec.kind === 'strings' ? 'string' : 'number').pushMany(values) : null;
    const state = list ? { list, plain } : plain;
    const initial = redux.encodeZerocopyState(state);
    assert.deepEqual(list ? redux.decodeZerocopyState(initial).list.toArray() : redux.decodeZerocopyState(initial), list ? values : plain);
    const initialBytes = initial.arenas.map(a => a.base64);
    for (const arena of initial.arenas) {
      const bytes = Buffer.from(arena.base64, 'base64');
      assert.equal(bytes.length, arena.used);
      assert.equal(bytes.toString('base64'), arena.base64);
    }
    const operation = spec.kind === 'serialize' ? () => redux.serializeZerocopyState(state)
      : spec.kind === 'decode' ? () => redux.decodeZerocopyState(initial)
      : () => redux.encodeZerocopyState(state);
    let verifiedOutputs = 0;
    const batch = () => {
      const output = new Array(spec.repetitions);
      const start = performance.now();
      for (let i = 0; i < spec.repetitions; i++) output[i] = operation();
      const elapsed = performance.now() - start;
      for (const result of output) {
        if (spec.kind === 'decode') assert.deepEqual(result.list.toArray(), values);
        else {
          const packet = spec.kind === 'serialize' ? JSON.parse(result) : result;
          assert.deepEqual(packet.arenas.map(a => a.base64), initialBytes);
          assert.deepEqual(packet.tree, initial.tree);
          assert.equal(packet.format, initial.format);
          assert.equal(packet.codec, initial.codec);
          if (spec.kind !== 'serialize') assert.ok(Object.isFrozen(packet));
          for (let i = 0; i < packet.arenas.length; i++) {
            assert.equal(packet.arenas[i].used, initial.arenas[i].used);
            assert.equal(packet.arenas[i].checksum, initial.arenas[i].checksum);
          }
        }
        verifiedOutputs++;
      }
      return elapsed;
    };
    const warmupBatchMs = [], sampleBatchMs = [];
    let warmupMs = 0;
    while (warmupMs < 500 || warmupBatchMs.length < 8) {
      const ms = batch(); warmupMs += ms; warmupBatchMs.push(ms);
    }
    for (let i = 0; i < 9; i++) sampleBatchMs.push(batch());
    if (list) assert.deepEqual(list.toArray(), values);
    records.push({ ...spec, fixtureDigest: digest(JSON.stringify(values)), arenaBytes: initial.arenas.reduce((n, a) => n + a.used, 0),
      initialArenaDigests: initialBytes.map(digest), warmupBatchMs, sampleBatchMs, verifiedOutputs,
      medianMs: median(sampleBatchMs) / spec.repetitions });
  }
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions,
    nativeToBase64: typeof Uint8Array.prototype.toBase64 === 'function', reversed, records };
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
      const a = runs.find(r => r.runtime === runtime && r.pair === pair && r.variant === 'before')?.records.find(r => r.name === spec.name);
      const b = runs.find(r => r.runtime === runtime && r.pair === pair && r.variant === 'after')?.records.find(r => r.name === spec.name);
      if (!a || !b) continue;
      assert.equal(a.fixtureDigest, b.fixtureDigest);
      assert.deepEqual(a.initialArenaDigests, b.initialArenaDigests);
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
  process.stdout.write(JSON.stringify(await subject(process.argv[3], process.argv[4] === 'reverse')));
} else {
  const [beforeArg, afterArg, bunArg, outArg, mode = 'pilot'] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outArg && ['pilot', 'formal'].includes(mode));
  const [beforeRoot, afterRoot, bun, out] = [beforeArg, afterArg, bunArg, outArg].map(p => resolve(p));
  assert.ok(!existsSync(out), 'Keep old recordings; choose a new output path');
  const before = identity(beforeRoot), after = identity(afterRoot);
  assert.equal(before.head, BASE);
  assert.deepEqual(Object.keys(before.source), Object.keys(after.source));
  assert.deepEqual(Object.keys(before.source).filter(p => before.source[p] !== after.source[p]), ['redux-checkpoint.ts']);
  const script = fileURLToPath(import.meta.url), neutral = mkdtempSync(resolve(tmpdir(), 'zerocopy-checkpoint-'));
  const data = { schema: 'zerocopy-checkpoint-base64/v1', mode, status: 'running', startedAt: new Date().toISOString(),
    before, after, driver: digest(readFileSync(script)),
    host: { arch: arch(), platform: platform(), release: release(), cpu: cpus()[0]?.model,
      affinity: readFileSync('/proc/self/status', 'utf8').split('\n').find(l => l.startsWith('Cpus_allowed_list:')) },
    method: { pairs: mode === 'formal' ? 6 : 2, cases: CASES, samples: 9, minimumWarmupMs: 500, minimumWarmupBatches: 8,
      order: 'balanced AB/BA; case order reversed each pair; one build per fresh process; identical import path',
      estimate: 'geometric mean paired ratios; unadjusted Student-t interval of log ratios, df5',
      timed: 'complete public operation including compaction, checksums, encoding, allocation, freezing; serialize includes JSON.stringify',
      excluded: 'imports, source construction, initial reference checkpoint, output verification, outer output array' }, runs: [], summary: [] };
  mkdirSync(dirname(out), { recursive: true });
  const save = () => { data.summary = summarize(data.runs, mode === 'formal'); writeFileSync(out, JSON.stringify(data, null, 2) + '\n'); };
  save();
  try {
    for (const runtime of ['node', 'bun']) for (let pair = 0; pair < data.method.pairs; pair++) {
      for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        for (const name of readdirSync(neutral)) rmSync(resolve(neutral, name), { recursive: true, force: true });
        const source = variant === 'before' ? beforeRoot : afterRoot;
        for (const name of Object.keys((variant === 'before' ? before : after).bundle)) cpSync(resolve(source, 'dist', name), resolve(neutral, name));
        const result = JSON.parse(execFileSync(runtime === 'node' ? process.execPath : bun,
          [script, '--subject', neutral, pair % 2 ? 'reverse' : 'forward'], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 }));
        assert.equal(result.runtime, runtime);
        data.runs.push({ pair, variant, ...result }); save();
        console.error(`${mode}: ${runtime} pair ${pair + 1}/${data.method.pairs} ${variant}, ${result.records.length} cases verified`);
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
