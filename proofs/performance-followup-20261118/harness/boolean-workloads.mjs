// Fixed ordinary List.get calls. Fixture construction, attachment, priming,
// explicit GC, and exact result/state verification are outside timing.
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => { if (!Object.is(actual, expected)) throw new Error(`${label}: values differ`); };
const collect = () => typeof globalThis.gc === 'function' ? globalThis.gc() : globalThis.Bun?.gc?.(true);
const spec = (type, size, style, mode) => Object.freeze({
  name: `list.${type}.get.${style}.${size}.${mode}`, type, size, style, mode,
});
export const cases = Object.freeze([
  ...[31, 32, 33, 8192].flatMap(size => ['sequential', 'shuffled', 'tail'].flatMap(style =>
    ['fresh', 'warm'].map(mode => spec('boolean', size, style, mode)))),
  ...['number', 'string', 'object'].flatMap(type => ['sequential', 'shuffled'].flatMap(style =>
    ['fresh', 'warm'].map(mode => spec(type, type !== 'number' && mode === 'warm' ? 1024 : 8192, style, mode)))),
]);

function valuesFor(type, size) {
  const specials = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE];
  return Array.from({ length: size }, (_, i) => {
    if (type === 'boolean') return ((i * 17 + (i >>> 3)) % 5) < 2;
    if (type === 'number') return i % 29 < specials.length ? specials[i % 29] : i + 0.125;
    if (type === 'string') return `${i % 4 === 0 ? '界' : 'ab'}${i.toString(36).padStart(12, '0')}\0x`;
    return { id: i, enabled: i % 3 === 0, label: `record${i}`, nested: { values: [i + 0.5, false, `v${i}`] } };
  });
}
function orderFor(size, style) {
  if (style === 'tail') {
    const tail = (size - 1) & ~31;
    const edges = [...new Set([tail - 2, tail - 1, tail, tail + 1, size - 2, size - 1].filter(i => i >= 0 && i < size))];
    return Array.from({ length: size }, (_, i) => edges[i % edges.length]);
  }
  const result = Array.from({ length: size }, (_, i) => i);
  if (style === 'shuffled') {
    let seed = 0x6a09e667;
    for (let i = result.length - 1; i > 0; i--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const j = (seed >>> 0) % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
  }
  return result;
}
function capture(list, order, output) {
  for (let i = 0; i < order.length; i++) output[i] = list.get(order[i]);
  return order.length;
}
function verifyValue(actual, expected) {
  if (expected === null || typeof expected !== 'object') {
    equal(actual, expected, 'Exact primitive result');
    return;
  }
  check(actual !== null && typeof actual === 'object', 'Expected a complete object result');
  equal(Array.isArray(actual), Array.isArray(expected), 'Object/array shape');
  check(Object.isFrozen(actual), 'Decoded object or nested array must be frozen');
  const actualKeys = Object.keys(actual), expectedKeys = Object.keys(expected);
  equal(actualKeys.length, expectedKeys.length, 'Object key count');
  for (let i = 0; i < expectedKeys.length; i++) {
    equal(actualKeys[i], expectedKeys[i], 'Object key');
    verifyValue(actual[actualKeys[i]], expected[expectedKeys[i]]);
  }
}
function verify(output, length, order, values) {
  check(Array.isArray(output), 'Timed observations must be ordinary Arrays');
  equal(length, order.length, 'Read count'); equal(output.length, order.length, 'Captured count');
  for (let i = 0; i < output.length; i++) verifyValue(output[i], values[order[i]]);
}
function canaries(sources) {
  const memories = new Map();
  for (const source of sources) {
    check(source.memory instanceof WebAssembly.Memory && !source.copy, 'Expected shared transport');
    const previous = memories.get(source.memory);
    if (previous) { equal(previous.used, source.used, 'Shared memory length disagreement'); continue; }
    memories.set(source.memory, {
      memory: source.memory, used: source.used, capacity: source.memory.buffer.byteLength,
      bytes: new Uint8Array(source.memory.buffer, 0, source.used).slice(),
    });
  }
  return memories;
}
function checkCanaries(memories) {
  for (const before of memories.values()) {
    equal(before.memory.buffer.byteLength, before.capacity, 'Shared capacity changed');
    const bytes = new Uint8Array(before.memory.buffer, 0, before.used);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== before.bytes[i]) throw new Error(`Shared byte ${i} changed`);
  }
}
function observeReader(reader, states, memories, phase) {
  // Internal checks remain outside timing. Sharing one memory must not hide a
  // change to any attachment's independent Arena allocator or WASM instance.
  const arena = reader.data.arena;
  check(arena && arena.readOnly, 'Expected a read-only reader Arena');
  check(Object.isFrozen(reader.data), 'Expected a frozen List snapshot');
  const memory = memories.get(arena.memory);
  check(memory, 'Reader copied or replaced shared memory');
  equal(arena.used, memory.used, 'Reader heap-end differs');
  equal(arena.memory.buffer.byteLength, memory.capacity, 'Reader capacity differs');
  if (!states.has(arena)) states.set(arena, {
    arena, wasm: arena.wasm, id: arena.id, memory: arena.memory,
    used: arena.used, capacity: arena.memory.buffer.byteLength, phase,
  });
}
function verifyStates(states) {
  for (const before of states.values()) {
    const arena = before.arena;
    check(arena.readOnly, 'Reader became writable');
    equal(arena.wasm, before.wasm, 'Reader WASM changed'); equal(arena.id, before.id, 'Reader identity changed');
    equal(arena.memory, before.memory, 'Reader memory changed'); equal(arena.used, before.used, 'Reader allocated Arena bytes');
    equal(arena.memory.buffer.byteLength, before.capacity, 'Reader grew shared memory');
  }
}
async function measure(lib, item, config) {
  const values = valuesFor(item.type, item.size), order = orderFor(item.size, item.style);
  const iterations = Math.max(1, Math.ceil(262144 * config.batchScale / order.length));
  lib.resetSharedList();
  const writer = new lib.SharedList(item.type).pushMany(values);
  const transport = lib.getWorkerData({ data: writer }, { copy: false });
  equal(transport.arenas.length, 1, 'Expected one fixture Arena');
  const memories = canaries(transport.arenas), states = new Map();
  const writerBefore = { arena: writer.arena, used: writer.arena.used, wasm: writer.arena.wasm };
  for (let i = 0; i < config.warmups; i++) {
    const reader = await lib.initWorker(transport), output = new Array(order.length);
    observeReader(reader, states, memories, 'warmup');
    verify(output, capture(reader.data, order, output), order, values);
  }
  const readers = new Array(iterations), outputs = new Array(iterations), lengths = new Array(iterations);
  if (item.mode === 'fresh') {
    for (let i = 0; i < iterations; i++) {
      const reader = readers[i] = await lib.initWorker(transport);
      observeReader(reader, states, memories, 'measured');
    }
  } else {
    const reader = await lib.initWorker(transport), primed = new Array(order.length);
    observeReader(reader, states, memories, 'measured');
    verify(primed, capture(reader.data, order, primed), order, values);
    readers.fill(reader);
  }
  for (let i = 0; i < iterations; i++) outputs[i] = new Array(order.length);
  collect();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) lengths[i] = capture(readers[i].data, order, outputs[i]);
  const elapsedMs = performance.now() - start;
  check(Number.isFinite(elapsedMs) && elapsedMs > 0, 'Invalid elapsed time');
  // Check the actual returned values, including full frozen objects. A second
  // get through a newly primed cache would not verify the timed observations.
  for (let i = 0; i < iterations; i++) verify(outputs[i], lengths[i], order, values);
  verifyStates(states); checkCanaries(memories);
  equal(writerBefore.arena.used, writerBefore.used, 'Reader changed writer allocator');
  equal(writerBefore.arena.wasm, writerBefore.wasm, 'Reader changed writer WASM');
  const stateValues = [...states.values()], measuredStates = stateValues.filter(state => state.phase === 'measured').length;
  const wasmInstances = new Set(stateValues.map(state => state.wasm)).size;
  equal(measuredStates, item.mode === 'fresh' ? iterations : 1, 'Measured reader Arena coverage');
  equal(states.size - measuredStates, config.warmups, 'Warmup reader Arena coverage');
  equal(wasmInstances, states.size, 'Distinct reader WASM coverage');
  const operations = iterations * order.length;
  return {
    elapsedMs, operations, millisecondsPer10000: elapsedMs / operations * 10000,
    operation: `ordinary ${item.type} List.get`, type: item.type, size: item.size, iterations,
    actualTimedValuesVerified: operations, rawValuesRetained: 'ordinary Arrays', exactTypesAndValuesVerified: true,
    frozenObjectsVerified: item.type === 'object', ordinaryGet: true, distinctIndexesRead: new Set(order).size,
    freshReaderPerIteration: item.mode === 'fresh', attachmentTimed: false, primedReader: item.mode === 'warm',
    readerMode: item.mode, order: item.style, tinyBatch: elapsedMs < 20, minimumBatchMs: 20,
    distinctReaderArenasChecked: states.size, distinctMeasuredReaderArenasChecked: measuredStates,
    distinctWarmupReaderArenasChecked: states.size - measuredStates, uniqueMemoriesByteChecked: memories.size,
    distinctReaderWasmInstancesChecked: wasmInstances, readerArenaAllocationBytes: 0, sharedBytesUnchanged: true,
    sharedUsedBytes: [...memories.values()].reduce((sum, value) => sum + value.used, 0),
    sharedCapacityBytes: [...memories.values()].reduce((sum, value) => sum + value.capacity, 0),
  };
}

