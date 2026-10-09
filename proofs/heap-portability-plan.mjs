import assert from 'node:assert/strict';
import { CONFIG } from './heap-entry-protocol.mjs';
export function freezePlan(pilots) {
  assert.equal(pilots.length, 2);
  assert(pilots.every(p => p.status === 'passed' && p.invalid.length === 0));
  assert.deepEqual(pilots[0].expected, pilots[1].expected, 'pilot oracle differs by arm');
  assert.deepEqual(pilots[0].identity, pilots[1].identity, 'fixture bytes or descriptors differ by arm');
  const repeat = Math.max(...pilots.map(p => p.repeat)), fastest = Math.min(...pilots.map(p => p.minMsPerIteration));
  assert(Number.isFinite(fastest) && fastest > 0);
  const warmupScans = Math.ceil((CONFIG.warmupTargetMs * 1.25 / fastest) / repeat) * repeat;
  assert(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= CONFIG.repeatLimit);
  assert(Number.isSafeInteger(warmupScans) && warmupScans > 0);
  return { repeat, warmupScans, fastestPilotMsPerIteration: fastest, expected: pilots[0].expected, identity: pilots[0].identity };
}
