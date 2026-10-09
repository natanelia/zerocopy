// Fixed public-API fixture construction and read-only diagnostics. No clocks.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const hex4 = n => n.toString(16).padStart(4, '0');
export const key = (i, group = 0) => `g${hex4(group)}/k${hex4(i)}`;
export const missKey = i => `g0000/k0/${i.toString(16).padStart(3, '0')}`;
export const doomedKey = i => `doomed${hex4(i)}`;
export const longKey = i => 'L'.repeat(16381) + hex4(i);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export const owner = snapshot => snapshot.arena;
export const untimedCounts = spec => [spec.ladder[0], spec.ladder.at(-1)];
export function arenaFootprint(arenas, measured, outputSlots, maximumArenaBytes) {
  const unique = [...new Set(arenas)], measuredSet = new Set(measured);
  const live = unique.map(arena => {
    const capacity = arena.memory.buffer.byteLength, used = arena.used;
    assert(capacity <= maximumArenaBytes, 'Per-arena capacity'); assert(used <= capacity);
    return {capacity, used};
  });
  const summedArenaCapacity = live.reduce((sum, value) => sum + value.capacity, 0);
  return {liveOwners: unique.length, measuredOwners: measuredSet.size, summedArenaCapacity,
    summedArenaUsed: live.reduce((sum, value) => sum + value.used, 0),
    measuredArenaCapacity: unique.reduce((sum, arena, i) => sum + (measuredSet.has(arena) ? live[i].capacity : 0), 0),
    outputSlots, outputReferenceBytesAt8PerSlot: outputSlots * 8,
    arenaCapacityPlusOutputReferencesAt8: summedArenaCapacity + outputSlots * 8};
}

export function sourceIndex(kind, i) {
  if (kind === 'cold-small') return i >>> 4;
  if (kind === 'cold-large') return i >>> 12;
  if (kind === 'cold-miss') return i >>> 11;
  if (kind === 'stale') return (i & 1) ^ 1;
  return 0;
}
export function queryIndex(kind, i) {
  if (kind === 'cold-small' || kind === 'cold-miss') return i & 2047;
  if (kind === 'cold-large') return i & 4095;
  if (kind === 'stale') return (i >>> 1) & 1023;
  if (kind === 'warm' || kind === 'control') return i & 1023;
  if (kind === 'cached-miss') return i & 15;
  return 0;
}
export function expectedPool(kind, operations) {
  if (kind === 'cold-small') return {owners: Math.ceil(operations / 2048), sources: operations / 16, sourceEntries: operations};
  if (kind === 'cold-large') return {owners: Math.ceil(operations / 4096), sources: Math.ceil(operations / 4096), sourceEntries: Math.ceil(operations / 4096) * 4096};
  if (kind === 'cold-miss') return {owners: Math.ceil(operations / 2048), sources: Math.ceil(operations / 2048), sourceEntries: Math.ceil(operations / 2048) * 4096};
  return {owners: 1, sources: kind === 'stale' ? 2 : 1};
}

const record = (snapshot, entries) => ({snapshot, entries, model: new Map(entries)});
const frozenEntries = entries => Object.freeze(entries.map(entry => Object.freeze(entry)));
function build(api, entries, control = false) {
  let snapshot = new (control ? api.SharedMap : api.SharedSortedMap)('number');
  for (const [k, value] of entries) snapshot = snapshot.set(k, value);
  return snapshot;
}
export function createTemplate(api, spec) {
  if (spec.kind === 'control') api.resetMap(); else api.resetSortedMap();
  const records = [];
  if (spec.kind === 'cold-small') {
    for (let group = 0; group < 128; group++) {
      const entries = frozenEntries(Array.from({length: 16}, (_, i) => [key(i, group), i]));
      records.push(record(build(api, entries), entries));
    }
  } else {
    let entries = Array.from({length: spec.size}, (_, i) => [spec.kind === 'long' ? longKey(i) : key(i), i]);
    if (spec.kind === 'cached-miss') entries.push(...Array.from({length: 16}, (_, i) => [doomedKey(i), 4096 + i]));
    entries = frozenEntries(entries);
    const original = build(api, entries, spec.kind === 'control');
    records.push(record(original, entries));
    if (spec.kind === 'stale') {
      const nextEntries = frozenEntries(entries.map(([k, value], i) => [k, i === 4095 ? 8191 : value]));
      records.push(record(original.set(key(4095), 8191), nextEntries));
    }
  }
  const inputs = Object.freeze(records.map(r => r.entries));
  return {records, inputs, inputDigest: digest(inputs), owners: [...new Set(records.map(r => owner(r.snapshot)))]};
}

