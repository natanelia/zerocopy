/** Deterministic allocated-payload comparison. Arguments are identically built
 * baseline and candidate directories. No RSS/peak-memory or timing claim.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const roots = [resolve(process.argv[2]), resolve(process.argv[3])];
const libraries = await Promise.all(roots.map(root => import(pathToFileURL(resolve(root, 'dist/shared.js')).href)));
const count = 4096, encoder = new TextEncoder();
const align4 = n => Math.ceil(n / 4) * 4, align8 = n => Math.ceil(n / 8) * 8;
const cases = [...Array.from({ length: 8 }, (_, i) => ({ name: `ascii-${i + 3}`, key: n => 'x'.repeat(i) + n.toString(36).padStart(3, '0') })),
  { name: 'unicode-9', key: n => `中文${n.toString(36).padStart(3, '0')}` },
  { name: 'mixed-length', key: n => 'x'.repeat(n % 8) + n.toString(36).padStart(3, '0') }];
const rows = [];
for (const type of ['number', 'boolean']) for (const item of cases) {
  const entries = Array.from({ length: count }, (_, i) => [item.key(i), type === 'number' ? i + 0.25 : i % 2 === 0]);
  const expectedSavings = entries.reduce((sum, [key]) => { const raw = 16 + encoder.encode(key).length + (type === 'number' ? 8 : 1); return sum + align8(raw) - align4(raw); }, 0);
  const variants = [];
  for (const S of libraries) {
    S.resetMap(); const before = new S.SharedMap(type), arena = before.arena, start = arena.used;
    const map = before.setMany(entries), allocatedBytes = arena.used - start;
    assert.equal(map.size, count); assert.equal(before.size, 0);
    for (const [key, value] of entries) assert.equal(map.get(key), value);
    const reader = S.SharedMap.fromWorkerData(map.root, type, count, new arena.constructor({ memory: arena.memory, used: arena.used, readOnly: true }));
    for (const [key, value] of entries) assert.equal(reader.get(key), value);
    variants.push({ allocatedBytes, backingBytes: arena.memory.buffer.byteLength });
  }
  assert.equal(variants[0].allocatedBytes - variants[1].allocatedBytes, expectedSavings);
  rows.push({ type, workload: item.name, count, expectedSavings, variants });
}
const sha256 = (root, path) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
console.log(JSON.stringify({ timestamp: new Date().toISOString(), harnessSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), runtime: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`, platform: process.platform, arch: process.arch,
  measurement: 'Append-only arena bytes allocated by one setMany call; not total memory, peak memory, or RSS', outputChecked: true, independentReaderChecked: true,
  source: roots.map(root => ({ arena: sha256(root, 'arena.ts'), core: sha256(root, 'persistent-core.as.ts'), wasm: sha256(root, 'persistent-core.wasm') })), rows }, null, 2));
