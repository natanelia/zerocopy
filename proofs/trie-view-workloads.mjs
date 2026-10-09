// Fixed public-API workload catalogue. Fixture construction, independent output
// oracles, shape inspection, hashing and allocator checks are all untimed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const catalogue = [];
function add(kind, trie, type, size, shape, operation, category, description) {
  catalogue.push(Object.freeze({
    name: `${kind}/${trie}/${type}/${size}/${shape}/${operation}`,
    kind, trie, type, size, shape, operation, category, target: category === 'target', description,
  }));
}
for (const size of [0, 1]) for (const trie of ['hamt', 'radix']) {
  add('map', trie, 'number', size, 'canonical', 'entries', 'control',
    `${size ? 'Singleton' : 'Empty'} ${trie === 'hamt' ? 'ordinary' : 'natural-sorted'} numeric map, full entries().`);
}
for (const size of [0, 1]) for (const trie of ['hamt', 'radix']) {
  add('set', trie, 'number', size, 'canonical', 'values', 'control',
    `${size ? 'Singleton' : 'Empty'} ${trie === 'hamt' ? 'ordinary' : 'sorted'} numeric set, full values().`);
}
add('map', 'hamt', 'number', 2, 'collision', 'entries', 'control',
  'Two FNV-1a collision keys, costarring and liquid, built with public setMany().');
add('map', 'hamt', 'number', 32, 'patched', 'entries', 'control',
  'Canonical 32-entry HAMT followed by 17 existing-key overwrites through set().');
for (const trie of ['hamt', 'radix']) add('map', trie, 'number', 4096, 'canonical', 'first', 'control',
  'One entries().next() followed by return(), on a canonical 4096-entry numeric map.');
for (const trie of ['hamt', 'radix']) add('map', trie, 'number', 4096, 'canonical', 'get', 'control',
  'One warmed existing-key get("key2048"), on a canonical 4096-entry numeric map.');
add('map', 'hamt', 'number', 4096, 'canonical', 'entries', 'control',
  'Full entries() on a 4096-entry HAMT built by one public setMany().');
add('map', 'hamt', 'number', 4096, 'patched', 'entries', 'control',
  'Full entries() after 47 existing-key overwrites at key(i * 7), using set().');
add('map', 'radix', 'number', 4096, 'canonical', 'entries', 'target',
  'Full entries() on natural-sorted radix; a temporary-key set/delete flushes its journal.');
add('map', 'radix', 'number', 4096, 'journal', 'entries', 'target',
  'Full entries() after four existing-key overwrites at key(i * 997), retaining four pending edits.');
for (const trie of ['hamt', 'radix']) add('map', trie, 'object', 4096, 'canonical', 'keys', trie === 'hamt' ? 'control' : 'target',
  'Full keys() on a canonical 4096-entry object map; existing public decode behavior is unchanged.');
export const CASES = Object.freeze(catalogue);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha256(JSON.stringify(value));
const HEAP_START = 65536;
const encode = new TextEncoder();
export function hashKey(key) {
  let hash = 2166136261;
  for (const byte of encode.encode(key)) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}
