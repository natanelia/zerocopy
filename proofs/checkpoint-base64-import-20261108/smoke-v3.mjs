import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { study, createWorkload } from './workloads-v3.mjs';

const directory = resolve(process.argv[2] ?? fileURLToPath(new URL('../../', import.meta.url)));
const selected = process.argv[3];
for (const spec of study.cases.filter(item => !selected || item.name === selected)) {
  if (!selected) {
    // Each feature environment must be installed before the first module load.
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), directory, spec.name], { stdio: 'inherit' });
    assert.equal(child.status, 0); continue;
  }
  const workload = await createWorkload(directory, spec);
  workload.checkInvariant();
  workload.verify(workload.operation());
  workload.verify(workload.operation());
  workload.checkInvariant();
  console.log(`${spec.name}: full output and input invariants passed`);
}
