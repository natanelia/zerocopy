import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { study, makeFixture } from './workloads.mjs';

const [rootArg, outputArg] = process.argv.slice(2);
assert.ok(rootArg && outputArg, 'Usage: node allocation.mjs BUILT_REPOSITORY OUTPUT_JSON');
const root = resolve(rootArg), output = resolve(outputArg);
assert.ok(!existsSync(output), 'Use a new path; do not replace recorded allocation evidence');
const S = await import(pathToFileURL(join(root, 'dist/shared.js')));
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Number.isNaN(value) ? ['NaN'] : Object.is(value, -0) ? ['-0']
  : value === Infinity ? ['+Infinity'] : value === -Infinity ? ['-Infinity'] : value;
const sorted = entries => [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const rows = [];
function inspect(name, initial, keys) {
  const expected = new Map(initial); for (const key of keys) expected.delete(key);
  S.resetMap();
  const source = new S.SharedMap('number').setMany(initial);
  const original = S.getWorkerData({ source }, { copy: false });
  assert.equal(original.arenas.length, 1);
  const arena = original.arenas[0], usedBefore = arena.used, capacityBefore = arena.memory.buffer.byteLength;
  const originalBytes = hash(new Uint8Array(arena.memory.buffer, 65536, usedBefore - 65536));
  const result = source.deleteMany(keys);
  const packet = S.getWorkerData({ source, result }, { copy: false });
  assert.equal(packet.arenas.length, 1); assert.equal(packet.arenas[0].id, arena.id);
  assert.equal(result.size, expected.size); assert.ok(Object.isFrozen(result));
  assert.deepEqual(sorted(result.entries()), sorted(expected));
  assert.deepEqual(sorted(source.entries()), sorted(initial));
  assert.deepEqual(packet.structures.source.data, original.structures.source.data);
  assert.equal(hash(new Uint8Array(arena.memory.buffer, 65536, usedBefore - 65536)), originalBytes);
  const actualBytes = packet.arenas[0].used - usedBefore;
  assert.ok(Number.isSafeInteger(actualBytes) && actualBytes >= 0);
  if (expected.size === initial.length) { assert.strictEqual(result, source); assert.equal(actualBytes, 0); }
  rows.push({ name, sourceCount: initial.length, submittedKeys: keys.length,
    distinctRequests: new Set(keys).size, removedKeys: initial.length - expected.size,
    usedBefore, usedAfter: packet.arenas[0].used, actualBytes,
    capacityBefore, capacityAfter: arena.memory.buffer.byteLength, originalBytesUnchanged: true,
    fixtureDigest: hash(JSON.stringify({ initial: initial.map(([key, value]) => [key, canonical(value)]), keys,
      expected: sorted(expected).map(([key, value]) => [key, canonical(value)]) })) });
}
for (const spec of study.cases.filter(spec => spec.kind === 'delete')) {
  const { initial, keys } = makeFixture(spec); inspect(spec.name, initial, keys);
}
// Eight-byte keys consume 20 stage bytes each. Include the 32 scalar probe
// requests, then stop exactly at, just beyond, and twice at the chunk boundary.
const fixed = Array.from({ length: 6000 }, (_, i) => [`k${String(i).padStart(7, '0')}`, i + 0.25]);
for (const count of [2489, 2490, 4946]) inspect(`fixed-width-request-count-${count}`, fixed, fixed.slice(0, count).map(([key]) => key));
const fitting = 'x'.repeat(49140), oversized = 'y'.repeat(49141), unicode = '界'.repeat(16380);
const mixed = Array.from({ length: 600 }, (_, i) => [`key/${i}`, i + 0.25]);
mixed.push([fitting, -1], [oversized, -2], [unicode, -3]);
const mixedKeys = [...mixed.slice(0, 32).map(([key]) => key), fitting, 'key/40', oversized, unicode, fitting, oversized];
while (mixedKeys.length < 512) mixedKeys.push(`missing/${mixedKeys.length}`);
inspect('encoded-key-cutoff-49140-and-49141', mixed, mixedKeys);
const report = { schema: 'zerocopy-map-delete-allocation/v1', recordedAt: new Date().toISOString(), root,
  node: process.version, bun: process.versions.bun ?? null,
  operation: 'one complete public source.deleteMany(keys) call on a newly built source',
  scope: 'Exact difference in the append-only WASM writer allocation frontier. Includes intermediate paths from the scalar probe, all chunk outputs, and unreachable intermediate versions. Excludes JavaScript allocation, GC, total backing-buffer capacity and RSS; this is not a total-memory or cross-library memory comparison.',
  harnessSha256: hash(readFileSync(new URL(import.meta.url))),
  workloadSha256: hash(readFileSync(new URL('./workloads.mjs', import.meta.url))),
  bundleSha256: hash(readFileSync(join(root, 'dist/shared.js'))),
  sourceHashes: Object.fromEntries([...study.changedSources, 'persistent-core.wasm'].map(name => [name, hash(readFileSync(join(root, name)))])),
  rows };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, rows }, null, 2));
