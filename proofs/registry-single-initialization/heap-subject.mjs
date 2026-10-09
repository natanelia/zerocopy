import assert from 'node:assert/strict';
import { modules, fixture, runSubject, settleGc, checkReads } from './common.mjs';

await runSubject(async ({ root, count, copy, mode }) => {
  assert.equal(mode, 'attach');
  const { S } = await modules(root);
  const setup = fixture(S, count, copy);
  globalThis.__registryProbeKeep = { setup };
  // Warm this code path once, then release it before the baseline. The actual
  // retained attachment is fresh and receives no reads until after sampling.
  await S.initWorker(setup.data);
  await settleGc();
  const before = process.memoryUsage();
  globalThis.__registryProbeKeep.attached = await S.initWorker(setup.data);
  await settleGc();
  const after = process.memoryUsage();
  const delta = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
  const reads = checkReads(S, globalThis.__registryProbeKeep.attached, setup, copy);
  return { metric: 'post-GC-process-memory-observation', before, after, delta, reads,
    scope: 'One fresh retained attachment; producer graph and payload pinned; no reads/cache priming before memory sampling',
    inferentialThresholdApplied: false,
    note: 'Observed process memory deltas are not Map-expression counts, Map counts, object sizes, or a memory non-inferiority test.' };
});
