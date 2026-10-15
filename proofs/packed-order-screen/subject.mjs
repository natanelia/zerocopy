/** Prospective packed ordered-pointer screen. No library import occurs in probe mode. */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const CASES = ['P', 'E0', 'F128', 'F513', 'F100k', 'D100k', 'O32k'];
export const MEMORY_CASES = ['E0', 'N1', 'N32', 'N4096', 'N4097', 'N8192', 'N8193', 'P'];
export const CLOSE_CASES = ['N4096', 'N4097', 'N8193', 'P'];
const SNAPSHOT_SIZES = [1, 32, 4096, 4097, 8192, 8193];
const ALL_CASES = [...CASES, ...MEMORY_CASES.filter(id => !CASES.includes(id))];
const COUNTS = { N1: 1, N32: 32, N4096: 4096, N4097: 4097, N8192: 8192, N8193: 8193, P: 100000, E0: 0, F128: 128, F513: 513, F100k: 100000, D100k: 12500, O32k: 32768 };
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
  } else if (endpoint === 'first' || endpoint === 'close') {
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
  return { fields, gc, now, sampleInto, collect, record, primaryIndex: bun ? 7 : 0, engine }; 
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
  S.resetOrderedMap(); let stable = new S.SharedOrderedMap('number'), snapshots = {};
  for (let index = 0; index < 8193; index++) {
    stable = stable.set(keyOf(index), index); writes++;
    if (SNAPSHOT_SIZES.includes(index + 1)) snapshots['N' + (index + 1)] = stable;
  }
  require(writes === 235513, 'construction operation count');
  let owners = { P, E0, F128, F513, F100k, D100k, O32k, ...snapshots };
  let wire = S.getWorkerData(owners, { copy: false });
  require(wire.arenas.length === 6, 'expected six arenas');
  require(wire.arenas.every(row => row.memory instanceof WebAssembly.Memory && row.memory.buffer instanceof SharedArrayBuffer && !row.copy), 'copy fallback');
  require(new Set(wire.arenas.map(row => row.memory)).size === 6, 'duplicate memory descriptor');
  const arenas = wire.arenas.map(row => ({ id: row.id, used: row.used, memory: row.memory }));
  const maps = await S.initWorker(wire);
  for (const id of ALL_CASES) {
    require(Object.isFrozen(maps[id]) && maps[id] instanceof S.SharedOrderedMap, 'not genuine frozen attachment');
    // Diagnostic only: no setter, cache manipulation or extra public write call.
    require(maps[id].arena.readOnly === true, 'attachment is not read-only');
  }
  // No owner, input descriptor or intermediate snapshot survives this function.
  P = F100k = D100k = E0 = F128 = F513 = O32k = stable = snapshots = owners = wire = null;
  return { maps, arenas, writes };
}
function arenaState(S, maps, arenas) {
  const wire = S.getWorkerData(maps, { copy: false });
  require(wire.arenas.length === 6, 'arena count changed');
  const rows = wire.arenas.map(row => {
    const original = arenas.find(item => item.id === row.id);
    require(original && row.memory === original.memory && row.used === original.used && !row.copy, 'arena identity/used changed');
    return { id: row.id, used: row.used, capacity: row.memory.buffer.byteLength };
  });
  return { rows, used: rows.reduce((sum, row) => sum + row.used, 0), capacity: rows.reduce((sum, row) => sum + row.capacity, 0) };
}

