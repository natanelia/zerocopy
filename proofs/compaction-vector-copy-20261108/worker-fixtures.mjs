export function assert(condition, message) { if (!condition) throw new Error(message); }
export function sameArray(actual, expected, name = 'values') {
  assert(actual.length === expected.length, `${name}: length differs`);
  for (let i = 0; i < expected.length; i++) assert(Object.is(actual[i], expected[i]), `${name}: value differs at ${i}`);
}
export function queueArray(queue) {
  const result = [];
  while (queue.size) { result.push(queue.peek()); queue = queue.dequeue(); }
  return result;
}
function readOnly(action) {
  let error;
  try { action(); } catch (caught) { error = caught; }
  assert(error instanceof Error && /read-only/.test(error.message), 'Expected read-only attachment');
}
export function fixture(S) {
  const numbers = Array.from({ length: 4134 }, (_, i) => i / 8 - 1000);
  numbers[0] = -0; numbers[31] = NaN; numbers[37] = -0; numbers[38] = NaN;
  numbers[64] = Infinity; numbers[1024] = -Infinity; numbers[4096] = Number.MIN_VALUE;
  const booleans = Array.from({ length: 4097 }, (_, i) => i % 5 === 2);
  const list = new S.SharedList('number').pushMany(numbers.slice(0, 4097));
  const booleanList = new S.SharedList('boolean').pushMany(booleans);
  let queue = new S.SharedQueue('number');
  for (const value of numbers) queue = queue.enqueue(value);
  for (let i = 0; i < 37; i++) queue = queue.dequeue();
  const outer = new S.SharedMap('SharedList<number>').set('original', list).set('alias', list);
  return { structures: { list, booleanList, queue, outer, again: list },
    expected: { list: numbers.slice(0, 4097), booleanList: booleans, queue: numbers.slice(37) } };
}
export function edited(S, structures, expected) {
  const list = structures.list.set(31, 123456).push(777);
  const listValues = [...expected.list, 777]; listValues[31] = 123456;
  const booleanList = structures.booleanList.set(1024, !expected.booleanList[1024]).pop();
  const booleanValues = expected.booleanList.slice(0, -1); booleanValues[1024] = !expected.booleanList[1024];
  const queue = structures.queue.dequeue().enqueue(-0);
  const outer = structures.outer.set('original', list).set('alias', list);
  return { structures: { list, booleanList, queue, outer, again: list },
    expected: { list: listValues, booleanList: booleanValues, queue: [...expected.queue.slice(1), -0] } };
}
export function verifySnapshots(S, structures, expected, readOnlySnapshots = false) {
  assert(Object.keys(structures).join(',') === 'list,booleanList,queue,outer,again', 'Snapshot names/order');
  for (const value of Object.values(structures)) assert(Object.isFrozen(value), 'Frozen snapshot');
  sameArray(structures.list.toArray(), expected.list, 'number list');
  sameArray(structures.booleanList.toArray(), expected.booleanList, 'boolean list');
  sameArray(queueArray(structures.queue), expected.queue, 'offset queue');
  sameArray(structures.again.toArray(), expected.list, 'snapshot alias');
  sameArray(structures.outer.get('original').toArray(), expected.list, 'nested original');
  sameArray(structures.outer.get('alias').toArray(), expected.list, 'nested alias');
  if (readOnlySnapshots) {
    readOnly(() => structures.list.push(1)); readOnly(() => structures.queue.enqueue(1));
    readOnly(() => structures.booleanList.set(0, true));
  }
}
function capture(S, structures) {
  return S.getWorkerData(structures, { copy: false }).arenas.map(arena => ({ arena,
    bytes: new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536).slice() }));
}
function unchanged(records) {
  for (const { arena, bytes } of records) {
    const next = new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536);
    assert(bytes.length === next.length, 'Published byte length');
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== next[i]) throw new Error(`Source byte changed at ${i}`);
  }
}
export function grow(S, structures) {
  const records = capture(S, structures);
  for (const { arena } of records) {
    const before = arena.memory.buffer;
    arena.memory.grow(1);
    assert(arena.memory.buffer !== before, 'Memory actually grew');
  }
  unchanged(records);
}
export function createWorkerHandler(S) {
  let retained, retainedCopies, retainedExpected;
  return async function (payload, expected) {
    if (retained) {
      verifySnapshots(S, retained, retainedExpected, true);
      verifySnapshots(S, retainedCopies, retainedExpected);
    }
    const attached = await S.initWorker(payload);
    verifySnapshots(S, attached, expected, true);
    const source = capture(S, attached), copies = S.compactMany(attached);
    verifySnapshots(S, copies, expected);
    assert(copies.list === copies.again, 'compactMany preserves aliases');
    const packed = S.getWorkerData(copies, { copy: false });
    assert(packed.arenas.length === 1, 'One new arena for compactMany');
    assert(!source.some(({ arena }) => arena.memory === packed.arenas[0].memory), 'Independent target arena');
    assert(JSON.stringify(copies.outer.get('original').toWorkerData()) === JSON.stringify(copies.list.toWorkerData()), 'Nested compacted descriptor alias');
    assert(Object.is(copies.list.push(-0).get(expected.list.length), -0), 'Compacted list is writable and preserves negative zero');
    const nextQueue = copies.queue.enqueue(-0);
    const nextQueueValues = queueArray(nextQueue);
    assert(Object.is(nextQueueValues.at(-1), -0), 'Compacted queue is writable and preserves negative zero');
    assert(copies.booleanList.push(true).get(expected.booleanList.length) === true, 'Compacted boolean list is writable');
    grow(S, copies);
    verifySnapshots(S, copies, expected);
    verifySnapshots(S, attached, expected, true);
    unchanged(source);
    if (!retained) { retained = attached; retainedCopies = copies; retainedExpected = expected; }
    return { ok: true, numberValues: expected.list.length + expected.queue.length,
      booleanValues: expected.booleanList.length, compactedArenaCount: packed.arenas.length };
  };
}
