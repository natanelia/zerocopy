/** Runtime-neutral checks. Mechanism tracing runs separately from timing. */
export function equal(actual, expected, label = 'value') {
  if (Object.is(actual, expected)) return;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') throw new Error(`${label}: unequal primitives`);
  const ak = Object.keys(actual), ek = Object.keys(expected);
  if (Array.isArray(actual) !== Array.isArray(expected) || ak.length !== ek.length) throw new Error(`${label}: shape mismatch`);
  for (let i = 0; i < ek.length; i++) {
    if (ak[i] !== ek[i]) throw new Error(`${label}: key mismatch`);
    equal(actual[ek[i]], expected[ek[i]], `${label}/${ek[i]}`);
  }
}
export const budget = size => size * (2 + Math.ceil(Math.log2(size)));
export function churnFixture(S, size, history, type = 'number', pattern = 'rotate') {
  S.resetOrderedMap();
  const value = i => type === 'number' ? i + 0.25 : type === 'boolean' ? i % 2 === 0 : type === 'string' ? `Résumé 🙂 ${i}` : { i, values: [i, i + 1] };
  let map = new S.SharedOrderedMap(type), native = new Map();
  const keys = Array.from({ length: Math.max(2, size) }, (_, i) => i % 3 ? `key-${i}` : `鍵🙂-${i}`);
  for (let i = 0; i < size; i++) { map = map.set(keys[i], value(i)); native.set(keys[i], value(i)); }
  const initial = map, initialExpected = [...native];
  for (let i = size; i < history; i++) {
    if (size === 1) {
      const old = native.keys().next().value, key = old === keys[0] ? keys[1] : keys[0];
      map = map.set(key, value(i)).delete(old); native.set(key, value(i)); native.delete(old);
    } else {
      const key = keys[pattern === 'hot' ? 0 : (Math.imul(i, 17) >>> 0) % size];
      map = map.delete(key).set(key, value(i)); native.delete(key); native.set(key, value(i));
    }
  }
  return { map, expected: [...native], initial, initialExpected };
}
export function assertScans(map, expected) {
  equal([...map.entries()], expected, 'entries'); equal([...map.keys()], expected.map(e => e[0]), 'keys'); equal([...map.values()], expected.map(e => e[1]), 'values');
  const visited = []; map.forEach((value, key) => visited.push([key, value])); equal(visited, expected, 'forEach');
}
export async function runChurnChecks(S) {
  const passed = [];
  const check = (name, fn) => { fn(); passed.push(name); };
  for (const size of [1, 2, 3, 8, 31, 32, 33, 256]) for (const history of [size, budget(size) - 1, budget(size), budget(size) + 1, budget(size) * 2]) {
    check(`numeric boundaries ${size}/${history}`, () => {
      const { map, expected, initial, initialExpected } = churnFixture(S, size, history);
      assertScans(map, expected); assertScans(initial, initialExpected);
      if (map.tail !== history) throw new Error('Fixture history mismatch');
      const key = expected[0][0], replacement = map.set(key, -0), replaced = expected.map(([k, v]) => [k, k === key ? -0 : v]);
      if (replacement.tail !== history) throw new Error('Replacement changed insertion ordinal');
      assertScans(replacement, replaced); assertScans(map, expected);
      assertScans(S.compact(map), expected);
    });
  }
  for (const type of ['number', 'boolean', 'string', 'object']) for (const pattern of ['rotate', 'hot']) {
    const { map, expected } = churnFixture(S, 33, 2048, type, pattern);
    check(`${type}/${pattern}: interleaving and identities`, () => {
      const a = map.entries(), b = map.entries(), firstA = a.next().value, firstB = b.next().value;
      equal(firstA, expected[0]); equal(firstB, expected[0]);
      const memory = S.getWorkerData({ map }, { copy: false }).arenas[0].memory;
      const before = memory.buffer.byteLength; memory.grow(1);
      if (memory.buffer.byteLength <= before) throw new Error('No memory growth');
      equal([firstA, ...a], expected); equal([firstB, ...b], expected); assertScans(map, expected);
      if (type === 'object') {
        const key = expected[0][0], cached = map.get(key);
        if (!Object.isFrozen(cached) || !Object.isFrozen(cached.values) || map.entries().next().value[1] !== cached) throw new Error('Decoded object identity/freeze changed');
      }
      let nested = 0; map.forEach(() => { if (!nested++) assertScans(map, expected); });
      const iterator = map.entries(); iterator.next(); equal(iterator.return(undefined), { value: undefined, done: true });
      equal(iterator.next(), { value: undefined, done: true });
      const lazy = map.entries(); if (Object.getPrototypeOf(lazy) !== Object.getPrototypeOf(map.entries())) throw new Error('Generator ownership changed');
    });
    for (const copy of [false, true]) {
      const reader = await S.initWorker(S.getWorkerData({ map }, { copy }));
      check(`${type}/${pattern}: ${copy ? 'copy' : 'shared'} attachment`, () => {
        assertScans(reader.map, expected);
        let failed = false; try { reader.map.set('new', expected[0][1]); } catch (error) { failed = /read-only/.test(error.message); }
        if (!failed) throw new Error('Reader allowed a write');
      });
    }
  }
  check('exact-hash collisions and deterministic mixed edit history', () => {
    let map = new S.SharedOrderedMap('number'), native = new Map(), seed = 0x19730307;
    const keys = ['costarring', 'liquid', 'anchor', ...Array.from({ length: 61 }, (_, i) => `key-${i}`)];
    const retained = [];
    for (let i = 0; i < 5000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const key = keys[seed % keys.length];
      if (i % 4 === 0) { map = map.delete(key); native.delete(key); }
      else { if (i % 3 === 0) { map = map.delete(key); native.delete(key); } map = map.set(key, i); native.set(key, i); }
      if (i % 127 === 0) { assertScans(map, [...native]); retained.push([map, [...native]]); }
    }
    for (const [old, expected] of retained) assertScans(old, expected);
    assertScans(map, [...native]);
    let bucket = new S.SharedOrderedMap('number').set('costarring', 1).set('liquid', 2);
    for (let i = 0; i < 128; i++) bucket = bucket.delete('costarring').set('costarring', i);
    assertScans(bucket, [['liquid', 2], ['costarring', 127]]);
  });
  check('special numeric values and Unicode-equivalent keys', () => {
    let map = new S.SharedOrderedMap('number'); const native = new Map();
    const numbers = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE];
    for (let i = 0; i < 128; i++) {
      const key = `key-${i % numbers.length}`; map = map.delete(key).set(key, numbers[i % numbers.length]); native.delete(key); native.set(key, numbers[i % numbers.length]);
    }
    map = map.set('\ud800', 2).set('\ufffd', 3); native.set('\ufffd', 3); assertScans(map, [...native]);
  });
  check('empty reset, deletion-only, forks and legacy descriptors', () => {
    const { map, expected } = churnFixture(S, 33, 2048);
    let empty = map; for (const key of map.keys()) empty = empty.delete(key);
    assertScans(empty, []); if (empty.tail || empty.head) throw new Error('Empty counters were not reset');
    assertScans(empty.set('new', 1), [['new', 1]]);
    const deleted = map.delete(expected[0][0]); assertScans(deleted, expected.slice(1)); assertScans(map, expected);
    const descriptor = map.toWorkerData(), arena = map.arena;
    const { orderStable, ...legacy } = descriptor;
    assertScans(S.SharedOrderedMap.fromWorkerData(legacy, arena), expected);
    for (const bad of [{ tail: 0 }, { tail: undefined }, { tail: descriptor.tail + 99999 }, { size: 0 }, { size: 1 }, { size: -1 }, { size: NaN }, { tail: Infinity }]) {
      assertScans(S.SharedOrderedMap.fromWorkerData({ ...descriptor, ...bad }, arena), expected);
    }
    assertScans(S.SharedOrderedMap.fromWorkerData({ ...descriptor, head: 0 }, arena), []);
  });
  check('nested frozen collection values retain their source snapshot', () => {
    const nested = new S.SharedList('number').push(7).push(8);
    let map = new S.SharedOrderedMap('SharedList<number>').set('anchor', nested);
    for (let i = 0; i < 256; i++) map = map.delete('churn').set('churn', nested);
    const first = map.get('anchor');
    for (const [key, value] of map.entries()) { equal([...value.values()], [7, 8]); if (!Object.isFrozen(value) || value !== map.get(key)) throw new Error('Nested snapshot identity mismatch'); }
    if (map.entries().next().value[1] !== first) throw new Error('Nested identity changed');
  });
  check('ordered set string/number identity and insertion history', () => {
    let set = new S.SharedOrderedSet(), native = new Set();
    const values = ['0', 0, '', -1, '🙂', Infinity, NaN, 'NaN'];
    for (const value of values) { set = set.add(value); native.add(value); }
    const old = set, oldExpected = [...native];
    for (let i = 0; i < 256; i++) { const value = values[i % values.length]; set = set.delete(value).add(value); native.delete(value); native.add(value); }
    equal([...set.values()], [...native]); equal([...old.values()], oldExpected);
    const visited = []; set.forEach(value => visited.push(value)); equal(visited, [...native]);
  });
  check('large retained snapshot', () => { const { map, expected, initial, initialExpected } = churnFixture(S, 2048, 32768); assertScans(map, expected); assertScans(initial, initialExpected); });
  return passed;
}

