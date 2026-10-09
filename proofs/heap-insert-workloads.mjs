import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const HEAP_START = 65536;
export const BATCH_USED_BYTE_CAP = 64 * 1024 * 1024;
export const WARMUP_USED_BYTE_CAP = 1024 * 1024 * 1024;
export const WARMUP_BATCH_CAP = 256;
const REPEAT_CAP = 10000000;
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonDigest = value => digest(JSON.stringify(value));

// One iteration is one complete chain/build, or one fixed-snapshot operation.
// Only the first two cases establish the gate's representative gain.
export const CASES = Object.freeze([
  ['min-random-4096-enqueue', 4096, false, 'random', 'enqueue', 'representative', true],
  ['max-random-4096-enqueue', 4096, true, 'random', 'enqueue', 'representative', true],
  ['min-improving-4096-enqueue', 4096, false, 'improving', 'enqueue', 'best-case', false],
  ['empty-single-enqueue', 1, false, 'single', 'enqueue', 'unchanged-control', false],
  ['singleton-tied-enqueue', 1, false, 'ties', 'enqueue', 'unchanged-control', false],
  ['min-worsening-4096-enqueue', 4096, false, 'worsening', 'enqueue', 'unchanged-control', false],
  ['min-4096-pop-256', 4096, false, 'random', 'pop', 'unchanged-control', false],
  ['min-4096-full-entries', 4096, false, 'random', 'entries', 'unchanged-control', false],
  ['singleton-map-set-number', 1, false, 'single', 'map-set', 'unchanged-control', false],
  ['singleton-list-push', 1, false, 'single', 'list-push', 'unchanged-control', false],
].map(([name, size, maxHeap, priorities, operation, category, target]) => Object.freeze({
  name, size, type: 'number', maxHeap, priorities, operation, category, target,
  operationsPerIteration: operation === 'pop' ? 256 : operation === 'entries' ? 1 : size,
  cache: 'numeric values; no internal cache edits',
  allocationMode: 'one fresh arena per batch; natural growth included; arena creation excluded',
})));

export function canonicalWorkload(workload) {
  const fixed = CASES.find(value => value.name === workload?.name);
  assert(fixed, 'Unknown predeclared workload');
  assert.deepEqual(workload, fixed, 'Workload differs from the frozen case');
  return fixed;
}
function randomPriorities(size) {
  const priorities = Array.from({ length: size }, (_, i) => i - (size >>> 1));
  let state = 0x12574;
  for (let i = size - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [priorities[i], priorities[j]] = [priorities[j], priorities[i]];
  }
  return priorities;
}

// Independent old-algorithm oracle. The allocation log includes discarded
// singleton and copied nodes, making raw controls identical to a baseline build.
function referenceArena() {
  const records = [];
  const node = (priority, value, left, right) => {
    if ((left?.rank ?? 0) < (right?.rank ?? 0)) [left, right] = [right, left];
    const result = { priority, value, left, right, rank: (right?.rank ?? 0) + 1,
      size: (left?.size ?? 0) + (right?.size ?? 0) + 1, ptr: HEAP_START + records.length * 32 };
    records.push(result); return result;
  };
  const merge = (a, b, maxHeap) => {
    if (!a) return b;
    if (!b) return a;
    if (maxHeap ? b.priority > a.priority : b.priority < a.priority) [a, b] = [b, a];
    return node(a.priority, a.value, a.left, merge(a.right, b, maxHeap));
  };
  return { records, insert: (root, priority, value, maxHeap) => merge(root, node(priority, value, null, null), maxHeap),
    pop: (root, maxHeap) => root ? merge(root.left, root.right, maxHeap) : null };
}
function promotes(root, priority, maxHeap) {
  while (root) {
    if (maxHeap ? priority > root.priority : priority < root.priority) return true;
    root = root.right;
  }
  return false;
}
function referenceShape(root) {
  const nodes = [], entries = [], pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) { nodes.push(null); continue; }
    nodes.push([node.priority, node.value, node.rank, node.size]);
    entries.push([node.value, node.priority]); pending.push(node.right, node.left);
  }
  return { sha256: jsonDigest(nodes), entries };
}
function referenceBytes(records) {
  const bytes = new Uint8Array(records.length * 32), view = new DataView(bytes.buffer);
  for (const node of records) {
    const at = node.ptr - HEAP_START;
    view.setFloat64(at, node.priority, true); view.setFloat64(at + 8, node.value, true);
    view.setUint32(at + 16, node.left?.ptr ?? 0, true); view.setUint32(at + 20, node.right?.ptr ?? 0, true);
    view.setUint32(at + 24, node.rank, true); view.setUint32(at + 28, node.size, true);
  }
  return bytes;
}
const zero = () => ({ count: 0, value: 0, priority: 0, paired: 0, completed: 0 });
function add(checksum, value, priority) {
  checksum.count++; checksum.value = (checksum.value + value) | 0;
  checksum.priority = (checksum.priority + priority) | 0;
  checksum.paired = (checksum.paired + Math.imul(value, priority + 101)) | 0;
}

