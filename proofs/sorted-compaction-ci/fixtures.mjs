import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const bytesDigest = value => createHash('sha256').update(value).digest('hex');
const align = (n, a) => Math.ceil(n / a) * a;
const decimal = i => String(i).padStart(4, '0');
const pc = word => { let n = 0; for (word >>>= 0; word; word = (word & (word - 1)) >>> 0) n++; return n; };
const encoder = new TextEncoder();

export function fixture(spec) {
  const keys = Object.freeze(Array.from({length: spec.size}, (_, i) => spec.shape === 'tiny' ? ['a', 'b'][i]
    : spec.shape === 'binary' ? i.toString(2).padStart(8, '0')
    : spec.shape === 'prefix' ? 'a'.repeat(i)
    : spec.shape === 'long' ? 'a'.repeat(4096) + i.toString().padStart(2, '0') : decimal(i)));
  const entries = Object.freeze(keys.map((key, i) => Object.freeze([key, i])));
  // JSON encoding is exactly 65,536 ASCII bytes, including the object syntax.
  const payload = Object.freeze({text: 'x'.repeat(65525)});
  assert.equal(JSON.stringify(payload).length, 65536);
  const changed = Object.freeze(keys.map((_, i) => i + 1000000));
  return {keys, entries, changed, payload, inputDigest: digest({keys, values: entries.map(x => x[1]), groupPayload: spec.shape === 'group' ? payload : null}), expectedDigest: digest(entries)};
}

function sumBacking(owners) { return [...owners].reduce((n, a) => n + a.memory.buffer.byteLength, 0); }
function keepSource(root) { return {root, descriptor: root.toWorkerData(), used: root.arena.used, payload: bytesDigest(root.arena.buf.subarray(65536, root.arena.used))}; }
function cold(owner) { assert.equal(owner.keys.size, 0); assert.equal(owner.reads, undefined); assert.equal(owner.valueMap, undefined); }
export function reset(api) { api.resetMap(); api.resetSortedMap(); }

