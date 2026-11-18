// Ordinary Map.get sessions. All actual timed values survive in ordinary Arrays.
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => check(Object.is(actual, expected), `${label}: ${String(actual)} !== ${String(expected)}`);
const collect = () => typeof globalThis.gc === 'function' ? globalThis.gc() : globalThis.Bun?.gc?.(true);
const spec = (type, count, queries, extra = {}) => ({ name: `map.${type}.${count}.q${queries}${extra.suffix ?? ''}`, type, count, queries, ...extra });
export const cases = [
  ...[1, 2, 4, 16].map(queries => spec('number', 10000, queries)),
  ...[1, 2, 4, 16, 256, 32768].map(queries => spec('number', 100000, queries)),
  ...[1, 16].map(queries => spec('string', 10000, queries)),
  ...[1, 16].map(queries => spec('object', 4096, queries)),
  ...[1, 16].map(queries => spec('number', 100000, queries, { suffix: '.miss', missing: true })),
  ...[1, 16].map(queries => spec('number', 100000, queries, { suffix: '.unicode', unicode: true })),
  spec('number', 1024, 16, { suffix: '.warm', warm: true }),
  spec('number', 100000, 256, { suffix: '.alternate-roots', alternate: true }),
  ...[10000, 100000].map(count => spec('number', count, 1, { suffix: '.attach', attach: true })),
];

