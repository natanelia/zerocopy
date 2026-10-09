import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const HEAP_START = 65536, BATCH_USED_BYTE_CAP = 64 * 1024 * 1024,
  WARMUP_USED_BYTE_CAP = 1024 * 1024 * 1024, WARMUP_BATCH_CAP = 256, REPEAT_CAP = 10000000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonDigest = value => digest(JSON.stringify(value));
export const CASES = Object.freeze([
  { name: 'linked-append-8192', structure: 'SharedLinkedList', operation: 'append', initialSize: 0, operationsPerIteration: 8192, target: true, rationale: 'Repeated blockAppend rotations during a public append history.' },
  { name: 'linked-prepend-256', structure: 'SharedLinkedList', operation: 'prepend', initialSize: 4096, operationsPerIteration: 256, target: true, rationale: 'Left-side blockInsert and block splitting from a fixed balanced tree.' },
  { name: 'doubly-mixed-insert-256', structure: 'SharedDoublyLinkedList', operation: 'insert', initialSize: 4096, operationsPerIteration: 256, target: true, rationale: 'Indexed insertion across both sides and full blocks using a fixed rank schedule.' },
  { name: 'vector-list-push-4096', structure: 'SharedList', operation: 'push', initialSize: 0, operationsPerIteration: 4096, target: false, rationale: 'Public list append control uses unchanged vector code.' },
  { name: 'vector-queue-enqueue-4096', structure: 'SharedQueue', operation: 'enqueue', initialSize: 0, operationsPerIteration: 4096, target: false, rationale: 'Public queue append control uses unchanged vector code and queue metadata.' },
  { name: 'linked-singleton-tail-append', structure: 'SharedLinkedList', operation: 'append', initialSize: 1, operationsPerIteration: 1, target: false, rationale: 'Small tailAppend control bypasses block balancing.' },
  { name: 'linked-first-block-append', structure: 'SharedLinkedList', operation: 'append', initialSize: 32, operationsPerIteration: 1, target: false, rationale: 'First blockAppend invokes the changed entry without any rotation.' },
  { name: 'doubly-delete-256', structure: 'SharedDoublyLinkedList', operation: 'delete', initialSize: 4096, operationsPerIteration: 256, target: false, rationale: 'Real blockDelete work, including collapsing blocks and rebalance, is unchanged.' },
  { name: 'linked-indexed-read-4096', structure: 'SharedLinkedList', operation: 'get', initialSize: 4096, operationsPerIteration: 4096, target: false, rationale: 'Full deterministic permuted indexed reads traverse unchanged blockGet.' },
].map(row => Object.freeze({ ...row, size: row.initialSize, category: row.target ? 'changed-target' : 'unchanged-control' })));
export function canonicalWorkload(supplied) {
  const result = CASES.find(row => row.name === supplied?.name);
  assert(result && JSON.stringify(result) === JSON.stringify(supplied), 'Expected exact frozen case'); return result;
}
const pins = JSON.parse(readFileSync(new URL('./block-reuse-allocation-pins.json', import.meta.url), 'utf8'));
export const allocationPins = () => pins;
const ownerOf = (api, item) => Object.getPrototypeOf(api.SharedLinkedList).owner(item);
const state = owner => ({ usedBytes: owner.used, capacityBytes: owner.memory.buffer.byteLength });
const prefix = owner => new Uint8Array(owner.memory.buffer, HEAP_START, owner.used - HEAP_START);
export function warmupWorkLimit(initialUsedBytes, worstBytesPerIteration) {
  assert(Number.isSafeInteger(initialUsedBytes) && initialUsedBytes >= HEAP_START && initialUsedBytes <= BATCH_USED_BYTE_CAP, 'Invalid initial arena size');
  assert(Number.isSafeInteger(worstBytesPerIteration) && worstBytesPerIteration >= 0, 'Invalid worst-case allocation cost');
  if (!worstBytesPerIteration) return REPEAT_CAP;
  const result = Math.floor((WARMUP_USED_BYTE_CAP - WARMUP_BATCH_CAP * initialUsedBytes) / worstBytesPerIteration);
  assert(Number.isSafeInteger(result) && result > 0, 'No mutation warmup fits the byte budget'); return result;
}
export function workloadLimits(workload, initialUsedBytes) {
  const pin = pins.rows?.[workload.name];
  assert(pin, 'Missing pre-timing allocation pin');
  const costs = [pin.baseline.first, pin.baseline.next, pin.candidate.first, pin.candidate.next];
  const worstBytesPerIteration = Math.max(...costs);
  const memoryCap = worstBytesPerIteration ? Math.floor((BATCH_USED_BYTE_CAP - initialUsedBytes) / worstBytesPerIteration) : Infinity;
  const repeatCap = Math.min(REPEAT_CAP, memoryCap);
  assert(repeatCap > 0);
  return { batchUsedByteCap: BATCH_USED_BYTE_CAP, warmupUsedByteCap: WARMUP_USED_BYTE_CAP, maxWarmupBatches: WARMUP_BATCH_CAP,
    maxWarmupScans: warmupWorkLimit(initialUsedBytes, worstBytesPerIteration), repeatCap, initialUsedBytes, worstBytesPerIteration,
    repeatCapReason: memoryCap <= REPEAT_CAP ? 'used-byte-budget' : 'global-repeat-limit',
    allocation: pin, bound: 'Maximum first/subsequent allocation from frozen clock-free equal-work observations; verified on every batch' };
}
const templates = new Map();
function template(workload) {
  if (templates.has(workload.name)) return templates.get(workload.name);
  const input = Array.from({ length: workload.operationsPerIteration }, (_, i) => 100000 + i),
    initial = Array.from({ length: workload.initialSize }, (_, i) => i), expected = [...initial], ranks = [];
  let midpoint, readSum = 0;
  for (let i = 0; i < input.length; i++) {
    if (['append','push','enqueue'].includes(workload.operation)) expected.push(input[i]);
    else if (workload.operation === 'prepend') expected.unshift(input[i]);
    else if (workload.operation === 'insert') { const rank = ((Math.imul(i + 1, 2654435761) >>> 0) % expected.length); ranks.push(rank); expected.splice(rank, 0, input[i]); }
    else if (workload.operation === 'delete') { ranks.push(0); expected.splice(0, 1); }
    else { const rank = Math.imul(i, 2053) & 4095; ranks.push(rank); readSum = (readSum + initial[rank]) | 0; }
    if (i + 1 === Math.floor(input.length / 2)) midpoint = [...expected];
  }
  const result = { initial, input, ranks, expected, midpoint, readSum,
    inputSha256: jsonDigest({ workload, initial, input, ranks }), expectedSha256: jsonDigest(expected) };
  templates.set(workload.name, result); return result;
}
export function fixture(api, supplied, { allowUnpinned = false } = {}) {
  const workload = canonicalWorkload(supplied), model = template(workload);
  api.configureMemory({ maximumBytes: BATCH_USED_BYTE_CAP });
  const Arena = ownerOf(api, new api.SharedLinkedList('number')).constructor, owner = new Arena({ id: 'block-reuse-' + workload.name });
  const Constructor = api[workload.structure];
  let item = workload.structure === 'SharedQueue' ? new Constructor('number', 0, 0, 0, undefined, owner)
    : new Constructor('number', 0, 0, 0, owner);
  if (workload.initialSize >= 4096) {
    // Unchanged blockBuild produces an identical compact balanced fixture in both arms.
    const data = owner.alloc(model.initial.length * 8);
    for (let i = 0; i < model.initial.length; i++) owner.dv.setFloat64(data + 8 * i, model.initial[i], true);
    const head = owner.wasm.blockBuild(data, model.initial.length / 32) >>> 0;
    item = new Constructor('number', head, 0, model.initial.length, owner, 0);
  } else for (const value of model.initial) item = item.append(value);
  const initial = state(owner), initialPayloadSha256 = digest(prefix(owner)), retained = { descriptor: item.toWorkerData() };
  const prepared = { item, owner, model, initial, initialPayloadSha256, retained,
    limits: allowUnpinned ? null : workloadLimits(workload, initial.usedBytes),
    expected: { count: workload.operation === 'get' ? model.initial.length : model.expected.length, value: model.readSum, completed: 1 } };
  assert.deepEqual(values(item), model.initial);
  if (!allowUnpinned) assert.deepEqual(fixtureIdentity(api, prepared), pins.rows[workload.name].fixture, 'Frozen fixture changed');
  return prepared;
}
function values(item) {
  if (typeof item.toArray === 'function') return item.toArray();
  const result = []; for (let q = item; !q.isEmpty; q = q.dequeue()) result.push(q.peek()); return result;
}
export function fixtureIdentity(api, prepared) {
  void api; return { schema: 'block-reuse-input/v1', descriptor: prepared.retained.descriptor,
    arena: { ...prepared.initial, sha256: prepared.initialPayloadSha256 }, inputSha256: prepared.model.inputSha256,
    outputSha256: prepared.model.expectedSha256, fixture: 'fresh empty/tail or unchanged balanced blockBuild with deterministic numeric values' };
}
export function runBatch(prepared, workload, repeat) {
  const { item, model } = prepared;
  let last = item, first = null, midpoint = null, rootSink = 0;
  const checksum = { count: 0, value: 0, completed: 0 };
  for (let j = 0; j < repeat; j++) {
    last = item;
    if (workload.operation === 'get') {
      for (let i = 0; i < model.ranks.length; i++) checksum.value = (checksum.value + item.get(model.ranks[i])) | 0;
    } else for (let i = 0; i < model.input.length; i++) {
      const value = model.input[i];
      if (workload.operation === 'append') last = last.append(value);
      else if (workload.operation === 'prepend') last = last.prepend(value);
      else if (workload.operation === 'insert') last = last.insertBefore(model.ranks[i], value);
      else if (workload.operation === 'delete') last = last.removeFirst();
      else if (workload.operation === 'push') last = last.push(value);
      else last = last.enqueue(value);
      if (j === 0 && i + 1 === Math.floor(model.input.length / 2)) midpoint = last;
    }
    if (j === 0) first = last;
    checksum.count += last.size; checksum.completed++; rootSink = (rootSink + (last.head ?? last.root ?? 0) + last.tail) | 0;
  }
  return { first, last, midpoint, rootSink, checksum };
}
export const allocationFor = (pin, repeat) => pin.first + (repeat - 1) * pin.next;
function blockShape(prepared, workload, item) {
  if (!['SharedLinkedList', 'SharedDoublyLinkedList'].includes(workload.structure)) return null;
  const { owner } = prepared, view = new DataView(owner.memory.buffer), seen = new Set(), shape = [];
  function visit(pointer) {
    if (!pointer) { shape.push(null); return { size: 0, height: 0 }; }
    assert(pointer >= HEAP_START && pointer + 24 <= owner.used && pointer % 8 === 0, 'Invalid block node');
    assert(!seen.has(pointer), 'Cycle or duplicate node in a snapshot'); seen.add(pointer);
    const left = view.getUint32(pointer, true), right = view.getUint32(pointer + 4, true), size = view.getUint32(pointer + 8, true),
      height = view.getUint32(pointer + 12, true), data = view.getUint32(pointer + 16, true), length = view.getUint32(pointer + 20, true);
    assert(length > 0 && length <= 32 && data >= HEAP_START && data + length * 8 <= owner.used);
    shape.push([size, height, length, Array.from({length}, (_, i) => view.getFloat64(data + 8 * i, true))]);
    const l = visit(left), r = visit(right);
    assert.equal(size, l.size + length + r.size); assert.equal(height, Math.max(l.height, r.height) + 1);
    assert(Math.abs(l.height - r.height) <= 1, 'Unbalanced AVL block tree'); return { size, height };
  }
  assert.equal(visit(item.head).size + item.tailSize, item.size);
  return jsonDigest(shape);
}
export function verifyBatch(prepared, workload, repeat, result, { allowUnpinned = false } = {}) {
  assert(Number.isSafeInteger(repeat) && repeat > 0);
  if (!allowUnpinned) assert(repeat <= prepared.limits.repeatCap);
  const { model, owner, item, expected } = prepared;
  assert.deepEqual(result.checksum, { count: expected.count * repeat, value: Math.imul(expected.value, repeat), completed: repeat });
  assert.deepEqual(item.toWorkerData(), prepared.retained.descriptor);
  assert.equal(digest(new Uint8Array(owner.memory.buffer, HEAP_START, prepared.initial.usedBytes - HEAP_START)), prepared.initialPayloadSha256, 'Old published bytes changed');
  assert.deepEqual(values(item), model.initial);
  assert.deepEqual(values(result.last), model.expected);
  if (result.first !== result.last) assert.deepEqual(values(result.first), model.expected);
  if (result.midpoint) assert.deepEqual(values(result.midpoint), model.midpoint);
  for (const snapshot of [item, result.first, result.midpoint].filter(Boolean)) blockShape(prepared, workload, snapshot);
  const outputShapeSha256 = blockShape(prepared, workload, result.last);
  const after = state(owner), usedDeltaBytes = after.usedBytes - prepared.initial.usedBytes;
  assert(after.usedBytes <= BATCH_USED_BYTE_CAP && after.capacityBytes <= BATCH_USED_BYTE_CAP);
  assert.equal(after.capacityBytes, Math.max(prepared.initial.capacityBytes, Math.ceil(after.usedBytes / HEAP_START) * HEAP_START));
  let allocationMatches = null;
  if (!allowUnpinned) {
    const pin = prepared.limits.allocation;
    const a = usedDeltaBytes === allocationFor(pin.baseline, repeat), b = usedDeltaBytes === allocationFor(pin.candidate, repeat);
    assert(a || b, 'Unexpected arena allocation'); allocationMatches = a && b ? 'both' : a ? 'baseline' : 'candidate';
  }
  globalThis.__blockReuseSink = { checksum: result.checksum, rootSink: result.rootSink };
  return { before: prepared.initial, after, usedDeltaBytes, capacityGrowthBytes: after.capacityBytes - prepared.initial.capacityBytes,
    growthPages: (after.capacityBytes - prepared.initial.capacityBytes) / HEAP_START, grew: after.capacityBytes !== prepared.initial.capacityBytes,
    allocationMatches, retainedSnapshotsChecked: 2 + (result.first !== result.last ? 1 : 0) + (result.midpoint ? 1 : 0),
    inputSha256: model.inputSha256, outputSha256: model.expectedSha256, outputShapeSha256 };
}
export function checkFixture(api, workload) {
  const prepared = fixture(api, workload), result = runBatch(prepared, workload, 2);
  return { name: workload.name, expected: prepared.expected, identity: fixtureIdentity(api, prepared), limits: prepared.limits,
    observations: verifyBatch(prepared, workload, 2, result) };
}
