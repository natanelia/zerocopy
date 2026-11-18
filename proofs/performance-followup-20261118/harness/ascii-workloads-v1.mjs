// Fixed ordinary string reads. Construction, attachment, priming, and exact
// result/state verification stay outside timing. Every timed result is retained.
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => check(Object.is(actual, expected), `${label}: ${String(actual)} !== ${String(expected)}`);
const collect = () => typeof globalThis.gc === 'function' ? globalThis.gc() : globalThis.Bun?.gc?.(true);
const encoder = new TextEncoder();
const spec = (group, style, mode = 'cold', extra = {}) => Object.freeze({
  name: `${group}.${style}.${mode}`, group, style, mode, count: mode === 'warm' ? 1024 : 8192, ...extra,
});

export const cases = Object.freeze([
  spec('list.string.get', 'ascii16'),
  spec('list.string.get', 'ascii32'),
  spec('list.string.get', 'ascii16', 'over-cap', { shuffled: true }),
  spec('list.string.get', 'ascii16', 'warm'),
  spec('list.string.get', 'boundaries'),
  spec('list.string.get', 'unicode'),
  spec('list.string.get', 'ascii64'),
  spec('map.keys', 'ascii16'),
  spec('map.keys', 'ascii32'),
  spec('map.keys', 'ascii16', 'over-cap'),
  spec('map.keys', 'ascii16', 'warm'),
  spec('map.keys', 'boundaries'),
  spec('map.keys', 'unicode'),
]);

function value(index, style) {
  const id = index.toString(36);
  if (style.startsWith('ascii')) return id.padStart(Number(style.slice(5)), '0');
  if (style === 'boundaries') {
    const lengths = [3, 4, 5, 7, 8, 15, 16, 31, 32, 33, 64];
    return id.padStart(lengths[index % lengths.length], '0');
  }
  const suffix = id.padStart(6, '0');
  switch (index % 6) {
    case 0: return `é${suffix}`;
    case 1: return `a界${suffix}`;
    case 2: return `ab🙂${suffix}`;
    case 3: return `abcé${suffix}`;
    case 4: return `\ufeff${suffix}`;
    default: return `abcdefghijklmnopqrstuv${suffix}é`;
  }
}

function indexes(count, shuffled) {
  const result = Array.from({ length: count }, (_, i) => i);
  if (shuffled) {
    let seed = 0x6a09e667;
    for (let i = result.length - 1; i > 0; i--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const j = (seed >>> 0) % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
  }
  return result;
}

function capture(data, list, order, output) {
  if (list) {
    for (let i = 0; i < order.length; i++) output[i] = data.get(order[i]);
    return order.length;
  }
  let length = 0;
  for (const key of data.keys()) output[length++] = key;
  return length;
}

function verify(output, length, list, order, values, expectedKeys) {
  equal(length, values.length, 'Returned string count');
  equal(output.length, values.length, 'Captured string count');
  const seen = list ? null : new Set();
  for (let i = 0; i < output.length; i++) {
    const actual = output[i];
    check(typeof actual === 'string', `Returned non-string at ${i}`);
    if (list) equal(actual, values[order[i]], `List value ${order[i]}`);
    else {
      check(expectedKeys.has(actual), `Unexpected Map key at ${i}`);
      check(!seen.has(actual), `Duplicate Map key at ${i}`);
      seen.add(actual);
    }
  }
  if (seen) equal(seen.size, expectedKeys.size, 'Map key coverage');
}

function canaries(sources) {
  const memories = new Map();
  for (const source of sources) {
    check(source.memory instanceof WebAssembly.Memory && !source.copy, 'Expected shared-memory transport');
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
    equal(before.memory.buffer.byteLength, before.capacity, 'Reader changed shared capacity');
    const bytes = new Uint8Array(before.memory.buffer, 0, before.used);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== before.bytes[i]) throw new Error(`Reader changed shared byte ${i}`);
  }
}

function observeReader(reader, states, memories, phase) {
  // Internal observation only: each attachment has its own Arena/WASM globals,
  // even though its bytes and arena identifier are shared with every reader.
  const arena = reader.data.arena;
  check(arena && arena.readOnly, 'Expected a read-only reader Arena');
  check(Object.isFrozen(reader.data), 'Expected a frozen public collection');
  const memory = memories.get(arena.memory);
  check(memory, 'Attachment copied or replaced shared memory');
  equal(arena.used, memory.used, 'Attachment changed its private heap-end');
  equal(arena.memory.buffer.byteLength, memory.capacity, 'Attachment grew shared memory');
  if (!states.has(arena)) states.set(arena, {
    arena, wasm: arena.wasm, id: arena.id, memory: arena.memory,
    used: arena.used, capacity: arena.memory.buffer.byteLength, phase,
  });
}

