// SOURCE PREPARATION ONLY. Inert exports; not released, imported, or executed.
// A reviewed external caller must enforce SCREEN-PLAN.md and exact build pins.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const CASES = [
  ...[64, 8192].flatMap(n => ['number', 'ascii', 'unicode'].map(keys =>
    ({ id: `insert-${keys}-${n}`, kind: 'insert', keys, n }))),
  ...['number', 'ascii', 'unicode'].map(keys =>
    ({ id: `duplicate-current-cached-${keys}`, kind: 'duplicate', keys, n: 512, cached: true, historical: false, passes: 32 })),
  ...['number', 'unicode'].map(keys =>
    ({ id: `duplicate-current-cold-${keys}`, kind: 'duplicate', keys, n: 512, cached: false, historical: false, passes: 1 })),
  ...['ascii', 'unicode'].map(keys =>
    ({ id: `duplicate-history-cold-${keys}`, kind: 'duplicate', keys, n: 512, cached: false, historical: true, passes: 1 })),
  ...['ascii', 'unicode'].map(keys =>
    ({ id: `duplicate-history-cached-${keys}`, kind: 'duplicate', keys, n: 512, cached: true, historical: true, passes: 32 })),
  { id: 'map-ascii-number-8192', kind: 'map', keys: 'ascii', valueType: 'number', n: 8192 },
  { id: 'map-unicode-string-8192', kind: 'map', keys: 'unicode', valueType: 'string', n: 8192 },
  { id: 'startup', kind: 'startup' },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => `${typeof value === 'number' ? 'n:' : 's:'}${String(value)}`;
const digest = rows => sha(JSON.stringify(rows.sort()));
const now = () => performance.now();

export function fixture(c) {
  assert.notEqual(c.kind, 'startup');
  const values = Array.from({ length: c.n }, (_, i) => {
    const index = (i * 4051) & (c.n - 1), tail = index.toString(36).padStart(4, '0');
    return c.keys === 'number' ? index : c.keys === 'ascii' ? `k${tail}` : `${'café-東京-🚀|'.repeat(8)}${tail}`;
  });
  const keys = values.map(encoded), mapValues = values.map((_, i) => c.valueType === 'string' ? `v${i}` : i);
  const bytes = (c.kind === 'map' ? values : keys).map(key => new TextEncoder().encode(key));
  const hashes = bytes.map(b => { let h = 2166136261; for (const x of b) h = Math.imul(h ^ x, 16777619); return h >>> 0; });
  return { values, keys, mapValues, entries: keys.map(key => [key, 0]),
    expected: c.kind === 'map'
      ? digest(values.map((key, i) => JSON.stringify([key, mapValues[i]]))) : digest([...keys]),
    evidence: { fixtureSha256: sha(JSON.stringify({ values, mapValues })), count: values.length,
      minEncodedBytes: Math.min(...bytes.map(b => b.length)), maxEncodedBytes: Math.max(...bytes.map(b => b.length)),
      totalEncodedBytes: bytes.reduce((n, b) => n + b.length, 0),
      totalEncodedChars: (c.kind === 'map' ? values : keys).reduce((n, key) => n + key.length, 0),
      distinctFullHashes: new Set(hashes).size, collisionExcess: hashes.length - new Set(hashes).size } };
}

function published(a) {
  return sha(new Uint8Array(a.memory.buffer, 65536, a.used - 65536));
}
function audit(c, f, map, advanced) {
  // Read existing compiled fields only. Never clear caches or rewrite roots.
  const a = map.arena;
  assert.ok(a?.memory instanceof WebAssembly.Memory, 'Expected source-pinned Arena field surface');
  assert.ok('valueRoot' in a && 'valueMap' in a && 'reads' in a, 'Missing cache-audit fields');
  if (c.historical) {
    assert.notEqual(advanced.root, map.root);
    assert.equal(a.valueRoot, advanced.root);
    if (!c.cached) assert.equal(a.reads, undefined);
    else for (const key of f.keys) {
      const slot = a.reads?.slot(key);
      assert.notEqual(slot, undefined); assert.equal(a.reads.root(slot), map.root);
      assert.notEqual(a.reads.leaf(slot), 0);
    }
  } else if (c.cached) {
    assert.equal(a.valueRoot, map.root);
    for (const key of f.keys) assert.ok(a.valueMap?.has(key));
  } else {
    assert.equal(a.valueRoot, 0); assert.equal(a.valueMap, undefined); assert.equal(a.reads, undefined);
  }
  return { historical: c.historical, cached: c.cached, targetRoot: map.root,
    currentRoot: a.valueRoot, positiveKeysChecked: c.cached ? f.keys.length : 0,
    coldStateVerified: !c.cached };
}