export function pretouchMemoryIterator(map, id) {
  let iterator = map.entries(), result = iterator.next();
  checkFirst(id, result); result = null; iterator.return(); iterator = null;
}
export function pauseMemoryIterator(holder, map, id) {
  holder.value = map.entries();
  let result = holder.value.next();
  checkFirst(id, result); result = null;
}
export function resumeAndReleaseMemoryIterator(holder, id) {
  let iterator = holder.value, result = iterator.next();
  if (COUNTS[id] <= 1) require(result.done === true, id + ' should complete after its first result');
  else {
    require(result.done === false, id + ' paused iterator lost continuation');
    checkPair(id, result.value, 1);
  }
  result = null; iterator.return(); iterator = null; holder.value = null;
  return true;
}
export function retentionTotal(state, engine) {
  return engine === 'node' ? state.heapUsed + state.external : state.heapSize;
}
function numericTotal(row, engine) { return engine === 'node' ? row[0] + row[2] : row[7]; }
function stateRecord(fields) { return Object.fromEntries(fields.map(field => [field, 0])); }
function copyRecord(fields, row, target) { for (let i = 0; i < fields.length; i++) target[fields[i]] = row[i]; }
export function endpointPlan(caseOrder, endpointOrder) {
  const result = caseOrder.flatMap(id => endpointOrder.map(endpoint => [id, endpoint]));
  const closeOrder = endpointOrder[0] === 'full' ? [...CLOSE_CASES].reverse() : CLOSE_CASES;
  for (const id of closeOrder) result.push([id, 'close']);
  return result;
}
export function attributionOK(before, released, engine, limit) {
  const indexes = engine === 'node' ? [0, 2] : [7, 9];
  return Math.abs(numericTotal(released, engine) - numericTotal(before, engine)) <= limit &&
    indexes.every(index => Math.abs(released[index] - before[index]) <= limit);
}
function prepareLedger(fields, plan) {
  // Every retained measurement row, holder, result object and numeric chunk slot is
  // allocated before the startup before-import sample. Only numbers/flags change.
  const state = () => stateRecord(fields), row = () => new Float64Array(fields.length);
  const memory = { eligible: true, invalid_reasons: [], cases: {} }, memoryRows = {};
  const holders = {};
  for (const id of MEMORY_CASES) {
    const count = id === 'P' ? 2 : 1;
    const raw = id === 'P' || SNAPSHOT_SIZES.slice(2).some(size => id === 'N' + size);
    const cycles = Array.from({ length: count }, () => ({ before: state(), rawPaused: raw ? state() : null,
      paused: state(), released: state(), resumed_ok: false }));
    memory.cases[id] = { eligible: true, invalid_reasons: [], cycles };
    memoryRows[id] = Array.from({ length: count }, () => [row(), row(), row(), row()]);
    holders[id] = { value: null };
  }
  const endpoints = {};
  for (const [id, endpoint] of plan) endpoints[id + ':' + endpoint] = {
    eligible: false, invalid_reasons: [], k: 0, warmup_ms: new Array(4).fill(0),
    measured_ms: new Array(6).fill(0), clock_ok: false, checksum_ok: false,
    overhead_ms_per_call: 0, clock_resolution_ms: 0 };
  endpoints['startup:import'] = { eligible: false, invalid_reasons: [], k: 1,
    warmup_ms: [], measured_ms: [0], clock_ok: false, checksum_ok: true,
    overhead_ms_per_call: 0, clock_resolution_ms: 0 };
  return { memory, memoryRows, holders, endpoints, emptyArenas: [], startupRows: [row(), row()],
    startup: { before: state(), after: state(), eligible: true, invalid_reasons: [] } };
}
async function memoryCycles(maps, arenas, instrument, ledger) {
  const { fields, collect, sampleInto, engine } = instrument;
  for (const id of MEMORY_CASES) {
    const output = ledger.memory.cases[id], holder = ledger.holders[id], rows = ledger.memoryRows[id];
    require(maps[id].size === COUNTS[id], id + ' memory fixture size mismatch');
    for (let touch = 0; touch < 2; touch++) pretouchMemoryIterator(maps[id], id);
    for (let cycle = 0; cycle < rows.length; cycle++) {
      const record = output.cycles[cycle], samples = rows[cycle];
      await collect(); sampleInto(samples[0], arenas);
      pauseMemoryIterator(holder, maps[id], id);
      // Fixed raw diagnostic only; never an endpoint or peak observation.
      if (record.rawPaused !== null) sampleInto(samples[1], arenas);
      await collect(); sampleInto(samples[2], arenas);
      record.resumed_ok = resumeAndReleaseMemoryIterator(holder, id);
      await collect(); sampleInto(samples[3], arenas);
      const limit = id === 'P' ? 65536 : (COUNTS[id] <= 32 ? 512 : 2048);
      if (!attributionOK(samples[0], samples[3], engine, limit)) {
        output.eligible = false;
        output.invalid_reasons.push('closed-minus-before component/total drift exceeds ' + limit + ' bytes at cycle ' + cycle);
      }
      const checkedStates = record.rawPaused === null ? [0, 2, 3] : [0, 1, 2, 3];
      for (const position of checkedStates) {
        require(samples[position][5] === samples[0][5] && samples[position][6] === samples[0][6], 'arena changed during memory cycle');
      }
      copyRecord(fields, samples[0], record.before);
      if (record.rawPaused !== null) copyRecord(fields, samples[1], record.rawPaused);
      copyRecord(fields, samples[2], record.paused);
      copyRecord(fields, samples[3], record.released);
    }
  }
  // Attribution eligibility is per case. Invalid small attribution cannot be
  // silently converted into a passed control or poison valid harm elsewhere.
  return ledger.memory;
}