function requireCold(arena) {
  assert.equal(arena.keys.size, 0, 'Compaction target key tokens must start empty');
  assert.equal(arena.reads, undefined, 'Compaction target ReadCache must start unallocated');
}
function requireCanonical(snapshot) {
  assert(snapshot.root > 0);
  assert.notEqual(owner(snapshot).dv.getUint32(snapshot.root, true), 0xffffffff);
}
function requireSlot(source, query, present) {
  const arena = owner(source), slot = arena.reads?.slot(query);
  assert.notEqual(slot, undefined, 'Expected an existing ReadCache slot');
  assert.equal(arena.reads.root(slot), source.root);
  assert.equal(arena.reads.leaf(slot) !== 0, present);
  assert(arena.reads.keyLeaf(slot) >= 65536);
}

export function prepareChunk(api, spec, template, operations, checkpoint = () => {}) {
  assert(spec.ladder.includes(operations), 'Only literal frozen ladder entries are admitted');
  const sources = [], records = [], retained = [], measuredOwners = new Set();
  const add = (snapshot, sourceRecord) => {
    sources.push(snapshot); records.push(record(snapshot, sourceRecord.entries));
    measuredOwners.add(owner(snapshot));
  };
  let queries;
  if (spec.kind === 'cold-small') {
    queries = template.records.flatMap(r => r.entries.map(([k]) => k));
    for (let start = 0; start < operations; start += 2048) {
      const count = Math.min(128, (operations - start) / 16), input = Object.create(null);
      for (let j = 0; j < count; j++) input[`g${j}`] = template.records[j].snapshot;
      const group = api.compactMany(input);
      for (let j = 0; j < count; j++) add(group[`g${j}`], template.records[j]);
      requireCold(owner(group.g0)); checkpoint([...measuredOwners]);
    }
  } else if (spec.kind === 'cold-large' || spec.kind === 'cold-miss') {
    queries = Array.from({length: spec.kind === 'cold-miss' ? 2048 : 4096}, (_, i) => spec.kind === 'cold-miss' ? missKey(i) : key(i));
    const stride = spec.kind === 'cold-miss' ? 2048 : 4096;
    for (let start = 0; start < operations; start += stride) {
      const source = api.compact(template.records[0].snapshot);
      requireCold(owner(source)); add(source, template.records[0]); checkpoint([...measuredOwners]);
      if (spec.kind === 'cold-miss') {
        const view = owner(source).dv, position = view.getUint32(source.root, true) - 3;
        const digit = ((queries[0].charCodeAt(position >>> 1) >>> ((position & 1) ? 0 : 4)) & 15) + 1;
        assert.equal(view.getUint32(source.root + 4, true) & (1 << digit), 0, 'Adverse miss must fail at first varying branch');
      }
    }
  } else if (spec.kind === 'stale') {
    const pair = api.compactMany({A: template.records[0].snapshot, B: template.records[1].snapshot});
    requireCold(owner(pair.A)); assert.equal(owner(pair.A), owner(pair.B)); assert.notEqual(pair.A.root, pair.B.root);
    add(pair.A, template.records[0]); add(pair.B, template.records[1]);
    queries = Array.from({length: 1024}, (_, i) => key(i));
    for (const query of queries) assert.equal(pair.A.has(query), true);
    for (const query of queries) requireSlot(pair.A, query, true);
  } else {
    let source = api.compact(template.records[0].snapshot);
    requireCold(owner(source));
    let entries = template.records[0].entries;
    if (spec.kind === 'cached-miss') {
      const positive = source; retained.push(record(positive, entries));
      queries = Array.from({length: 16}, (_, i) => doomedKey(i));
      for (const query of queries) assert.equal(positive.has(query), true);
      for (const query of queries) source = source.delete(query);
      entries = frozenEntries(entries.filter(([k]) => !k.startsWith('doomed')));
      for (const query of queries) assert.equal(source.has(query), false);
      for (const query of queries) requireSlot(source, query, false);
    } else if (spec.kind === 'journal') {
      retained.push(record(source, entries));
      for (let i = 0; i < 4; i++) source = source.set(key(i), 8192 + i);
      entries = frozenEntries(entries.map(([k, value], i) => [k, i < 4 ? 8192 + i : value]));
      assert.equal(owner(source).dv.getUint32(source.root, true), 0xffffffff);
      assert.equal(owner(source).dv.getUint32(source.root + 12, true), 4);
      queries = [key(256)]; assert.equal(source.has(queries[0]), true); requireSlot(source, queries[0], true);
    } else if (spec.kind === 'long') {
      queries = [longKey(0)]; assert.equal(queries[0].length, 16385);
      assert.equal(source.has(queries[0]), true); requireSlot(source, queries[0], true);
    } else {
      queries = Array.from({length: 1024}, (_, i) => key(i));
      if (spec.kind === 'warm') {
        for (const query of queries) assert.equal(source.has(query), true);
        for (const query of queries) requireSlot(source, query, true);
      } else assert.equal(spec.kind, 'control');
    }
    add(source, {entries});
  }
  for (const source of sources) {
    assert.equal(source.size, spec.size);
    if (spec.kind !== 'journal') requireCanonical(source);
  }
  const expected = expectedPool(spec.kind, operations);
  assert.equal(sources.length, expected.sources); assert.equal(measuredOwners.size, expected.owners);
  const queryDigest = digest(queries);
  return {sources, records, retained, queries: Object.freeze(queries), queryDigest,
    measuredOwners: [...measuredOwners], allOwners: [...new Set([...template.owners, ...measuredOwners])], operations};
}

