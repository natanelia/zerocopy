import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createWorkload, study } from './workloads.mjs';

// Untimed check of every workload, including retained forks and repeated resets.
const roots = process.argv.slice(2).map(root => resolve(root));
assert.equal(roots.length, 2, 'Usage: node smoke.mjs BASELINE_ROOT CANDIDATE_ROOT');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = [];
for (let variant = 0; variant < roots.length; variant++) {
  for (const spec of study.cases) {
    const workload = await createWorkload(roots[variant], spec);
    for (let batch = 0; batch < 2; batch++) {
      workload.prepareBatch?.(2);
      const first = workload.operation(), second = workload.operation();
      workload.verify(first); workload.verify(second); workload.checkInvariant?.();
    }
    rows.push({ variant: variant ? 'after' : 'before', name: spec.name,
      expectedDigest: workload.expectedDigest, fixture: workload.fixture, verifiedResults: 4 });
  }
}
for (const before of rows.filter(row => row.variant === 'before')) {
  const after = rows.find(row => row.variant === 'after' && row.name === before.name);
  assert.deepEqual({ ...before, variant: 'same' }, { ...after, variant: 'same' });
}
console.log(JSON.stringify({ passed: true, timingMeasurements: false, runtime: process.versions,
  sources: roots.map(root => ({ root, sourceSha256: hash(readFileSync(join(root, 'arena.ts'))),
    bundleSha256: hash(readFileSync(join(root, 'dist/shared.js'))),
    coreWasmSha256: hash(readFileSync(join(root, 'persistent-core.wasm'))),
  })), rows }, null, 2));