function touchBytes(view) { for (let i = 0; i < view.length; i += 4096) view[i] = 1; }
function touched(view, length) { let sum = 0; for (let i = 0; i < view.length; i += 4096) sum += view[i]; return sum === length / 4096; }
function allocateProbePayload(holder, kind, length) {
  let held = null;
  if (kind === 'arrayBuffer') { held = new ArrayBuffer(length); touchBytes(new Uint8Array(held)); }
  else if (kind === 'typedArray') { held = new Uint8Array(length); touchBytes(held); }
  else if (kind === 'packedBlocks') {
    held = Array.from({ length: 25 }, () => new Uint32Array(4096));
    for (let block = 0; block < held.length; block++)
      for (let index = 0; index < held[block].length; index++) held[block][index] = index + 1;
  }
  else if (kind === 'sharedWasm') { held = new WebAssembly.Memory({ initial: 128, maximum: 128, shared: true }); touchBytes(new Uint8Array(held.buffer)); }
  else { held = Array.from({ length: 131072 }, (_, index) => ({ index, active: true })); }
  holder.value = held; held = null;
}
function validateAndReleaseProbePayload(holder, kind, length) {
  let held = holder.value;
  if (kind === 'arrayBuffer') require(held.byteLength === length && touched(new Uint8Array(held), length), 'ArrayBuffer probe lost contents');
  else if (kind === 'typedArray') require(held.byteLength === length && touched(held, length), 'typed array probe lost contents'); // Never expose .buffer.
  else if (kind === 'packedBlocks') {
    require(held.length === 25, 'packed probe block count');
    for (let block = 0; block < held.length; block++) {
      require(held[block].length === 4096 && held[block].byteLength === 16384, 'packed probe shape');
      for (let index = 0; index < 4096; index++) require(held[block][index] === index + 1, 'packed probe contents');
    }
  }
  else if (kind === 'sharedWasm') require(held.buffer instanceof SharedArrayBuffer && held.buffer.byteLength === length && touched(new Uint8Array(held.buffer), length), 'shared WASM probe lost contents');
  else require(held.length === 131072 && held.every((value, index) => value.index === index && value.active === true), 'object probe lost contents');
  held = null; holder.value = null;
}
async function probe(instrument, engine) {
  const { fields, collect, sampleInto, record, primaryIndex, now } = instrument;
  const clock = clockDiagnostics(now), records = [];
  const length = 8 * 1024 * 1024, holder = { value: null };
  const kinds = ['arrayBuffer', 'typedArray', 'sharedWasm', 'objects', 'packedBlocks'];
  const allRows = kinds.map(() => Array.from({ length: 3 }, () => new Float64Array(fields.length)));
  for (let kindIndex = 0; kindIndex < kinds.length; kindIndex++) {
    const kind = kinds[kindIndex], rows = allRows[kindIndex];
    await collect(); sampleInto(rows[0], []);
    allocateProbePayload(holder, kind, length);
    await collect(); sampleInto(rows[1], []);
    validateAndReleaseProbePayload(holder, kind, length);
    await collect(); sampleInto(rows[2], []);
    const primaryIncrement = rows[1][primaryIndex] - rows[0][primaryIndex];
    // No numeric substitution. Shared WASM's explicit 8 MiB capacity is authoritative;
    // runtime heap buckets need not count it. Owned heap objects must be visible/releasable.
    try {
      if (kind === 'packedBlocks') {
        const requested = 409600;
        require(numericTotal(rows[1], engine) - numericTotal(rows[0], engine) >= .9 * requested, 'packed payload retained total under 90%');
        require(Math.abs(numericTotal(rows[2], engine) - numericTotal(rows[0], engine)) <= 65536, 'packed payload total release exceeds 64 KiB');
        if (engine === 'node') {
          require(rows[1][2] - rows[0][2] >= .9 * requested, 'packed payload external under 90%');
          require(Math.abs(rows[2][2] - rows[0][2]) <= 65536, 'packed payload external release exceeds 64 KiB');
        }
      }
      if (kind === 'objects') require(primaryIncrement > 0 && rows[2][primaryIndex] < rows[1][primaryIndex], 'unaccountable object heap response');
      if (kind === 'arrayBuffer' || kind === 'typedArray') {
        require(engine === 'bun' ? primaryIncrement > 0 : rows[1][2] > rows[0][2] || rows[1][3] > rows[0][3], 'unaccountable owned buffer response');
      }
    } catch (error) {
      try {
        process.stdout.write(JSON.stringify({ event: 'probe-accounting-diagnostic', diagnosticOnly: true, scientificAdmission: false,
          hostScope: 'github-hosted-runner', engine, sourceRunId: null, primaryField: fields[primaryIndex], primaryIncrement,
          clock, completedRecords: records, failedRecord: { kind, expectedBytes: kind === 'objects' ? null : (kind === 'packedBlocks' ? 409600 : length),
            objectCount: kind === 'objects' ? 131072 : null, before: record(rows[0]), retained: record(rows[1]), released: record(rows[2]) } }) + '\n');
      } finally { throw error; }
    }
    records.push({ kind, expectedBytes: kind === 'objects' ? null : (kind === 'packedBlocks' ? 409600 : length), objectCount: kind === 'objects' ? 131072 : null,
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
export function overheadOK(id, endpoint, k, duration, overhead) {
  const bracket = endpoint === 'first' && !SMALL.has(id) ? duration / k : duration;
  return bracket > 0 && overhead <= 0.005 * bracket;
}
function ladderFor(id, endpoint) { return SMALL.has(id) || endpoint === 'close' ? [...LADDER, 262144, 1048576] : LADDER; }

export async function main(job) {
  require(job.schema === 1 && typeof job.jobId === 'string', 'bad job input');
  const emit = row => process.stdout.write(JSON.stringify({ schema: 1, jobId: job.jobId, ...row }) + '\n');
  const phase = (name, extra = {}) => emit({ event: 'phase', phase: name, ...extra });
  phase(job.mode === 'probe' ? 'probe' : job.mode === 'comparison' ? 'startup' : 'setup');
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
  const plan = endpointPlan(job.caseOrder, job.endpointOrder);
  const ledger = prepareLedger(instrument.fields, plan);
  const expected = Object.fromEntries(ALL_CASES.map(id => [id, oracle(id)]));
  const clock = clockDiagnostics(instrument.now);
  const targetURL = pathToFileURL(job.entrypoint).href;
  const calibration = Object.fromEntries(ALL_CASES.map(id => [id, {}]));
  let S = null;
  if (job.mode === 'comparison') {
    await instrument.collect(); instrument.sampleInto(ledger.startupRows[0], ledger.emptyArenas);
    const before = instrument.now();
    S = await import(targetURL); // First and only target import in this fresh process.
    const after = instrument.now();
    require(after >= before, 'import clock reversed');
    const duration = after - before;
    await instrument.collect(); instrument.sampleInto(ledger.startupRows[1], ledger.emptyArenas);
    copyRecord(instrument.fields, ledger.startupRows[0], ledger.startup.before);
    copyRecord(instrument.fields, ledger.startupRows[1], ledger.startup.after);
    const endpoint = ledger.endpoints['startup:import'];
    endpoint.measured_ms[0] = duration;
    endpoint.clock_resolution_ms = clock.resolutionMs;
    endpoint.overhead_ms_per_call = clock.overheadMs;
    endpoint.clock_ok = duration > 0 && clock.resolutionMs <= .005 * duration && clock.overheadMs <= .005 * duration;
    endpoint.eligible = endpoint.clock_ok;
    if (!endpoint.eligible) endpoint.invalid_reasons.push('single import resolution/bracket overhead unresolved');
    emit({ event: 'startup', startup: ledger.startup, endpoint });
    phase('setup');
  } else S = await import(targetURL); // Calibration setup is untimed and is not an import observation.
  const { maps, arenas, writes } = await build(S);
  const beforeArena = arenaState(S, maps, arenas);
  const admission = { postFixtureRssBytes: process.memoryUsage().rss, uniqueArenaCapacityBytes: beforeArena.capacity,
    uniqueArenaUsedBytes: beforeArena.used };
  require(admission.postFixtureRssBytes <= 1073741824 && beforeArena.capacity <= 536870912, 'measurement admission limit');
  let memory = null;
  if (job.mode === 'comparison') {
    phase('memory', admission);
    memory = await memoryCycles(maps, arenas, instrument, ledger);
    emit({ event: 'memory', memory }); // Every iterator is closed and released.
    phase('latency');
  }
  const validationOrder = [...job.caseOrder, ...CLOSE_CASES.filter(id => !CASES.includes(id))];
  for (const id of validationOrder) { validateCase(maps[id], id); validateCase(maps[id], id); }
  if (job.mode === 'calibration') {
    admission.postFixtureRssBytes = process.memoryUsage().rss;
    require(admission.postFixtureRssBytes <= 1073741824, 'calibration admission RSS limit');
    phase('calibration', admission);
  }
  for (const [id, endpoint] of plan) {
    if (job.mode === 'calibration') {
      const ladder = ladderFor(id, endpoint), observed = [];
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
        verification.every(duration => overheadOK(id, endpoint, k, duration, clock.overheadMs)),
        verification_ms: verification, ladder: observed, clock_resolution_ms: clock.resolutionMs, overhead_ms_per_call: clock.overheadMs };
    } else {
      const frozen = job.calibration?.[id]?.[endpoint];
      require(frozen && Number.isSafeInteger(frozen.k) && ladderFor(id, endpoint).includes(frozen.k), 'missing frozen baseline K');
      const output = ledger.endpoints[id + ':' + endpoint], k = frozen.k;
      for (let index = 0; index < 10; index++) {
        const result = chunk(maps[id], id, endpoint, k, expected[id], instrument.now);
        (index < 4 ? output.warmup_ms : output.measured_ms)[index < 4 ? index : index - 4] = result.milliseconds;
        emit({ event: 'sample', case: id, endpoint, kind: index < 4 ? 'warmup' : 'measured', index: index < 4 ? index : index - 4, k, ...result });
      }
      const durations = [...output.warmup_ms, ...output.measured_ms];
      output.k = k;
      output.clock_ok = resolutionOK(id, endpoint, k, durations, clock.resolutionMs) &&
        durations.every(duration => overheadOK(id, endpoint, k, duration, clock.overheadMs));
      output.eligible = frozen.resolved === true && output.clock_ok;
      if (!output.eligible) output.invalid_reasons.push('baseline calibration or timer resolution/bracket overhead unresolved');
      output.checksum_ok = true; output.overhead_ms_per_call = clock.overheadMs; output.clock_resolution_ms = clock.resolutionMs;
    }
  }
  phase('final');
  const afterArena = arenaState(S, maps, arenas);
  require(JSON.stringify(beforeArena) === JSON.stringify(afterArena), 'backing changed during experiment');
  const metadata = Object.fromEntries(ALL_CASES.map(id => [id, maps[id].toWorkerData()]));
  const common = { engine: job.engine, arm: job.arm, mode: job.mode, writes, arenaBefore: beforeArena, arenaAfter: afterArena,
    fixtures: metadata, identity_ok: true, oracle_ok: true, backing_ok: true, eligible: true, invalid_reasons: [] };
  // Do not export unused empty calibration case keys.
  const usedCalibration = Object.fromEntries(Object.entries(calibration).filter(([, endpoints]) => Object.keys(endpoints).length));
  emit({ event: 'result', result: job.mode === 'calibration' ? { ...common, calibration: usedCalibration } :
    { ...common, pair: job.pairIndex, endpoints: ledger.endpoints, memory, startup: ledger.startup } });
  if (job.mode === 'comparison') phase('exit');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  await main(job);
}
