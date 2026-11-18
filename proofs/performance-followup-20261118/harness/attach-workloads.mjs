import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// One operation is one public attachment, or one private prepare call in the
// explicitly labeled diagnostics. Sizes never adapt to the measured revision.
export const cases = Object.freeze([
  ...[false, true].flatMap(firstGet => [
    { name: `attach.shared1${firstGet ? '.first-get' : ''}`, arenaCount: 1, copy: false, firstGet, batch: 1024 },
    { name: `attach.shared32${firstGet ? '.first-get' : ''}`, arenaCount: 32, copy: false, firstGet, batch: 32 },
    { name: `attach.copied1${firstGet ? '.first-get' : ''}`, arenaCount: 1, copy: true, firstGet, batch: 256 },
  ]),
  ...['number', 'boolean', 'interleaved'].map(mode => ({
    name: `diagnostic.prepare.${mode}`, mode, batch: 131072,
  })),
].map(value => Object.freeze(value)));

const probeIndices = [0, 1, 31, 32, 33, 64];
const minimumBatchMs = 50;
const immutableStart = 0;
const collect = () => typeof globalThis.gc === 'function' ? globalThis.gc() : globalThis.Bun?.gc?.(true);
function digestBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function digest(memory, used) {
  return digestBytes(new Uint8Array(memory.buffer, immutableStart, used - immutableStart));
}
function equalValues(actual, expected, label) {
  assert(Array.isArray(actual), `${label}: observations must be an ordinary Array`);
  assert.equal(actual.length, expected.length, `${label}: observation count`);
  for (let i = 0; i < actual.length; i++) {
    if (!Object.is(actual[i], expected[i])) assert.fail(`${label}: value ${i} differs (${String(actual[i])} / ${String(expected[i])})`);
  }
}
function sourceState(lib, structures) {
  return lib.getWorkerData(structures, { copy: false }).arenas.map(source => ({
    id: source.id, memory: source.memory, used: source.used,
    capacity: source.memory.buffer.byteLength, hash: digest(source.memory, source.used),
  }));
}
function verifySources(lib, structures, before) {
  const after = sourceState(lib, structures);
  assert.equal(after.length, before.length);
  after.forEach((value, i) => {
    assert.equal(value.memory, before[i].memory);
    assert.equal(value.used, before[i].used);
    assert.equal(value.capacity, before[i].capacity);
    assert.equal(value.hash, before[i].hash);
  });
}
function makeAttachment(lib, spec, operations) {
  const structures = {}, names = [], values = [];
  for (let a = 0; a < spec.arenaCount; a++) {
    lib.resetSharedList();
    const input = Array.from({ length: 65 }, (_, i) => i === 0 ? -0 : i === 1 ? NaN
      : i === 32 ? Infinity : i === 33 ? -(a + 0.5) : a * 1000 + i + 0.25);
    const name = `list${a}`;
    structures[name] = new lib.SharedList('number').pushMany(input);
    names.push(name); values.push(input);
  }
  const source = sourceState(lib, structures);
  const payload = lib.getWorkerData(structures, { copy: spec.copy });
  assert.equal(payload.arenas.length, spec.arenaCount);
  const copiedPayloads = new Map(payload.arenas.filter(value => value.copy).map(value => {
    assert.equal(value.copy.byteLength, value.used);
    return [value.id, { bytes: value.copy, hash: digestBytes(value.copy) }];
  }));
  const firstExpected = new Array(spec.firstGet ? operations * spec.arenaCount : 0);
  if (spec.firstGet) for (let i = 0; i < operations; i++) for (let a = 0; a < names.length; a++) {
    firstExpected[i * names.length + a] = values[a][probeIndices[(i + a) % probeIndices.length]];
  }
  return { structures, names, values, source, payload, copiedPayloads, firstExpected };
}
async function measureAttachment(lib, spec, fixture, operations) {
  const { structures, names, values, source, payload, copiedPayloads, firstExpected } = fixture;
  const readers = new Array(operations), observed = new Array(firstExpected.length);
  collect();
  const start = performance.now();
  if (spec.firstGet) {
    for (let i = 0; i < operations; i++) {
      const reader = readers[i] = await lib.initWorker(payload);
      for (let a = 0; a < names.length; a++) {
        observed[i * names.length + a] = reader[names[a]].get(probeIndices[(i + a) % probeIndices.length]);
      }
    }
  } else {
    for (let i = 0; i < operations; i++) readers[i] = await lib.initWorker(payload);
  }
  const elapsedMs = performance.now() - start;
  equalValues(observed, firstExpected, spec.name);
  assert.equal(new Set(readers).size, operations, 'Every attachment must produce a distinct reader');

  // Each reader's own heap end and capacity are checked. Shared backing memory
  // is hashed once per batch, while every independently copied memory is hashed.
  const expectedById = new Map(source.map(value => [value.id, value]));
  const checkedMemories = new Set(), memoryHashes = new Set(), checkedArenas = new Set(), checkedWasm = new Set();
  const probes = [], expectedProbes = [];
  for (const reader of readers) {
    assert(Object.isFrozen(reader));
    for (const structure of Object.values(reader)) {
      assert(structure.arena.readOnly);
      checkedArenas.add(structure.arena); checkedWasm.add(structure.arena.wasm);
    }
    const exported = lib.getWorkerData(reader, { copy: false });
    assert.equal(exported.arenas.length, source.length);
    for (const arena of exported.arenas) {
      const expected = expectedById.get(arena.id);
      assert(expected);
      assert.equal(arena.used, expected.used);
      const expectedCapacity = spec.copy ? Math.max(131072, Math.ceil(expected.used / 65536) * 65536) : expected.capacity;
      assert.equal(arena.memory.buffer.byteLength, expectedCapacity);
      assert.equal(arena.memory === expected.memory, !spec.copy);
      if (!checkedMemories.has(arena.memory)) {
        const hash = digest(arena.memory, arena.used);
        assert.equal(hash, expected.hash);
        if (spec.copy) assert.equal(digestBytes(new Uint8Array(arena.memory.buffer, 0, arena.used)), copiedPayloads.get(arena.id).hash);
        checkedMemories.add(arena.memory); memoryHashes.add(hash);
      }
    }
    for (let a = 0; a < names.length; a++) {
      assert(Object.isFrozen(reader[names[a]]));
      for (const index of probeIndices) {
        probes.push(reader[names[a]].get(index)); expectedProbes.push(values[a][index]);
      }
    }
  }
  equalValues(probes, expectedProbes, `${spec.name} untimed probes`);
  for (const reader of [readers[0], readers.at(-1)]) {
    assert.throws(() => reader[names[0]].push(999), /read-only/);
  }
  verifySources(lib, structures, source);
  for (const value of copiedPayloads.values()) assert.equal(digestBytes(value.bytes), value.hash);
  assert.equal(checkedMemories.size, spec.copy ? operations * spec.arenaCount : spec.arenaCount);
  assert.equal(checkedArenas.size, operations * spec.arenaCount);
  assert.equal(checkedWasm.size, checkedArenas.size);
  return {
    name: spec.name, elapsedMs, operations, operation: spec.firstGet ? 'public initWorker plus first List.get per arena' : 'public initWorker attachment',
    millisecondsPer10000: elapsedMs / operations * 10000,
    millisecondsPer10000Arenas: elapsedMs / (operations * spec.arenaCount) * 10000,
    tinyBatch: elapsedMs < minimumBatchMs, minimumBatchMs,
    firstGet: spec.firstGet, copied: spec.copy, arenasPerAttachment: spec.arenaCount,
    checkedReaders: readers.length, checkedArenaStates: checkedArenas.size, checkedReaderWasmInstances: checkedWasm.size,
    checkedUniqueMemories: checkedMemories.size, verifiedRawValues: observed.length + probes.length,
    rawObservationType: 'Array', equality: 'Object.is', immutableStart,
    sourceUsedBytes: source.map(value => value.used), sourceCapacityBytes: source.map(value => value.capacity),
    immutableHashes: [...memoryHashes], readOnlyRejections: 2,
    checkedInitialPayloads: spec.copy ? checkedMemories.size : 0,
    copiedPayloadHashes: [...copiedPayloads.values()].map(value => value.hash),
  };
}

