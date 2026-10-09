import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Sizes 31/32/33/65 are workload controls, not heap layout boundaries.
export const CASES = Object.freeze([
  ['empty-next', 0, 'number', false, 'mixed', 'next'],
  ['empty-full', 0, 'number', true, 'ties', 'full'],
  ['singleton-full', 1, 'number', false, 'mixed', 'full'],
  ['singleton-first-close', 1, 'string', true, 'ties', 'first-close'],
  ['number-31-min', 31, 'number', false, 'mixed', 'full'],
  ['boolean-32-max-ties', 32, 'boolean', true, 'ties', 'full'],
  ['string-33-min', 33, 'string', false, 'mixed', 'full'],
  ['object-65-max-ties', 65, 'object', true, 'ties', 'full'],
  ['nested-65-first-close', 65, 'nested', false, 'mixed', 'first-close'],
  ['number-1057-min', 1057, 'number', false, 'mixed', 'full'],
  ['number-4097-max-ties', 4097, 'number', true, 'ties', 'full'],
  ['boolean-1057-max', 1057, 'boolean', true, 'mixed', 'full'],
  ['string-4097-min-ties', 4097, 'string', false, 'ties', 'full'],
  ['object-1057-min-warm', 1057, 'object', false, 'mixed', 'full'],
  ['object-4097-max-saturated', 4097, 'object', true, 'mixed', 'full'],
  ['nested-1057-max-ties', 1057, 'nested', true, 'ties', 'full'],
].map(([name, size, type, maxHeap, priorities, operation]) => Object.freeze({
  name, size, type, maxHeap, priorities, operation,
  cache: type === 'number' || type === 'boolean' ? 'not applicable'
    : size > 2048 ? 'naturally saturated: at most 2048 decoded records retained'
      : 'warmed by normal public reads; no internal cache edits',
  target: size >= 1057 && operation === 'full',
})));

export function valueAt(type, i) {
  if (type === 'number') return i * 13 - 7;
  if (type === 'boolean') return i % 3 === 0;
  if (type === 'string') return `heap-界-${i}-z`;
  return { id: i, payload: { score: i * 7 + 3 }, label: `v${i}` };
}
export const priorityAt = (workload, i) => workload.priorities === 'ties' ? 5 : ((i * 37) % (workload.size + 17)) - 11;
export function valueCode(type, value) {
  if (type === 'number') return value | 0;
  if (type === 'boolean') return value ? 17 : 3;
  if (type === 'string') { let code = 0; for (let i = 0; i < value.length; i++) code = (Math.imul(code, 31) + value.charCodeAt(i)) | 0; return code; }
  if (type === 'nested') return (Math.imul(value.get('id'), 31) + value.get('score')) | 0;
  return (Math.imul(value.id, 31) + value.payload.score + value.label.length) | 0;
}
const plainCode = (type, i) => type === 'nested' ? (Math.imul(i, 31) + i * 7 + 3) | 0 : valueCode(type, valueAt(type, i));
function add(checksum, value, priority) {
  checksum.count++;
  checksum.value = (checksum.value + value) | 0;
  checksum.priority = (checksum.priority + priority) | 0;
  checksum.paired = (checksum.paired + Math.imul(value, priority + 101)) | 0;
}
const zero = () => ({ count: 0, value: 0, priority: 0, paired: 0, completed: 0 });

export function fixture(api, workload) {
  // Recover the built Arena constructor only for deterministic fixture setup.
  // Random default IDs otherwise change nested descriptor lengths across arms.
  const Snapshot = Object.getPrototypeOf(api.SharedPriorityQueue);
  assert.equal(typeof Snapshot.owner, 'function');
  const Arena = Snapshot.owner(new api.SharedPriorityQueue('number')).constructor;
  const owner = new Arena({ id: 'heap-benchmark-' + workload.name });
  const nestedOwner = workload.type === 'nested' ? new Arena({ id: 'heap-nested-' + workload.name }) : undefined;
  let item = new api.SharedPriorityQueue(workload.type === 'nested' ? api.map('number') : workload.type, { maxHeap: workload.maxHeap }, owner);
  const expected = zero();
  let firstIndex = -1, best;
  for (let i = 0; i < workload.size; i++) {
    const priority = priorityAt(workload, i);
    const value = workload.type === 'nested' ? new api.SharedMap('number', 0, 0, nestedOwner).set('id', i).set('score', i * 7 + 3) : valueAt(workload.type, i);
    item = item.enqueue(value, priority);
    if (firstIndex === -1 || (workload.maxHeap ? priority > best : priority < best)) { firstIndex = i; best = priority; }
    if (workload.operation === 'full') add(expected, plainCode(workload.type, i), priority);
  }
  if (workload.operation === 'first-close') {
    assert(workload.size > 0);
    // Early-return cases have a unique first priority or only one entry.
    assert(workload.size === 1 || workload.priorities === 'mixed');
    add(expected, plainCode(workload.type, firstIndex), best);
  }
  expected.completed = 1;
  return { item, expected };
}

export function fixtureIdentity(api, item) {
  const data = api.getWorkerData({ item }, { copy: true });
  const shared = api.getWorkerData({ item }, { copy: false });
  const capacities = new Map(shared.arenas.map(arena => [arena.id, arena.memory.buffer.byteLength]));
  const arenas = data.arenas.map(arena => ({
    id: arena.id, used: arena.used, sourceBytes: arena.copy.byteLength, capacityBytes: capacities.get(arena.id),
    sha256: createHash('sha256').update(arena.copy).digest('hex'),
  }));
  return { structures: data.structures, arenas, totalSourceBytes: arenas.reduce((sum, arena) => sum + arena.sourceBytes, 0) };
}

// Both yielded values and priorities contribute to every timed iteration's sink.
// No unused-generator control, fixture construction, or prototype instrumentation.
export function consume(item, workload) {
  const result = zero();
  if (workload.operation === 'next') {
    const step = item.entries().next();
    if (!step.done) throw new Error('Expected empty completion');
    result.completed++;
  } else if (workload.operation === 'first-close') {
    const iterator = item.entries(), step = iterator.next();
    if (step.done) throw new Error('Missing first yield');
    add(result, valueCode(workload.type, step.value[0]), step.value[1]);
    const closed = iterator.return();
    if (!closed.done || !iterator.next().done) throw new Error('Iterator did not close');
    result.completed++;
  } else {
    for (const [value, priority] of item.entries()) add(result, valueCode(workload.type, value), priority);
    result.completed++;
  }
  return result;
}
export function expectedBatch(expected, repeat) {
  return { count: expected.count * repeat, value: Math.imul(expected.value, repeat), priority: Math.imul(expected.priority, repeat),
    paired: Math.imul(expected.paired, repeat), completed: repeat };
}
export function scan(item, workload, repeat) {
  const total = zero();
  for (let i = 0; i < repeat; i++) {
    const one = consume(item, workload);
    total.count += one.count; total.value = (total.value + one.value) | 0;
    total.priority = (total.priority + one.priority) | 0; total.paired = (total.paired + one.paired) | 0;
    total.completed += one.completed;
  }
  return total;
}