// The HAMT consumes low hash nibbles first. Equal full hashes preserve this
// fixture's insertion order. This oracle uses keys, never runtime root pointers.
function hamtOrder(a, b) {
  const left = hashKey(a[0]), right = hashKey(b[0]);
  for (let shift = 0; shift < 32; shift += 4) {
    const delta = ((left >>> shift) & 15) - ((right >>> shift) & 15);
    if (delta) return delta;
  }
  return 0;
}
function orderedEntries(model, trie) {
  return [...model].sort(trie === 'hamt' ? hamtOrder : (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
function valueAt(index, type) {
  return type === 'number' ? index + 0.25 : {
    index, values: [index, index + 1], child: { text: `value:${index}:界🙂` },
  };
}
function resolveCase(workload) {
  const spec = CASES.find(row => row.name === (typeof workload === 'string' ? workload : workload?.name));
  assert.ok(spec, 'Unknown frozen trie view workload');
  if (typeof workload !== 'string') assert.deepEqual(workload, spec, 'Workload definition changed');
  return spec;
}
function makeOperation(item, operation) {
  if (operation === 'first') return () => {
    const iterator = item.entries(), first = iterator.next();
    iterator.return();
    return first.value;
  };
  if (operation === 'get') return () => item.get('key2048');
  if (operation === 'entries') return () => { let last; for (const entry of item.entries()) last = entry; return last; };
  if (operation === 'keys') return () => { let last; for (const key of item.keys()) last = key; return last; };
  if (operation === 'values') return () => { let last; for (const value of item.values()) last = value; return last; };
  throw new Error('Unknown frozen operation');
}
export function normalizeSink(value) {
  return value === undefined ? { defined: false } : { defined: true, value };
}

export function fixture(S, workload) {
  const spec = resolveCase(workload);
  // Public reset functions give each untimed fixture an independent arena.
  if (spec.trie === 'hamt') S.resetMap(); else S.resetSortedMap();
  let item, model, retained, retainedModel;
  if (spec.kind === 'set') {
    item = spec.trie === 'hamt' ? new S.SharedSet() : new S.SharedSortedSet();
    if (spec.size) item = item.add(7);
    model = new Map(spec.size ? [[7, 7]] : []);
    retained = item; retainedModel = new Map(model);
  } else {
    const entries = spec.shape === 'collision' ? [['costarring', 1.25], ['liquid', 2.25]]
      : Array.from({ length: spec.size }, (_, i) => [`key${i}`, valueAt(i, spec.type)]);
    model = new Map(entries);
    if (spec.trie === 'hamt') item = new S.SharedMap(spec.type).setMany(entries);
    else {
      item = new S.SharedSortedMap(spec.type);
      for (const [key, value] of entries) item = item.set(key, value);
      // The temporary key is absent from every published measured snapshot.
      if (spec.size > 1) item = item.set('\0flush', valueAt(-1, spec.type)).delete('\0flush');
    }
    retained = item; retainedModel = new Map(model);
    if (spec.shape === 'patched') {
      const count = spec.size === 32 ? 17 : 47, stride = spec.size === 32 ? 1 : 7;
      for (let i = 0; i < count; i++) {
        const key = `key${i * stride}`, value = -i - 1;
        item = item.set(key, value); model.set(key, value);
      }
    } else if (spec.shape === 'journal') for (let i = 0; i < 4; i++) {
      const key = `key${i * 997}`, value = -i - 1;
      item = item.set(key, value); model.set(key, value);
    }
  }
  const expected = spec.kind === 'set' ? [...model.keys()] : orderedEntries(model, spec.trie);
  const expectedRetained = spec.kind === 'set' ? [...retainedModel.keys()] : orderedEntries(retainedModel, spec.trie);
  const expectedSink = normalizeSink(spec.operation === 'get' ? model.get('key2048')
    : spec.operation === 'first' ? expected[0]
      : spec.operation === 'keys' ? expected.at(-1)?.[0] : expected.at(-1));
  const operation = makeOperation(item, spec.operation);
  // Each call is precisely one public operation. Consuming an iterator retains
  // its final yielded value; no checksum, validation, byte read or allocation
  // guard is added to the timed kernel. All comparisons happen after the timer.
  const execute = repeat => { let last; for (let i = 0; i < repeat; i++) last = operation(); return last; };
  const result = { S, spec, item, retained, model, expected, expectedRetained, expectedSink, execute };
  if (spec.operation === 'get') assert.deepEqual(normalizeSink(item.get('key2048')), expectedSink);
  return result;
}

export function inspectShape(f) {
  const data = f.S.getWorkerData({ item: f.item }, { copy: false });
  assert.equal(data.arenas.length, 1, 'Fixture unexpectedly spans multiple arenas');
  const root = data.structures.item.data.root, view = new DataView(data.arenas[0].memory.buffer);
  const tag = root ? view.getUint32(root, true) : null;
  if (!f.spec.size) assert.equal(root, 0, 'Empty fixture has a root');
  else if (f.spec.size === 1) assert.equal(tag, 0, 'Singleton fixture is not a leaf');
  else if (f.spec.shape === 'collision') {
    assert.equal(hashKey('costarring'), hashKey('liquid'));
    assert.equal(tag, 2, 'Collision fixture is not a collision root');
    assert.equal(view.getUint32(root + 8, true), 2);
  } else if (f.spec.shape === 'patched') {
    assert.notEqual(tag, 0xffffffff, 'Patched HAMT unexpectedly has a journal');
    assert.ok(tag & 0x80000000, 'Patched HAMT root has no overlay');
  } else if (f.spec.shape === 'journal') {
    assert.equal(tag, 0xffffffff, 'Radix journal fixture was materialized');
    assert.equal(view.getUint32(root + 12, true), 4, 'Radix journal must have four pending edits');
    assert.equal(view.getUint32(root + 4, true), f.retained.root, 'Radix journal base changed');
  } else {
    assert.notEqual(tag, 0xffffffff, 'Canonical fixture contains a root journal');
    assert.equal(tag & 0x80000000, 0, 'Canonical fixture contains a root overlay');
  }
  return { root, tag, pendingEdits: tag === 0xffffffff ? view.getUint32(root + 12, true) : 0 };
}

export function snapshot(f) {
  const payload = f.S.getWorkerData({ item: f.item, retained: f.retained }, { copy: false });
  return payload.arenas.map(({ memory, used }) => ({
    used, byteLength: memory.buffer.byteLength,
    payloadSha256: sha256(new Uint8Array(memory.buffer, HEAP_START, used - HEAP_START)),
  }));
}

export function verifyFixture(f) {
  const before = snapshot(f), shape = inspectShape(f);
  const actual = f.spec.kind === 'set' ? [...f.item.values()] : [...f.item.entries()];
  const actualRetained = f.spec.kind === 'set' ? [...f.retained.values()] : [...f.retained.entries()];
  assert.equal(f.item.size, f.spec.size, 'Fixture size changed');
  assert.deepEqual(actual, f.expected, `${f.spec.name}: complete content/order differs from independent model`);
  assert.deepEqual(actualRetained, f.expectedRetained, `${f.spec.name}: retained snapshot changed`);
  if (f.spec.kind === 'map') {
    assert.deepEqual([...f.item.keys()], f.expected.map(([key]) => key));
    assert.deepEqual([...f.item.values()], f.expected.map(([, value]) => value));
  }
  const sink = normalizeSink(f.execute(1));
  assert.deepEqual(sink, f.expectedSink, 'Public operation returned the wrong terminal value');
  const after = snapshot(f);
  assert.deepEqual(after, before, 'Untimed verification changed published payload or shared allocation');
  const expectedDigest = digest({ item: f.expected, retained: f.expectedRetained, sink: f.expectedSink });
  const actualDigest = digest({ item: actual, retained: actualRetained, sink });
  assert.equal(actualDigest, expectedDigest);
  return { expectedDigest, actualDigest, shape, before, after, allocatedSharedBytes: 0, immutableBytes: true, sink };
}

export function runChecks(S) {
  return CASES.map(workload => ({ name: workload.name, ...verifyFixture(fixture(S, workload)) }));
}
