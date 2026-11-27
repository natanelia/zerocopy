export const CASES = Object.freeze([
  { name: 'keys-object-large', size: 4096, type: 'object', operation: 'keys', role: 'target' },
  { name: 'keys-object-churn', size: 1024, type: 'object', operation: 'keys', churn: true, role: 'fallback' },
  { name: 'keys-number-small', size: 32, type: 'number', operation: 'keys', role: 'small' },
  { name: 'values-number-large', size: 4096, type: 'number', operation: 'values', longKeys: true, role: 'target' },
  { name: 'values-string-churn', size: 1024, type: 'string', operation: 'values', longKeys: true, churn: true, role: 'fallback' },
  { name: 'values-boolean-small', size: 32, type: 'boolean', operation: 'values', role: 'small' },
  { name: 'ordered-set-churn', size: 1024, type: 'set', operation: 'values', churn: true, role: 'consumer' },
  { name: 'entries-number-control', size: 4096, type: 'number', operation: 'entries', role: 'control' },
  { name: 'lookup-number-control', size: 4096, type: 'number', operation: 'lookup', role: 'control' },
  { name: 'empty-projections', size: 0, type: 'number', operation: 'both', role: 'empty' },
].map(Object.freeze));

export function makeFixture(api, workload) {
  api.resetOrderedMap();
  const { size, type, churn, operation, longKeys } = workload;
  const key = i => `${i % 4 === 0 ? '界🙂' : 'key'}-${String(i).padStart(6, '0')}${longKeys ? '-long-label'.repeat(5) : ''}`;
  const value = (i, revision = 0) => type === 'number' ? i + revision * size + 0.25
    : type === 'boolean' ? !!((i + revision) & 1)
    : type === 'string' ? `Résumé-${i}-r${revision}-${'界🙂'.repeat(4)}`
    : { i, revision, text: 'Résumé 🙂 '.repeat(12), values: [i, i + 1, i + 2], active: !!(i & 1) };
  let collection, model, queries;
  if (type === 'set') {
    collection = new api.SharedOrderedSet(); model = new Set();
    const item = i => i & 1 ? String(i >>> 1) : i >>> 1;
    for (let i = 0; i < size; i++) { collection = collection.add(item(i)); model.add(item(i)); }
    if (churn) for (let round = 0; round < 4; round++) for (let i = round & 1; i < size; i += 2) {
      collection = collection.delete(item(i)).add(item(i)); model.delete(item(i)); model.add(item(i));
    }
  } else {
    collection = new api.SharedOrderedMap(type); model = new Map();
    for (let i = 0; i < size; i++) { collection = collection.set(key(i), value(i)); model.set(key(i), value(i)); }
    if (churn) {
      for (let i = 0; i < size; i += 7) { collection = collection.set(key(i), value(i, 1)); model.set(key(i), value(i, 1)); }
      for (let round = 0; round < 4; round++) for (let i = round & 1; i < size; i += 2) {
        collection = collection.delete(key(i)).set(key(i), value(i, round + 2));
        model.delete(key(i)); model.set(key(i), value(i, round + 2));
      }
    }
    if (operation === 'lookup') queries = Array.from({ length: size }, (_, i) => i % 8 === 0 ? `missing-${i}` : key((i * 73) % size));
  }
  const expected = operation === 'keys' ? [...model.keys()] : operation === 'entries' ? [...model]
    : operation === 'lookup' ? queries.map(query => model.get(query)) : operation === 'both' ? [[], []] : [...model.values()];
  if (collection.size !== model.size) throw new Error(`Fixture size mismatch: ${workload.name}`);
  const descriptor = collection.toWorkerData();
  if (descriptor.orderStable !== !churn) throw new Error(`Unexpected order stability: ${workload.name}`);

  // The oracle comes from native Map/Set input semantics. It never invokes an
  // unmeasured projection, which would give the builds different cache histories.
  function materialize() {
    if (operation === 'keys') return Array.from(collection.keys());
    if (operation === 'values') return Array.from(collection.values());
    if (operation === 'entries') return Array.from(collection.entries());
    if (operation === 'both') return [Array.from(collection.keys()), Array.from(collection.values())];
    const result = new Array(queries.length);
    for (let i = 0; i < queries.length; i++) result[i] = collection.get(queries[i]);
    return result;
  }
  function verify(actual) {
    if (actual.length !== expected.length) throw new Error(`Output length mismatch: ${workload.name}`);
    if (operation === 'both') {
      if (!Array.isArray(actual[0]) || !Array.isArray(actual[1]) || actual[0].length || actual[1].length) throw new Error('Empty projections differ');
      return;
    }
    for (let i = 0; i < expected.length; i++) {
      if (!Object.hasOwn(actual, i)) throw new Error(`Missing output at ${i}: ${workload.name}`);
      const good = operation === 'entries'
        ? Array.isArray(actual[i]) && actual[i].length === 2 && actual[i][0] === expected[i][0] && Object.is(actual[i][1], expected[i][1])
        : Object.is(actual[i], expected[i]);
      if (!good) throw new Error(`Output differs at ${i}: ${workload.name}`);
    }
  }
  return { collection, expected, descriptor, materialize, verify,
    outputElements: operation === 'both' ? 2 : expected.length,
    maxRepeat: Math.min(65536, Math.max(1, Math.floor(1048576 / Math.max(1, expected.length * (operation === 'entries' ? 3 : 1))))) };
}