// The branches are chosen once per body. The loop performs public calls and
// identical preallocated reference stores; returned roots are not inspected.
export function performDeletes(spec, bundle, outputs) {
  const sources = bundle.sources, queries = bundle.queries, n = outputs.length;
  switch (spec.kind) {
    case 'cold-small': for (let i = 0; i < n; i++) outputs[i] = sources[i >>> 4].delete(queries[i & 2047]); break;
    case 'cold-large': for (let i = 0; i < n; i++) outputs[i] = sources[i >>> 12].delete(queries[i & 4095]); break;
    case 'cold-miss': for (let i = 0; i < n; i++) outputs[i] = sources[i >>> 11].delete(queries[i & 2047]); break;
    case 'stale': for (let i = 0; i < n; i++) outputs[i] = sources[(i & 1) ^ 1].delete(queries[(i >>> 1) & 1023]); break;
    case 'warm': case 'control': for (let i = 0; i < n; i++) outputs[i] = sources[0].delete(queries[i & 1023]); break;
    case 'cached-miss': for (let i = 0; i < n; i++) outputs[i] = sources[0].delete(queries[i & 15]); break;
    case 'journal': case 'long': for (let i = 0; i < n; i++) outputs[i] = sources[0].delete(queries[0]); break;
    default: assert.fail('Unknown prospective case');
  }
}

export function cacheSummary(arenas) {
  return arenas.map(arena => ({keys: arena.keys.size, keyBytes: arena.keyBytes,
    readEntries: arena.reads?.slots.size ?? 0, readChars: arena.reads?.chars ?? 0,
    readAllocated: arena.reads !== undefined, valueRoot: arena.valueRoot,
    primitiveEntries: arena.valueMap?.size ?? 0}));
}
export function verifyPostCache(spec, bundle) {
  const {sources, queries, measuredOwners, operations} = bundle;
  if (spec.kind === 'cold-small' || spec.kind === 'cold-large' || spec.kind === 'cold-miss') {
    const stride = spec.kind === 'cold-large' ? 4096 : 2048;
    measuredOwners.forEach((arena, index) => {
      const count = Math.min(stride, operations - index * stride);
      assert.equal(arena.keys.size, Math.min(count, 2048));
      assert.equal(arena.reads.slots.size, spec.kind === 'cold-miss' ? 0 : count);
      assert.equal(arena.keyBytes, Math.min(count, 2048) * (spec.kind === 'cold-miss' ? 12 : 11));
      assert.equal(arena.reads.chars, spec.kind === 'cold-miss' ? 0 : count * 11);
      for (const token of arena.keys.values()) assert.equal(token.ptr !== undefined, spec.kind !== 'cold-miss');
    });
    if (spec.kind !== 'cold-miss') for (let i = 0; i < operations; i++) requireSlot(sources[sourceIndex(spec.kind, i)], queries[queryIndex(spec.kind, i)], true);
  } else if (spec.kind === 'control') {
    requireCold(owner(sources[0]));
  } else {
    const source = sources[0]; // Every stale ladder count is an even full pair.
    for (const query of queries) requireSlot(source, query, spec.kind !== 'cached-miss');
    if (spec.kind === 'journal') {
      assert.equal(owner(source).dv.getUint32(source.root, true), 0xffffffff);
      assert.equal(owner(source).dv.getUint32(source.root + 12, true), 4);
    }
  }
}

