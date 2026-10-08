/** Isolated-process worker attachment benchmark. Run with node --expose-gc.
 * Example: node --expose-gc proofs/worker-arena-benchmark.mjs /path/to/checkout 512
 * Timed attachment excludes producer construction, module import, copying, and GC.
 * Re-export uses shared memory; reads use already attached snapshots. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { capture, sha256 } from './worker-arena-source-guard.mjs';

const checkout = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
const count = Number(process.argv[3] ?? 512), samples = Number(process.env.SAMPLES ?? 7), warmups = Number(process.env.WARMUPS ?? 3);
assert(Number.isInteger(count) && count > 0);
assert(Number.isInteger(samples) && samples >= 3);
assert(Number.isInteger(warmups) && warmups >= 1);
const minimumBatchMs = Number(process.env.MIN_BATCH_MS ?? 10);
assert(Number.isFinite(minimumBatchMs) && minimumBatchMs > 0);
const targetBatchMs = minimumBatchMs * 3;
const guardPath = process.env.ARENA_SOURCE_GUARD;
const guardBytes = guardPath ? readFileSync(guardPath) : undefined;
const guard = guardBytes ? JSON.parse(guardBytes) : undefined;
const expected = guard && (process.env.ARENA_VARIANT === 'baseline' ? guard.baseline : guard.candidate);
const sourceState = capture(checkout, expected?.source.files.map(file => file.path));
if (guard) {
  assert.equal(guard.passed, true);
  assert.equal(sourceState.commit, expected.commit);
  assert.equal(sourceState.sourceDirty, false);
  assert.equal(sourceState.source.sha256, expected.source.sha256);
  assert.equal(sourceState.build.sha256, expected.build.sha256);
}
const S = await import(pathToFileURL(`${checkout}/dist/shared.js`));
const digest = paths => createHash('sha256').update(paths.sort().map(path => `${path}\0${createHash('sha256').update(readFileSync(`${checkout}/${path}`)).digest('hex')}`).join('\n')).digest('hex');
const sourcePaths = readdirSync(checkout).filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'));
const buildPaths = readdirSync(`${checkout}/dist`).filter(path => path.endsWith('.js')).map(path => `dist/${path}`);
const metadata = {
  commit: sourceState.commit, sourceDirty: sourceState.sourceDirty, sourceStatus: sourceState.sourceStatus,
  worktreeDirty: sourceState.worktreeDirty, worktreeStatus: sourceState.worktreeStatus,
  sourceGuardSha256: guardBytes ? sha256(guardBytes) : null,
  guardedSourceSha256: sourceState.source.sha256,
  sourceGuardEnforced: Boolean(guard),
  sourceGuardModuleSha256: sha256(readFileSync(fileURLToPath(new URL('./worker-arena-source-guard.mjs', import.meta.url)))),
  sourceSha256: digest(sourcePaths), buildSha256: digest(buildPaths),
  harnessSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  wasmSha256: createHash('sha256').update(readFileSync(`${checkout}/persistent-core.wasm`)).digest('hex'),
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version, versions: process.versions, cpu: cpus()[0]?.model,
  date: new Date().toISOString(), loadavg: loadavg(), pid: process.pid,
};

S.configureMemory({ maximumBytes: 131072 });
const leaves = [];
for (let i = 0; i < Math.max(1, count - 1); i++) {
  S.resetMap(); leaves.push(new S.SharedMap('number').set('value', i));
}
if (count > 1) {
  S.configureMemory({ maximumBytes: Math.max(131072, Math.ceil((65536 + count * 1024) / 65536) * 65536) });
  S.resetMap();
}
const root = new S.SharedMap('SharedMap<number>').setMany(leaves.map((leaf, i) => [`leaf${i}`, leaf]));
const source = { root }, data = S.getWorkerData(source, { copy: false });
assert.equal(data.arenas.length, count);
// Pin producers explicitly: V8 can drop otherwise dead locals across awaits.
const keepAlive = globalThis.__workerArenaBenchmark = { source, leaves, data };
const keys = leaves.map((_, i) => `leaf${i}`);
function check(attached) {
  let total = 0;
  for (let i = 0; i < keys.length; i++) total += attached.root.get(keys[i]).get('value');
  assert.equal(total, leaves.length * (leaves.length - 1) / 2);
  return total;
}
let sink = 0;
const isArena = value => value && typeof value.id === 'string' && value.memory instanceof WebAssembly.Memory;
let dependencySets = 0;
const set = Map.prototype.set;
Map.prototype.set = function (key, value) { if (isArena(value)) dependencySets++; return set.call(this, key, value); };
let probe;
try { probe = await S.initWorker(data); } finally { Map.prototype.set = set; }
check(probe);
let traversedArenaValues = 0;
const values = Map.prototype.values;
Map.prototype.values = function* () { for (const value of values.call(this)) { if (isArena(value)) traversedArenaValues++; yield value; } };
try { assert.equal(S.getWorkerData(probe, { copy: false }).arenas.length, count); }
finally { Map.prototype.values = values; }
probe = null;
// Let the prior async result leave the task before measuring another session.
await setImmediate();

function gc() { for (let i = 0; i < 3; i++) globalThis.gc?.(); }
gc();
await setImmediate();
gc();
const memoryBefore = process.memoryUsage();
let retained = keepAlive.reader = await S.initWorker(data);
await setImmediate();
gc();
await setImmediate();
gc();
const memoryAfter = process.memoryUsage();
check(retained);
const memory = Object.fromEntries(Object.keys(memoryBefore).map(key => [key, memoryAfter[key] - memoryBefore[key]]));
const attachIterations = count <= 2 ? 64 : count <= 64 ? 16 : 2;
const exportIterations = count <= 2 ? 5000 : count <= 64 ? 500 : 32;
const readIterations = 100000;
function batch(phase, index, iterations, elapsedMs) {
  return { phase, index, iterations, elapsedMs, msPerOperation: elapsedMs / iterations, shortBatch: elapsedMs < minimumBatchMs };
}
async function measure(name, initialIterations, maximumIterations, action) {
  const calibration = [], warmup = [], measured = [];
  let iterations = initialIterations;
  for (let index = 0; index < 8; index++) {
    gc();
    const start = performance.now(); await action(iterations);
    const elapsedMs = performance.now() - start;
    calibration.push(batch('calibration', index, iterations, elapsedMs));
    if (elapsedMs >= targetBatchMs || iterations >= maximumIterations) break;
    iterations = Math.min(maximumIterations, Math.max(iterations + 1, Math.ceil(iterations * Math.min(8, targetBatchMs / Math.max(elapsedMs, 0.001)))));
  }
  for (let index = 0; index < warmups + samples; index++) {
    gc();
    const start = performance.now(); await action(iterations);
    const elapsedMs = performance.now() - start;
    const phase = index < warmups ? 'warmup' : 'sample';
    (phase === 'warmup' ? warmup : measured).push(batch(phase, index < warmups ? index : index - warmups, iterations, elapsedMs));
  }
  return {
    name, timingUse: 'throughput-comparison', initialIterations, iterations, maximumIterations,
    effectiveSamples: measured.length, effectiveWarmups: warmup.length, minimumBatchMs, targetBatchMs,
    calibration, warmup, measured, shortBatchCount: [...warmup, ...measured].filter(row => row.shortBatch).length,
    samples: measured.map(row => row.msPerOperation),
  };
}
const rows = [];
if (process.env.MODE !== 'memory') {
  rows.push(await measure('attach', attachIterations, Math.max(2, Math.floor(8192 / count)), async iterations => {
    for (let i = 0; i < iterations; i++) { const current = await S.initWorker(data); sink += current.root.size; }
  }));
  rows.push(await measure('reexport', exportIterations, 1000000, iterations => {
    for (let i = 0; i < iterations; i++) sink += S.getWorkerData(retained, { copy: false }).arenas.length;
  }));
  check(retained);
  rows.push(await measure('warmNestedRead', readIterations, 10000000, iterations => {
    for (let i = 0; i < iterations; i++) sink += retained.root.get(keys[i % keys.length]).get('value');
  }));
  // A bounded number of distinct records per new attachment cannot form a long
  // throughput batch. Keep cold reads diagnostic-only, regardless of medians.
  const warmup = [], measured = [], iterations = Math.min(keys.length, 64);
  for (let index = 0; index < samples + warmups; index++) {
    const current = await S.initWorker(data);
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sink += current.root.get(keys[i]).get('value');
    const elapsedMs = performance.now() - start, phase = index < warmups ? 'warmup' : 'sample';
    (phase === 'warmup' ? warmup : measured).push(batch(phase, index < warmups ? index : index - warmups, iterations, elapsedMs));
  }
  rows.push({
    name: 'coldNestedRead', timingUse: 'diagnostic-only',
    limitation: 'Only 1–64 distinct cold nested records per fresh attachment; short timer-sensitive batches cannot establish equivalence or non-regression.',
    iterations, effectiveSamples: measured.length, effectiveWarmups: warmup.length, minimumBatchMs,
    warmup, measured, shortBatchCount: [...warmup, ...measured].filter(row => row.shortBatch).length,
    samples: measured.map(row => row.msPerOperation),
  });
}
console.log(JSON.stringify({
  metadata, arenas: count,
  configuration: { samples, warmups, minimumBatchMs, targetBatchMs, transport: 'shared', explicitGcAvailable: typeof globalThis.gc === 'function', mode: process.env.MODE ?? 'timing-and-memory' },
  dependencySets, traversedArenaValues,
  counterScope: { dependencySets: 'Map.set calls whose value is an Arena, including the payload lookup', traversedArenaValues: 'Map.values yields whose value is an Arena, including final output traversal; excludes direct closed-registry array indexing' },
  memory: { scope: 'one retained attachment after GC; producers and shared payload buffers explicitly pinned', ...memory }, rows, sink,
}));