function frozen(value) {
  if (value === null || typeof value !== 'object') return;
  check(Object.isFrozen(value), 'Ordinary object result is not frozen');
  for (const child of Object.values(value)) frozen(child);
}
function verifyValue(actual, expected) {
  if (expected !== null && typeof expected === 'object') {
    equal(JSON.stringify(actual), JSON.stringify(expected), 'Object result'); frozen(actual);
  } else equal(actual, expected, 'Raw result');
}
function canary(memory, used) {
  return { memory, used, capacity: memory.buffer.byteLength, bytes: new Uint8Array(memory.buffer, 0, used).slice() };
}
function checkCanary(before) {
  equal(before.memory.buffer.byteLength, before.capacity, 'Reader changed shared capacity');
  const bytes = new Uint8Array(before.memory.buffer, 0, before.used);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== before.bytes[i]) throw new Error(`Reader changed shared byte ${i}`);
}
function readerStates(readers) {
  const seen = new Set(), states = [];
  for (const reader of readers) for (const structure of Object.values(reader)) {
    // Internal observation is outside timing. Every attachment has its own
    // WASM heap-end global even when all attachments share one memory.
    const arena = structure.arena;
    if (seen.has(arena)) continue;
    seen.add(arena);
    states.push({ arena, used: arena.used, capacity: arena.memory.buffer.byteLength });
  }
  return states;
}
function verifyStates(states) {
  for (const state of states) {
    check(state.arena.readOnly, 'Expected a read-only reader');
    equal(state.arena.used, state.used, 'Reader allocated arena bytes');
    equal(state.arena.memory.buffer.byteLength, state.capacity, 'Reader grew memory');
  }
}
function verifySource(states, source, capacity) {
  for (const state of states) {
    equal(state.used, source.used, 'Attachment/read allocated arena bytes');
    equal(state.arena.memory, source.memory, 'Shared attachment copied memory');
    equal(state.capacity, capacity, 'Attachment/read grew memory');
  }
}
function inputs(item, iterations) {
  const keys = Array.from({ length: item.count }, (_, i) => `${item.unicode ? '道路/' : 'item/'}${i.toString(36).padStart(7, '0')}`);
  const values = Array.from({ length: item.count }, (_, i) => item.type === 'object'
    ? { id: i, active: i % 3 !== 0, details: { label: `Row ${i} 道路`, tags: ['a', `group-${i % 13}`] } }
    : item.type === 'string' ? `Value ${i} 道路` : i === 0 ? -0 : i * 1.25 - 123);
  const selectors = new Array(iterations * item.queries), indexes = new Uint32Array(selectors.length);
  for (let i = 0; i < iterations; i++) for (let j = 0; j < item.queries; j++) {
    const index = item.alternate && j < 2 ? 0 : (i * 37 + j * 7919) % item.count, offset = i * item.queries + j;
    indexes[offset] = index; selectors[offset] = item.missing ? `missing/${keys[index]}` : keys[index];
  }
  return { keys, values, selectors, indexes };
}
function read(reader, selectors, offset, count, alternate, outputs) {
  for (let j = 0; j < count; j++) outputs[offset + j] = (alternate && j % 2 ? reader.next : reader.data).get(selectors[offset + j]);
}
async function measure(lib, item, config) {
  const baseIterations = item.warm ? 65536 : item.queries >= 256 ? Math.ceil(262144 / item.queries) : 4096;
  const iterations = Math.max(1, Math.ceil(baseIterations * config.batchScale));
  const { keys, values, selectors, indexes } = inputs(item, iterations);
  lib.resetMap();
  const writer = new lib.SharedMap(item.type).setMany(keys.map((key, i) => [key, values[i]]));
  const next = item.alternate ? writer.set(keys[0], -999) : null;
  const transport = lib.getWorkerData(next ? { data: writer, next } : { data: writer }, { copy: false });
  equal(transport.arenas.length, 1, 'Expected one source arena');
  const source = transport.arenas[0];
  check(source.memory instanceof WebAssembly.Memory, 'Expected shared memory');
  const sharedBefore = canary(source.memory, source.used);
  const expected = offset => item.missing ? undefined : item.alternate && offset % item.queries % 2 && indexes[offset] === 0 ? -999 : values[indexes[offset]];
  for (let i = 0; i < config.warmups; i++) {
    const reader = await lib.initWorker(transport), raw = new Array(item.queries);
    const state = readerStates([reader]); verifySource(state, source, sharedBefore.capacity);
    read(reader, selectors, 0, item.queries, item.alternate, raw);
    for (let j = 0; j < raw.length; j++) verifyValue(raw[j], expected(j));
    verifyStates(state);
  }
  const readers = new Array(iterations), outputs = new Array(iterations * item.queries);
  if (item.warm) {
    const reader = await lib.initWorker(transport);
    const state = readerStates([reader]); verifySource(state, source, sharedBefore.capacity);
    for (let i = 0; i < keys.length; i++) verifyValue(reader.data.get(keys[i]), values[i]);
    verifyStates(state);
    readers.fill(reader);
  } else if (!item.attach) for (let i = 0; i < iterations; i++) readers[i] = await lib.initWorker(transport);
  const before = item.attach ? [] : readerStates(readers);
  verifySource(before, source, sharedBefore.capacity);
  collect();
  const start = performance.now();
  if (item.attach) {
    for (let i = 0; i < iterations; i++) {
      const reader = readers[i] = await lib.initWorker(transport);
      read(reader, selectors, i * item.queries, item.queries, item.alternate, outputs);
    }
  } else for (let i = 0; i < iterations; i++) read(readers[i], selectors, i * item.queries, item.queries, item.alternate, outputs);
  const elapsedMs = performance.now() - start;
  // Never reread primed caches as a substitute for checking timed results.
  for (let i = 0; i < outputs.length; i++) verifyValue(outputs[i], expected(i));
  let states = before;
  if (item.attach) {
    states = readerStates(readers);
    verifySource(states, source, sharedBefore.capacity);
  }
  equal(states.length, item.warm ? 1 : iterations, 'Distinct reader Arena count');
  equal(new Set(states.map(state => state.arena.wasm)).size, states.length, 'Distinct WASM instance count');
  for (const state of states) equal(state.arena.memory, source.memory, 'Expected shared reader memory');
  verifyStates(states); checkCanary(sharedBefore);
  equal(writer.arena.used, source.used, 'Reader changed writer allocator');
  const directorySizes = states.map(state => (state.arena.prefixChildren?.byteLength ?? 0) + (state.arena.prefixValid?.byteLength ?? 0));
  const directoryBackingBytesHistogram = {};
  for (const size of directorySizes) directoryBackingBytesHistogram[size] = (directoryBackingBytesHistogram[size] ?? 0) + 1;
  const operations = iterations;
  return { elapsedMs, operations, millisecondsPer10000: elapsedMs / operations * 10000,
    operation: item.attach ? 'initWorker plus complete get session' : 'complete get session',
    count: item.count, queriesPerSession: item.queries, iterations, actualGetCalls: outputs.length,
    actualTimedValuesVerified: outputs.length, rawValuesRetained: 'ordinary Array', objectReadsDeeplyFrozen: item.type === 'object',
    freshReaderPerSession: !item.warm, attachmentTimed: !!item.attach, primedReader: !!item.warm,
    distinctReaderArenasChecked: states.length, uniqueMemoriesByteChecked: 1,
    directoryBackingBytesHistogram,
    readerArenaAllocationBytes: 0, sharedBytesUnchanged: true, sharedUsedBytes: source.used, sharedCapacityBytes: sharedBefore.capacity };
}
export async function run(lib, config, rotation = 0) {
  const selected = cases.filter(item => !config.only.length || config.only.includes(item.name));
  check(selected.length > 0, 'No selected cases');
  equal(JSON.stringify(selected.map(item => item.name)), JSON.stringify(config.caseNames), 'Case coverage');
  lib.configureMemory({ maximumBytes: 256 * 1024 * 1024 });
  const offset = rotation % selected.length, order = [...selected.slice(offset), ...selected.slice(0, offset)], rows = [];
  for (const item of order) {
    collect();
    try { rows.push({ name: item.name, ...await measure(lib, item, config) }); }
    catch (cause) { throw new Error(`Workload failed: ${item.name}`, { cause }); }
  }
  return { gcAvailable: typeof globalThis.gc === 'function' || typeof globalThis.Bun?.gc === 'function', rows };
}
