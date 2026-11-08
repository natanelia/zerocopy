import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { study, createWorkload } from './workloads.mjs';

const root = resolve(process.argv[2] ?? '.');
const results = [];
for (const spec of study.cases) {
  const workload = await createWorkload(root, spec);
  for (const count of [1, 3]) {
    workload.prepareBatch?.(count);
    const outputs = Array.from({ length: count }, () => workload.operation());
    for (const output of outputs) workload.verify(output);
    workload.checkInvariant?.();
  }
  assert.match(workload.expectedDigest, /^[a-f0-9]{64}$/);
  results.push({ name: spec.name, verifiedOutputs: 4, expectedDigest: workload.expectedDigest, fixture: workload.fixture });
}
console.log(JSON.stringify({ runtime: process.versions, root, timingCollected: false, cases: results }, null, 2));
