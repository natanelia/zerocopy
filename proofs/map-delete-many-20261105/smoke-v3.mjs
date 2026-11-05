import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createWorkload, study } from './workloads-v3.mjs';

const roots = process.argv.slice(2).map(path => resolve(path));
assert.ok(roots.length, 'Pass one or more built repository directories');
const result = { versions: process.versions, study: study.id, variants: [] };
for (const root of roots) {
  const files = [...study.changedSources, ...study.changedWasm,
    ...readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js')).map(name => `dist/${name}`)];
  const hashes = Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]));
  const rows = [];
  for (const spec of study.cases) {
    const workload = await createWorkload(root, spec);
    workload.checkInvariant(); workload.verify(workload.operation()); workload.checkInvariant();
    rows.push({ name: spec.name, expectedDigest: workload.expectedDigest, fixture: workload.fixture, observations: workload.observations() });
  }
  result.variants.push({ root, hashes, rows });
}
for (const variant of result.variants.slice(1)) {
  for (let i = 0; i < study.cases.length; i++) {
    assert.equal(variant.rows[i].expectedDigest, result.variants[0].rows[i].expectedDigest);
    assert.deepEqual(variant.rows[i].fixture, result.variants[0].rows[i].fixture);
  }
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
