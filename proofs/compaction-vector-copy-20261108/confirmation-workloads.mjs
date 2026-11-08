import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { study as originalStudy, createWorkload } from './workloads.mjs';

// The pilot's cases, source and operation are retained unchanged. Calibrate
// the number of simultaneously retained outputs before the final study:
// 128 fresh arenas produced roughly 0.8-second Bun batches in the pilot.
// A fixed 32 outputs bounds that pressure while retaining multi-ms Node batches.
const originalHash = 'fab3ae2dacc7be3e47959f3d693fdf0bb8bc256d13c69e7809fb0b7cf1bcc0fa';
assert.equal(createHash('sha256').update(readFileSync(new URL('./workloads.mjs', import.meta.url))).digest('hex'), originalHash);
export { createWorkload };
export const study = {
  ...originalStudy,
  id: 'compaction-vector-copy-confirmation-20261108',
  supportFiles: [{ name: 'workloads.mjs', sha256: originalHash }],
  calibration: 'Small/boundary/reset batches retain 32 outputs; large/fallback cases retain 8. Fixed after the two-pair pilot, before confirmation; no timings are pooled.',
  cases: originalStudy.cases.map(spec => spec.repetitions === 128 ? { ...spec, repetitions: 32 } : spec),
};
