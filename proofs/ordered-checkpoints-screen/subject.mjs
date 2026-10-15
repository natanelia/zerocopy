/** Fixed ordered-checkpoint screen. No library import occurs in probe mode. */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const CASES = ['P', 'E0', 'F128', 'F513', 'F100k', 'D100k', 'O32k'];
const COUNTS = { P: 100000, E0: 0, F128: 128, F513: 513, F100k: 100000, D100k: 12500, O32k: 32768 };
const SMALL = new Set(['E0', 'F128', 'F513']);
const LADDER = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536];
const FNV = 2166136261;
const FIELDS = ['heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'rss', 'arenaUsedBytes', 'arenaCapacityBytes'];
const JSC_FIELDS = ['heapSize', 'heapCapacity', 'extraMemorySize'];
export function require(value, message) { if (!value) throw new Error(message); }
export function keyOf(index) { return 'event:' + String(index).padStart(6, '0'); }
function startIndex(id) { return id === 'D100k' ? 87500 : 0; }
function valueOf(id, index) {
  if (id === 'O32k') return { id: index, group: index % 32, active: true };
  if ((id === 'F128' || id === 'F513') && index % 4 === 0) return index + 1000000;
  if (id === 'F100k' && index % 16 === 0) return index + 1000000;
  return index;
}
function token(key, value, objects) {
  return key.length + key.charCodeAt(key.length - 1) +
    (objects ? value.id + value.group + (value.active === true ? 1 : 0) : value);
}
export function oracle(id) {
  require(Object.hasOwn(COUNTS, id), 'unknown fixture');
  let hash = FNV;
  for (let index = startIndex(id); index < startIndex(id) + COUNTS[id]; index++) {
    hash = Math.imul(hash ^ token(keyOf(index), valueOf(id, index), id === 'O32k'), 16777619) >>> 0;
  }
  const firstIndex = startIndex(id);
  const first = COUNTS[id] ? token(keyOf(firstIndex), valueOf(id, firstIndex), id === 'O32k') : 1;
  return { count: COUNTS[id], hash, first };
}
function checkPair(id, pair, index) {
  require(Array.isArray(pair) && pair.length === 2 && pair[0] === keyOf(index), id + ' key/order mismatch');
  if (id === 'O32k') {
    const value = pair[1];
    require(value && value.id === index && value.group === index % 32 && value.active === true &&
      Object.keys(value).length === 3, id + ' object mismatch');
  } else require(pair[1] === valueOf(id, index), id + ' value mismatch');
}
function checkFirst(id, result) {
  if (id === 'E0') require(result.done === true, 'empty first result');
  else { require(result.done === false, id + ' missing first result'); checkPair(id, result.value, startIndex(id)); }
}
export function validateCase(map, id) {
  let index = startIndex(id), count = 0;
  require(map.size === COUNTS[id], id + ' size mismatch');
  for (const pair of map.entries()) { checkPair(id, pair, index++); count++; }
  require(count === COUNTS[id], id + ' yielded count mismatch');
}

/** The only timed library loops. Checks/output/GC are outside clock brackets. */
export function chunk(map, id, endpoint, k, expected, now) {
  require(Number.isSafeInteger(k) && k > 0, 'invalid K');
  let milliseconds = 0, checksum = 0, count = 0;
  const objects = id === 'O32k';
  if (endpoint === 'first' && !SMALL.has(id)) {
    for (let repeat = 0; repeat < k; repeat++) {
      let iterator = map.entries();
      const before = now();
      let result = iterator.next();
      const after = now();
      require(after >= before, 'clock reversed');
      milliseconds += after - before;
      checkFirst(id, result);
      checksum = (checksum + token(result.value[0], result.value[1], objects)) >>> 0;
      count++;
      result = null;
      iterator.return();
      iterator = null;
    }
  } else if (endpoint === 'first') {
    const before = now();
    for (let repeat = 0; repeat < k; repeat++) {
      const iterator = map.entries();
      const result = iterator.next();
      checksum = (checksum + (result.done ? 1 : token(result.value[0], result.value[1], objects))) >>> 0;
      count += result.done ? 0 : 1;
      iterator.return();
    }
    const after = now();
    require(after >= before, 'clock reversed');
    milliseconds = after - before;
  } else {
    require(endpoint === 'full', 'unknown endpoint');
    const before = now();
    for (let repeat = 0; repeat < k; repeat++) {
      let hash = FNV;
      for (const [key, value] of map.entries()) {
        hash = Math.imul(hash ^ token(key, value, objects), 16777619) >>> 0;
        count++;
      }
      checksum = (checksum + hash) >>> 0;
    }
    const after = now();
    require(after >= before, 'clock reversed');
    milliseconds = after - before;
  }
  const wanted = endpoint === 'full' ? expected.hash : expected.first;
  require(checksum === (Math.imul(wanted, k) >>> 0), id + ':' + endpoint + ' checksum mismatch');
  require(count === k * (endpoint === 'full' ? expected.count : Math.min(expected.count, 1)), 'timed count mismatch');
  require(Number.isFinite(milliseconds) && milliseconds >= 0, 'invalid duration');
  return { milliseconds, checksum, yieldedCount: count };
}

function clockDiagnostics(now) {
  let previous = now(), resolution = Infinity, overhead = 0;
  for (let i = 0; i < 16384; i++) {
    const before = now(), after = now();
    require(before >= previous && after >= before, 'nonmonotonic clock');
    const gap = before - previous, elapsed = after - before;
    if (gap > 0) resolution = Math.min(resolution, gap);
    if (elapsed > 0) resolution = Math.min(resolution, elapsed);
    overhead += elapsed;
    previous = after;
  }
  require(Number.isFinite(resolution) && resolution > 0, 'unresolved clock resolution');
  return { resolutionMs: resolution, overheadMs: overhead / 16384 };
}

async function instrumentation(engine) {
  const bun = typeof Bun !== 'undefined';
  require(engine === (bun ? 'bun' : 'node'), 'wrong engine');
  require(bun ? Bun.version === '1.4.2' : process.version === 'v22.16.0', 'wrong engine version');
  require(typeof performance.now === 'function', 'missing timer');
  require(bun ? typeof Bun.gc === 'function' : typeof globalThis.gc === 'function', 'missing synchronous GC');
  const heapStats = bun ? (await import('bun:jsc')).heapStats : null;
  require(!bun || typeof heapStats === 'function', 'missing JSC heapStats');
  const fields = bun ? [...FIELDS, ...JSC_FIELDS] : [...FIELDS];
  const gc = bun ? () => Bun.gc(true) : () => globalThis.gc();
  const now = performance.now.bind(performance);
  function sampleInto(target, arenas) {
    let state = process.memoryUsage();
    for (let i = 0; i < 5; i++) {
      require(Number.isFinite(state[FIELDS[i]]) && state[FIELDS[i]] >= 0, 'invalid memory API field ' + FIELDS[i]);
      target[i] = state[FIELDS[i]];
    }
    state = null;
    let used = 0, capacity = 0;
    for (let i = 0; i < arenas.length; i++) { used += arenas[i].used; capacity += arenas[i].memory.buffer.byteLength; }
    target[5] = used; target[6] = capacity;
    if (heapStats) {
      let jsc = heapStats();
      for (let i = 0; i < 3; i++) {
        require(Number.isFinite(jsc[JSC_FIELDS[i]]) && jsc[JSC_FIELDS[i]] >= 0, 'invalid JSC field ' + JSC_FIELDS[i]);
        target[7 + i] = jsc[JSC_FIELDS[i]];
      }
      jsc = null;
    }
  }
  async function collect() { for (let i = 0; i < 4; i++) { await new Promise(setImmediate); gc(); } }
  function record(row) { return Object.fromEntries(fields.map((field, index) => [field, row[index]])); }
  return { fields, gc, now, sampleInto, collect, record, primaryIndex: bun ? 7 : 0 };
}

async function build(S) {
  let writes = 0;
  function numeric(n) {
    let map = new S.SharedOrderedMap('number');
    for (let i = 0; i < n; i++) { map = map.set(keyOf(i), i); writes++; }
    return map;
  }
  S.resetOrderedMap();
  let P = numeric(100000), F100k = P, D100k = P;
  for (let i = 0; i < 100000; i += 16) { F100k = F100k.set(keyOf(i), i + 1000000); writes++; }
  for (let i = 0; i < 87500; i++) { D100k = D100k.delete(keyOf(i)); writes++; }
  S.resetOrderedMap(); let E0 = numeric(0);
  S.resetOrderedMap(); let F128 = numeric(128);
  for (let i = 0; i < 128; i += 4) { F128 = F128.set(keyOf(i), i + 1000000); writes++; }
  S.resetOrderedMap(); let F513 = numeric(513);
  for (let i = 0; i < 513; i += 4) { F513 = F513.set(keyOf(i), i + 1000000); writes++; }
  S.resetOrderedMap(); let O32k = new S.SharedOrderedMap(S.json());
  for (let i = 0; i < 32768; i++) { O32k = O32k.set(keyOf(i), { id: i, group: i % 32, active: true }); writes++; }
  require(writes === 227320, 'construction operation count');
  let owners = { P, E0, F128, F513, F100k, D100k, O32k };
  let wire = S.getWorkerData(owners, { copy: false });
  require(wire.arenas.length === 5, 'expected five arenas');
  require(wire.arenas.every(row => row.memory instanceof WebAssembly.Memory && row.memory.buffer instanceof SharedArrayBuffer && !row.copy), 'copy fallback');
  require(new Set(wire.arenas.map(row => row.memory)).size === 5, 'duplicate memory descriptor');
  const arenas = wire.arenas.map(row => ({ id: row.id, used: row.used, memory: row.memory }));
  const maps = await S.initWorker(wire);
  for (const id of CASES) {
    require(Object.isFrozen(maps[id]) && maps[id] instanceof S.SharedOrderedMap, 'not genuine frozen attachment');
    // Diagnostic only: no setter, cache manipulation or extra public write call.
    require(maps[id].arena.readOnly === true, 'attachment is not read-only');
  }
  // No owner, input descriptor or intermediate snapshot survives this function.
  P = F100k = D100k = E0 = F128 = F513 = O32k = owners = wire = null;
  return { maps, arenas, writes };
}
function arenaState(S, maps, arenas) {
  const wire = S.getWorkerData(maps, { copy: false });
  require(wire.arenas.length === 5, 'arena count changed');
  const rows = wire.arenas.map(row => {
    const original = arenas.find(item => item.id === row.id);
    require(original && row.memory === original.memory && row.used === original.used && !row.copy, 'arena identity/used changed');
    return { id: row.id, used: row.used, capacity: row.memory.buffer.byteLength };
  });
  return { rows, used: rows.reduce((sum, row) => sum + row.used, 0), capacity: rows.reduce((sum, row) => sum + row.capacity, 0) };
}

async function memoryCycles(map, arenas, instrument) {
  const { fields, collect, sampleInto, record, primaryIndex } = instrument;
  // All small result storage exists before the first barrier; only numbers persist.
  const rows = Array.from({ length: 6 }, () => new Float64Array(fields.length));
  const resumed = [false, false];
  for (let touch = 0; touch < 2; touch++) {
    let iterator = map.entries(), result = iterator.next();
    checkFirst('P', result); result = null; iterator.return(); iterator = null;
  }
  for (let cycle = 0; cycle < 2; cycle++) {
    await collect(); sampleInto(rows[cycle * 3], arenas);
    let iterator = map.entries();
    let result = iterator.next();
    checkFirst('P', result); result = null;
    await collect(); sampleInto(rows[cycle * 3 + 1], arenas);
    result = iterator.next();
    require(result.done === false, 'paused iterator lost continuation');
    checkPair('P', result.value, 1); resumed[cycle] = true; result = null;
    iterator.return(); iterator = null;
    await collect(); sampleInto(rows[cycle * 3 + 2], arenas);
  }
  const cycles = [0, 1].map(cycle => ({ before: record(rows[3 * cycle]), paused: record(rows[3 * cycle + 1]),
    released: record(rows[3 * cycle + 2]), resumed_ok: resumed[cycle] }));
  const valid = [0, 1].every(cycle => Math.abs(rows[3 * cycle + 2][primaryIndex] - rows[3 * cycle][primaryIndex]) <= 65536);
  return { eligible: valid, invalid_reasons: valid ? [] : ['release drift exceeds 64 KiB'], cycles };
}

async function probe(instrument, engine) {
  const { fields, collect, sampleInto, record, primaryIndex, now } = instrument;
  const clock = clockDiagnostics(now), records = [];
  const length = 8 * 1024 * 1024;
  function touchBytes(view) { for (let i = 0; i < view.length; i += 4096) view[i] = 1; }
  function touched(view) { let sum = 0; for (let i = 0; i < view.length; i += 4096) sum += view[i]; return sum === length / 4096; }
  for (const kind of ['arrayBuffer', 'typedArray', 'sharedWasm', 'objects']) {
    const rows = Array.from({ length: 3 }, () => new Float64Array(fields.length));
    let held = null;
    await collect(); sampleInto(rows[0], []);
    if (kind === 'arrayBuffer') { held = new ArrayBuffer(length); touchBytes(new Uint8Array(held)); }
    else if (kind === 'typedArray') { held = new Uint8Array(length); touchBytes(held); }
    else if (kind === 'sharedWasm') { held = new WebAssembly.Memory({ initial: 128, maximum: 128, shared: true }); touchBytes(new Uint8Array(held.buffer)); }
    else { held = Array.from({ length: 131072 }, (_, index) => ({ index, active: true })); }
    await collect(); sampleInto(rows[1], []);
    if (kind === 'arrayBuffer') require(held.byteLength === length && touched(new Uint8Array(held)), 'ArrayBuffer probe lost contents');
    else if (kind === 'typedArray') require(held.byteLength === length && touched(held), 'typed array probe lost contents'); // Never expose .buffer.
    else if (kind === 'sharedWasm') require(held.buffer instanceof SharedArrayBuffer && held.buffer.byteLength === length && touched(new Uint8Array(held.buffer)), 'shared WASM probe lost contents');
    else require(held.length === 131072 && held.every((value, index) => value.index === index && value.active === true), 'object probe lost contents');
    held = null;
    await collect(); sampleInto(rows[2], []);
    const primaryIncrement = rows[1][primaryIndex] - rows[0][primaryIndex];
    // No numeric substitution. Shared WASM's explicit 8 MiB capacity is authoritative;
    // runtime heap buckets need not count it. Owned heap objects must be visible/releasable.
    if (kind === 'objects') require(primaryIncrement > 0 && rows[2][primaryIndex] < rows[1][primaryIndex], 'unaccountable object heap response');
    if (kind === 'arrayBuffer' || kind === 'typedArray') {
      require(engine === 'bun' ? primaryIncrement > 0 : rows[1][2] > rows[0][2] || rows[1][3] > rows[0][3], 'unaccountable owned buffer response');
    }
    records.push({ kind, expectedBytes: kind === 'objects' ? null : length, objectCount: kind === 'objects' ? 131072 : null,
      before: record(rows[0]), retained: record(rows[1]), released: record(rows[2]) });
  }
  return { mode: 'probe', engine, accountable: true, clock_resolution_ms: clock.resolutionMs,
    overhead_ms_per_call: clock.overheadMs, records };
}

export function resolutionOK(id, endpoint, k, durations, resolution) {
  const isolated = endpoint === 'first' && !SMALL.has(id);
  return resolution > 0 && durations.every(duration => {
    const bracket = isolated ? duration / k : duration;
    return bracket > 0 && resolution <= 0.005 * bracket;
  });
}
function overheadOK(id, endpoint, k, duration, overhead) {
  return endpoint !== 'first' || SMALL.has(id) || overhead <= 0.005 * (duration / k);
}

export async function main(job) {
  require(job.schema === 1 && typeof job.jobId === 'string', 'bad job input');
  const emit = row => process.stdout.write(JSON.stringify({ schema: 1, jobId: job.jobId, ...row }) + '\n');
  const phase = (name, extra = {}) => emit({ event: 'phase', phase: name, ...extra });
  phase(job.mode === 'probe' ? 'probe' : 'setup');
  const instrument = await instrumentation(job.engine);
  if (job.mode === 'probe') {
    require(job.entrypoint === null, 'probe must have no library entry');
    emit({ event: 'result', result: await probe(instrument, job.engine) });
    return;
  }
  require(job.mode === 'calibration' || job.mode === 'comparison', 'bad mode');
  require(job.mode !== 'calibration' || job.arm === 'baseline', 'candidate calibration forbidden');
  require(Array.isArray(job.caseOrder) && job.caseOrder.length === 7 && new Set(job.caseOrder).size === 7 && job.caseOrder.every(id => CASES.includes(id)), 'bad case order');
  require(job.endpointOrder.join(',') === 'first,full' || job.endpointOrder.join(',') === 'full,first', 'bad endpoint order');
  const S = await import(pathToFileURL(job.entrypoint).href);
  const { maps, arenas, writes } = await build(S);
  const beforeArena = arenaState(S, maps, arenas);
  const expected = Object.fromEntries(CASES.map(id => [id, oracle(id)]));
  const clock = clockDiagnostics(instrument.now);
  const admission = { postFixtureRssBytes: process.memoryUsage().rss, uniqueArenaCapacityBytes: beforeArena.capacity,
    uniqueArenaUsedBytes: beforeArena.used };
  require(admission.postFixtureRssBytes <= 1073741824 && beforeArena.capacity <= 536870912, 'measurement admission limit');
  let memory = null;
  if (job.mode === 'comparison') {
    phase('memory', admission);
    memory = await memoryCycles(maps.P, arenas, instrument);
    // Memory results are emitted only after both cycles released every iterator.
    emit({ event: 'memory', memory });
    phase('latency');
  }
  for (const id of job.caseOrder) { validateCase(maps[id], id); validateCase(maps[id], id); }
  if (job.mode === 'calibration') {
    // Baseline setup includes complete validation/cache establishment.
    admission.postFixtureRssBytes = process.memoryUsage().rss;
    require(admission.postFixtureRssBytes <= 1073741824, 'calibration admission RSS limit');
    phase('calibration', admission);
  }
  const endpoints = {}, calibration = {};
  for (const id of job.caseOrder) {
    calibration[id] = {};
    for (const endpoint of job.endpointOrder) {
      if (job.mode === 'calibration') {
        const ladder = SMALL.has(id) ? [...LADDER, 262144, 1048576] : LADDER;
        const observed = [];
        let k = ladder[ladder.length - 1];
        for (const rung of ladder) {
          const result = chunk(maps[id], id, endpoint, rung, expected[id], instrument.now);
          observed.push({ k: rung, milliseconds: result.milliseconds });
          emit({ event: 'calibration-chunk', case: id, endpoint, kind: 'ladder', k: rung, ...result });
          if (result.milliseconds >= 20) { k = rung; break; }
        }
        const verification = [];
        for (let index = 0; index < 3; index++) {
          const result = chunk(maps[id], id, endpoint, k, expected[id], instrument.now);
          verification.push(result.milliseconds);
          emit({ event: 'calibration-chunk', case: id, endpoint, kind: 'verification', index, k, ...result });
        }
        const average = verification.reduce((sum, value) => sum + value, 0) / 3;
        calibration[id][endpoint] = { k, resolved: average >= 5 && resolutionOK(id, endpoint, k, verification, clock.resolutionMs) &&
          overheadOK(id, endpoint, k, average, clock.overheadMs),
          verification_ms: verification, ladder: observed, clock_resolution_ms: clock.resolutionMs, overhead_ms_per_call: clock.overheadMs };
      } else {
        const frozen = job.calibration?.[id]?.[endpoint];
        require(frozen && Number.isSafeInteger(frozen.k) && (SMALL.has(id) ? [...LADDER, 262144, 1048576] : LADDER).includes(frozen.k), 'missing frozen baseline K');
        const k = frozen.k, warmup = [], measured = [];
        for (let index = 0; index < 10; index++) {
          const result = chunk(maps[id], id, endpoint, k, expected[id], instrument.now);
          (index < 4 ? warmup : measured).push(result.milliseconds);
          emit({ event: 'sample', case: id, endpoint, kind: index < 4 ? 'warmup' : 'measured', index: index < 4 ? index : index - 4, k, ...result });
        }
        const mean = measured.reduce((sum, value) => sum + value, 0) / 6;
        const clockOK = resolutionOK(id, endpoint, k, [...warmup, ...measured], clock.resolutionMs) &&
          overheadOK(id, endpoint, k, mean, clock.overheadMs);
        const valid = frozen.resolved === true && clockOK;
        endpoints[id + ':' + endpoint] = { eligible: valid, invalid_reasons: valid ? [] : ['baseline calibration or timer resolution unresolved'],
          k, warmup_ms: warmup, measured_ms: measured, clock_ok: clockOK, checksum_ok: true,
          overhead_ms_per_call: clock.overheadMs, clock_resolution_ms: clock.resolutionMs };
      }
    }
  }
  phase('final');
  const afterArena = arenaState(S, maps, arenas);
  require(JSON.stringify(beforeArena) === JSON.stringify(afterArena), 'backing changed during experiment');
  const metadata = Object.fromEntries(CASES.map(id => [id, maps[id].toWorkerData()]));
  const common = { engine: job.engine, arm: job.arm, mode: job.mode, writes, arenaBefore: beforeArena, arenaAfter: afterArena,
    fixtures: metadata, identity_ok: true, oracle_ok: true, backing_ok: true, eligible: true, invalid_reasons: [] };
  emit({ event: 'result', result: job.mode === 'calibration' ? { ...common, calibration } : { ...common, pair: job.pairIndex, endpoints, memory } });
  if (job.mode === 'comparison') phase('exit');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  await main(job);
}
