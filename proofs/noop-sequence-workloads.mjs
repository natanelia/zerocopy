/** Fixed first x64 screen. Ten changed-write controls precede six target cases. */
const cases = [];
function add(type, size, index, pattern, group) {
  const start = (size - 1) & ~31, region = index >= start ? 'tail' : 'tree';
  let depth = 0, capacity = 32; while (start > capacity) { capacity *= 32; depth++; }
  cases.push(Object.freeze({ type, size, index, pattern, group, region, depth,
    bytesPerWrite: region === 'tail' ? (size - start) * 8 : 256 + depth * 128,
    name: `${group}/${type}/${region}${region === 'tail' ? size - start : depth}/${size}/${pattern}` }));
}
for (const [size, index] of [[1, 0], [32, 31], [33, 0], [65, 32], [1057, 1024], [32801, 32768]]) add('number', size, index, 'changed', 'control');
for (const type of ['boolean', 'string']) for (const [size, index] of [[32, 31], [1057, 1024]]) add(type, size, index, 'changed', 'control');
add('number', 1, 0, 'same', 'target'); add('number', 32801, 32768, 'same', 'target');
add('boolean', 65, 32, 'same', 'target'); add('string', 32, 31, 'same', 'target');
add('number', 1057, 1024, 'half-same', 'target'); add('string', 65, 32, 'nine-tenths-same', 'target');
export const CASES = Object.freeze(cases);
export const PAYLOAD_CAP = 128 * 1024 * 1024;
export const MAX_REPEATS = 1000000;
export const MIN_BATCH_MS = 10;
export function repeatCap(workload, fixtureUsed) {
  const cap = Math.min(MAX_REPEATS, Math.floor((PAYLOAD_CAP - (fixtureUsed - 65536)) / workload.bytesPerWrite));
  if (cap < 20) throw new Error('Fixture exceeds the baseline payload budget');
  return Math.floor(cap / 20) * 20;
}
export const PATTERNS = Object.freeze({ changed: [1, 0], same: [0], 'half-same': [1, 1, 0, 0], 'nine-tenths-same': [...Array(10).fill(1), ...Array(10).fill(0)] });
export function inputs(workload) {
  const values = workload.type === 'number' ? [13.25, -29.5] : workload.type === 'boolean' ? [false, true] : ['cached-first', 'cached-second'];
  const expected = Array(workload.size).fill(values[0]);
  // Both string values are interned in every timed string fixture, outside timing.
  if (workload.size > 1) expected[1] = values[1];
  expected[workload.index] = values[0];
  return { expected, pattern: PATTERNS[workload.pattern].map(i => values[i]) };
}
export function makeFixture(S, workload, expected) { return new S.SharedList(workload.type).pushMany(expected); }
export function writeSequence(item, index, pattern, repeat) {
  for (let i = 0; i < repeat; i++) item = item.set(index, pattern[i % pattern.length]);
  return item;
}
export function changedOperations(workload, repeat) {
  if (repeat % 20) throw new Error('Repeats must be a multiple of all pattern periods');
  return workload.pattern === 'changed' ? repeat : workload.pattern === 'same' ? 0 : workload.pattern === 'half-same' ? repeat / 2 : repeat / 10;
}
export function storage(S, item) {
  const data = S.getWorkerData({ item }, { copy: false });
  const arena = data.arenas.find(a => a.id === data.structures.item.arena);
  return { used: arena.used, byteLength: arena.memory.buffer.byteLength };
}
export function validate(item, source, expected) {
  if (item === source || !Object.isFrozen(item)) throw new Error('set() did not retain fresh frozen handle behavior');
  const got = item.toArray(), old = source.toArray();
  if (got.length !== expected.length || old.length !== expected.length) throw new Error('Incorrect output size');
  for (let i = 0; i < expected.length; i++) if (!Object.is(got[i], expected[i]) || !Object.is(old[i], expected[i])) throw new Error(`Output/source changed at ${i}`);
}
export function checkFixtures(S, reuse) {
  const rows = [];
  for (const workload of CASES) {
    S.resetSharedList();
    const { expected, pattern } = inputs(workload), source = makeFixture(S, workload, expected), before = storage(S, source), repeat = 40;
    const next = writeSequence(source, workload.index, pattern, repeat), after = storage(S, next);
    validate(next, source, expected);
    const want = workload.bytesPerWrite * (reuse ? changedOperations(workload, repeat) : repeat);
    if (after.used - before.used !== want) throw new Error(`Unexpected allocation: ${workload.name}`);
    rows.push({ name: workload.name, repeat, changed: changedOperations(workload, repeat), allocated: after.used - before.used,
      fixtureUsed: before.used, cap: repeatCap(workload, before.used), backingBytes: after.byteLength });
  }
  return rows;
}