export function batch(z, c, f) {
  const wallStart = now();
  z.resetMap();
  let map = new z.SharedMap(c.valueType ?? 'number'), set, advanced, cache;
  if (c.kind === 'duplicate') {
    map = map.setMany(f.entries); set = new z.SharedSet(map);
    if (c.historical) advanced = map.set('s:__screen_advanced__', 17);
    if (c.cached) for (const value of f.values) assert.equal(set.has(value), true);
    cache = audit(c, f, map, advanced);
  } else if (c.kind === 'insert') set = new z.SharedSet(map);
  const a = map.arena;
  const usedBefore = a.used, rootBefore = map.root;
  const payloadBefore = c.kind === 'duplicate' ? published(a) : undefined;
  let identityFailures = 0;
  const begin = now();
  if (c.kind === 'insert') for (const value of f.values) set = set.add(value);
  else if (c.kind === 'map') for (let i = 0; i < f.values.length; i++) map = map.set(f.values[i], f.mapValues[i]);
  else for (let pass = 0; pass < c.passes; pass++) for (const value of f.values) identityFailures += Number(set.add(value) !== set);
  const elapsedMs = now() - begin;
  const result = c.kind === 'map' ? map : set;
  assert.equal(result.size, c.n);
  const checksum = c.kind === 'map'
    ? digest([...map.entries()].map(entry => JSON.stringify(entry)))
    : digest([...set.values()].map(encoded));
  assert.equal(checksum, f.expected);
  const payloadAfter = c.kind === 'duplicate' ? published(a) : undefined;
  if (c.kind === 'duplicate') {
    assert.equal(identityFailures, 0); assert.equal(a.used, usedBefore);
    assert.equal(set.toWorkerData().root, rootBefore); assert.equal(payloadAfter, payloadBefore);
    if (advanced) assert.equal(advanced.get('s:__screen_advanced__'), 17);
  }
  return { elapsedMs, operations: c.n * (c.passes ?? 1), checksum, identityFailures,
    usedBefore, usedAfter: a.used, backingBytes: a.memory.buffer.byteLength,
    payloadBefore, payloadAfter, cache, wallMs: now() - wallStart };
}

// Call once in a fresh, authenticated child; never execute two cells in one child.
export async function subject(sharedURL, caseId, warmCount, measureCount) {
  assert.ok(sharedURL.startsWith('file:'), 'Use an explicit retained portable entry URL');
  const c = CASES.find(c => c.id === caseId); assert.ok(c);
  const importStart = now(), z = await import(sharedURL), importMs = now() - importStart;
  if (c.kind === 'startup') {
    assert.equal(warmCount, 0); assert.equal(measureCount, 1);
    const firstMapStart = now(), map = new z.SharedMap('number').set('first', 17), firstMapMs = now() - firstMapStart;
    const firstSetStart = now(), set = new z.SharedSet().add('first'), firstUseEnd = now(), firstSetMs = firstUseEnd - firstSetStart;
    assert.equal(map.get('first'), 17); assert.equal(set.size, 1);
    assert.equal(set.has('first'), true);
    return { case: caseId, importMs, firstMapMs, firstSetMs,
      importThroughFirstUseMs: firstUseEnd - importStart,
      checksum: sha(JSON.stringify([[...map.entries()], [...set.values()]])), warm: [], measured: [] };
  }
  assert.ok(Number.isSafeInteger(warmCount) && warmCount >= 8);
  assert.ok(Number.isSafeInteger(measureCount) && measureCount >= 4);
  z.configureMemory({ maximumBytes: 64 * 1024 * 1024 });
  const f = fixture(c), warm = [], measured = [];
  for (let i = 0; i < warmCount; i++) warm.push(batch(z, c, f));
  for (let i = 0; i < measureCount; i++) measured.push(batch(z, c, f));
  return { case: caseId, importMs, fixture: f.evidence, warm, measured,
    rssBytes: process.memoryUsage().rss, maxRSSPlatformUnits: process.resourceUsage().maxRSS };
}
