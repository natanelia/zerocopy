import { study, createWorkload } from './workloads.mjs';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2] ?? '.');
for (const spec of study.cases) {
  const workload = await createWorkload(directory, spec);
  workload.checkInvariant?.();
  workload.verify(workload.operation());
  workload.checkInvariant?.();
  console.log(`Verified full ${spec.name}`);
}