export function setup(api, spec, input, operations, protocol) {
  const mapDefault = new api.SharedMap('number'), sortedDefault = new api.SharedSortedMap('number');
  let root = spec.shape === 'hamt' ? mapDefault : sortedDefault;
  for (const [key, value] of input.entries) root = root.set(key, value);
  if (spec.shape === 'hamt') assert.deepEqual(new Map(root.entries()), new Map(input.entries));
  else assert.deepEqual([...root.entries()], input.entries);
  const context = {root, outputs: new Array(operations), baseOwners: new Set([mapDefault.arena, sortedDefault.arena]),
    owners: new Set([mapDefault.arena, sortedDefault.arena]), records: [], sourceRoots: [root], restore: () => {}, readSources: []};
  if (spec.shape === 'group') {
    const fork = root.set(input.keys.at(-1), input.changed.at(-1));
    const parent = new api.SharedMap('SharedSortedMap<number>').set('child', root);
    const objects = new api.SharedMap('object').set('payload', input.payload);
    context.group = Object.freeze({base: root, fork, again: root, parent, objects});
    context.sourceRoots.push(fork, parent, objects);
  }
  for (const source of context.sourceRoots) { context.baseOwners.add(source.arena); context.owners.add(source.arena); }
  assert(sumBacking(context.baseOwners) <= protocol.memory.maximumSourceBackingBytes, 'Source-owner backing envelope');
  if (spec.shape === 'fallback') {
    // The only mutating fixture exception: an own method on this one Arena.
    // Neither its prototype, its snapshot identity nor its published bytes change.
    const owner = root.arena, originalOwn = Object.getOwnPropertyDescriptor(owner, 'radixLeaves'), original = owner.radixLeaves;
    const pointers = [...original.call(owner, root.root)], expected = [...pointers];
    assert.deepEqual(pointers.map(p => owner.leafKey(p)), input.keys);
    [expected[expected.length - 2], expected[expected.length - 1]] = [expected.at(-1), expected.at(-2)];
    Object.freeze(expected);
    const override = function* (r) { if (r === root.root) yield* expected; else yield* original.call(this, r); };
    Object.defineProperty(owner, 'radixLeaves', {value: override, writable: true, configurable: true});
    const check = () => { assert.equal(root.arena, owner); assert.equal(owner.radixLeaves, override); assert.deepEqual([...owner.radixLeaves(root.root)], expected); };
    check();
    context.fallback = {check, pointerOrderDigest: digest(expected), emittedKeyOrderDigest: digest(expected.map(p => owner.leafKey(p))),
      naturalKeyOrderDigest: digest(input.keys), lastTwoKeys: expected.slice(-2).map(p => owner.leafKey(p))};
    context.restore = () => {
      check();
      if (originalOwn) Object.defineProperty(owner, 'radixLeaves', originalOwn); else delete owner.radixLeaves;
      assert.equal(owner.radixLeaves, original); assert.deepEqual(Object.getOwnPropertyDescriptor(owner, 'radixLeaves'), originalOwn);
      assert.deepEqual([...owner.radixLeaves(root.root)], pointers);
    };
  }
  if (spec.operation === 'get') {
    assert.equal(operations % spec.size, 0);
    for (let i = 0; i < operations / spec.size; i++) {
      const value = api.compact(root); cold(value.arena); context.readSources.push(value); context.owners.add(value.arena);
      assert(value.arena.memory.buffer.byteLength <= spec.maximumResultOwnerBackingBytes);
    }
    context.sourceRoots.push(...context.readSources);
  } else if (spec.operation === 'set') {
    context.root = api.compact(root); cold(context.root.arena); context.owners.add(context.root.arena); context.sourceRoots.push(context.root);
    // Exact-root primitive value cache is warm for every cyclic target.
    for (const [key, value] of input.entries) assert.equal(context.root.get(key), value);
    for (const key of input.keys) {
      const slot = context.root.arena.reads.slot(key);
      assert.notEqual(slot, undefined); assert.equal(context.root.arena.reads.root(slot), context.root.root);
      assert.equal(context.root.arena.reads.code(slot), 2);
    }
    assert.equal(context.root.arena.keys.size, 1024);
  }
  context.records = context.sourceRoots.map(keepSource);
  context.beforeBacking = sumBacking(context.owners);
  assert(context.beforeBacking <= protocol.memory.maximumLiveBackingBytes);
  // Prospective bound includes every retained result owner and both default writers.
  const newOwners = spec.operation === 'compact' || spec.operation === 'compactMany' ? operations : 0;
  const writeGrowthBound = spec.operation === 'set' ? spec.maximumResultOwnerBackingBytes : 0;
  context.plannedBackingBound = context.beforeBacking + newOwners * spec.maximumResultOwnerBackingBytes + writeGrowthBound;
  assert(context.plannedBackingBound <= protocol.memory.maximumLiveBackingBytes, 'Prospective total live backing bound');
  return context;
}

export function runBody(api, spec, input, context, operations) {
  const out = context.outputs, root = context.root, keys = input.keys;
  if (spec.operation === 'compact') for (let i = 0; i < operations; i++) out[i] = api.compact(root);
  else if (spec.operation === 'compactMany') for (let i = 0; i < operations; i++) out[i] = api.compactMany(context.group);
  else if (spec.operation === 'get') for (let i = 0; i < operations; i++) out[i] = context.readSources[i >>> 10].get(keys[i & 1023]);
  else for (let i = 0; i < operations; i++) out[i] = root.set(keys[i & 1023], input.changed[i & 1023]);
}

export function postBodyCache(spec, input, context) {
  if (spec.operation !== 'set') return null;
  const reads = context.root.arena.reads;
  let exactSourceRoot = 0, primitiveCode = 0;
  for (const key of input.keys) {
    const slot = reads?.slot(key);
    if (slot !== undefined && reads.root(slot) === context.root.root) exactSourceRoot++;
    if (slot !== undefined && reads.code(slot) === 2) primitiveCode++;
  }
  return {initiallyPrimedSlots: 1024, retainedSourceRootSlotsAfterBody: exactSourceRoot, primitiveValueSlotsAfterBody: primitiveCode};
}

