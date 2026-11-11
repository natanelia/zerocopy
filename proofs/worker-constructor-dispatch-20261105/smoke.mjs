import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createWorkload, study } from './workloads.mjs';

const [before, after] = process.argv.slice(2).map(directory => resolve(directory));
assert.ok(before && after, 'Usage: node smoke.mjs BASELINE_CHECKOUT CANDIDATE_CHECKOUT');
for (const spec of study.cases) {
  const digests = [];
  for (const directory of [before, after]) {
    const workload = await createWorkload(directory, spec);
    for (let index = 0; index < 2; index++) workload.verify(workload.operation());
    workload.checkInvariant(); digests.push(workload.expectedDigest);
  }
  assert.equal(digests[0], digests[1]);
  console.log(`${spec.name}: complete outputs and invariants match`);
}