export async function run(lib, config = {}, rotation = 0) {
  const warmups = config.warmups ?? 2, batchScale = config.batchScale ?? 1;
  check(Number.isSafeInteger(warmups) && warmups >= 0, 'Invalid warmup count');
  check(Number.isFinite(batchScale) && batchScale > 0, 'Invalid batch scale');
  check(Number.isSafeInteger(rotation) && rotation >= 0, 'Invalid rotation');
  const requested = config.only ?? config.caseNames ?? [];
  const only = typeof requested === 'string' ? requested.split(',').filter(Boolean) : requested;
  check(Array.isArray(only) && only.every(name => typeof name === 'string'), 'Invalid case selection');
  equal(new Set(only).size, only.length, 'Duplicate case selection');
  for (const name of only) check(cases.some(item => item.name === name), `Unknown case: ${name}`);
  const selected = cases.filter(item => !only.length || only.includes(item.name));
  check(selected.length > 0, 'No selected cases');
  if (config.caseNames) equal(JSON.stringify(selected.map(item => item.name)), JSON.stringify(config.caseNames), 'Case coverage');
  lib.configureMemory({ maximumBytes: 256 * 1024 * 1024 });
  const offset = rotation % selected.length, ordered = [...selected.slice(offset), ...selected.slice(0, offset)], rows = [];
  for (const item of ordered) { collect(); rows.push({ name: item.name, ...await measure(lib, item, { warmups, batchScale }) }); }
  return { gcAvailable: typeof globalThis.gc === 'function' || typeof globalThis.Bun?.gc === 'function', rows };
}
