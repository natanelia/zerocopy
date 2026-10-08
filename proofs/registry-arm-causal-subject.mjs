/** One build per fresh process at one physical package path. No role or source path input. */
import assert from 'node:assert/strict';
import { applyGraphTreatment } from './graph.mjs';
import { Arena, arenaOf } from './internals.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { cpus, loadavg, platform, arch, release } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const request = JSON.parse(process.argv[2]);
const { operation, arenas: count, phase, iterations: fixedIterations, settings, treatment } = request;
assert.equal(operation, 'warmNestedRead');
assert(['native', 'materialized', 'materialized-released'].includes(treatment));
assert(['pilot', 'measure', 'correctness', 'census', 'trace'].includes(phase));
assert.equal(count, 512);
assert.equal(typeof globalThis.gc, 'function');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Synchronous JSONL preserves completed work even if a later batch crashes or
// the controller kills this process. Every write is outside the timed region.
const emit = event => writeSync(3, JSON.stringify(event) + '\n');
const setupStarted = performance.now();
const metadata = {
  date: new Date().toISOString(), pid: process.pid, executable: process.execPath, executableSha256: hash(readFileSync(process.execPath)),
  versions: process.versions, platform: platform(), arch: arch(), osRelease: release(), cpus: cpus(), loadavgBefore: loadavg(),
  execArgv: process.execArgv, cwd: process.cwd(), entryPath: fileURLToPath(new URL('./dist/shared.js', import.meta.url)),
  entrySha256: hash(readFileSync(new URL('./dist/shared.js', import.meta.url))), packageSha256: hash(readFileSync(new URL('./package.json', import.meta.url))),
  harnessSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
};
emit({ event: 'start', metadata, request });
const S = await import('./dist/shared.js');
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
const diagnostic = phase === 'census' ? await import('./census.mjs') : null;
const weak = diagnostic?.observeMaterializedMaps(Arena);
let graph;
try { graph = applyGraphTreatment(arenaOf(retained.root), treatment); }
finally { weak?.restore(); }
keepAlive.graph = graph.kept;
await setImmediate();
gc();
await setImmediate();
gc();
const memoryAfter = process.memoryUsage();
const weakMaps = weak?.afterGC(treatment) ?? null;
check(retained);
const census = diagnostic?.census({ Arena, arenaOf, retained, source, keys, kept: graph.kept }) ?? null;
const memory = Object.fromEntries(Object.keys(memoryBefore).map(key => [key, memoryAfter[key] - memoryBefore[key]]));

const setupElapsedMs = performance.now() - setupStarted;
emit({ event: 'setup', setupElapsedMs, dependencySets, traversedArenaValues, memoryBefore, memoryAfter, memory, graph: graph.summary, weakMaps, census });
// The three loop bodies are byte-for-byte copies of the historical kernels.
const actions = {
  attach: async iterations => {
    for (let i = 0; i < iterations; i++) { const current = await S.initWorker(data); sink += current.root.size; }
  },
  reexport: iterations => {
    for (let i = 0; i < iterations; i++) sink += S.getWorkerData(retained, { copy: false }).arenas.length;
  },
  warmNestedRead: iterations => {
    for (let i = 0; i < iterations; i++) sink += retained.root.get(keys[i % keys.length]).get('value');
  },
};
const action = actions[operation];
const calibration = [], warmup = [], measured = [];
async function batch(phase, index, iterations) {
  const mark = boundary => { if (request.phase === 'trace') writeSync(1, 'REGISTRY_TRACE ' + JSON.stringify({ boundary, phase, index, uptimeMs: process.uptime() * 1000, performanceNowMs: performance.now() }) + '\n'); };
  mark('before-pre-batch-gc');
  gc();
  mark('before-action');
  const start = performance.now(); await action(iterations);
  const elapsedMs = performance.now() - start;
  mark('after-action');
  assert(Number.isFinite(elapsedMs) && elapsedMs > 0);
  const row = { phase, index, iterations, elapsedMs, msPerOperation: elapsedMs / iterations, shortBatch: elapsedMs < settings.minimumBatchMs };
  emit({ event: 'batch', row });
  return row;
}
let iterations = fixedIterations;
if (phase === 'pilot') {
  iterations = settings.initialIterations;
  for (let index = 0; index < settings.pilotMaximumBatches; index++) {
    const row = await batch('pilot-calibration', index, iterations); calibration.push(row);
    if (row.elapsedMs >= settings.pilotTargetBatchMs || iterations >= settings.maximumIterations) break;
    iterations = Math.min(settings.maximumIterations, Math.max(iterations + 1, Math.ceil(iterations * Math.min(8, settings.pilotTargetBatchMs / Math.max(row.elapsedMs, 0.001)))));
  }
  // Record fixed-work pilot warmup before freezing the common count. These
  // discarded processes contribute no samples to the inferential estimate.
  for (let index = 0; index < settings.warmups; index++) warmup.push(await batch('pilot-warmup', index, iterations));
} else if (phase === 'measure' || phase === 'trace') {
  assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= settings.maximumIterations);
  for (let index = 0; index < settings.warmups + settings.samples; index++) {
    const kind = index < settings.warmups ? 'warmup' : 'sample';
    (kind === 'warmup' ? warmup : measured).push(await batch(kind, kind === 'warmup' ? index : index - settings.warmups, iterations));
  }
}
check(retained);
assert.equal(S.getWorkerData(retained, { copy: false }).arenas.length, count);
assert.throws(() => retained.root.get(keys[0]).set('value', -1), /read-only/);
const fastestPilotMsPerOperation = phase === 'pilot' ? Math.min(...warmup.map(row => row.msPerOperation)) : null;
const prescribedIterations = phase === 'pilot' ? Math.max(iterations, Math.ceil(settings.pilotTargetBatchMs / fastestPilotMsPerOperation)) : null;
const result = {
  metadata: { ...metadata, loadavgAfter: loadavg() }, request, operation, arenas: count, phase, setupElapsedMs,
  dependencySets, traversedArenaValues, graph: graph.summary, weakMaps, census, setupMemoryDelta: memory, setupMemoryBefore: memoryBefore, setupMemoryAfter: memoryAfter,
  iterations, calibration, warmup, measured, fastestPilotMsPerOperation, prescribedIterations,
  correctness: { checkedAllLeaves: leaves.length, nestedReadOnly: true, sharedReexportArenas: count }, sink,
};
emit({ event: 'result', result });
