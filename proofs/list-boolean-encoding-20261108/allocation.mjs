import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exact storage observations only; this script collects no timing samples.
// Usage: node allocation.mjs BASELINE_ROOT CANDIDATE_ROOT
const roots = process.argv.slice(2).map(path => resolve(path));
assert.equal(roots.length, 2, 'Supply baseline and candidate package roots');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const flags = count => Array.from({ length: count }, (_, i) => i % 3 === 0 || i % 7 === 2);
const rows = [];
for (let variant = 0; variant < roots.length; variant++) {
  const root = roots[variant], S = await import(pathToFileURL(join(root, 'dist/shared.js')));
  for (const prefixCount of [0, 1, 31, 32, 65, 1056]) {
    for (const count of [256, 1024, 32767, 32768, 32769, 262144]) {
      S.resetSharedList();
      const prefix = flags(prefixCount), input = flags(count);
      const source = new S.SharedList('boolean').pushMany(prefix);
      const before = S.getWorkerData({ source }, { copy: false }).arenas[0];
      const original = new Uint8Array(before.memory.buffer, 65536, before.used - 65536).slice();
      const next = source.pushMany(input);
      const after = S.getWorkerData({ next }, { copy: false }).arenas[0];
      assert.deepEqual(source.toArray(), prefix);
      assert.deepEqual(next.toArray(), [...prefix, ...input]);
      assert.deepEqual(new Uint8Array(after.memory.buffer, 65536, original.length), original);
      rows.push({ variant: variant ? 'after' : 'before', prefixCount, count,
        allocatedBytes: after.used - before.used, sourceDescriptor: source.toWorkerData(), descriptor: next.toWorkerData(),
        publishedBytesPreserved: true, completeValuesChecked: true,
        wholeArenaSha256: hash(new Uint8Array(after.memory.buffer, 65536, after.used - 65536)),
      });
    }
  }
}
for (const before of rows.filter(row => row.variant === 'before')) {
  const after = rows.find(row => row.variant === 'after' && row.prefixCount === before.prefixCount && row.count === before.count);
  assert.deepEqual({ ...before, variant: 'same' }, { ...after, variant: 'same' });
}
console.log(JSON.stringify({ passed: true, timingMeasurements: false, runtime: process.versions,
  scope: 'Exact shared-arena allocation, descriptors and byte identity. JavaScript temporary heap is not measured.',
  sources: roots.map(root => ({ root, arenaSha256: hash(readFileSync(join(root, 'arena.ts'))),
    coreWasmSha256: hash(readFileSync(join(root, 'persistent-core.wasm'))),
    bundleSha256: hash(readFileSync(join(root, 'dist/shared.js'))),
  })), pairs: rows.length / 2, rows }, null, 2));
