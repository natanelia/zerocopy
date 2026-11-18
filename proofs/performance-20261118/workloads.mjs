// The same public-API workloads run in Node, Bun, and a cross-origin-isolated page.
// Inputs, fresh reader attachment, warmup, GC, and verification are outside timing.
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => check(Object.is(actual, expected), `${label}: ${actual} !== ${expected}`);
const collect = () => typeof globalThis.gc === 'function' ? globalThis.gc() : globalThis.Bun?.gc?.(true);
const countFor = (item, count) => item.beyond ? Math.max(32768, count) : item.type === 'object' && item.group === 'map' ? Math.max(4096, Math.min(count, 10000)) : item.warm ? 1024 : count;

export const cases = [
  { name: 'map.number.ascii8.cold', group: 'map', type: 'number', key: 'ascii8' },
  { name: 'map.number.ascii16.cold', group: 'map', type: 'number', key: 'ascii16' },
  { name: 'map.number.ascii32.cold', group: 'map', type: 'number', key: 'ascii32' },
  { name: 'map.number.unicode.cold', group: 'map', type: 'number', key: 'unicode' },
  { name: 'map.number.ascii8.beyond-cache', group: 'map', type: 'number', key: 'ascii8', beyond: true },
  { name: 'map.number.ascii16.beyond-cache', group: 'map', type: 'number', key: 'ascii16', beyond: true },
  { name: 'map.number.ascii16.beyond-cache-repeated', group: 'map', type: 'number', key: 'ascii16', beyond: true, repeated: true },
  { name: 'map.object.ascii8.cold', group: 'map', type: 'object', key: 'ascii8' },
  { name: 'map.number.ascii8.miss', group: 'map', type: 'number', key: 'ascii8', missing: true },
  { name: 'map.number.ascii8.warm', group: 'map', type: 'number', key: 'ascii8', warm: true },
  { name: 'map.number.ascii8.updated', group: 'map', type: 'number', key: 'ascii8', updated: true },
  ...['number', 'boolean', 'string', 'object', 'nested'].map(type => ({ name: `list.${type}.build`, group: 'list', type })),
  { name: 'list.string.repeated.build', group: 'list', type: 'string', valueStyle: 'repeated' },
  { name: 'list.string.ascii.build', group: 'list', type: 'string', valueStyle: 'ascii' },
  { name: 'list.object.large.build', group: 'list', type: 'object', valueStyle: 'large' },
  ...['string', 'object'].map(type => ({ name: `list.${type}.append`, group: 'list', type, append: true })),
  { name: 'json-array.sequential.1024', group: 'json-array', count: 1024, order: 'sequential' },
  { name: 'json-array.sequential.4096', group: 'json-array', count: 4096, order: 'sequential' },
  { name: 'json-array.stride.4096', group: 'json-array', count: 4096, order: 'stride' },
  { name: 'json-array.reverse.4096', group: 'json-array', count: 4096, order: 'reverse' },
  { name: 'json-array.random.4096', group: 'json-array', count: 4096, order: 'random' },
  { name: 'json-array.repeated.4096', group: 'json-array', count: 4096, order: 'repeated' },
  { name: 'json-array.fields.control', group: 'json-array', count: 4096, order: 'fields' },
];

