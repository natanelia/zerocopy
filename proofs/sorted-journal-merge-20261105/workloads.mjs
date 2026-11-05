import { Buffer } from 'node:buffer';

export const CASES = Object.freeze([
  { name: 'values-tail-4096', baseSize: 4096, operation: 'values', changes: 'tail', pending: 1, role: 'target' },
  { name: 'keys-tail-4096', baseSize: 4096, operation: 'keys', changes: 'tail', pending: 1, role: 'target' },
  { name: 'values-long-prefix-4096', baseSize: 4096, operation: 'values', changes: 'tail', pending: 1, longPrefix: true, role: 'target' },
  { name: 'entries-mixed-4096', baseSize: 4096, operation: 'entries', changes: 'mixed', pending: 4, role: 'mixed' },
  { name: 'values-overwrite-4096', baseSize: 4096, operation: 'values', changes: 'overwrite', pending: 4, role: 'overwrite' },
  { name: 'values-front-4096', baseSize: 4096, operation: 'values', changes: 'front', pending: 1, role: 'adversarial' },
  { name: 'values-small-32', baseSize: 31, operation: 'values', changes: 'tail', pending: 1, role: 'small' },
  { name: 'values-canonical-control', baseSize: 4096, operation: 'values', changes: 'none', pending: 0, role: 'control' },
  { name: 'map-get-control', baseSize: 4096, operation: 'lookup', changes: 'none', kind: 'map', role: 'control' },
  { name: 'empty-projections', baseSize: 0, operation: 'both', changes: 'none', pending: 0, role: 'empty' },
].map(Object.freeze));

export function makeFixture(api, workload) {
  const { baseSize, operation, changes, longPrefix, kind = 'sorted' } = workload;
  if (kind === 'map') api.resetMap(); else api.resetSortedMap();
  let collection = kind === 'map' ? new api.SharedMap('number') : new api.SharedSortedMap('number');
  const model = new Map(), prefix = longPrefix ? 'route/界🙂/'.repeat(24) : '';
  const key = i => `${prefix}k-${String(i).padStart(6, '0')}`;
  const put = (k, value) => { collection = collection.set(k, value); model.set(k, value); };
  for (let i = 0; i < baseSize; i++) put(key(i), i + .25);
  if (changes === 'tail') put(`${prefix}z-tail`, -123.25);
  else if (changes === 'front') put(`${prefix}a-front`, -123.25);
  else if (changes === 'overwrite') for (const i of [3000, 1, 4095, 1536]) put(key(i), -(i + .25));
  else if (changes === 'mixed') for (const [k, value] of [
    [key(3072) + 'a', -3072.25], [key(256), -256.25], [key(2048), -2048.25], [key(1024) + 'a', -1024.25],
  ]) put(k, value);

  const descriptor = collection.toWorkerData(), data = api.getWorkerData({ collection }, { copy: false }).arenas[0];
  const view = new DataView(data.memory.buffer), tag = descriptor.root ? view.getUint32(descriptor.root, true) : null;
  const pending = tag === 0xffffffff ? view.getUint32(descriptor.root + 12, true) : 0;
  const base = pending ? view.getUint32(descriptor.root + 4, true) : descriptor.root;
  const shape = { kind, size: collection.size, rootTag: tag, pending, baseRoot: base,
    baseTag: base ? view.getUint32(base, true) : null, keyPrefixUtf8Bytes: new TextEncoder().encode(prefix).length };
  if (collection.size !== model.size) throw new Error(`Fixture size differs: ${workload.name}`);
  if (kind === 'sorted' && (pending !== workload.pending || shape.baseTag === 0xffffffff)) throw new Error(`Unexpected journal shape: ${workload.name}`);

  // Independent byte-order oracle. Encoding/sorting happens outside timing and
  // never invokes an unmeasured library projection or lookup.
  const encoder = new TextEncoder();
  const ordered = [...model].map(([key, value]) => ({ key, value, bytes: encoder.encode(key) }));
  ordered.sort((a, b) => Buffer.compare(a.bytes, b.bytes));
  const queries = operation === 'lookup' ? Array.from({ length: baseSize }, (_, i) => i % 8 ? key((i * 73) % baseSize) : `missing-${i}`) : undefined;
  const expected = operation === 'both' ? [[], []] : operation === 'lookup' ? queries.map(query => model.get(query))
    : operation === 'keys' ? ordered.map(row => row.key) : operation === 'values' ? ordered.map(row => row.value)
    : ordered.map(row => [row.key, row.value]);

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
    if (actual.length !== expected.length) throw new Error(`Output length differs: ${workload.name}`);
    if (operation === 'both') {
      if (!Array.isArray(actual[0]) || !Array.isArray(actual[1]) || actual[0].length || actual[1].length) throw new Error('Nonempty empty projection');
      return;
    }
    for (let i = 0; i < expected.length; i++) {
      if (!Object.hasOwn(actual, i)) throw new Error(`Missing output ${i}: ${workload.name}`);
      const equal = operation === 'entries' ? Array.isArray(actual[i]) && actual[i].length === 2 && actual[i][0] === expected[i][0] && Object.is(actual[i][1], expected[i][1])
        : Object.is(actual[i], expected[i]);
      if (!equal) throw new Error(`Output differs at ${i}: ${workload.name}`);
    }
  }
  return { collection, expected, descriptor, shape, materialize, verify, outputElements: expected.length,
    maxRepeat: Math.min(65536, Math.max(1, Math.floor(1048576 / Math.max(1, expected.length * (operation === 'entries' ? 3 : 1))))) };
}