function verifyStates(states) {
  for (const before of states.values()) {
    const arena = before.arena;
    check(arena.readOnly, 'Reader became writable');
    equal(arena.wasm, before.wasm, 'Reader replaced its WASM instance');
    equal(arena.id, before.id, 'Reader identity changed');
    equal(arena.memory, before.memory, 'Reader memory changed');
    equal(arena.used, before.used, 'Reader allocated Arena bytes');
    equal(arena.memory.buffer.byteLength, before.capacity, 'Reader grew shared memory');
  }
}

async function measure(lib, item, config) {
  const list = item.group === 'list.string.get';
  const values = Array.from({ length: item.count }, (_, i) => value(i, item.style));
  const expectedKeys = new Set(values), order = indexes(item.count, item.shuffled);
  equal(expectedKeys.size, item.count, 'Fixture strings must be distinct');
  const iterations = Math.max(1, Math.ceil(262144 * config.batchScale / item.count));
  if (list) lib.resetSharedList(); else lib.resetMap();
  const writer = list ? new lib.SharedList('string').pushMany(values)
    : new lib.SharedMap('number').setMany(values.map((key, i) => [key, i]));
  const transport = lib.getWorkerData({ data: writer }, { copy: false });
  equal(transport.arenas.length, 1, 'Expected one fixture Arena');
  const memories = canaries(transport.arenas), states = new Map();
  const writerBefore = { arena: writer.arena, used: writer.arena.used, wasm: writer.arena.wasm };
  for (let i = 0; i < config.warmups; i++) {
    const reader = await lib.initWorker(transport), output = new Array(item.count);
    observeReader(reader, states, memories, 'warmup');
    const length = capture(reader.data, list, order, output);
    verify(output, length, list, order, values, expectedKeys);
  }
  const readers = new Array(iterations), outputs = new Array(iterations), lengths = new Array(iterations);
  if (item.mode === 'cold') {
    for (let i = 0; i < iterations; i++) {
      const reader = readers[i] = await lib.initWorker(transport);
      observeReader(reader, states, memories, 'measured');
    }
  } else {
    const reader = await lib.initWorker(transport), primed = new Array(item.count);
    observeReader(reader, states, memories, 'measured');
    verify(primed, capture(reader.data, list, order, primed), list, order, values, expectedKeys);
    readers.fill(reader);
  }
  for (let i = 0; i < iterations; i++) outputs[i] = new Array(item.count);
  collect();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) lengths[i] = capture(readers[i].data, list, order, outputs[i]);
  const elapsedMs = performance.now() - start;
  check(Number.isFinite(elapsedMs) && elapsedMs > 0, 'Invalid elapsed time');
  // Check the actual timed strings, never a second read through primed caches.
  for (let i = 0; i < iterations; i++) verify(outputs[i], lengths[i], list, order, values, expectedKeys);
  verifyStates(states); checkCanaries(memories);
  equal(writerBefore.arena.used, writerBefore.used, 'Reader changed writer allocator');
  equal(writerBefore.arena.wasm, writerBefore.wasm, 'Reader replaced writer WASM');
  const operations = iterations * item.count;
  const stateValues = [...states.values()];
  const measuredStates = stateValues.filter(state => state.phase === 'measured').length;
  const wasmInstances = new Set(stateValues.map(state => state.wasm)).size;
  equal(measuredStates, item.mode === 'cold' ? iterations : 1, 'Measured reader Arena coverage');
  equal(states.size - measuredStates, config.warmups, 'Warmup reader Arena coverage');
  equal(wasmInstances, states.size, 'Distinct reader WASM instance coverage');
  return {
    elapsedMs, operations, millisecondsPer10000: elapsedMs / operations * 10000,
    operation: list ? 'ordinary string List.get' : 'ordinary Map key yielded', count: item.count, iterations,
    actualTimedValuesVerified: operations, rawValuesRetained: 'ordinary Arrays',
    exactStringTypesAndValuesVerified: true, ordinaryGet: list, ordinaryMapKeys: !list,
    freshReaderPerIteration: item.mode === 'cold', attachmentTimed: false, primedReader: item.mode !== 'cold',
    cacheMode: item.mode, stringCacheEntryLimit: 2048, fixtureDistinctStrings: expectedKeys.size,
    fixtureByteLengths: [...new Set(values.map(text => encoder.encode(text).length))].sort((a, b) => a - b),
    order: list && item.shuffled ? 'fixed shuffled permutation' : list ? 'sequential' : 'Map key iteration',
    distinctReaderArenasChecked: states.size, distinctMeasuredReaderArenasChecked: measuredStates,
    distinctWarmupReaderArenasChecked: states.size - measuredStates, uniqueMemoriesByteChecked: memories.size,
    distinctReaderWasmInstancesChecked: wasmInstances,
    readerArenaAllocationBytes: 0, sharedBytesUnchanged: true,
    sharedUsedBytes: [...memories.values()].reduce((sum, item) => sum + item.used, 0),
    sharedCapacityBytes: [...memories.values()].reduce((sum, item) => sum + item.capacity, 0),
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
