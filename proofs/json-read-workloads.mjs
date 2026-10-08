/** Portable public-API workloads shared by the process and browser proofs. */
export const jsonReadCases = [
  { name: 'cold-map-flat', collection: 'map', shape: 'flat', phase: 'cold' },
  { name: 'cold-list-flat', collection: 'list', shape: 'flat', phase: 'cold' },
  { name: 'cold-map-feature', collection: 'map', shape: 'feature', phase: 'cold' },
  { name: 'cold-list-feature', collection: 'list', shape: 'feature', phase: 'cold' },
  { name: 'cold-list-coordinates', collection: 'list', shape: 'coordinates', phase: 'cold' },
  { name: 'cold-list-numbers', collection: 'list', shape: 'numbers', phase: 'cold' },
  { name: 'warm-map-json', collection: 'map', shape: 'flat', phase: 'warm' },
  { name: 'warm-list-json', collection: 'list', shape: 'flat', phase: 'warm' },
  { name: 'warm-stack-json', collection: 'stack', shape: 'flat', phase: 'warm' },
  { name: 'warm-queue-json', collection: 'queue', shape: 'flat', phase: 'warm' },
  { name: 'saturated-map-json', collection: 'map', shape: 'flat', phase: 'saturated' },
  { name: 'saturated-list-json', collection: 'list', shape: 'flat', phase: 'saturated' },
  ...['cold', 'warm'].flatMap(phase => ['number', 'string'].flatMap(shape =>
    ['map', 'list'].map(collection => ({ name: `${phase}-${collection}-${shape}`, collection, shape, phase })))),
];

export function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

function check(condition, message) { if (!condition) throw new Error(message); }

function equal(actual, expected, message) {
  const pending = [[actual, expected]];
  while (pending.length) {
    const [left, right] = pending.pop();
    if (right === null || typeof right !== 'object') { check(Object.is(left, right), message); continue; }
    check(left !== null && typeof left === 'object' && Array.isArray(left) === Array.isArray(right), message);
    const keys = Object.keys(right);
    check(Object.keys(left).length === keys.length, message);
    if (Array.isArray(right)) check(left.length === right.length, message);
    for (const key of keys) {
      check(Object.hasOwn(left, key), message);
      pending.push([left[key], right[key]]);
    }
  }
}

function frozenTree(value, expected, message) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object') continue;
    check(Object.isFrozen(item) === expected, message);
    for (const key of Object.keys(item)) pending.push(item[key]);
  }
}

function coordinates(index) {
  return Array.from({ length: 128 }, (_, point) =>
    [-115 + index / 1024 + point / 1048576, 36 + point / 1048576, 624 + point / 8]);
}

function fixture(shape, index) {
  if (shape === 'number') return index + 0.125;
  if (shape === 'string') return `lane-${index}-Singapore-\u65b0\u52a0\u5761`;
  if (shape === 'coordinates') return coordinates(index);
  if (shape === 'numbers') return Array.from({ length: 512 }, (_, item) => index + item / 8);
  if (shape === 'feature') return {
    type: 'Feature', id: index,
    properties: { roadId: `road-${index >>> 3}`, laneType: 'driving', speedLimit: 45, width: 3.75,
      turnDirections: ['left', 'straight'], connections: [{ lane: index + 1, relation: 'successor' }, { lane: index - 1, relation: 'predecessor' }] },
    geometry: { type: 'LineString', coordinates: coordinates(index) },
  };
  return Object.fromEntries([['id', index], ...Array.from({ length: 31 }, (_, field) => [`attribute${field}`, index + field])]);
}

function consumer(shape) {
  if (shape === 'number') return value => value;
  if (shape === 'string') return value => value.length;
  if (shape === 'coordinates') return value => value.length + value[0][0];
  if (shape === 'numbers') return value => value.length + value[0];
  if (shape === 'feature') return value => value.id + value.geometry.coordinates.length;
  return value => value.id + value.attribute0;
}

/** Setup attaches a new reader for every sample. Cold cases do not decode any
 * measured values before timing. Warm cases prime each measured value once.
 * Saturated cases first decode 2,048 earlier flat records, outside timing.
 * Stack/queue cases read 512 (by default) retained snapshots, not one constant
 * top value. All construction and descriptor work is outside the timed region.
 */