function row(index) {
  return { id: index, name: `Item ${index} 道路`, active: index % 3 !== 0,
    nested: { price: index * 1.25, tags: ['plain', `group-${index % 17}`] } };
}
function key(index, kind) {
  const suffix = index.toString(36).padStart(kind === 'ascii16' || kind === 'ascii32' ? 8 : 7, '0');
  return kind === 'ascii32' ? `catalog/products/record/${suffix}` : kind === 'ascii16' ? `product/${suffix}` : kind === 'unicode' ? `道/${suffix}` : `k${suffix}`;
}
function payload(lib, data) { return lib.getWorkerData({ data }, { copy: false }); }
function state(lib, data, copy = false) {
  return payload(lib, data).arenas.map(source => {
    check(source.memory instanceof WebAssembly.Memory && !source.copy, 'Expected shared-memory transport');
    return { id: source.id, used: source.used, capacity: source.memory.buffer.byteLength, memory: source.memory,
      ...(copy ? { bytes: new Uint8Array(source.memory.buffer, 0, source.used).slice() } : {}) };
  });
}
function unchanged(lib, data, before) {
  const after = state(lib, data);
  equal(after.length, before.length, 'Arena count changed');
  for (let i = 0; i < before.length; i++) {
    equal(after[i].id, before[i].id, 'Arena identity changed');
    equal(after[i].used, before[i].used, 'Reader allocated shared bytes');
    equal(after[i].capacity, before[i].capacity, 'Reader grew shared memory');
    const bytes = new Uint8Array(after[i].memory.buffer, 0, after[i].used), saved = before[i].bytes;
    for (let j = 0; j < saved.length; j++) if (bytes[j] !== saved[j]) throw new Error(`Reader changed shared byte ${j}`);
  }
}
function deeplyFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  check(Object.isFrozen(value), 'Ordinary object read must be deeply frozen');
  for (const child of Object.values(value)) deeplyFrozen(child);
}
function scanNumbers(map, keys) { let sum = 0; for (let i = 0; i < keys.length; i++) sum += map.get(keys[i]); return sum; }
function scanObjects(map, keys) { let sum = 0; for (let i = 0; i < keys.length; i++) sum += map.get(keys[i]).id; return sum; }
function scanMissing(map, keys) { let count = 0; for (let i = 0; i < keys.length; i++) count += map.get(keys[i]) === undefined; return count; }
function verifyMap(map, keys, values, item, changed = false) {
  for (let i = 0; i < keys.length; i++) {
    const actual = map.get(keys[i]);
    if (item.missing) equal(actual, undefined, 'Missing key');
    else if (item.type === 'object') {
      equal(JSON.stringify(actual), JSON.stringify(values[i]), 'JSON value'); deeplyFrozen(actual);
    } else equal(actual, changed && i % 101 === 0 ? values[i] + 1 : values[i], 'Numeric value');
  }
}

async function measureMap(lib, item, config) {
  const count = countFor(item, config.count);
  const keys = Array.from({ length: count }, (_, i) => key(i, item.key));
  const values = Array.from({ length: count }, (_, i) => item.type === 'object' ? row(i) : i * 1.25);
  lib.resetMap();
  const writer = new lib.SharedMap(item.type).setMany(values.map((value, i) => [keys[i], value]));
  const next = item.updated ? writer.setMany(keys.flatMap((name, i) => i % 101 === 0 ? [[name, values[i] + 1]] : [])) : null;
  const transport = lib.getWorkerData(next ? { data: writer, next } : { data: writer }, { copy: false });
  const selectors = item.missing ? keys.map(name => `z${name.slice(1)}`) : keys;
  const scan = item.type === 'object' ? scanObjects : item.missing ? scanMissing : scanNumbers;
  const expected = item.missing ? count : values.reduce((sum, value) => sum + (item.type === 'object' ? value.id : value), 0);
  const expectedNext = expected + Math.ceil(count / 101);
  const iterations = Math.max(1, Math.ceil((item.warm ? 1048576 : item.type === 'object' ? 80000 : 262144) * (config.batchScale ?? 1) / count));
  for (let i = 0; i < config.warmups; i++) {
    const reader = await lib.initWorker(transport);
    equal(scan(reader.data, selectors), expected, 'Warmup checksum');
    if (next) equal(scan(reader.next, selectors), expectedNext, 'Warmup updated checksum');
  }
  const readers = [];
  if (item.warm || item.repeated) {
    const reader = await lib.initWorker(transport);
    equal(scan(reader.data, selectors), expected, 'Prime cached reader');
    for (let i = 0; i < iterations; i++) readers.push(reader);
  } else for (let i = 0; i < iterations; i++) readers.push(await lib.initWorker(transport));
  const before = state(lib, readers[0].data, true);
  collect();
  let checksum = 0;
  const start = performance.now();
  for (const reader of readers) {
    checksum += scan(reader.data, selectors);
    if (next) checksum += scan(reader.next, selectors);
  }
  const elapsedMs = performance.now() - start;
  equal(checksum, iterations * (expected + (next ? expectedNext : 0)), 'Measured checksum');
  // Check the exact values after timing; correctness never primes a cold reader.
  for (const reader of new Set(readers)) {
    verifyMap(reader.data, selectors, values, item);
    if (next) verifyMap(reader.next, selectors, values, item, true);
  }
  unchanged(lib, readers[0].data, before);
  const operations = iterations * count * (next ? 2 : 1);
  return { elapsedMs, operations, millisecondsPer10000: elapsedMs / operations * 10000, count, iterations, checksum,
    freshReaderPerIteration: !item.warm && !item.repeated, primedReader: !!item.warm || !!item.repeated, ordinaryGet: true,
    sharedBytesUnchanged: true, sharedArenaAllocationBytes: 0,
    sharedUsedBytes: before.reduce((sum, arena) => sum + arena.used, 0), sharedCapacityBytes: before.reduce((sum, arena) => sum + arena.capacity, 0) };
}