export function traceChurn(map) {
  const arena = map.arena, view = arena.dv, logOffsets = new Set(); let node = map.head;
  while (node) { logOffsets.add(node); logOffsets.add(node + 4); node = view.getUint32(node, true); }
  const arenaBytesBefore = arena.used;
  const originalRead = DataView.prototype.getUint32, originalPush = Array.prototype.push, originalSort = Array.prototype.sort, wasm = arena.wasm;
  let logReads = 0, findCalls = 0, maxPointerArray = 0, sortItems = 0, comparisons = 0, count = 0;
  DataView.prototype.getUint32 = function (offset, le) { if (this.buffer === view.buffer && logOffsets.has(offset)) logReads++; return originalRead.call(this, offset, le); };
  Array.prototype.push = function (...items) { const size = originalPush.apply(this, items); if (items.length === 1 && Number.isInteger(items[0]) && items[0] >= 65536) maxPointerArray = Math.max(maxPointerArray, size); return size; };
  Array.prototype.sort = function (compare) { sortItems += this.length; return originalSort.call(this, (a, b) => { comparisons++; return compare(a, b); }); };
  arena.wasm = { ...wasm, mapFind: (...args) => { findCalls++; return wasm.mapFind(...args); } };
  try { for (const entry of map.entries()) count++; }
  finally { DataView.prototype.getUint32 = originalRead; Array.prototype.push = originalPush; Array.prototype.sort = originalSort; arena.wasm = wasm; }
  if (count !== map.size) throw new Error('Traced count mismatch');
  if (arena.used !== arenaBytesBefore) throw new Error('Scanning allocated shared bytes');
  return { live: map.size, history: map.tail, logReads, findCalls, maxPointerArray, sortItems, comparisons, count, allocatedSharedBytes: arena.used - arenaBytesBefore };
}
export function runChurnMechanism(S, expectAdaptive) {
  const rows = [];
  for (const [size, histories] of [[1, [1, 2, 3, 64]], [32, [32, 64, 223, 224, 225, 1024, 8192, 65536]], [1024, [12288, 12289, 32768]]]) {
    for (const history of histories) {
      const { map } = churnFixture(S, size, history), row = traceChurn(map); rows.push(row);
      const adaptive = expectAdaptive && history > budget(size);
      equal(row.logReads, adaptive ? 1 : history * 2, 'history reads');
      equal(row.findCalls, adaptive || history === size ? 0 : history, 'mapFind calls');
      equal(row.maxPointerArray, adaptive ? size : history, 'temporary pointer slots');
      equal(row.sortItems, adaptive ? size : 0, 'sorted items');
    }
  }
  return rows;
}
