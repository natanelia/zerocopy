// Deterministic fixtures shared unchanged by Node, Bun and the browser runner.
export const FIXTURE_VERSION = 1;
const shapes = ['shallow', 'deep', 'coordinates', 'unicode', 'long-string', 'large-record', 'heterogeneous', 'json-scalars'];
const sizes = { shallow: 1024, deep: 128, coordinates: 512, unicode: 1024, 'long-string': 64, 'large-record': 24, heterogeneous: 1024, 'json-scalars': 1024 };
const keyEncoder = new TextEncoder(), keyDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
// The collection stores UTF-8 keys: lone UTF-16 surrogates become U+FFFD.
// NFC and NFD are intentionally distinct; do not apply canonical normalization.
const storedKey = key => keyDecoder.decode(keyEncoder.encode(key));
export const CASES = [
  { id: 'catalog-full-get', kind: 'map', type: 'object', shape: 'catalog', size: 10000, workload: 'full-object-get' },
  { id: 'catalog-legacy-lookup', kind: 'map', type: 'object', shape: 'catalog', size: 10000, workload: 'legacy-lookup' },
  { id: 'catalog-legacy-validate', kind: 'map', type: 'object', shape: 'catalog', size: 10000, workload: 'legacy-validate' },
  ...shapes.flatMap(shape => ['map', 'list'].map(kind => ({ id: `${kind}-${shape}`, kind, type: 'object', shape, size: sizes[shape], workload: 'ordinary-get' }))),
  ...['entries-below', 'entries-above', 'bytes-below', 'bytes-above'].flatMap(shape => ['map', 'list'].map(kind => ({
    id: `${kind}-${shape}`, kind, type: 'object', shape, size: shape === 'entries-below' ? 1984 : shape === 'entries-above' ? 2112 : 128,
    workload: 'ordinary-get', cacheBoundary: shape.startsWith('entries') ? '2048 entries; bytes remain below 2 MiB' : '2 MiB serialized bytes; count remains below 2048',
  }))),
  ...['map', 'list'].map(kind => ({ id: `${kind}-primitive-number`, kind, type: 'number', shape: 'numbers', size: 2048, workload: 'ordinary-get' })),
  ...['map', 'list'].map(kind => ({ id: `${kind}-nested-descriptor`, kind, type: 'SharedMap<number>', shape: 'nested-number-map', size: 256, workload: 'ordinary-get' })),
  ...['map', 'list'].map(kind => ({ id: `${kind}-misses`, kind, type: 'object', shape: 'shallow', size: 1024, workload: 'ordinary-get', onlyMisses: true })),
];

function record(shape, index) {
  if (shape === 'nested-number-map') return index + 0.125;
  if (shape === 'numbers') return index % 17 === 0 ? -0 : index + 0.125;
  if (shape === 'deep') {
    let value = { index, text: `leaf-${index}` };
    for (let depth = 0; depth < 48; depth++) value = { depth, child: value, siblings: [depth, index] };
    return value;
  }
  if (shape === 'coordinates') return { index, coordinates: Array.from({ length: 128 }, (_, i) => [index + i / 10, -index - i / 100, i % 5]), bounds: [index, -index, index + 1, 1 - index] };
  if (shape === 'unicode') return { index, text: `商品🦊é e\u0301 零\u0000 \"quoted\" \\slash \nline \ud800 ${index}`, tags: ['🙂', '𐐷', '\udfff'], constructor: { safe: true }, ...JSON.parse('{"__proto__":{"own":true}}') };
  if (shape === 'long-string') return { index, text: `${index}:` + 'a🙂漢字\"\\'.repeat(2048) };
  if (shape === 'large-record') return { index, payload: 'x'.repeat(65536), details: Array.from({ length: 128 }, (_, i) => ({ i, value: index + i, names: ['a', 'b', 'c'] })) };
  if (shape === 'heterogeneous') {
    switch (index % 5) {
      case 0: return { index, a: true, objects: [{ name: 'nested' }] };
      case 1: return { index, label: `item-${index}`, price: index / 7, extra: { tags: ['a', 'b'] } };
      case 2: return [index, null, { index, nested: [1, 2, 3] }];
      case 3: return JSON.parse(`{"__proto__":{"index":${index}},"constructor":"record","empty":{}}`);
      default: return { index, status: null, values: [false, '🙂', index] };
    }
  }
  if (shape === 'json-scalars') return [null, true, false, index, `value-${index}`, -0][index % 6];
  if (shape === 'bytes-below' || shape === 'bytes-above') return { index, text: 'x'.repeat(shape === 'bytes-below' ? 15360 : 17408) };
  return { index, active: index % 3 === 0, label: `record-${index}`, score: index / 3 };
}

export function makeFixture(definition, catalog) {
  if (definition.shape === 'catalog') {
    const entries = catalog.entriesFor(definition.size), requests = catalog.queryIds(definition.size);
    return { entries, values: entries.map(([, value]) => value), requests, uniqueLookupKeys: new Set(requests).size,
      edits: catalog.editsFor(definition.size, 1), expected: new Map(entries), serializedBytes: entries.reduce((n, [, value]) => n + new TextEncoder().encode(JSON.stringify(value)).length, 0) };
  }
  const values = Array.from({ length: definition.size }, (_, index) => record(definition.shape, index));
  const entries = values.map((value, index) => [definition.shape === 'unicode' && index % 13 === 1 ? `surrogate/\ud800/${index}`
    : definition.shape === 'unicode' && index % 11 === 1 ? `cafe\u0301/${index}` : index % 7 ? `record/${index}` : `café/${index}`, value]);
  const keys = entries.map(([key]) => key);
  const requests = definition.onlyMisses
    ? values.map((_, index) => definition.kind === 'map' ? `missing/${index}` : index + definition.size)
    : definition.kind === 'map' ? keys : values.map((_, index) => index);
  if (definition.shape === 'unicode' && definition.kind === 'map') requests.push('cafe\u0301/0', 'café/12', 'surrogate/\ufffd/1');
  const normalized = definition.type === 'object' ? values.map(value => JSON.parse(JSON.stringify(value))) : values;
  const expected = definition.kind === 'map' ? new Map(entries.map(([key], i) => [storedKey(key), normalized[i]])) : normalized;
  const edits = Array.from({ length: Math.min(100, values.length) }, (_, i) => [definition.kind === 'map' ? entries[i][0] : i,
    definition.type === 'number' || definition.shape === 'nested-number-map' ? i + 100000.5 : { edited: i, nested: { revision: 1 }, payload: `replacement-${i}` }]);
  return { entries, values, requests, edits, expected, uniqueLookupKeys: new Set(requests.map(key => typeof key === 'string' ? storedKey(key) : key)).size,
    serializedBytes: definition.shape === 'nested-number-map' ? null : definition.type === 'object' ? values.reduce((n, value) => n + new TextEncoder().encode(JSON.stringify(value)).length, 0) : values.length * 8 };
}

export function expectedPlain(fixture, definition, edited = false, requests = fixture.requests) {
  const changes = new Map(fixture.edits.map(([key, value]) => [typeof key === 'string' ? storedKey(key) : key, value]));
  return requests.map(key => {
    const normalizedKey = typeof key === 'string' ? storedKey(key) : key;
    if (edited && changes.has(normalizedKey)) return changes.get(normalizedKey);
    return definition.kind === 'map' ? fixture.expected.get(normalizedKey) : fixture.expected[normalizedKey];
  });
}