function makePrepare(lib, spec, operations) {
  lib.resetSharedList();
  const structures = { list0: new lib.SharedList('number').push(1.5) };
  // Internal access is confined to this diagnostic; public attachment timing
  // above uses only exported collection and worker transport operations.
  const arena = structures.list0.arena;
  const source = sourceState(lib, structures);
  const numbers = [0, -0, 1.5, -13.5, Number.MIN_VALUE, Infinity, -Infinity, NaN];
  const inputs = new Array(operations), types = new Array(operations), expected = [];
  const native = new Uint8Array(8), view = new DataView(native.buffer);
  for (let i = 0; i < operations; i++) {
    const number = spec.mode === 'number' || spec.mode === 'interleaved' && (i & 1) === 0;
    const position = spec.mode === 'interleaved' ? i >>> 1 : i;
    types[i] = number ? 'number' : 'boolean';
    inputs[i] = number ? numbers[position % numbers.length] : Boolean(position & 1);
    if (number) {
      view.setFloat64(0, inputs[i], true); expected.push(8);
      for (let j = 0; j < 8; j++) expected.push(native[j]);
    } else expected.push(1, inputs[i] ? 1 : 0);
  }
  // The diagnostic measures repeated preparation after first use.
  if (spec.mode !== 'boolean') arena.prepare('number', 0);
  if (spec.mode !== 'number') arena.prepare('boolean', false);
  return { structures, arena, source, inputs, types, expected };
}
function measurePrepare(lib, spec, fixture, operations) {
  const { structures, arena, source, inputs, types, expected } = fixture;
  const observed = new Array(expected.length);
  let cursor = 0;
  collect();
  const start = performance.now();
  for (let i = 0; i < operations; i++) {
    const prepared = arena.prepare(types[i], inputs[i]);
    observed[cursor++] = prepared.byteLength;
    const width = types[i] === 'number' ? 8 : 1;
    for (let j = 0; j < width; j++) observed[cursor++] = prepared[j];
  }
  const elapsedMs = performance.now() - start;
  equalValues(observed, expected, spec.name);
  assert.equal(cursor, expected.length);
  verifySources(lib, structures, source);
  return {
    name: spec.name, elapsedMs, operations, operation: 'private prepare plus raw byte observation',
    millisecondsPer10000: elapsedMs / operations * 10000,
    tinyBatch: elapsedMs < minimumBatchMs, minimumBatchMs, diagnosticOnly: true,
    verifiedRawValues: observed.length, rawObservationType: 'Array', equality: 'Object.is',
    checkedArenaStates: 1, checkedUniqueMemories: 1, immutableStart,
    sourceUsedBytes: source.map(value => value.used), sourceCapacityBytes: source.map(value => value.capacity),
    immutableHashes: source.map(value => value.hash),
  };
}

