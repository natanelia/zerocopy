// Prospective fixed sorted-journal delete subject. Public APIs only.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;
const HEAP_START = 65536;
const ARENA_LIMIT = 128 * MiB;
const SETUP_LIMIT = 8 * MiB;
const BUILDER_LIMIT = 16 * MiB;
const CHILD_LIMIT = 8 * 1024 * MiB;
const STUDY_LIMIT = 128 * 1024 * MiB;
const INITIALIZATION_RESERVATION = 112 * MiB;
const JOURNAL = 0xffffffff;
const PREFIX = 'p'.repeat(1024);
const REPLACEMENTS = [256, 1024, 2048, 3072];
const SMALL_REPLACEMENTS = [1, 4, 8, 12];
const ROWS = [
  { id: 'P', template: 'T', setup: 'four', target: 2048, unitBytes: 4096, maxCount: 16384 },
  { id: 'S16', template: 'S', setup: 'four', target: 8, unitBytes: 2048, maxCount: 32768 },
  { id: 'R1', template: 'T', setup: 'one', target: 2048, unitBytes: 2048, maxCount: 32768 },
  { id: 'N4', template: 'T', setup: 'new', target: 4098, unitBytes: 4096, maxCount: 16384 },
  { id: 'G1', template: 'G', setup: 'g', target: 'ac', unitBytes: 64, maxCount: 1048576 },
  { id: 'B0', template: 'T', setup: 'four', target: 512, unitBytes: 4096, maxCount: 16384 },
  { id: 'C0', template: 'T', setup: 'none', target: 2048, unitBytes: 1024, maxCount: 65536 },
  { id: 'M0', template: 'T', setup: 'four', target: 8192, unitBytes: 0, maxCount: 1048576 },
  { id: 'L4', template: 'L', setup: 'four', target: 2048, unitBytes: 4096, maxCount: 16384 },
  { id: 'X4', template: 'T', setup: 'none', target: 2048, unitBytes: 4096, maxCount: 16384 },
  { id: 'I4', template: 'T', setup: 'four', target: 2048, unitBytes: 4096, maxCount: 256 },
];

const engine = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';
const version = engine === 'node' ? process.versions.node : globalThis.Bun.version;
const mode = process.argv[4];
const templates = Object.create(null);
const templateReceipts = Object.create(null);
const accountedArenaIds = new Set(); // Strings only; no arena or snapshot references.
const ledger = [];
const cases = [];
const initialization = { reservationBytes: INITIALIZATION_RESERVATION, templates: [], replay: null, defaultArena: null };
let api;
let emptyDefault;
let timer = null;
let cumulativePayloadBytes = 0;
let studyAllowance = 0;
let accountingComplete = true;

class SubjectFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireThat(condition, code) { if (!condition) throw new SubjectFailure(code); }
function failureCode(error) { return error instanceof SubjectFailure ? error.code : 'unexpected_subject_error'; }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function finiteJson(value) {
  if (Number.isFinite(value)) return value;
  return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
}
function key(i, long = false) { return (long ? PREFIX : '') + 'k' + i.toString(16).padStart(4, '0'); }
function targetKey(row) { return typeof row.target === 'string' ? row.target : key(row.target, row.template === 'L'); }
function templateEntries(name) {
  if (name === 'G') return [['aa', 0], ['ab', 1]];
  const count = name === 'S' ? 16 : 4096;
  return Array.from({ length: count }, (_, i) => [key(i, name === 'L'), i]);
}
function setupEntries(row) {
  if (row.setup === 'none') return [];
  if (row.setup === 'g') return [['ac', 2]];
  const indices = row.setup === 'one' ? [2048] : row.setup === 'new' ? [4096, 4097, 4098, 4099]
    : row.template === 'S' ? SMALL_REPLACEMENTS : REPLACEMENTS;
  return indices.map(i => [key(i, row.template === 'L'), 10000 + i]);
}
function modelEntries(base, pending, deleted = null) {
  const model = new Map(base);
  for (const [k, v] of pending) model.set(k, v);
  if (deleted !== null) model.delete(deleted);
  return [...model].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function sameEntries(actual, expected, code) {
  requireThat(actual.length === expected.length, `${code}_length`);
  for (let i = 0; i < expected.length; i++) {
    requireThat(actual[i][0] === expected[i][0] && Object.is(actual[i][1], expected[i][1]), `${code}_entry`);
  }
}

// This helper returns only scalar metadata. Its exported payload cannot escape.
function arenaReceipt(map) {
  const exported = api.getWorkerData({ map }, { copy: false });
  requireThat(exported.__shared === true && exported.version === 4 && exported.arenas.length === 1, 'one_arena_transport');
  const descriptor = exported.structures.map;
  const arena = exported.arenas[0];
  requireThat(descriptor.type === 'SharedSortedMap' && descriptor.arena === arena.id, 'transport_identity');
  requireThat(descriptor.data.root === map.root && descriptor.data.size === map.size && descriptor.data.valueType === 'number', 'transport_descriptor');
  requireThat(arena.memory && !arena.copy, 'live_memory_receipt');
  const used = arena.used;
  const capacity = arena.memory.buffer.byteLength;
  requireThat(Number.isSafeInteger(used) && used >= HEAP_START && used <= capacity && capacity <= ARENA_LIMIT, 'arena_frontier');
  return { arenaId: arena.id, used, capacity, payloadBytes: used - HEAP_START, root: map.root >>> 0, size: map.size };
}

// All byte inspection, full public reads, and graph/model checks are untimed.
// The closure, view, memory, transport object, graph, and models die on return.
function inspectMap(map, expected, spec = {}) {
  const exported = api.getWorkerData({ map }, { copy: false });
  requireThat(exported.__shared === true && exported.version === 4 && exported.arenas.length === 1, 'shape_one_arena');
  const descriptor = exported.structures.map;
  const arena = exported.arenas[0];
  requireThat(descriptor.arena === arena.id && descriptor.type === 'SharedSortedMap' && descriptor.data.valueType === 'number', 'shape_descriptor_type');
  requireThat(descriptor.data.root === map.root && descriptor.data.size === map.size, 'shape_descriptor_value');
  requireThat(arena.memory && !arena.copy, 'shape_live_memory');
  const buffer = arena.memory.buffer; // Reacquired on each inspection, including after growth.
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const used = arena.used;
  requireThat(Number.isSafeInteger(used) && used >= HEAP_START && used <= buffer.byteLength && buffer.byteLength <= ARENA_LIMIT, 'shape_frontier');
  function bounds(p, n, alignment = 4) {
    requireThat(Number.isSafeInteger(p) && Number.isSafeInteger(n) && p >= HEAP_START && n >= 0 && p % alignment === 0 && p <= used && n <= used - p, 'allocated_record_bounds');
  }
  function leaf(p) {
    bounds(p, 16);
    requireThat(view.getUint32(p, true) === 0, 'leaf_tag');
    const length = view.getUint32(p + 8, true);
    const valueLength = view.getUint32(p + 12, true);
    requireThat(valueLength === 8 && length <= 1029, 'numeric_leaf_lengths');
    bounds(p, Math.ceil((16 + length + valueLength) / 4) * 4);
    let hash = 2166136261;
    for (let i = 0; i < length; i++) {
      const c = bytes[p + 16 + i];
      requireThat(c < 128, 'fixture_ascii_key');
      hash = Math.imul(hash ^ c, 16777619) >>> 0;
    }
    requireThat(view.getUint32(p + 4, true) === hash, 'leaf_hash');
    const k = String.fromCharCode(...bytes.subarray(p + 16, p + 16 + length));
    const value = view.getFloat64(p + 16 + length, true);
    requireThat(Number.isFinite(value), 'finite_numeric_leaf');
    return { pointer: p, key: k, value, keyPointer: p + 16, keyLength: length };
  }
  const visited = new Set();
  function canonical(root, previous = -1) {
    if (root === 0) return [];
    bounds(root, 16);
    requireThat(!visited.has(root), 'canonical_acyclic_unique_nodes');
    visited.add(root);
    const tag = view.getUint32(root, true);
    requireThat(tag !== JOURNAL, 'no_nested_journal');
    if (tag === 0) return [leaf(root)];
    requireThat(tag >= 3, 'canonical_branch_tag');
    const critical = tag - 3;
    const bitmap = view.getUint32(root + 4, true);
    requireThat(critical > previous && critical < 2058 && (bitmap & ~0x1ffff) === 0, 'branch_order_and_bitmap');
    let children = 0;
    for (let d = 0; d <= 16; d++) if (bitmap & (1 << d)) children++;
    requireThat(children >= 2, 'branch_child_count');
    bounds(root, Math.ceil((16 + 4 * children) / 8) * 8, 8);
    const leaves = [];
    let offset = 0;
    for (let digit = 0; digit <= 16; digit++) {
      if (!(bitmap & (1 << digit))) continue;
      const child = view.getUint32(root + 16 + 4 * offset++, true);
      requireThat(child !== 0, 'nonzero_branch_child');
      const members = canonical(child, critical);
      for (const item of members) {
        const i = critical >>> 1;
        const actual = i < item.keyLength ? ((bytes[item.keyPointer + i] >>> ((critical & 1) ? 0 : 4)) & 15) + 1 : 0;
        requireThat(actual === digit, 'branch_digit_membership');
        leaves.push(item);
      }
    }
    requireThat(view.getUint32(root + 8, true) === leaves.length, 'native_subtree_size');
    const representative = view.getUint32(root + 12, true);
    requireThat(leaves.some(item => item.pointer === representative), 'representative_membership');
    for (let i = 1; i < leaves.length; i++) requireThat(leaves[i - 1].key < leaves[i].key, 'canonical_sorted_unique_keys');
    return leaves;
  }
  let tag = 0;
  if (map.root !== 0) { bounds(map.root, 16); tag = view.getUint32(map.root, true); }
  const rootKind = map.root === 0 ? 'empty' : tag === JOURNAL ? 'journal' : tag === 0 ? 'leaf' : 'branch';
  if (spec.kind === 'canonical') requireThat(rootKind !== 'journal', 'expected_canonical_root');
  if (spec.kind === 'journal') requireThat(rootKind === 'journal', 'expected_journal_root');
  let baseRoot = null;
  let canonicalLeaves;
  const pending = [];
  if (rootKind === 'journal') {
    bounds(map.root, 16, 8);
    const count = view.getUint32(map.root + 12, true);
    requireThat(count >= 1 && count <= 4, 'bounded_pending_count');
    bounds(map.root, Math.ceil((16 + count * 4) / 8) * 8, 8);
    baseRoot = view.getUint32(map.root + 4, true);
    requireThat(baseRoot !== 0 && baseRoot < map.root, 'journal_base_relation');
    if (spec.baseRoot !== undefined) requireThat(baseRoot === spec.baseRoot, 'expected_base_root');
    canonicalLeaves = canonical(baseRoot);
    if (spec.baseEntries) sameEntries(canonicalLeaves.map(item => [item.key, item.value]), spec.baseEntries, 'canonical_base_model');
    const pendingKeys = new Set();
    for (let i = 0; i < count; i++) {
      const item = leaf(view.getUint32(map.root + 16 + i * 4, true));
      requireThat(item.pointer < map.root && !pendingKeys.has(item.key), 'pending_leaf_relation');
      if (spec.baseUsed !== undefined) requireThat(item.pointer >= spec.baseUsed, 'pending_leaf_after_base');
      pendingKeys.add(item.key);
      pending.push(item);
    }
    if (spec.pending) sameEntries(pending.map(item => [item.key, item.value]), spec.pending, 'ordered_pending_leaves');
    requireThat(view.getUint32(map.root + 8, true) === expected.length, 'journal_native_size');
  } else {
    canonicalLeaves = canonical(map.root);
    if (spec.pending) requireThat(spec.pending.length === 0, 'expected_zero_pending');
  }
  const logical = modelEntries(canonicalLeaves.map(item => [item.key, item.value]), pending.map(item => [item.key, item.value]));
  sameEntries(logical, expected, 'exported_exact_model');
  requireThat(map.size === expected.length, 'wrapper_size');
  let publicIndex = 0;
  for (const [k, v] of map.entries()) {
    requireThat(publicIndex < expected.length && k === expected[publicIndex][0] && Object.is(v, expected[publicIndex][1]), 'public_sorted_entries');
    publicIndex++;
  }
  requireThat(publicIndex === expected.length, 'public_entry_count');
  for (const [k, v] of expected) requireThat(map.has(k) && Object.is(map.get(k), v), 'public_exact_reads');
  let targetLeaf = null;
  if (spec.target !== undefined) {
    const pendingTarget = pending.find(item => item.key === spec.target);
    const resolved = pendingTarget ?? canonicalLeaves.find(item => item.key === spec.target);
    const expectedValue = expected.find(([k]) => k === spec.target);
    requireThat(Boolean(resolved) === Boolean(expectedValue) && map.has(spec.target) === Boolean(expectedValue), 'target_membership');
    requireThat(expectedValue ? Object.is(map.get(spec.target), expectedValue[1]) : map.get(spec.target) === undefined, 'target_value');
    if (spec.pendingHit) requireThat(pendingTarget && resolved === pendingTarget, 'resolved_pending_leaf');
    targetLeaf = resolved ? { pointer: resolved.pointer, keyPointer: resolved.keyPointer, keyLength: resolved.keyLength } : null;
  }
  return { arenaId: arena.id, root: map.root >>> 0, rootKind, size: map.size, baseRoot, pendingCount: pending.length,
    pending: pending.map(item => ({ key: item.key, value: item.value, leaf: item.pointer, keyPointer: item.keyPointer, keyLength: item.keyLength })), targetLeaf };
}

function gc() {
  if (engine === 'node') globalThis.gc();
  else globalThis.Bun.gc(true);
}
function checkProspective(bytes) {
  requireThat(Number.isSafeInteger(bytes) && bytes >= 0 && cumulativePayloadBytes + bytes <= CHILD_LIMIT && cumulativePayloadBytes + bytes <= studyAllowance, 'cumulative_payload_allowance');
}
function commitArena(receipt, stage, caseId = null, phase = null, ordinal = null, rawReceipt = receipt) {
  requireThat(!accountedArenaIds.has(receipt.arenaId), 'arena_accounted_once');
  accountedArenaIds.add(receipt.arenaId);
  cumulativePayloadBytes += receipt.payloadBytes;
  const item = { event: 'ledger', stage, caseId, phase, ordinal, arenaId: receipt.arenaId,
    addedPayloadBytes: receipt.payloadBytes, cumulativePayloadBytes,
    remainingChildPayloadBytes: CHILD_LIMIT - cumulativePayloadBytes,
    remainingStudyPayloadBytes: studyAllowance - cumulativePayloadBytes,
    receipt: JSON.parse(JSON.stringify(rawReceipt)) };
  ledger.push(item);
  emit(item);
  requireThat(cumulativePayloadBytes <= CHILD_LIMIT && cumulativePayloadBytes <= studyAllowance, 'actual_cumulative_payload_limit');
}
function defaultIsEmpty() {
  const receipt = arenaReceipt(emptyDefault);
  requireThat(receipt.used === HEAP_START && receipt.root === 0 && receipt.size === 0 && receipt.capacity === initialization.defaultArena.capacity, 'default_arena_stays_empty');
  return receipt;
}

// Stores only the retained canonical template; the builder and transport refs
// exist solely in this synchronous frame. The return value is JSON data only.
function buildTemplate(name) {
  const receipt = { name, validation: 'failed', builder: null, template: null, wallMs: null, failure: null };
  let builder;
  let canonicalTemplate;
  const started = performance.now();
  try {
    const expected = templateEntries(name);
    builder = api.compact(new api.SharedSortedMap('number'));
    requireThat(arenaReceipt(builder).arenaId !== initialization.defaultArena.arenaId, 'fresh_builder_arena');
    for (const [k, v] of expected) builder = builder.set(k, v);
    receipt.builder = arenaReceipt(builder);
    requireThat(receipt.builder.used <= BUILDER_LIMIT, 'builder_payload_ceiling');
    inspectMap(builder, expected);
    canonicalTemplate = api.compact(builder);
    receipt.template = arenaReceipt(canonicalTemplate);
    requireThat(receipt.template.used <= SETUP_LIMIT && receipt.template.arenaId !== receipt.builder.arenaId, 'fresh_template_ceiling');
    inspectMap(canonicalTemplate, expected, { kind: 'canonical' });
    templates[name] = canonicalTemplate;
    templateReceipts[name] = receipt.template;
    defaultIsEmpty();
    receipt.validation = 'passed';
  } catch (error) {
    receipt.failure = failureCode(error);
  } finally {
    try { if (builder) receipt.builder = arenaReceipt(builder); } catch { accountingComplete = false; }
    try { if (canonicalTemplate) receipt.template = arenaReceipt(canonicalTemplate); } catch { accountingComplete = false; }
    if (!builder || (receipt.builder && !canonicalTemplate && receipt.failure === 'unexpected_subject_error')) accountingComplete = false;
    receipt.wallMs = performance.now() - started;
  }
  return receipt;
}

// One untimed X4 replay verifies every intermediate writer shape. No snapshot,
// arena, exported payload, buffer, view, iterator, or closure escapes this call.
function sacrificialReplay() {
  const receipt = { validation: 'failed', arena: null, shapes: [], finalShape: null, wallMs: null, failure: null };
  let base;
  let working;
  const started = performance.now();
  try {
    base = api.compact(templates.T);
    working = base;
    const start = arenaReceipt(base);
    requireThat(start.used <= SETUP_LIMIT && !accountedArenaIds.has(start.arenaId), 'replay_fresh_setup');
    const original = templateEntries('T');
    inspectMap(base, original, { kind: 'canonical' });
    const replacements = REPLACEMENTS.map(i => [key(i), 10000 + i]);
    const applied = [];
    for (const [k, v] of replacements) {
      working = working.set(k, v);
      applied.push([k, v]);
      receipt.shapes.push(inspectMap(working, modelEntries(original, applied), {
        kind: 'journal', baseRoot: base.root, baseUsed: start.used, baseEntries: original, pending: applied,
        target: k, pendingHit: true,
      }));
    }
    const output = working.delete(key(2048));
    const end = arenaReceipt(output);
    requireThat(end.arenaId === start.arenaId && end.used - start.used <= 4096, 'replay_operation_envelope');
    requireThat(output !== working && output !== base, 'replay_new_wrapper');
    receipt.finalShape = inspectMap(output, modelEntries(original, replacements, key(2048)), { kind: 'canonical', target: key(2048) });
    inspectMap(base, original, { kind: 'canonical' });
    inspectMap(templates.T, original, { kind: 'canonical' });
    defaultIsEmpty();
    receipt.startUsed = start.used;
    receipt.endUsed = end.used;
    receipt.allocationBytes = end.used - start.used;
    receipt.validation = 'passed';
  } catch (error) {
    receipt.failure = failureCode(error);
  } finally {
    try { if (working) receipt.arena = arenaReceipt(working); } catch { accountingComplete = false; }
    if (!base) accountingComplete = false;
    receipt.wallMs = performance.now() - started;
  }
  return receipt;
}

function timerPrecheck() {
  const readings = new Array(4096);
  for (let i = 0; i < 4096; i++) readings[i] = performance.now();
  const positiveDeltasMs = [];
  let valid = true;
  let quantum = Infinity;
  for (let i = 0; i < readings.length; i++) {
    if (!Number.isFinite(readings[i])) valid = false;
    if (i !== 0) {
      if (!(readings[i] >= readings[i - 1])) valid = false;
      const delta = readings[i] - readings[i - 1];
      if (Number.isFinite(delta) && delta > 0) { positiveDeltasMs.push(delta); quantum = Math.min(quantum, delta); }
    }
  }
  return { readingsMs: readings.map(finiteJson), positiveDeltasMs,
    quantumMs: Number.isFinite(quantum) && quantum > 0 ? quantum : null,
    precheckPassed: valid && Number.isFinite(quantum) && quantum > 0 };
}

// This complete synchronous batch returns JSON-only data. Its caller never
// receives or retains any batch snapshot, arena, memory, view, or payload.
function runBatch(row, count, phase, ordinal, trial = null) {
  const receipt = { caseId: row.id, count, phase, ordinal, trial, validation: 'failed', failure: null,
    elapsedMs: null, elapsedNs: null, durationClassification: null, timerEligible: false,
    arenaId: null, startUsed: null, endUsed: null, startCapacity: null, endCapacity: null,
    allocationBytes: null, prospectivePayloadBytes: SETUP_LIMIT + count * row.unitBytes,
    preGcMs: null, setupMs: null, setupConstructionMs: null, setupValidationMs: null, setupGcMs: null, validationMs: null,
    inputShape: null, finalShape: null, sinks: null, arena: null };
  let base;
  let input;
  let latest;
  try {
    const preGcStart = performance.now();
    gc();
    receipt.preGcMs = performance.now() - preGcStart;
    const setupStart = performance.now();
    const original = templateEntries(row.template);
    const pending = setupEntries(row);
    const target = targetKey(row);
    base = api.compact(templates[row.template]);
    input = base;
    const baseReceipt = arenaReceipt(base);
    requireThat(!accountedArenaIds.has(baseReceipt.arenaId) && baseReceipt.arenaId !== templateReceipts[row.template].arenaId, 'fresh_batch_arena');
    requireThat(baseReceipt.used <= SETUP_LIMIT, 'compacted_setup_ceiling');
    for (const [k, v] of pending) input = input.set(k, v);
    receipt.setupConstructionMs = performance.now() - setupStart;
    const setupValidationStart = performance.now();
    const expectedInput = modelEntries(original, pending);
    const timedPending = row.id === 'X4' ? REPLACEMENTS.map(i => [key(i), 10000 + i]) : pending;
    const expectedOutput = modelEntries(original, timedPending, target);
    const inputSpec = { kind: pending.length ? 'journal' : 'canonical', pending, baseRoot: base.root,
      baseUsed: baseReceipt.used, baseEntries: original, target,
      pendingHit: ['P', 'S16', 'R1', 'N4', 'G1', 'L4', 'I4'].includes(row.id) };
    receipt.inputShape = inspectMap(input, expectedInput, inputSpec);
    inspectMap(base, original, { kind: 'canonical' });
    inspectMap(templates[row.template], original, { kind: 'canonical' });
    requireThat(arenaReceipt(input).used <= SETUP_LIMIT, 'prepared_setup_ceiling');
    defaultIsEmpty();
    let expectedValueSum = 0;
    let expectedKeyLengthSum = 0;
    for (const [k, v] of expectedOutput) { expectedValueSum += v; expectedKeyLengthSum += k.length; }
    const expectedSize = expectedOutput.length;
    const xKeys = REPLACEMENTS.map(i => key(i));
    const xValues = REPLACEMENTS.map(i => 10000 + i);
    const survivingKey = key(1024);
    const survivingValue = 11024;
    receipt.setupValidationMs = performance.now() - setupValidationStart;
    receipt.setupMs = performance.now() - setupStart;
    const setupGcStart = performance.now();
    gc();
    receipt.setupGcMs = performance.now() - setupGcStart;
    const start = arenaReceipt(input);
    receipt.arenaId = start.arenaId;
    receipt.startUsed = start.used;
    receipt.startCapacity = start.capacity;
    let sizeSum = 0;
    let rootSum = 0;
    let sizeMismatchCount = 0;
    let identityMismatchCount = 0;
    let missingGetCount = 0;
    let survivingGetSum = 0;
    let getMismatchCount = 0;
    let entryCount = 0;
    let numericValueSum = 0;
    let keyLengthSum = 0;
    let invalidIterationCount = 0;
    let clockStart;
    let clockEnd;
    if (row.id === 'X4') {
      clockStart = performance.now();
      for (let i = 0; i < count; i++) {
        latest = input.set(xKeys[0], xValues[0]).set(xKeys[1], xValues[1]).set(xKeys[2], xValues[2]).set(xKeys[3], xValues[3]).delete(target);
        sizeSum += latest.size;
        rootSum += latest.root >>> 0;
        sizeMismatchCount += latest.size === expectedSize ? 0 : 1;
        identityMismatchCount += latest === input ? 1 : 0;
      }
      clockEnd = performance.now();
    } else if (row.id === 'I4') {
      clockStart = performance.now();
      for (let i = 0; i < count; i++) {
        latest = input.delete(target);
        const absent = latest.get(target);
        const surviving = latest.get(survivingKey);
        missingGetCount += absent === undefined ? 1 : 0;
        survivingGetSum += typeof surviving === 'number' ? surviving : 0;
        getMismatchCount += absent === undefined && surviving === survivingValue ? 0 : 1;
        for (const [k, v] of latest.entries()) {
          entryCount++;
          numericValueSum += typeof v === 'number' ? v : 0;
          keyLengthSum += typeof k === 'string' ? k.length : 0;
          invalidIterationCount += typeof k === 'string' && typeof v === 'number' && Number.isFinite(v) ? 0 : 1;
        }
        sizeSum += latest.size;
        rootSum += latest.root >>> 0;
        sizeMismatchCount += latest.size === expectedSize ? 0 : 1;
        identityMismatchCount += latest === input ? 1 : 0;
      }
      clockEnd = performance.now();
    } else if (row.id === 'M0') {
      clockStart = performance.now();
      for (let i = 0; i < count; i++) {
        latest = input.delete(target);
        sizeSum += latest.size;
        rootSum += latest.root >>> 0;
        sizeMismatchCount += latest.size === expectedSize ? 0 : 1;
        identityMismatchCount += latest === input ? 0 : 1;
      }
      clockEnd = performance.now();
    } else {
      clockStart = performance.now();
      for (let i = 0; i < count; i++) {
        latest = input.delete(target);
        sizeSum += latest.size;
        rootSum += latest.root >>> 0;
        sizeMismatchCount += latest.size === expectedSize ? 0 : 1;
        identityMismatchCount += latest === input ? 1 : 0;
      }
      clockEnd = performance.now();
    }
    const elapsed = clockEnd - clockStart;
    const end = arenaReceipt(latest);
    receipt.elapsedMs = Number.isFinite(elapsed) ? elapsed : null;
    receipt.elapsedNs = Number.isFinite(elapsed) ? elapsed * 1e6 : null;
    receipt.durationClassification = Number.isFinite(elapsed) ? elapsed > 0 ? 'positive' : 'nonpositive' : finiteJson(elapsed);
    receipt.timerEligible = timer.precheckPassed && Number.isFinite(elapsed) && elapsed > 0 && timer.quantumMs <= 0.005 * elapsed;
    receipt.endUsed = end.used;
    receipt.endCapacity = end.capacity;
    receipt.allocationBytes = end.used - start.used;
    receipt.sinks = { sizeSum, rootSum, sizeMismatchCount, identityMismatchCount,
      missingGetCount, survivingGetSum, getMismatchCount, entryCount, numericValueSum, keyLengthSum, invalidIterationCount };
    const validationStart = performance.now();
    requireThat(end.arenaId === start.arenaId && end.used >= start.used && end.capacity >= start.capacity, 'batch_unchanged_arena');
    requireThat(receipt.allocationBytes <= count * row.unitBytes, 'operation_allocation_envelope');
    requireThat(end.payloadBytes <= receipt.prospectivePayloadBytes, 'batch_payload_envelope');
    requireThat(sizeMismatchCount === 0 && identityMismatchCount === 0 && sizeSum === count * expectedSize, 'every_result_wrapper');
    for (const value of Object.values(receipt.sinks)) requireThat(Number.isSafeInteger(value) && value >= 0, 'safe_scalar_sink');
    if (row.id === 'I4') {
      requireThat(missingGetCount === count && survivingGetSum === count * survivingValue && getMismatchCount === 0, 'i4_get_sinks');
      requireThat(entryCount === count * expectedSize && numericValueSum === count * expectedValueSum && keyLengthSum === count * expectedKeyLengthSum && invalidIterationCount === 0, 'i4_iteration_sinks');
    }
    receipt.finalShape = inspectMap(latest, expectedOutput, row.id === 'M0' ? inputSpec : { kind: 'canonical', target });
    if (row.id === 'M0') {
      requireThat(latest === input && receipt.allocationBytes === 0 && JSON.stringify(receipt.finalShape) === JSON.stringify(receipt.inputShape), 'missing_identity_and_journal');
    } else {
      requireThat(latest !== input && latest.get(target) === undefined && !latest.has(target), 'deleted_result_and_absence');
    }
    if (row.id === 'G1') requireThat(latest.root !== base.root, 'g1_prior_root_inequality');
    requireThat(JSON.stringify(inspectMap(input, expectedInput, inputSpec)) === JSON.stringify(receipt.inputShape), 'untouched_input_shape');
    inspectMap(base, original, { kind: 'canonical' });
    inspectMap(templates[row.template], original, { kind: 'canonical' });
    const unchangedTemplate = arenaReceipt(templates[row.template]);
    requireThat(JSON.stringify(unchangedTemplate) === JSON.stringify(templateReceipts[row.template]), 'untouched_template_frontier');
    requireThat(arenaReceipt(input).used === end.used, 'validation_does_not_append');
    defaultIsEmpty();
    receipt.validationMs = performance.now() - validationStart;
    receipt.validation = 'passed';
  } catch (error) {
    receipt.failure = failureCode(error);
  } finally {
    try { if (input ?? base) receipt.arena = arenaReceipt(input ?? base); } catch { accountingComplete = false; }
    if (!base) accountingComplete = false;
  }
  return receipt;
}

// A batch is accounted only after its complete frame has returned, so its next
// caller cannot keep a prior arena alive across the next pre-construction GC.
function collectBatch(row, count, phase, ordinal, trial = null) {
  checkProspective(SETUP_LIMIT + count * row.unitBytes);
  const receipt = runBatch(row, count, phase, ordinal, trial);
  receipt.cumulativePayloadBytes = cumulativePayloadBytes + (receipt.arena?.payloadBytes ?? 0);
  if (receipt.arena) commitArena(receipt.arena, 'batch', row.id, phase, ordinal, receipt);
  return receipt;
}
function requirePassed(receipt) { requireThat(receipt.validation === 'passed', receipt.failure ?? 'batch_validation_failed'); }

function calibrate() {
  for (const row of ROWS) {
    const entry = { id: row.id, count: row.id === 'I4' ? 4 : 256, accepted: false, trials: [] };
    cases.push(entry);
    for (let trial = 1; trial <= 4; trial++) {
      const attempt = { trial, count: entry.count, warmup: [], pilots: [], medianMs: null, accepted: false };
      entry.trials.push(attempt);
      for (let ordinal = 1; ordinal <= 5; ordinal++) {
        const batch = collectBatch(row, entry.count, 'warmup', ordinal, trial);
        attempt.warmup.push(batch);
        requirePassed(batch);
      }
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        const batch = collectBatch(row, entry.count, 'pilot', ordinal, trial);
        attempt.pilots.push(batch);
        requirePassed(batch);
        requireThat(Number.isFinite(batch.elapsedMs) && batch.elapsedMs > 0, 'invalid_calibration_pilot_duration');
      }
      const sorted = attempt.pilots.map(batch => batch.elapsedMs).sort((a, b) => a - b);
      attempt.medianMs = sorted[1];
      attempt.accepted = attempt.medianMs >= 20 && attempt.medianMs <= 50;
      entry.accepted = attempt.accepted;
      if (entry.accepted || trial === 4) break;
      const next = Math.min(row.maxCount, Math.max(1, Math.round(entry.count * 30 / attempt.medianMs)));
      if (next === entry.count) break;
      entry.count = next;
    }
  }
}
function measure(counts) {
  for (const row of ROWS) {
    const entry = { id: row.id, count: counts[row.id], warmup: [], measured: [] };
    cases.push(entry);
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      const batch = collectBatch(row, entry.count, 'warmup', ordinal);
      entry.warmup.push(batch);
      requirePassed(batch);
    }
    for (let ordinal = 1; ordinal <= 9; ordinal++) {
      const batch = collectBatch(row, entry.count, 'measured', ordinal);
      entry.measured.push(batch);
      requirePassed(batch);
    }
  }
}

