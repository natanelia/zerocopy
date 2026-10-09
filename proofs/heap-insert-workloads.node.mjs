import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASES, HEAP_START, BATCH_USED_BYTE_CAP, WARMUP_USED_BYTE_CAP, WARMUP_BATCH_CAP, warmupWorkLimit, canonicalWorkload, checkFixture, fixture, fixtureIdentity,
  runBatch, verifyBatch } from './heap-insert-workloads.mjs';
import { calibrationDecision } from './heap-insert-subject.mjs';

// Small deterministic fixture checks only. No benchmark, timing, or full suite.
// Usage: node|bun proofs/heap-insert-workloads.node.mjs BASELINE/dist/shared.js CANDIDATE/dist/shared.js
const paths = process.argv.slice(2);
assert.equal(paths.length, 2, 'Expected baseline and candidate built public entry paths');
const apis = await Promise.all(paths.map(path => import(pathToFileURL(resolve(path)).href)));
const originalPerformance = globalThis.performance, originalNow = Date.now;
const clockForbidden = () => { throw new Error('Fixture-only verification must not read a clock'); };
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: clockForbidden } });
Date.now = clockForbidden;
try {
  // Algebraic boundaries use synthetic costs, not the observed pilot counts.
  let warmupBudgetCases = 0;
  for (const initial of [HEAP_START, 2 * HEAP_START, 3 * HEAP_START + 8]) {
    for (const cost of [1, 3, 16, 37, 4096]) {
      const limit = warmupWorkLimit(initial, cost);
      const remaining = WARMUP_USED_BYTE_CAP - WARMUP_BATCH_CAP * initial;
      assert(Number.isSafeInteger(limit) && limit > 0);
      assert(limit * cost <= remaining);
      assert((limit + 1) * cost > remaining);
      warmupBudgetCases++;
    }
    assert.equal(warmupWorkLimit(initial, 0), 10000000, 'Read-only work bound stays fixed');
    warmupBudgetCases++;
  }
  assert(warmupWorkLimit(HEAP_START, 1) > 10000000, 'Mutation warmup is not capped by timed repeats');
  for (const initial of [NaN, Infinity, -1, HEAP_START - 1, HEAP_START + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => warmupWorkLimit(initial, 1), /Invalid initial/); warmupBudgetCases++;
  }
  for (const cost of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => warmupWorkLimit(HEAP_START, cost), /Invalid worst-case/); warmupBudgetCases++;
  }
  assert.throws(() => warmupWorkLimit(WARMUP_USED_BYTE_CAP / WARMUP_BATCH_CAP, 1), /No mutation warmup/);
  warmupBudgetCases++;
  const headerBoundary = WARMUP_USED_BYTE_CAP / WARMUP_BATCH_CAP;
  assert.equal(warmupWorkLimit(headerBoundary - 1, WARMUP_BATCH_CAP), 1);
  assert.throws(() => warmupWorkLimit(headerBoundary - 1, WARMUP_BATCH_CAP + 1), /No mutation warmup/);
  assert.throws(() => warmupWorkLimit(headerBoundary + 1, 1), /No mutation warmup/);
  assert.throws(() => warmupWorkLimit(BATCH_USED_BYTE_CAP + 1, 1), /Invalid initial/);
  warmupBudgetCases += 4;

  const calibrationCases = [
    { name: 'normal-target', input: { repeat: 3, repeatCap: 66, repeatCapReason: 'used-byte-budget', samples: [50, 51, 52], step: 0 },
      expected: { stop: true, accepted: true, capped: false, reason: 'normal-target', memoryCeilingReached: false, normalTargetMiss: false } },
    { name: 'memory-ceiling-at-floor', input: { repeat: 66, repeatCap: 66, repeatCapReason: 'used-byte-budget', samples: [20, 22, 21], step: 15 },
      expected: { stop: true, accepted: true, capped: false, reason: 'memory-ceiling-floor', memoryCeilingReached: true, normalTargetMiss: true } },
    { name: 'memory-ceiling-below-floor', input: { repeat: 66, repeatCap: 66, repeatCapReason: 'used-byte-budget', samples: [20, 19.999, 22], step: 2 },
      expected: { stop: true, accepted: false, capped: true, reason: 'below-memory-ceiling-floor', memoryCeilingReached: true, normalTargetMiss: true } },
    { name: 'nonmemory-iteration-cap', input: { repeat: 10000000, repeatCap: 10000000, repeatCapReason: 'global-repeat-limit', samples: [25, 28, 27], step: 2 },
      expected: { stop: true, accepted: false, capped: true, reason: 'global-repeat-limit', memoryCeilingReached: false, normalTargetMiss: true } },
    { name: 'step-cap', input: { repeat: 30, repeatCap: 66, repeatCapReason: 'used-byte-budget', samples: [25, 28, 27], step: 15 },
      expected: { stop: true, accepted: false, capped: true, reason: 'calibration-step-limit', memoryCeilingReached: false, normalTargetMiss: true } },
    { name: 'continue-below-target', input: { repeat: 30, repeatCap: 66, repeatCapReason: 'used-byte-budget', samples: [25, 28, 27], step: 2 },
      expected: { stop: false, accepted: false, capped: false, reason: 'continue', memoryCeilingReached: false, normalTargetMiss: true } },
    { name: 'invalid-duration', input: { repeat: 66, repeatCap: 66, repeatCapReason: 'used-byte-budget', samples: [NaN, 28, 27], step: 2 },
      expected: { stop: true, accepted: false, capped: true, reason: 'invalid-duration', memoryCeilingReached: true, normalTargetMiss: true } },
  ];
  for (const { name, input, expected } of calibrationCases) {
    const { fastest, ...decision } = calibrationDecision(input);
    assert.deepEqual(decision, expected, name);
  }
  assert.equal(CASES.length, 10);
  assert.deepEqual(CASES.filter(row => row.target).map(row => row.name), [
    'min-random-4096-enqueue', 'max-random-4096-enqueue',
  ]);
  assert.throws(() => canonicalWorkload({ ...CASES[0], size: 1 }), /frozen case/);
  const rows = [];
  for (const workload of CASES) {
    const pair = apis.map(api => checkFixture(api, workload));
    const common = ({ observations, ...rest }) => rest;
    assert.deepEqual(common(pair[1]), common(pair[0]), 'Cross-arm input/expectation/limit identity');
    const { limits, identity } = pair[0];
    if (limits.worstBytesPerIteration) {
      assert.equal(limits.repeatCapReason, 'used-byte-budget');
      assert(limits.initialUsedBytes + limits.repeatCap * limits.worstBytesPerIteration <= limits.batchUsedByteCap);
      assert(limits.initialUsedBytes + (limits.repeatCap + 1) * limits.worstBytesPerIteration > limits.batchUsedByteCap);
      assert(limits.maxWarmupBatches * limits.initialUsedBytes
        + limits.maxWarmupScans * limits.worstBytesPerIteration <= limits.warmupUsedByteCap);
    } else assert.equal(limits.repeatCapReason, 'global-repeat-limit');
    assert.equal(pair[0].observations.usedDeltaBytes - pair[1].observations.usedDeltaBytes,
      identity.targetPromotionsPerIteration * 32 * 2, 'Exactly one discarded 32-byte node saved per promotion');
    if (workload.category === 'unchanged-control') assert.deepEqual(pair[1].observations, pair[0].observations);
    rows.push({ name: workload.name, baselineUsedDeltaBytes: pair[0].observations.usedDeltaBytes,
      candidateUsedDeltaBytes: pair[1].observations.usedDeltaBytes,
      promotionsPerIteration: identity.targetPromotionsPerIteration, repeatCap: limits.repeatCap });
  }

  // The same full baseline allocation-log image is loaded for pop and entries.
  // Compare to the actual built baseline's public enqueue output, not another
  // invocation of the JavaScript oracle.
  let rawFixtureChecks = 0;
  for (const workload of CASES.filter(row => row.operation === 'pop' || row.operation === 'entries')) {
    const baseline = fixture(apis[0], workload), candidate = fixture(apis[1], workload);
    const owner = new baseline.owner.constructor({ id: 'raw-baseline-crosscheck' });
    let built = new apis[0].SharedPriorityQueue('number', { maxHeap: workload.maxHeap }, owner);
    for (const [value, priority] of baseline.input) built = built.enqueue(value, priority);
    assert.deepEqual(baseline.item.toWorkerData(), built.toWorkerData());
    assert.deepEqual(candidate.item.toWorkerData(), built.toWorkerData());
    assert.equal(baseline.owner.used, owner.used);
    assert.equal(candidate.owner.used, owner.used);
    assert.equal(baseline.owner.memory.buffer.byteLength, owner.memory.buffer.byteLength);
    const actual = new Uint8Array(owner.memory.buffer, HEAP_START, owner.used - HEAP_START);
    for (const prepared of [baseline, candidate]) assert.deepEqual(
      new Uint8Array(prepared.owner.memory.buffer, HEAP_START, prepared.owner.used - HEAP_START), actual);
    assert.deepEqual(fixtureIdentity(apis[0], baseline), fixtureIdentity(apis[1], candidate));
    rawFixtureChecks++;
  }

  // Fresh batches fork safely without holding a large array of arenas. A
  // three-repeat small case catches frontier handling and first-output retention.
  for (const api of apis) for (const workload of CASES.filter(row => row.size === 1)) {
    const prepared = fixture(api, workload), result = runBatch(prepared, workload, 3);
    verifyBatch(prepared, workload, 3, result);
    assert.notEqual(result.first, result.last);
    if (workload.operation === 'list-push') {
      assert.deepEqual(result.first.toArray(), [7, 13]);
      assert.equal(prepared.owner.used - prepared.initial.usedBytes, 40);
    }
  }
  console.log(JSON.stringify({ passed: true, clockFree: true, latencyCollected: false,
    runtime: process.versions.bun ? 'bun' : 'node', node: process.versions.node, bun: process.versions.bun ?? null,
    warmupBudgetCases, calibrationCases: calibrationCases.length, cases: rows.length, crossArmCases: rows.length * 2, rawFixtureChecks, rows }, null, 2));
} finally {
  Date.now = originalNow;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
}