function sortedCensus(map, entries, arm, fallback) {
  const a = map.arena, dv = a.dv, leaves = [...a.radixLeaves(map.root)];
  const leafBytes = entries.reduce((n, [key]) => n + align(16 + encoder.encode(key).length + 8, 4), 0);
  const inputStart = align(65536 + leafBytes, 8), inputBytes = align(entries.length * 4, 8), branchStart = inputStart + inputBytes;
  let branchBytes = 0, branchAllocations = 0;
  const records = new Set();
  for (let p = branchStart; p < a.used;) {
    const degree = pc(dv.getUint32(p + 4, true)); assert(degree >= 2 && degree <= 17);
    assert(dv.getUint32(p, true) > 0 && dv.getUint32(p, true) !== 0xffffffff);
    const bytes = align(16 + degree * 4, 8); records.add(p); branchAllocations++; branchBytes += bytes; p += bytes;
    assert(p <= a.used);
  }
  const live = new Set(), pending = [map.root]; let reachableBranchBytes = 0;
  while (pending.length) {
    const p = pending.pop(); if (!dv.getUint32(p, true)) continue;
    assert(records.has(p)); assert(!live.has(p)); live.add(p);
    const degree = pc(dv.getUint32(p + 4, true)); reachableBranchBytes += align(16 + degree * 4, 8);
    for (let i = 0; i < degree; i++) pending.push(dv.getUint32(p + 16 + i * 4, true));
  }
  assert.equal(leaves.length, entries.length);
  if (arm === 'candidate' && !fallback) assert.equal(records.size, live.size);
  assert.equal(65536 + leafBytes + (inputStart - 65536 - leafBytes) + inputBytes + branchBytes, a.used);
  return {leafBytes, alignmentBeforeInput: inputStart - 65536 - leafBytes, inputBytes, branchBytes, branchAllocations,
    reachableBranchBytes, reachableBranches: live.size, abandonedBranches: records.size - live.size,
    usedBytes: a.used, backingBytes: a.memory.buffer.byteLength, ...(fallback ? {payloadSha256: bytesDigest(a.buf.subarray(65536, a.used))} : {})};
}

