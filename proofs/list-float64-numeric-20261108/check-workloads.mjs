// Untimed complete-oracle preflight for both builds, using the measured inputs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { study, createWorkload } from './workloads.mjs';

const [before, after] = process.argv.slice(2).map(path => resolve(path));
assert.ok(before && after, 'Supply baseline and candidate directories');
const checks = [];
for (const spec of study.cases) {
  const fixtures = [];
  for (const root of [before, after]) {
    const workload = await createWorkload(root, spec);
    workload.prepareBatch();
    for (let i = 0; i < 2; i++) workload.verify(workload.operation());
    workload.checkInvariant();
    fixtures.push({ expectedDigest: workload.expectedDigest, fixture: workload.fixture });
  }
  assert.deepEqual(fixtures[0], fixtures[1]);
  checks.push({ case: spec.name, expectedDigest: fixtures[0].expectedDigest, completeOutputOraclesPassed: true });
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({ runtime: process.versions, timingMeasurements: false,
  source: sha(readFileSync(resolve(after, 'numeric.ts'))),
  workload: sha(readFileSync(new URL('./workloads.mjs', import.meta.url))),
  driver: sha(readFileSync(new URL(import.meta.url))), checks }, null, 2));
