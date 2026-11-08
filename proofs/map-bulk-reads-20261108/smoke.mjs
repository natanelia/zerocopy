import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { study, createWorkload } from './workloads.mjs';

const directories = process.argv.slice(2).map(directory => resolve(directory));
assert.ok(directories.length, 'Pass at least one built package directory');
const records = [];
for (const directory of directories) for (const spec of study.cases) {
  const workload = await createWorkload(directory, spec);
  workload.checkInvariant();
  await workload.prepareBatch?.(3);
  const outputs = Array.from({ length: 3 }, () => workload.operation());
  for (const output of outputs) workload.verify(output);
  workload.checkInvariant();
  records.push({ directory, name: spec.name, expectedDigest: workload.expectedDigest, fixture: workload.fixture });
}
if (directories.length === 2) for (let i = 0; i < study.cases.length; i++) {
  assert.equal(records[i].expectedDigest, records[i + study.cases.length].expectedDigest);
  assert.deepEqual(records[i].fixture, records[i + study.cases.length].fixture);
}
console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', status: 'passed', records }, null, 2));