const templates = new Map();
function templateFor(workload) {
  if (templates.has(workload.name)) return templates.get(workload.name);
  const priorities = workload.priorities === 'random' ? randomPriorities(workload.size)
    : Array.from({ length: workload.size }, (_, i) => workload.priorities === 'improving' ? -i
      : workload.priorities === 'worsening' ? i : 5);
  const input = Object.freeze(priorities.map((priority, i) => Object.freeze([i * 13 - 7, priority])));
  const model = referenceArena();
  let start = null, end = null, midpoint = null, promotions = 0, initialRecords = 0;
  if (workload.operation === 'pop' || workload.operation === 'entries') {
    for (const [value, priority] of input) start = model.insert(start, priority, value, workload.maxHeap);
    initialRecords = model.records.length; end = start;
    if (workload.operation === 'pop') for (let i = 0; i < 256; i++) {
      end = model.pop(end, workload.maxHeap); if (i === 127) midpoint = end;
    }
  } else if (workload.operation === 'enqueue') {
    if (workload.priorities === 'ties') start = model.insert(null, 5, 23, false);
    initialRecords = model.records.length; end = start;
    for (let i = 0; i < input.length; i++) {
      const [value, priority] = input[i];
      if (promotes(end, priority, workload.maxHeap)) promotions++;
      end = model.insert(end, priority, value, workload.maxHeap);
      if (i + 1 === Math.floor(input.length / 2)) midpoint = end;
    }
  }
  const initialPayload = referenceBytes(model.records.slice(0, initialRecords));
  const baselineBytesPerIteration = workload.operation === 'map-set' ? 28
    : workload.operation === 'list-push' ? 16 : (model.records.length - initialRecords) * 32;
  const candidateBytesPerIteration = baselineBytesPerIteration - promotions * 32;
  const outputSize = workload.operation === 'map-set' ? 1 : workload.operation === 'list-push' ? 2 : end?.size ?? 0;
  const expected = zero();
  if (workload.operation === 'entries') for (const [value, priority] of referenceShape(end).entries) add(expected, value, priority);
  else expected.count = outputSize;
  expected.completed = 1;
  const result = { input, initialPayload, start, end, midpoint, expected,
    startShape: referenceShape(start), endShape: referenceShape(end), midpointShape: midpoint ? referenceShape(midpoint) : null,
    baselineBytesPerIteration, candidateBytesPerIteration, promotions,
    inputChecksum: jsonDigest({ input, maxHeap: workload.maxHeap, operation: workload.operation,
      initial: workload.priorities === 'ties' ? [23, 5] : workload.operation === 'map-set' || workload.operation === 'list-push' ? [7] : [],
      changedValue: workload.operation === 'map-set' ? 11 : workload.operation === 'list-push' ? 13 : null }) };
  templates.set(workload.name, result); return result;
}

