import { resolve } from 'node:path';
import { study, createWorkload } from './workloads-v3.mjs';

const root = resolve(process.argv[2] ?? '.');
for (const spec of study.cases) {
  const workload = await createWorkload(root, spec);
  workload.checkInvariant?.();
  workload.verify(workload.operation());
  workload.checkInvariant?.();
  console.log(`${spec.name}: full public output and invariants verified`);
}