function verifyList(result, values, prefix, type) {
  equal(result.size, prefix.length + values.length, 'List size');
  for (let i = 0; i < result.size; i++) {
    const expected = i < prefix.length ? prefix[i] : values[i - prefix.length], actual = result.get(i);
    if (type === 'object') { equal(JSON.stringify(actual), JSON.stringify(expected), 'List JSON'); deeplyFrozen(actual); }
    else if (type === 'nested') {
      equal(actual.size, expected.size, 'Nested size');
      for (let j = 0; j < expected.size; j++) equal(actual.get(j), expected.get(j), 'Nested value');
    } else equal(actual, expected, 'List value');
  }
}
async function measureList(lib, item, config) {
  const count = config.count, descriptor = item.type === 'nested' ? 'SharedList<number>' : item.type;
  let pool;
  if (item.type === 'nested') {
    lib.resetSharedList();
    pool = Array.from({ length: 64 }, (_, i) => new lib.SharedList('number').pushMany([i, i + 1, i + 2]));
  }
  const values = Array.from({ length: count }, (_, i) => item.type === 'object' ? (item.valueStyle === 'large' ? { ...row(i), description: 'A longer JSON record with reusable description. '.repeat(8) } : row(i))
    : item.type === 'string' ? item.valueStyle === 'repeated' ? `kind-${i % 1024}` : item.valueStyle === 'ascii' ? `value-${i}` : `value-${i}-道路`
    : item.type === 'boolean' ? i % 3 !== 0 : item.type === 'nested' ? pool[i % pool.length] : i * 1.25);
  const prefix = item.append ? values.slice(0, Math.min(31, values.length)) : [];
  const makeBase = () => { lib.resetSharedList(); return new lib.SharedList(descriptor).pushMany(prefix); };
  for (let i = 0; i < config.warmups; i++) verifyList(makeBase().pushMany(values), values, prefix, item.type);
  // Cap distinct arenas for tiny-size controls; the report flags short batches.
  const iterations = Math.min(256, Math.max(1, Math.ceil((item.type === 'object' ? 80000 : item.type === 'string' || item.type === 'nested' ? 160000 : 1280000) * (config.batchScale ?? 1) / count)));
  const bases = Array.from({ length: iterations }, makeBase), before = bases.map(base => state(lib, base));
  const results = new Array(iterations);
  collect();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) results[i] = bases[i].pushMany(values);
  const elapsedMs = performance.now() - start;
  const allocations = [], capacities = [];
  for (let i = 0; i < iterations; i++) {
    verifyList(results[i], values, prefix, item.type);
    verifyList(bases[i], [], prefix, item.type);
    const after = state(lib, results[i]), owner = before[i][0].id;
    const ownerAfter = after.find(arena => arena.id === owner);
    check(ownerAfter, 'List owner was lost');
    allocations.push(ownerAfter.used - before[i][0].used);
    capacities.push(ownerAfter.capacity - before[i][0].capacity);
  }
  equal(new Set(allocations).size, 1, 'Allocation differs between identical builds');
  // Reader reconstruction occurs after timing and must retain the same values.
  const reader = (await lib.initWorker(payload(lib, results[0]))).data;
  const readerBefore = state(lib, reader, true);
  verifyList(reader, values, prefix, item.type); unchanged(lib, reader, readerBefore);
  const operations = iterations * count;
  return { elapsedMs, operations, millisecondsPer10000: elapsedMs / operations * 10000, count, iterations,
    retainedPrefixCount: prefix.length, sharedArenaAllocationBytesPerBuild: allocations[0],
    sharedCapacityGrowthBytesPerBuild: capacities[0], sharedReaderVerified: true,
    memoryScope: 'Owner shared arena only; excludes JavaScript heap and referenced nested arenas' };
}