let failure = null;
emit({ event: 'ready', schemaVersion: 1, engine, version, mode: ['calibrate', 'measure'].includes(mode) ? mode : null });
try {
  requireThat(process.argv.length === 7 && process.argv[2] === 'child' && ['calibrate', 'measure'].includes(mode), 'cli_contract');
  requireThat(engine === 'node' ? version === '22.16.0' : version === '1.4.2', 'pinned_engine_version');
  requireThat(typeof performance?.now === 'function', 'performance_timer_available');
  requireThat(engine === 'node' ? typeof globalThis.gc === 'function' : typeof globalThis.Bun.gc === 'function', 'synchronous_gc_available');
  studyAllowance = Number(process.argv[6]);
  requireThat(Number.isSafeInteger(studyAllowance) && studyAllowance >= INITIALIZATION_RESERVATION && studyAllowance <= STUDY_LIMIT, 'study_allowance');
  const moduleFile = realpathSync(resolve(process.argv[3]));
  requireThat(moduleFile.endsWith(engine === 'node' ? `${sep}dist${sep}shared.js` : `${sep}shared.ts`), 'ordinary_engine_entrypoint');
  let counts = null;
  if (mode === 'measure') {
    counts = JSON.parse(readFileSync(process.argv[5], 'utf8'));
    requireThat(counts && typeof counts === 'object' && !Array.isArray(counts) && Object.keys(counts).length === ROWS.length, 'complete_fixed_counts');
    for (const row of ROWS) requireThat(Object.hasOwn(counts, row.id) && Number.isSafeInteger(counts[row.id]) && counts[row.id] >= 1 && counts[row.id] <= row.maxCount, 'fixed_count_range');
  } else requireThat(process.argv[5] === '-', 'calibration_no_counts_file');
  api = await import(pathToFileURL(moduleFile).href); // One canonical ordinary import, never cache-busted.
  for (const name of ['SharedSortedMap', 'compact', 'getWorkerData', 'configureMemory']) requireThat(typeof api[name] === 'function', 'public_api_available');
  api.configureMemory({ maximumBytes: ARENA_LIMIT }); // Exactly once, before the first collection construction.
  emptyDefault = new api.SharedSortedMap('number');
  initialization.defaultArena = arenaReceipt(emptyDefault);
  requireThat(initialization.defaultArena.payloadBytes === 0 && initialization.defaultArena.root === 0, 'empty_default_arena');
  checkProspective(INITIALIZATION_RESERVATION);
  for (const name of ['T', 'S', 'G', 'L']) {
    const built = buildTemplate(name);
    initialization.templates.push(built);
    if (built.builder) commitArena(built.builder, 'template_builder', null, null, null, built);
    if (built.template) commitArena(built.template, 'canonical_template', null, null, null, built);
    requirePassed(built);
  }
  initialization.replay = sacrificialReplay();
  if (initialization.replay.validation === 'passed') timer = timerPrecheck();
  if (initialization.replay.arena) commitArena(initialization.replay.arena, 'sacrificial_replay', 'X4', null, null,
    { replay: initialization.replay, timer });
  requirePassed(initialization.replay);
  initialization.actualPayloadBytes = cumulativePayloadBytes;
  requireThat(cumulativePayloadBytes <= INITIALIZATION_RESERVATION, 'initialization_reservation_bound');
  if (mode === 'calibrate') calibrate();
  else measure(counts);
  for (const name of ['T', 'S', 'G', 'L']) {
    inspectMap(templates[name], templateEntries(name), { kind: 'canonical' });
    requireThat(JSON.stringify(arenaReceipt(templates[name])) === JSON.stringify(templateReceipts[name]), 'final_template_unchanged');
  }
  defaultIsEmpty();
} catch (error) {
  failure = failureCode(error);
  process.exitCode = 1;
}
emit({ event: 'result', schemaVersion: 1, status: failure === null ? 'complete' : 'incomplete', mode, engine, version,
  cases: Object.fromEntries(cases.map(entry => [entry.id, entry])), cumulativePayloadBytes, accountingComplete, timer, initialization, ledger, failure,
  limits: { arenaBytes: ARENA_LIMIT, setupBytes: SETUP_LIMIT, builderBytes: BUILDER_LIMIT,
    childPayloadBytes: CHILD_LIMIT, studyPayloadAllowanceBytes: studyAllowance } });
