/** Isolated retained-memory comparison. Run with node --expose-gc. */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Map as ImmutableMap, OrderedMap as ImmutableOrderedMap, List as ImmutableList, Stack as ImmutableStack } from 'immutable';
import * as S from '../dist/shared.js';

const definitions = {
  Map: { C: S.SharedMap, I: ImmutableMap, reset: S.resetMap, map: true },
  List: { C: S.SharedList, I: ImmutableList, reset: S.resetSharedList, map: false },
  Stack: { C: S.SharedStack, I: ImmutableStack, reset: S.resetStack, map: false },
  OrderedMap: { C: S.SharedOrderedMap, I: ImmutableOrderedMap, reset: S.resetOrderedMap, map: true },
};
const method = 'Post-GC incremental V8 heapUsed plus live backing-buffer bytes, including read caches. Not RSS or peak memory. Initialized libraries and empty default arenas are outside the heap baseline. The full current backing buffer is included for Shared.';
async function collect() { for (let i = 0; i < 4; i++) { await new Promise(setImmediate); global.gc(); } }
function build(name, kind, n) {
  const d = definitions[name];
  let value = kind === 'shared' ? new d.C(d.map ? 'string' : 'number') : kind === 'immutable' ? d.I() : d.map ? new Map() : [];
  for (let i = 0; i < n; i++) {
    if (d.map) value = value.set(`key${i}`, `val${i}`);
    else if (kind === 'native') value.push(i); else value = value.push(i);
  }
  return value;
}
function warmAndCheck(name, kind, value, n) {
  const d = definitions[name]; let sum = 0;
  if (d.map) {
    assert.equal(value.size, n);
    for (let i = 0; i < n; i++) { const text = value.get(`key${i}`); assert.equal(text, `val${i}`); sum += text.length; }
  } else if (name === 'List') {
    assert.equal(kind === 'native' ? value.length : value.size, n);
    for (let i = 0; i < n; i++) { const v = kind === 'native' ? value[i] : value.get(i); assert.equal(v, i); sum += v; }
  } else {
    assert.equal(kind === 'native' ? value.length : value.size, n);
    if (kind === 'native') { for (let i = n - 1; i >= 0; i--) sum += value[i]; }
    else { let cursor = value; for (let i = n - 1; i >= 0; i--) { assert.equal(cursor.peek(), i); sum += cursor.peek(); cursor = cursor.pop(); } }
  }
  return sum;
}
function backingBytes(value) {
  // Diagnostic access only. All heap allocations, including the wrapper objects,
  // are measured by V8. Explicit enumeration adds off-heap bytes once.
  const arena = value.arena;
  assert(arena?.memory instanceof WebAssembly.Memory);
  arena.refresh();
  const arenas = new Set(), buffers = new Set(), seen = new Set();
  const pendingArenas = [arena];
  let wasmBytes = 0, auxiliaryBytes = 0, allocatedBytes = 0;
  while (pendingArenas.length) {
    const a = pendingArenas.pop(); if (arenas.has(a)) continue; arenas.add(a);
    const backing = a.memory.buffer; wasmBytes += backing.byteLength; allocatedBytes += a.used - 65536; buffers.add(backing);
    // Old shared views after memory.grow refer to the same physical backing.
    for (const item of Object.values(a)) {
      if (item instanceof SharedArrayBuffer) buffers.add(item);
      if (ArrayBuffer.isView(item) && item.buffer instanceof SharedArrayBuffer) buffers.add(item.buffer);
    }
    for (const dependency of a.dependencies.values()) pendingArenas.push(dependency);
  }
  const pending = [...arenas];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof WebAssembly.Memory) continue;
    if (item instanceof ArrayBuffer || item instanceof SharedArrayBuffer) {
      if (!buffers.has(item)) { buffers.add(item); auxiliaryBytes += item.byteLength; } continue;
    }
    if (ArrayBuffer.isView(item)) { pending.push(item.buffer); continue; }
    if (item instanceof Map || item instanceof Set) { for (const child of item.values()) pending.push(child); continue; }
    for (const child of Object.values(item)) pending.push(child);
  }
  return { wasmBytes, auxiliaryBytes, allocatedBytes, total: wasmBytes + auxiliaryBytes };
}
async function measure(name, kind, state, n) {
  assert.equal(typeof global.gc, 'function', 'Run Node with --expose-gc');
  assert(definitions[name] && ['shared', 'immutable', 'native'].includes(kind));
  // Exercise code and force imports before the heap baseline. Release warm-up data.
  let warm = build(name, kind, 256); warmAndCheck(name, kind, warm, 256); warm = undefined;
  definitions[name].reset(); await collect();
  const before = process.memoryUsage();
  let result = build(name, kind, n);
  let history;
  if (state === 'history') {
    assert(definitions[name].map);
    history = [result];
    for (let i = 0; i < 31; i++) { result = kind === 'native' ? new Map(result) : result; result = result.set('key0', `version${i}`); history.push(result); }
    for (let i = 0; i < history.length; i++) assert.equal(history[i].get('key0'), i === 0 ? 'val0' : `version${i - 1}`);
  } else {
    if (state === 'compact' && kind === 'shared') { result = S.compact(result); definitions[name].reset(); }
    warmAndCheck(name, kind, result, n);
  }
  globalThis.__memoryEvidenceHolder = history ?? result;
  await collect();
  const after = process.memoryUsage();
  const binary = kind === 'shared' ? backingBytes(result) : { wasmBytes: 0, auxiliaryBytes: 0, allocatedBytes: null, total: 0 };
  const heapDelta = after.heapUsed - before.heapUsed;
  assert(heapDelta > 0, 'Heap delta is non-positive; increase the workload rather than publishing a misleading ratio');
  return { name, kind, state, n, retainedVersions: history?.length ?? 1, before, after, heapDelta, binary, retainedBytes: heapDelta + binary.total };
}
if (process.argv[2] === '--case') {
  const [name, kind, state, count] = process.argv.slice(3);
  console.log(JSON.stringify(await measure(name, kind, state, Number(count))));
} else {
  const trials = Number(process.env.MEMORY_TRIALS ?? 3);
  assert(Number.isInteger(trials) && trials >= 3 && trials <= 10);
  const cases = [];
  for (const n of [10000, 100000]) for (const name of Object.keys(definitions)) cases.push({ name, n, state: 'warm' });
  for (const name of ['Map', 'OrderedMap']) cases.push({ name, n: 10000, state: 'compact' }, { name, n: 10000, state: 'history' });
  const samples = [];
  for (let trial = 0; trial < trials; trial++) for (const test of cases) {
    const kinds = ['shared', 'immutable', 'native'];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[(i + trial) % kinds.length];
      const run = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--case', test.name, kind, test.state, String(test.n)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (run.status !== 0) throw new Error(`${test.name}/${kind}/${test.state}: ${run.stderr}\n${run.stdout}`);
      samples.push({ trial: trial + 1, ...JSON.parse(run.stdout) });
    }
    console.error(`memory ${trial + 1}: ${test.name} ${test.n} ${test.state}`);
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = cases.map(test => {
    const get = kind => median(samples.filter(r => r.name === test.name && r.kind === kind && r.n === test.n && r.state === test.state).map(r => r.retainedBytes));
    return { ...test, shared: get('shared'), immutable: get('immutable'), native: get('native') };
  });
  const output = process.argv[2] ?? 'proofs/results/library-memory.json';
  mkdirSync(new URL('results/', import.meta.url), { recursive: true });
  const bundleFiles = readdirSync(new URL('../dist/', import.meta.url)).filter(name => name.endsWith('.js')).sort();
  const bundleHash = createHash('sha256');
  for (const name of bundleFiles) bundleHash.update(name + '\0').update(readFileSync(new URL('../dist/' + name, import.meta.url))).update('\0');
  const result = { schema: 1, method, measuredAt: new Date().toISOString(), runtime: process.version, cpu: cpus()[0].model, platform: process.platform, arch: process.arch, trials,
    driverSHA256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    immutable: JSON.parse(readFileSync(new URL('../node_modules/immutable/package.json', import.meta.url))).version,
    bundleFiles, bundleSHA256: bundleHash.digest('hex'), summary, samples };
  writeFileSync(output, JSON.stringify(result) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