function validateEntries(snapshot, expected, sorted) {
  const actual = [...snapshot.entries()];
  assert.equal(snapshot.size, expected.size); assert.deepEqual(new Map(actual), expected);
  if (sorted) assert.deepEqual(actual.map(([k]) => k), [...expected.keys()].sort());
}
export function validateOutputs(spec, template, bundle, outputs, retained) {
  const miss = spec.kind === 'cold-miss' || spec.kind === 'cached-miss';
  for (let i = 0; i < outputs.length; i++) {
    const source = bundle.sources[sourceIndex(spec.kind, i)], output = outputs[i];
    assert.equal(output.size, spec.size - (miss ? 0 : 1)); assert.equal(owner(output), owner(source));
    if (miss) assert.equal(output, source); else {
      assert.notEqual(output, source);
      assert.equal(output.has(bundle.queries[queryIndex(spec.kind, i)]), false);
      requireCanonical(output);
    }
  }
  if (spec.kind === 'cached-miss') for (const query of bundle.queries) assert.equal(bundle.sources[0].has(query), false);
  if (spec.kind === 'cold-miss') for (let i = 0; i < outputs.length; i++) assert.equal(bundle.sources[sourceIndex(spec.kind, i)].has(bundle.queries[queryIndex(spec.kind, i)]), false);
  // Fixed full-result samples avoid an O(work * mapSize) validation.
  for (const i of new Set([0, Math.floor((outputs.length - 1) / 2), outputs.length - 1])) {
    const expected = new Map(bundle.records[sourceIndex(spec.kind, i)].model);
    if (!miss) expected.delete(bundle.queries[queryIndex(spec.kind, i)]);
    validateEntries(outputs[i], expected, spec.kind !== 'control');
  }
  for (const r of [...bundle.records, ...bundle.retained]) validateEntries(r.snapshot, r.model, spec.kind !== 'control');
  for (const [arena, state] of retained) {
    assert.equal(bytesDigest(arena.buf.subarray(65536, state.used)), state.payload);
    if (miss) { assert.equal(arena.used, state.used); assert.equal(arena.memory.buffer.byteLength, state.capacity); }
  }
  assert.equal(digest(template.inputs), template.inputDigest); assert.equal(digest(bundle.queries), bundle.queryDigest);
  // Output reads have moved shared cache slots. Re-prime the retained source
  // only after all post-body cache, payload and input checks are complete.
  for (const r of bundle.records) {
    const [k, value] = r.entries[0];
    assert.equal(r.snapshot.get(k), value);
    assert.equal(r.snapshot.set(k, value), r.snapshot);
  }
}

export async function correctnessPrelude(api) {
  api.resetSortedMap();
  const empty = new api.SharedSortedMap('number'); assert.equal(empty.delete('absent'), empty);
  const singleton = api.compact(empty.set('one', 1));
  assert.equal(singleton.delete('one').size, 0); assert.equal(singleton.get('one'), 1);
  const normalize = text => new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(text));
  const raw = [['', 1], ['\ufeffx', 2], ['é/界/🙂', 3], ['alias-\ud800', 4], ['alias-\ufffd', 5]];
  let source = new api.SharedSortedMap('number'); const model = new Map();
  for (const [k, value] of raw) { source = source.set(k, value); model.set(normalize(k), value); }
  source = api.compact(source);
  for (const query of [...raw.map(([k]) => k), 'alias-\udfff', 'absent']) {
    const expected = new Map(model), found = expected.delete(normalize(query)), next = source.delete(query);
    if (!found) assert.equal(next, source);
    validateEntries(next, expected, false); // Unicode byte order is not JS UTF-16 order.
  }
  const journal = singleton.set('two', 2); assert.equal(journal.delete('absent'), journal);
  const long = api.compact(empty.set(longKey(0), 7).set('short', 8));
  assert.equal(long.delete(longKey(1)), long);
  const reader = (await api.initWorker(api.getWorkerData({source}, {copy: true}))).source;
  assert.throws(() => reader.delete('absent'), /read-only/);
  validateEntries(reader, model, false);
  api.resetSortedMap();
  return {passed: true, scope: 'small public fallback, Unicode alias, old-root, singleton, empty and read-only checks; no deep-trap replay'};
}