function arrayIndexes(item) {
  const indexes = Array.from({ length: item.count }, (_, i) => i);
  if (item.order === 'stride') return indexes.filter(index => index % 4 === 0);
  if (item.order === 'reverse') return indexes.reverse();
  if (item.order === 'repeated') return indexes.fill(1023);
  if (item.order === 'random') {
    let seed = 0x69ae431b;
    for (let i = indexes.length - 1; i > 0; i--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const j = (seed >>> 0) % (i + 1); [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
  }
  return indexes;
}
function scanArray(view, indexes, outputs, offset) {
  for (let i = 0; i < indexes.length; i++) outputs[offset + i] = view.at(indexes[i]);
}
function scanFields(view, indexes, outputs, offset) {
  for (let i = 0; i < indexes.length; i++) outputs[offset + i] = view.get('id');
}
async function measureJsonArray(lib, item, config) {
  const values = Array.from({ length: item.count }, (_, i) => i * 1.25 - 100), indexes = arrayIndexes(item);
  const document = { id: 123, items: values, sibling: { value: 999 } };
  lib.resetMap();
  const writer = new lib.SharedMap('object').set('doc', document);
  const next = writer.set('doc', { ...document, items: [777] });
  const reader = await lib.initWorker(lib.getWorkerData({ data: writer, next }, { copy: false }));
  const makeView = () => {
    const view = reader.data.getView('doc');
    return item.order === 'fields' ? view : view.get('items');
  };
  const scan = item.order === 'fields' ? scanFields : scanArray;
  const expected = item.order === 'fields' ? indexes.map(() => 123) : indexes.map(index => values[index]);
  const warmOutput = new Float64Array(indexes.length);
  for (let i = 0; i < config.warmups; i++) {
    scan(makeView(), indexes, warmOutput, 0);
    for (let j = 0; j < expected.length; j++) equal(warmOutput[j], expected[j], 'Array warmup');
  }
  // Reverse/random are quadratic in both revisions; a smaller fixed batch
  // keeps those controls practical. Forward cases use enough calls for a
  // linear candidate to produce a useful batch without adapting to timings.
  const target = item.order === 'reverse' || item.order === 'random' ? 8192 : 262144;
  const iterations = Math.max(1, Math.ceil(target * (config.batchScale ?? 1) / indexes.length));
  const views = Array.from({ length: iterations }, makeView), outputs = new Float64Array(iterations * indexes.length);
  const before = state(lib, reader.data, true);
  collect();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) scan(views[i], indexes, outputs, i * indexes.length);
  const elapsedMs = performance.now() - start;
  let checksum = 0;
  for (let i = 0; i < outputs.length; i++) { equal(outputs[i], expected[i % expected.length], 'Measured array value'); checksum += outputs[i]; }
  const retained = reader.data.getView('doc'), selected = retained.get('items');
  equal(JSON.stringify(selected.toObject()), JSON.stringify(values), 'Retained array materialization');
  equal(selected.at(values.length), undefined, 'Array must stop before sibling bytes');
  equal(selected.at(values.length + 1), undefined, 'Array bounds after an out-of-range access');
  equal(selected.at(0), values[0], 'Rewinding after an out-of-range access');
  equal(retained.get('sibling').get('value'), 999, 'Nested sibling');
  equal(reader.next.getView('doc').get('items').at(0), 777, 'Updated snapshot');
  unchanged(lib, reader.data, before);
  const operations = indexes.length * iterations;
  return { elapsedMs, operations, millisecondsPer10000: elapsedMs / operations * 10000, count: values.length,
    selectedIndexes: indexes.length, iterations, checksum, freshViewPerIteration: true, ordinaryGet: false,
    operation: item.order === 'fields' ? 'JsonView.get' : 'JsonView.at', order: item.order,
    sharedBytesUnchanged: true, sharedArenaAllocationBytes: 0,
    sharedUsedBytes: before.reduce((sum, arena) => sum + arena.used, 0) };
}

export async function run(lib, config, rotation = 0) {
  check(Number.isSafeInteger(config.count) && config.count >= 32 && config.count <= 262144, 'Invalid count');
  check(Number.isSafeInteger(config.warmups) && config.warmups >= 0 && config.warmups <= 64, 'Invalid warmups');
  const selected = cases.filter(item => (!config.group || config.group === item.group) && (!config.only?.length || config.only.includes(item.name)));
  check(selected.length, 'No selected cases');
  for (const name of config.only ?? []) check(selected.some(item => item.name === name), `Unknown/excluded case ${name}`);
  lib.configureMemory({ maximumBytes: 256 * 1024 * 1024 });
  const offset = rotation % selected.length, order = [...selected.slice(offset), ...selected.slice(0, offset)], rows = [];
  for (const item of order) {
    collect();
    const measure = item.group === 'map' ? measureMap : item.group === 'list' ? measureList : measureJsonArray;
    rows.push({ name: item.name, ...await measure(lib, item, config) });
  }
  return { gcAvailable: typeof globalThis.gc === 'function' || typeof globalThis.Bun?.gc === 'function', rows };
}
