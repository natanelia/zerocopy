import { resolve } from 'node:path';
import { study, createWorkload } from './workloads.mjs';

const root = resolve(process.argv[2] ?? '.');
for (const spec of study.cases) {
  const workload = await createWorkload(root, spec);
  workload.checkInvariant();
  workload.verify(workload.operation());
  workload.checkInvariant();
  console.log(`Verified complete public output and source invariants: ${spec.name}`);
}
