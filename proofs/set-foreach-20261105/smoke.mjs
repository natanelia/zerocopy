import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createWorkload, study } from './workloads.mjs';

const directory = resolve(process.argv[2]);
const rows = [];
for (const spec of study.cases) {
  const workload = await createWorkload(directory, spec);
  workload.checkInvariant();
  for (let i = 0; i < 2; i++) workload.verify(workload.operation());
  workload.checkInvariant();
  rows.push({ name: spec.name, expectedDigest: workload.expectedDigest, fixture: workload.fixture });
}
assert.equal(rows.length, 24);
console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, rows }, null, 2));