const constructors = new WeakMap();
function arenaConstructor(api) {
  if (!constructors.has(api)) {
    // The sole private seam: recover the built Arena during setup only.
    const Snapshot = Object.getPrototypeOf(api.SharedPriorityQueue);
    assert.equal(typeof Snapshot.owner, 'function');
    constructors.set(api, Snapshot.owner(new api.SharedPriorityQueue('number')).constructor);
  }
  return constructors.get(api);
}
const payload = owner => new Uint8Array(owner.memory.buffer, HEAP_START, owner.used - HEAP_START);
const memoryState = owner => ({ usedBytes: owner.used, capacityBytes: owner.memory.buffer.byteLength,
  declaredMaximumBytes: BATCH_USED_BYTE_CAP });
// Warmup work is separate from a single timed batch's repeat limit. Reserve
// every allowed arena header, then derive mutation work from the fixed byte cap.
export function warmupWorkLimit(initialUsedBytes, worstBytesPerIteration) {
  assert(Number.isSafeInteger(initialUsedBytes) && initialUsedBytes >= HEAP_START
    && initialUsedBytes <= BATCH_USED_BYTE_CAP, 'Invalid initial arena size');
  assert(Number.isSafeInteger(worstBytesPerIteration) && worstBytesPerIteration >= 0,
    'Invalid worst-case allocation cost');
  if (worstBytesPerIteration === 0) return REPEAT_CAP;
  const reserved = WARMUP_BATCH_CAP * initialUsedBytes;
  assert(Number.isSafeInteger(reserved), 'Unsafe reserved arena bytes');
  const remaining = WARMUP_USED_BYTE_CAP - reserved;
  const limit = Math.floor(remaining / worstBytesPerIteration);
  assert(Number.isSafeInteger(limit) && limit > 0, 'No mutation warmup fits the byte budget');
  return limit;
}

export function workloadLimits(workload, initialUsedBytes) {
  const model = templateFor(canonicalWorkload(workload)), bytes = model.baselineBytesPerIteration;
  const memoryRepeatCap = bytes ? Math.floor((BATCH_USED_BYTE_CAP - initialUsedBytes) / bytes) : Infinity;
  const repeatCap = Math.min(REPEAT_CAP, memoryRepeatCap);
  const maxWarmupScans = warmupWorkLimit(initialUsedBytes, bytes);
  assert(repeatCap > 0 && maxWarmupScans > 0);
  return { batchUsedByteCap: BATCH_USED_BYTE_CAP, warmupUsedByteCap: WARMUP_USED_BYTE_CAP,
    maxWarmupBatches: WARMUP_BATCH_CAP, maxWarmupScans, repeatCap, initialUsedBytes,
    repeatCapReason: memoryRepeatCap <= REPEAT_CAP ? 'used-byte-budget' : 'global-repeat-limit',
    worstBytesPerIteration: bytes, baselineBytesPerIteration: bytes,
    candidateBytesPerIteration: model.candidateBytesPerIteration,
    bound: workload.operation === 'list-push' ? '16 bytes worst; first frontier append uses 8'
      : 'exact fixed-sequence baseline allocation; candidate cannot exceed baseline' };
}

export function fixture(api, supplied) {
  const workload = canonicalWorkload(supplied), model = templateFor(workload);
  api.configureMemory({ maximumBytes: BATCH_USED_BYTE_CAP });
  const Arena = arenaConstructor(api), owner = new Arena({ id: 'heap-insert-' + workload.name });
  let item;
  if (workload.operation === 'map-set') item = new api.SharedMap('number', 0, 0, owner).set('k', 7);
  else if (workload.operation === 'list-push') item = new api.SharedList('number', 0, 0, 0, owner).push(7);
  else {
    if (model.initialPayload.length) {
      assert.equal(owner.alloc(model.initialPayload.length), HEAP_START);
      new Uint8Array(owner.memory.buffer).set(model.initialPayload, HEAP_START);
    }
    item = new api.SharedPriorityQueue('number', {
      root: model.start?.ptr ?? 0, size: model.start?.size ?? 0, isMaxHeap: workload.maxHeap,
    }, owner);
  }
  const initial = memoryState(owner), initialPayloadSha256 = digest(payload(owner));
  const prepared = { item, owner, input: model.input, expected: model.expected,
    limits: workloadLimits(workload, initial.usedBytes), model, initial, initialPayloadSha256,
    retained: { descriptor: item.toWorkerData() } };
  verifySnapshot(prepared, item, 'start'); return prepared;
}
export function fixtureIdentity(api, prepared) {
  void api;
  return { schema: 'heap-insert-input/v1', descriptor: prepared.retained.descriptor,
    arena: { ...prepared.initial, sha256: prepared.initialPayloadSha256 },
    inputSha256: prepared.model.inputChecksum, outputShapeSha256: prepared.model.endShape.sha256,
    midpointShapeSha256: prepared.model.midpointShape?.sha256 ?? null,
    source: prepared.model.initialPayload.length ? 'independent baseline allocation-log fixture' : 'fresh public numeric fixture',
    targetPromotionsPerIteration: prepared.model.promotions };
}
export function expectedBatch(expected, repeat) {
  return { count: expected.count * repeat, value: Math.imul(expected.value, repeat),
    priority: Math.imul(expected.priority, repeat), paired: Math.imul(expected.paired, repeat), completed: repeat };
}

