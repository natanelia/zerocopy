// Shared by Node and Chromium proofs. Expected values come only from inputs
// and native Map models, never from the collection being tested.
export const types = ['number', 'boolean', 'string', 'object'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const normalize = key => decoder.decode(encoder.encode(key));
export function insist(condition, message) { if (!condition) throw new Error(message); }
export function same(actual, expected, where = 'value') {
  if (Object.is(actual, expected)) return;
  insist(actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object', `Wrong ${where}`);
  insist(Array.isArray(actual) === Array.isArray(expected), `Wrong container at ${where}`);
  if (Array.isArray(actual)) insist(actual.length === expected.length, `Wrong array length at ${where}`);
  const keys = Object.keys(actual), expectedKeys = Object.keys(expected);
  insist(keys.length === expectedKeys.length && keys.every(key => Object.hasOwn(expected, key)), `Wrong properties at ${where}`);
  for (const key of keys) same(actual[key], expected[key], `${where}.${key}`);
}
function frozen(value) {
  if (value === null || typeof value !== 'object') return;
  insist(Object.isFrozen(value), 'Decoded object must remain frozen');
  for (const child of Object.values(value)) frozen(child);
}
function valueFor(type, index) {
  if (type === 'number') return index % 257 === 0
    ? [NaN, -0, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE][(index / 257) % 6]
    : index + 0.25;
  if (type === 'boolean') return index % 3 !== 0;
  if (type === 'string') return index % 7 === 0 ? '' : `value/${index}/é/界/🙂`;
  return { index, nested: { values: [index, null, index % 2 === 0] }, label: `object/${index}` };
}
export function makeFixture(type, count = 2048) {
  insist(types.includes(type), 'Unsupported fixture type');
  const key = i => `key/${String(i).padStart(5, '0')}`;
  const entries = Array.from({ length: count }, (_, i) => [key(i), valueFor(type, i)]);
  for (const [i, name] of ['', '\0', '\uFEFFkey', '路/é/🙂', '\uFFFD', '\uD800', 'costarring', 'liquid'].entries()) {
    entries.push([name, valueFor(type, count + i)]);
  }
  const before = new Map(entries.map(([name, value]) => [normalize(name), value]));
  const afterWrites = [['arrives/later', valueFor(type, count + 20)], ['\uD801/unpublished', valueFor(type, count + 21)],
    [key(4), valueFor(type, count + 22)]];
  const forkWrites = [['arrives/later', valueFor(type, count + 30)], ['fork-only', valueFor(type, count + 31)]];
  const after = new Map(before), fork = new Map(before);
  for (const [name, value] of afterWrites) after.set(normalize(name), value);
  for (const [name, value] of forkWrites) fork.set(normalize(name), value);
  after.delete(key(5)); fork.delete(key(6));
  const misses = Array.from({ length: 300 }, (_, i) => `absent/${i}`);
  // Admit the keys that will be inserted into a future root before exhausting
  // the 256-entry negative-cache budget with unrelated missing requests.
  const queries = [...Array.from({ length: 64 }, (_, i) => key(i)), '', '\0', '\uFEFFkey', '路/é/🙂',
    '\uD800', '\uDC00', '\uFFFD', 'costarring', 'liquid', 'arrives/later', 'fork-only',
    '\uD801/unpublished', '\uFFFD/unpublished', ...misses, key(0), key(0), 'oversized/' + 'x'.repeat(16385)];
  const concurrentKeys = [...queries.slice(0, 48), ...misses.slice(0, 12), 'arrives/later', '\uD801/unpublished', '\uFFFD/unpublished', '\uD800'];
  return { type, count, entries, afterWrites, forkWrites, deleteAfter: key(5), deleteFork: key(6),
    queries, concurrentKeys, models: { before, after, fork, compacted: after },
    growth: () => Array.from({ length: 16000 }, (_, i) => [`growth/${i}`, valueFor(type, count + 100 + i)]),
    readonlyValue: valueFor(type, count + 40) };
}
export function checkReads(map, keys, model) {
  const values = map.getMany(keys);
  insist(values.length === keys.length, 'Wrong bulk read length');
  for (let i = 0; i < keys.length; i++) {
    insist(Object.hasOwn(values, i), 'Bulk read lost a dense input position');
    const key = normalize(keys[i]), expected = model.get(key);
    same(values[i], expected, `getMany(${keys[i]})`);
    same(map.get(keys[i]), expected, `get(${keys[i]})`);
    insist(map.has(keys[i]) === model.has(key), `Wrong has(${keys[i]})`);
    frozen(values[i]);
  }
  return keys.length * 3;
}
export function checkMap(map, model, queries) {
  insist(Object.isFrozen(map) && map.size === model.size, 'Wrong or mutable Map snapshot');
  const seen = new Set();
  for (const [key, value] of map.entries()) {
    insist(model.has(key) && !seen.has(key), `Unexpected/duplicate entry ${key}`);
    same(value, model.get(key), `entry ${key}`); frozen(value); seen.add(key);
  }
  insist(seen.size === model.size, 'Missing public entries');
  checkReads(map, [...model.keys()], model);
  // Both passes are retained and fully checked: warm positives and repeated
  // misses, including requests beyond the optional negative-cache budget.
  checkReads(map, queries, model); checkReads(map, queries, model);
}
export function checkReadonly(map, value) {
  for (const operation of [() => map.set('forbidden-write', value), () => map.delete('absent/readonly'),
    () => map.deleteMany([])]) {
    let rejected = false;
    try { operation(); } catch (error) { rejected = /read-only/.test(String(error)); }
    insist(rejected, 'Attached snapshot accepted a write');
  }
}
export function checkBytes(memory, saved, start = 65536) {
  const current = new Uint8Array(memory.buffer, start, saved.length);
  insist(current.length === saved.length && saved.every((value, i) => value === current[i]), 'Published source bytes changed');
}
export function readState(S, map) {
  const packet = S.getWorkerData({ map }, { copy: false }), arena = packet.arenas[0];
  return { arena, used: arena.used, descriptor: packet.structures.map.data,
    bytes: new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536).slice() };
}
export function checkReadState(S, map, saved) {
  const packet = S.getWorkerData({ map }, { copy: false }), current = packet.arenas[0];
  insist(current.used === saved.used, 'Reads advanced the writer allocation frontier');
  same(packet.structures.map.data, saved.descriptor, 'retained descriptor');
  checkBytes(current.memory, saved.bytes);
}