export function createJsonReadWorkload(api, spec, requestedCount, requestedPasses = 32) {
  // Short primitive reads need more records to stay above coarse timer noise.
  const count = spec.phase === 'cold' && (spec.shape === 'number' || spec.shape === 'string')
    ? Math.max(8192, requestedCount) : requestedCount;
  const offset = spec.phase === 'saturated' ? 2048 : 0;
  check(spec.phase !== 'warm' || count <= 2048, 'Warm cases require at most 2,048 cached values');
  const total = count + offset, passes = spec.phase === 'warm' ? requestedPasses : 1;
  const values = Array.from({ length: total }, (_, index) => fixture(spec.shape, index));
  // Native JSON semantics are the independent expected-value oracle.
  const expected = values.map(value => JSON.parse(JSON.stringify(value)));
  const keys = Array.from({ length: total }, (_, index) => `record-${index}`);
  const type = spec.shape === 'number' || spec.shape === 'string' ? spec.shape : 'object';
  const owners = Object.create(null);
  if (spec.collection === 'map') {
    api.resetMap(); owners.value = new api.SharedMap(type).setMany(values.map((value, index) => [keys[index], value]));
  } else if (spec.collection === 'list') {
    api.resetSharedList(); owners.value = new api.SharedList(type).pushMany(values);
  } else if (spec.collection === 'stack') {
    api.resetStack(); let value = new api.SharedStack(type);
    for (let index = 0; index < count; index++) { value = value.push(values[index]); owners[`snapshot${index}`] = value; }
  } else if (spec.collection === 'queue') {
    api.resetQueue(); let value = new api.SharedQueue(type);
    for (const item of values) value = value.enqueue(item);
    for (let index = 0; index < count; index++) { owners[`snapshot${index}`] = value; value = value.dequeue(); }
  } else throw new Error('Unknown collection');

  const names = Object.keys(owners), payload = api.getWorkerData(owners, { copy: false });
  check(payload.arenas.length === 1 && payload.arenas[0].memory, 'Expected one shared arena');
  const initial = payload.arenas[0];
  const descriptors = names.map(name => owners[name].toWorkerData());
  let readers, snapshots;
  const read = spec.collection === 'map' ? index => snapshots[0].get(keys[index])
    : spec.collection === 'list' ? index => snapshots[0].get(index)
    : index => snapshots[index].peek();
  const consume = consumer(spec.shape);
  let expectedChecksum = 0;
  for (let pass = 0; pass < passes; pass++) for (let index = offset; index < total; index++) expectedChecksum += consume(expected[index]);

  function storage() {
    const owner = api.getWorkerData(owners, { copy: false });
    check(owner.arenas.length === 1 && owner.arenas[0].memory === initial.memory, 'Owner arena changed');
    check(owner.arenas[0].used === initial.used, 'A read allocated owner bytes');
    equal(names.map(name => owners[name].toWorkerData()), descriptors, 'Owner descriptors changed');
    if (readers) {
      const reader = api.getWorkerData(readers, { copy: false });
      check(reader.arenas.length === 1 && reader.arenas[0].memory === initial.memory, 'Reader arena changed');
      check(reader.arenas[0].used === initial.used, 'A read allocated reader bytes');
      equal(names.map(name => readers[name].toWorkerData()), descriptors, 'Reader descriptors changed');
    }
    return { allocatedBytes: initial.used - 65536, usedBytes: initial.used,
      backingBytes: initial.memory.buffer.byteLength, descriptors,
      payload: new Uint8Array(initial.memory.buffer, 65536, initial.used - 65536) };
  }

  return {
    requestedCount, count, totalValues: total, operations: count * passes, passes, snapshotCount: names.length,
    fixture: { shape: spec.shape, jsonBytes: new TextEncoder().encode(JSON.stringify(expected[0])).length,
      coordinateCount: spec.shape === 'coordinates' || spec.shape === 'feature' ? 128 : undefined,
      numberCount: spec.shape === 'numbers' ? 512 : undefined },
    async setup() {
      readers = await api.initWorker(payload); snapshots = names.map(name => readers[name]);
      if (spec.phase === 'warm') for (let index = 0; index < total; index++) read(index);
      if (spec.phase === 'saturated') for (let index = 0; index < offset; index++) read(index);
    },
    run() {
      let checksum = 0;
      for (let pass = 0; pass < passes; pass++) for (let index = offset; index < total; index++) checksum += consume(read(index));
      return checksum;
    },
    verify(checksum) {
      check(Object.is(checksum, expectedChecksum), 'Read checksum differs from the fixture');
      for (let index = 0; index < total; index++) {
        const actual = read(index);
        equal(actual, expected[index], 'Decoded value differs from native JSON');
        frozenTree(actual, true, 'Decoded JSON is not deeply frozen');
        frozenTree(values[index], false, 'Caller input was frozen');
        equal(values[index], expected[index], 'Caller input was changed');
      }
      return storage();
    },
    storage,
  };
}