// Runs between the two clock reads: no setup, heap introspection, explicit GC,
// hidden dequeue, per-operation timer, or array of arenas.
export function runBatch(prepared, workload, repeat) {
  const { item, input } = prepared, checksum = zero();
  let last = item, first = null, midpoint = null, rootSink = 0;
  if (workload.operation === 'enqueue') {
    for (let j = 0; j < repeat; j++) {
      last = item;
      for (let i = 0; i < input.length; i++) {
        last = last.enqueue(input[i][0], input[i][1]);
        if (j === 0 && i + 1 === Math.floor(input.length / 2)) midpoint = last;
      }
      if (j === 0) first = last;
      checksum.count += last.size; checksum.completed++; rootSink = (rootSink + last.root) | 0;
    }
  } else if (workload.operation === 'pop') {
    for (let j = 0; j < repeat; j++) {
      last = item;
      for (let i = 0; i < 256; i++) {
        last = last.dequeue(); if (j === 0 && i === 127) midpoint = last;
      }
      if (j === 0) first = last;
      checksum.count += last.size; checksum.completed++; rootSink = (rootSink + last.root) | 0;
    }
  } else if (workload.operation === 'entries') {
    for (let j = 0; j < repeat; j++) {
      for (const [value, priority] of item.entries()) add(checksum, value, priority);
      checksum.completed++;
    }
    first = last;
  } else if (workload.operation === 'map-set') {
    for (let j = 0; j < repeat; j++) {
      last = item.set('k', 11); if (j === 0) first = last;
      checksum.count += last.size; checksum.completed++; rootSink = (rootSink + last.root) | 0;
    }
  } else if (workload.operation === 'list-push') {
    for (let j = 0; j < repeat; j++) {
      last = item.push(13); if (j === 0) first = last;
      checksum.count += last.size; checksum.completed++; rootSink = (rootSink + last.tail) | 0;
    }
  } else throw new Error('Unknown operation');
  return { checksum, rootSink, last, first, midpoint };
}

