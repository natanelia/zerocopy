import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '.');
const S = await import(pathToFileURL(join(root, 'dist/shared.js')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = [
  { name: 'entry-budget', keys: Array.from({ length: 400 }, (_, i) => `absent-${i}`), entries: 256 },
  { name: 'character-budget', keys: ['x'.repeat(16384), 'extra', ''], entries: 2 },
  { name: 'over-character-budget', keys: ['x'.repeat(16385)], entries: 0 },
];
const results = [];
for (const spec of cases) {
  S.resetMap();
  const map = new S.SharedMap('number').setMany(Array.from({ length: 4096 }, (_, i) => [`id/${i}`, i + 0.25]));
  const arena = map.arena, start = arena.used, before = hash(arena.buf.subarray(65536, start));
  map.get('id/0'); const positiveBefore = arena.valueMap.size;
  for (let pass = 0; pass < 3; pass++) for (const key of spec.keys) {
    assert.equal(map.get(key), undefined); assert.equal(map.has(key), false);
  }
  const cache = arena.missingReads, candidate = typeof arena.rememberMissing === 'function';
  const cachedEntries = cache?.roots.size ?? 0, retainedKeyCodeUnits = cache?.chars ?? 0;
  assert.equal(cachedEntries, candidate ? spec.entries : 0);
  assert.ok(cachedEntries <= 256); assert.ok(retainedKeyCodeUnits <= 16384);
  assert.equal(retainedKeyCodeUnits, [...(cache?.roots.keys() ?? [])].reduce((sum, key) => sum + key.length, 0));
  assert.equal(arena.valueMap.size, positiveBefore);
  assert.equal(arena.used, start); assert.equal(hash(arena.buf.subarray(65536, start)), before);
  results.push({ name: spec.name, negativeCachePresent: candidate, cachedEntries, retainedKeyCodeUnits,
    wasmBytesAllocatedByReads: arena.used - start, successfulEntriesBefore: positiveBefore, successfulEntriesAfter: arena.valueMap.size });
}
console.log(JSON.stringify({ root, runtime: process.versions, timingCollected: false,
  scope: 'Logical JavaScript negative-cache entries and retained UTF-16 code units; actual JS heap/RSS/capacity are not measured. Reads allocate no WASM bytes.', cases: results }, null, 2));
