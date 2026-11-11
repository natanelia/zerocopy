import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { study, createWorkload } from './workloads.mjs';

const directory = resolve(process.argv[2] ?? fileURLToPath(new URL('../../', import.meta.url)));
for (const spec of study.cases) {
  const workload = await createWorkload(directory, spec);
  workload.checkInvariant();
  workload.verify(workload.operation());
  workload.verify(workload.operation());
  workload.checkInvariant();
  console.log(`${spec.name}: full output and input invariants passed`);
}
