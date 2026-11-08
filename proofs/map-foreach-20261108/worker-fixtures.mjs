// Browser/Node shared correctness fixtures. These checks never collect timings.
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function equal(actual, expected, label = 'value') {
  if (Object.is(actual, expected)) return;
  assert(actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object', `Mismatch: ${label}`);
  assert(Array.isArray(actual) === Array.isArray(expected), `Array kind: ${label}`);
  if (Array.isArray(expected)) assert(actual.length === expected.length, `Array length: ${label}`);
  const actualKeys = Object.keys(actual), expectedKeys = Object.keys(expected);
  assert(actualKeys.length === expectedKeys.length, `Key count: ${label}`);
  for (let i = 0; i < expectedKeys.length; i++) {
    const key = expectedKeys[i];
    assert(actualKeys[i] === key, `Key order: ${label}`);
    equal(actual[key], expected[key], `${label}.${key}`);
  }
}
const normalize = value => value && typeof value.toArray === 'function' ? value.toArray() : value;
export function collect(map) {
  const output = [];
  assert(map.forEach((value, key) => output.push([key, normalize(value)])) === undefined, 'forEach return');
  return output;
}
export function expected(structures) {
  return Object.fromEntries(Object.entries(structures).map(([name, map]) => [name, [...map.entries()].map(([key, value]) => [key, normalize(value)])]));
}
export function capture(S, structures) {
  return S.getWorkerData(structures, { copy: false }).arenas.map(source => ({ memory: source.memory,
    bytes: new Uint8Array(source.memory.buffer, 65536, source.used - 65536).slice() }));
}
export function unchanged(records) {
  for (const { memory, bytes } of records) {
    const current = new Uint8Array(memory.buffer, 65536, bytes.length);
    assert(current.every((value, i) => value === bytes[i]), 'Published source bytes changed');
  }
}
export function fixture(S) {
  S.resetMap(); S.resetSharedList();
  const specials = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE];
  const numericEntries = Array.from({ length: 1025 }, (_, i) => [`${i % 7 ? 'row' : '道路🙂'}/${i}`, i < specials.length ? specials[i] : i + 0.5]);
  numericEntries.push(['costarring', 23], ['liquid', -17], ['', 11], ['\0', 12], ['\ufeff', 13]);
  let numeric = new S.SharedMap('number').setMany(numericEntries);
  for (let i = 0; i < 37; i++) numeric = numeric.set(`overlay/${i}`, -i);
  const strings = new S.SharedMap('string').setMany(Array.from({ length: 65 }, (_, i) => [`text/${i}`, i % 3 ? `界🙂${i}\ufeff` : '']));
  const objects = new S.SharedMap('object').setMany(Array.from({ length: 65 }, (_, i) => [`json/${i}`, { i, children: [null, false, { value: i * 3 }] }]));
  const child = new S.SharedList('number').pushMany([NaN, -0, Infinity, 42]);
  const nested = new S.SharedMap('SharedList<number>').set('child', child);
  const structures = { numeric, strings, objects, nested };
  // Validate membership and exact scalar values without relying on forEach.
  for (const [key, value] of numericEntries) assert(Object.is(numeric.get(key), value), `Numeric fixture ${key}`);
  return { structures, expected: expected(structures) };
}
export function verify(structures, wanted, readOnly = false) {
  for (const [name, map] of Object.entries(structures)) {
    equal(collect(map), wanted[name], `forEach ${name}`);
    equal([...map.entries()].map(([key, value]) => [key, normalize(value)]), wanted[name], `entries ${name}`);
    if (name === 'objects') map.forEach(value => {
      assert(Object.isFrozen(value) && Object.isFrozen(value.children) && Object.isFrozen(value.children[2]), 'Frozen JSON');
    });
  }
  if (readOnly) {
    let threw = false;
    try { structures.numeric.set('forbidden', 1); } catch (error) { threw = /read-only/.test(error.message); }
    assert(threw, 'Attached writer must reject edits');
  }
}
export function editAndGrow(S, original) {
  const memory = S.getWorkerData(original, { copy: false }).arenas[0].memory, before = memory.buffer;
  const strings = original.strings.set('growth', 'x'.repeat(before.byteLength * 2));
  assert(memory.buffer !== before, 'Writer must grow');
  const numeric = original.numeric.set('costarring', 99).delete('liquid').set('new/🙂', -73);
  const objects = original.objects.set('new-json', { i: -1, children: [null, false, { value: -3 }] });
  return { numeric, strings, objects, nested: original.nested };
}
export function reentrantWriter(S) {
  const original = fixture(S), published = capture(S, original.structures), seen = [];
  let next;
  original.structures.numeric.forEach((value, key) => {
    if (seen.length === 3) {
      next = editAndGrow(S, original.structures);
      equal(collect(original.structures.numeric), original.expected.numeric, 'Reentrant original');
      verify(next, expected(next));
    }
    seen.push([key, value]);
  });
  equal(seen, original.expected.numeric, 'Reentrant outer traversal');
  verify(original.structures, original.expected);
  unchanged(published);
  return { checks: ['callback-growth', 'forks', 'reentrancy', 'special-values', 'original-byte-immutability'] };
}
export function createWorkerHandler(S, send, control) {
  let old, oldExpected, originalBytes;
  return async message => {
    if (message.type === 'initial') {
      old = await S.initWorker(message.payload); oldExpected = message.expected;
      originalBytes = capture(S, old);
      const visited = [];
      old.numeric.forEach((value, key) => {
        if (visited.length === 3) {
          send({ type: 'paused' });
          assert(Atomics.wait(control, 0, 0, 20000) !== 'timed-out', 'Owner growth handshake');
          equal(collect(old.numeric), oldExpected.numeric, 'Worker reentrant scan');
          equal(collect(old.strings), oldExpected.strings, 'Worker second collection');
        }
        visited.push([key, value]);
      });
      equal(visited, oldExpected.numeric, 'Worker resumed order and values');
      verify(old, oldExpected, true); unchanged(originalBytes);
      return { type: 'scanned', ok: true, count: visited.length };
    }
    assert(message.type === 'updated' && old, 'Worker protocol');
    const updated = await S.initWorker(message.payload);
    verify(updated, message.expected, true);
    verify(old, oldExpected, true); unchanged(originalBytes);
    return { type: 'complete', ok: true, checked: ['retained-snapshot', 'new-root-after-growth', 'read-only', 'all-value-types', 'published-bytes'] };
  };
}
