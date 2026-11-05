import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createWorkload, study } from './workloads.mjs';

// Deterministic full-output checks. This does not collect timing measurements.
const directory = resolve(process.argv[2] ?? fileURLToPath(new URL('../../', import.meta.url)));
for (const spec of study.cases) {
  const workload = await createWorkload(directory, spec);
  workload.checkInvariant?.();
  workload.verify(workload.operation());
  workload.verify(workload.operation());
  workload.checkInvariant?.();
  console.log(`${spec.name}: complete output and source invariants passed`);
}