function actualShape(owner, item) {
  const view = new DataView(owner.memory.buffer), nodes = [], seen = new Set(), pending = [item.root];
  while (pending.length) {
    const ptr = pending.pop();
    if (!ptr) { nodes.push(null); continue; }
    assert(ptr >= HEAP_START && ptr + 32 <= owner.used && ptr % 8 === 0, 'Invalid heap node address');
    assert(!seen.has(ptr), 'Cycle or repeated heap node'); seen.add(ptr);
    const priority = view.getFloat64(ptr, true), value = view.getFloat64(ptr + 8, true);
    const left = view.getUint32(ptr + 16, true), right = view.getUint32(ptr + 20, true);
    const rank = view.getUint32(ptr + 24, true), size = view.getUint32(ptr + 28, true);
    const lr = left ? view.getUint32(left + 24, true) : 0, rr = right ? view.getUint32(right + 24, true) : 0;
    assert(lr >= rr); assert.equal(rank, rr + 1);
    assert.equal(size, (left ? view.getUint32(left + 28, true) : 0) + (right ? view.getUint32(right + 28, true) : 0) + 1);
    for (const child of [left, right]) if (child) {
      const childPriority = view.getFloat64(child, true);
      assert(item.isMaxHeap ? priority >= childPriority : priority <= childPriority);
    }
    nodes.push([priority, value, rank, size]); pending.push(right, left);
  }
  assert.equal(seen.size, item.size); return jsonDigest(nodes);
}
function verifySnapshot(prepared, item, which) {
  const model = prepared.model;
  if (typeof item.enqueue === 'function') {
    const shape = which === 'start' ? model.startShape : which === 'midpoint' ? model.midpointShape : model.endShape;
    assert.equal(actualShape(prepared.owner, item), shape.sha256, `${which} heap topology`);
    assert.deepEqual([...item.entries()], shape.entries, `${which} public values/priorities`);
  } else if (typeof item.set === 'function' && typeof item.entries === 'function') {
    assert.deepEqual([...item.entries()], [['k', which === 'start' ? 7 : 11]]);
  } else assert.deepEqual(item.toArray(), which === 'start' ? [7] : [7, 13]);
}
export function verifyBatch(prepared, workload, repeat, result) {
  assert(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= prepared.limits.repeatCap);
  assert.deepEqual(result.checksum, expectedBatch(prepared.expected, repeat), 'Timed checksum');
  assert.deepEqual(prepared.item.toWorkerData(), prepared.retained.descriptor, 'Old descriptor changed');
  assert.equal(digest(new Uint8Array(prepared.owner.memory.buffer, HEAP_START,
    prepared.initial.usedBytes - HEAP_START)), prepared.initialPayloadSha256, 'Published starting bytes changed');
  verifySnapshot(prepared, prepared.item, 'start'); verifySnapshot(prepared, result.last, 'end');
  if (result.first !== result.last) verifySnapshot(prepared, result.first, 'end');
  if (result.midpoint) verifySnapshot(prepared, result.midpoint, 'midpoint');
  const after = memoryState(prepared.owner), usedDeltaBytes = after.usedBytes - prepared.initial.usedBytes;
  const allocations = [prepared.limits.baselineBytesPerIteration, prepared.limits.candidateBytesPerIteration]
    .map(bytes => repeat * bytes - (workload.operation === 'list-push' ? 8 : 0));
  assert(allocations.includes(usedDeltaBytes), 'Unexpected allocation total');
  assert(after.usedBytes <= prepared.limits.batchUsedByteCap, 'Batch exceeded used-byte cap');
  assert(after.capacityBytes <= prepared.limits.batchUsedByteCap, 'Batch exceeded capacity cap');
  assert.equal(after.capacityBytes, Math.max(prepared.initial.capacityBytes, Math.ceil(after.usedBytes / HEAP_START) * HEAP_START));
  // Escape scalar data only: completed batches must not retain arenas.
  globalThis.__heapInsertSink = { checksum: result.checksum, rootSink: result.rootSink };
  return { before: prepared.initial, after, usedDeltaBytes,
    capacityGrowthBytes: after.capacityBytes - prepared.initial.capacityBytes,
    growthPages: (after.capacityBytes - prepared.initial.capacityBytes) / HEAP_START,
    grew: after.capacityBytes !== prepared.initial.capacityBytes,
    allocationMatches: usedDeltaBytes === allocations[0] && usedDeltaBytes === allocations[1] ? 'both'
      : usedDeltaBytes === allocations[0] ? 'baseline' : 'candidate',
    retainedSnapshotsChecked: 2 + (result.first !== result.last ? 1 : 0) + (result.midpoint ? 1 : 0),
    inputSha256: prepared.model.inputChecksum, finalShapeSha256: prepared.model.endShape.sha256 };
}

// Clock-free, bounded fixture proof. Post-mutation observations are arm-specific.
export function checkFixture(api, workload) {
  const prepared = fixture(api, workload), identity = fixtureIdentity(api, prepared);
  const result = runBatch(prepared, workload, 2), observations = verifyBatch(prepared, workload, 2, result);
  return { name: workload.name, expected: prepared.expected, identity, limits: prepared.limits, observations };
}
