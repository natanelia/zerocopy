import assert from 'node:assert/strict';
import { LIMITS } from './heap-repair-screen-protocol.mjs';
export const INFRASTRUCTURE = Object.freeze({
 jobMinutes: 180,
 stepMinutes: Object.freeze({ checkout: 5, node: 5, bun: 5, prepare: 18, verify: 3, study: 123, archive: 5, upload: 10 }),
 studySoftStopSeconds: 7320, studyKillGraceSeconds: 30,
 artifactReserveMinutes: 15, unallocatedReserveMinutes: 6,
 nativeCleanupMs: 5000,
});
export function verifyBudget() {
 const b = INFRASTRUCTURE, total = Object.values(b.stepMinutes).reduce((sum, value) => sum + value, 0);
 assert.equal(LIMITS.prerequisiteTotalMs, 3600000); assert.equal(LIMITS.controllerMs, 3600000);
 assert.equal(total + b.unallocatedReserveMinutes, b.jobMinutes);
 assert.equal(b.stepMinutes.archive + b.stepMinutes.upload, b.artifactReserveMinutes);
 assert(b.studySoftStopSeconds * 1000 > LIMITS.prerequisiteTotalMs + LIMITS.controllerMs);
 assert(b.studySoftStopSeconds + b.studyKillGraceSeconds <= b.stepMinutes.study * 60);
 assert(b.nativeCleanupMs < b.studyKillGraceSeconds * 1000);
 assert(300 + 5 + 600 + 5 < b.stepMinutes.prepare * 60, 'Setup leaves bounded worktree/hash overhead');
 assert(120 + 120 < b.stepMinutes.archive * 60, 'Archive and checksum leave bounded overhead');
 return { totalStepMinutes: total, scientificPhaseMinutes: 120, preArtifactMaximumMinutes: total - b.artifactReserveMinutes,
  artifactReserveMinutes: b.artifactReserveMinutes, unallocatedReserveMinutes: b.unallocatedReserveMinutes, jobMinutes: b.jobMinutes };
}