export async function run(lib, config = {}, rotation = 0) {
  const warmups = config.warmups ?? 2, batchScale = config.batchScale ?? 1;
  assert(Number.isInteger(warmups) && warmups >= 0, 'warmups must be a nonnegative integer');
  assert(Number.isFinite(batchScale) && batchScale > 0, 'batchScale must be positive');
  const requested = config.caseNames ?? config.only;
  const names = requested === undefined ? cases.map(value => value.name)
    : Array.isArray(requested) ? requested : String(requested).split(',').filter(Boolean);
  const selected = cases.filter(value => names.includes(value.name));
  assert.equal(selected.length, new Set(names).size, 'Unknown or empty case selection');
  assert(selected.length > 0, 'Select at least one case');
  const offset = ((rotation % selected.length) + selected.length) % selected.length;
  const ordered = selected.slice(offset).concat(selected.slice(0, offset)), rows = [];
  for (const spec of ordered) {
    const operations = Math.max(1, Math.round(spec.batch * batchScale));
    const fixture = spec.mode ? makePrepare(lib, spec, operations) : makeAttachment(lib, spec, operations);
    const measure = spec.mode ? measurePrepare : measureAttachment;
    for (let i = 0; i < warmups; i++) await measure(lib, spec, fixture, operations);
    rows.push(await measure(lib, spec, fixture, operations));
  }
  return { rows };
}
