export function equal(actual, expected, label = 'values') {
  if (actual.length !== expected.length) throw new Error(`${label}: length mismatch`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], b = expected[i];
    const same = b !== null && typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b);
    if (!same || !Object.hasOwn(actual, i)) throw new Error(`${label}: mismatch at ${i}`);
  }
}
export function fixture(S, workload) {
  const { kind, type, size, edited } = workload;
  const C = S[kind === 'linked' ? 'SharedLinkedList' : 'SharedDoublyLinkedList'];
  const value = i => type === 'number' ? i + 0.25 : type === 'boolean' ? i % 3 === 0
    : type === 'string' ? `界🙂:${i}:value` : { i, values: [i, i + 1], child: { text: `界${i}` } };
  let item = S.compact(new C(type));
  const expected = Array.from({ length: size }, (_, i) => value(i));
  for (const v of expected) item = item.append(v);
  const retained = item;
  if (edited) for (let step = 0; step < 16; step++) {
    const index = 17 + step * 37, v = value(size + step);
    item = item.insertAfter(index, v).removeFirst(); expected.splice(index + 1, 0, v); expected.shift();
  }
  return { item, retained, expected };
}
export function materialize(item, operation) {
  if (operation === 'compact') return item.toArray();
  if (operation === 'forEach' || operation === 'forEachReverse') {
    const values = [], indices = [];
    item[operation]((value, index) => { values.push(value); indices.push(index); });
    const expectedIndices = Array.from({ length: item.size }, (_, i) => operation === 'forEachReverse' ? item.size - 1 - i : i);
    equal(indices, expectedIndices, 'callback indices'); return values;
  }
  return item[operation]();
}