function entriesEqual(root, expected) { assert.equal(root.size, expected.length); assert.deepEqual([...root.entries()], expected); }
export function validate(spec, input, context, operations, protocol, arm) {
  const fingerprints = [], allocations = new Map(); let checksum = 0;
  const record = allocation => { const key = JSON.stringify(allocation); allocations.set(key, (allocations.get(key) ?? 0) + 1); };
  if (spec.operation === 'get') {
    for (let i = 0; i < operations; i++) { assert.equal(context.outputs[i], i & 1023); checksum += context.outputs[i]; }
    for (const root of context.readSources) {
      assert.equal(root.arena.keys.size, 1024); assert.equal(root.arena.reads.slots.size, 1024);
      for (const key of input.keys) { const slot = root.arena.reads.slot(key); assert.equal(root.arena.reads.root(slot), root.root); assert.equal(root.arena.reads.code(slot), 2); }
      entriesEqual(root, input.entries); record(sortedCensus(root, input.entries, arm, false));
    }
    fingerprints.push(input.expectedDigest);
  } else if (spec.operation === 'set') {
    for (let i = 0; i < operations; i++) {
      const result = context.outputs[i], k = i & 1023, other = (k + 1) & 1023;
      assert.notEqual(result, context.root); assert.equal(result.arena, context.root.arena); assert.equal(result.size, 1024);
      assert.equal(result.get(input.keys[k]), input.changed[k]); assert.equal(result.get(input.keys[other]), other); checksum += result.size;
    }
    for (const i of [0, operations - 1]) entriesEqual(context.outputs[i], input.entries.map(([key, value], k) => [key, k === (i & 1023) ? input.changed[k] : value]));
    assert(context.root.arena.memory.buffer.byteLength <= spec.maximumResultOwnerBackingBytes);
    const saved = context.records.find(x => x.root === context.root);
    record({initialUsedBytes: saved.used, usedBytes: context.root.arena.used, appendedBytes: context.root.arena.used - saved.used, backingBytes: context.root.arena.memory.buffer.byteLength, allResultsShareSourceOwner: true});
    fingerprints.push(digest({keys: input.keys, changed: input.changed, operations, eachResultForksRetainedSource: true}));
  } else for (const result of context.outputs) {
    const main = spec.operation === 'compactMany' ? result.base : result;
    context.owners.add(main.arena); assert(!context.baseOwners.has(main.arena));
    assert(main.arena.memory.buffer.byteLength <= spec.maximumResultOwnerBackingBytes);
    if (spec.shape === 'hamt') { assert.equal(main.size, input.entries.length); assert.deepEqual(new Map(main.entries()), new Map(input.entries)); }
    else entriesEqual(main, input.entries);
    checksum += main.size;
    if (spec.operation === 'compactMany') {
      assert.equal(result.again, result.base); assert.equal(result.fork.arena, main.arena); assert.equal(result.parent.arena, main.arena); assert.equal(result.objects.arena, main.arena);
      entriesEqual(result.fork, input.entries.map(([key, value], i) => [key, i === 255 ? input.changed[i] : value]));
      const nested = result.parent.get('child'); assert.deepEqual(nested.toWorkerData(), main.toWorkerData()); assert.equal(nested.arena, main.arena);
      const object = result.objects.get('payload'); assert.deepEqual(object, input.payload); assert(Object.isFrozen(object));
      const leaves = [...main.arena.radixLeaves(main.root)], forkLeaves = [...main.arena.radixLeaves(result.fork.root)];
      assert.deepEqual(leaves.slice(0, -1), forkLeaves.slice(0, -1)); assert.notEqual(leaves.at(-1), forkLeaves.at(-1));
      // Count unique reachable nodes; do not classify mixed raw allocation regions.
      const nodes = new Set(), pending = [main.root, result.fork.root];
      while (pending.length) {
        const p = pending.pop(); if (nodes.has(p)) continue; nodes.add(p);
        if (main.arena.dv.getUint32(p, true)) for (let j = 0; j < pc(main.arena.dv.getUint32(p + 4, true)); j++) pending.push(main.arena.dv.getUint32(p + 16 + j * 4, true));
      }
      for (const root of [result.parent.root, result.objects.root]) { assert.equal(main.arena.dv.getUint32(root, true), 0); nodes.add(root); }
      record({usedBytes: main.arena.used, backingBytes: main.arena.memory.buffer.byteLength, uniqueReachableNodes: nodes.size, uniqueSortedLeaves: new Set([...leaves, ...forkLeaves]).size,
        jsonPayloadBytes: encoder.encode(JSON.stringify(object)).length, nestedDescriptorBytes: main.arena.dv.getUint32([...main.arena.leaves(result.parent.root)][0] + 12, true)});
    } else if (spec.shape !== 'hamt') record(sortedCensus(main, input.entries, arm, spec.shape === 'fallback'));
    else record({usedBytes: main.arena.used, backingBytes: main.arena.memory.buffer.byteLength, reachableLeaves: [...main.arena.leaves(main.root)].length, rawBranchAllocationClassification: 'not attempted'});
    fingerprints.push(spec.shape === 'hamt' ? digest([...main.entries()]) : input.expectedDigest);
  }
  if (context.fallback) context.fallback.check();
  for (const saved of context.records) {
    assert.deepEqual(saved.root.toWorkerData(), saved.descriptor);
    assert.equal(bytesDigest(saved.root.arena.buf.subarray(65536, saved.used)), saved.payload);
    if (spec.operation !== 'set' || saved.root.arena !== context.root.arena) assert.equal(saved.root.arena.used, saved.used);
  }
  const liveBackingBytes = sumBacking(context.owners); assert(liveBackingBytes <= protocol.memory.maximumLiveBackingBytes);
  for (const owner of context.owners) assert(owner.memory.buffer.byteLength <= protocol.memory.maximumArenaBytes);
  const root = context.root; assert.equal(root.get(input.keys[0]), 0); assert.equal(root.set(input.keys[0], 0), root);
  // The explicit re-read above establishes the promised same-value identity precondition.
  for (const saved of context.records) assert.equal(bytesDigest(saved.root.arena.buf.subarray(65536, saved.used)), saved.payload);
  return {checksum, semanticDigest: digest({shape: spec.shape, operations, fingerprints, checksum}), expectedDigest: input.expectedDigest,
    resultCount: context.outputs.length, sourcePayloads: context.records.map(x => x.payload), liveBackingBytes,
    baseSourceBackingBytes: sumBacking(context.baseOwners), uniqueLiveOwners: context.owners.size,
    plannedBackingBound: context.plannedBackingBound, allocations: [...allocations].map(([value, count]) => ({...JSON.parse(value), count})),
    cacheState: spec.operation === 'get' ? 'one initially empty owner cache per 1024 distinct gets; all results retained' : spec.operation === 'set' ? 'initially 1024 exact-root primitive slots primed; later slots evolve naturally; each result forks original root' : 'source traversal only; outputs unqueried until validation',
    adversarialTraversal: context.fallback ? {pointerOrderDigest: context.fallback.pointerOrderDigest, emittedKeyOrderDigest: context.fallback.emittedKeyOrderDigest, lastTwoKeys: context.fallback.lastTwoKeys} : null};
}
