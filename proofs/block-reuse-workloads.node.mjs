import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASES, HEAP_START, BATCH_USED_BYTE_CAP, WARMUP_USED_BYTE_CAP, WARMUP_BATCH_CAP, warmupWorkLimit,
  canonicalWorkload, checkFixture, fixture, runBatch, verifyBatch, allocationFor, allocationPins } from './block-reuse-workloads.mjs';
import { calibrationDecision } from './block-reuse-subject.mjs';
const paths = process.argv.slice(2); assert.equal(paths.length, 2, 'Expected baseline and candidate built entry paths');
const apis = await Promise.all(paths.map(path => import(pathToFileURL(resolve(path)).href)));
const originalPerformance = globalThis.performance, originalNow = Date.now;
const clockForbidden = () => { throw Error('Fixture verification must not read a clock'); };
globalThis.performance = { now: clockForbidden }; Date.now = clockForbidden;
try {
  let budgetCases = 0;
  for (const initial of [HEAP_START, HEAP_START * 2, HEAP_START * 3 + 8]) for (const cost of [0, 1, 3, 16, 37, 4096]) {
    const limit = warmupWorkLimit(initial, cost), remaining = WARMUP_USED_BYTE_CAP - WARMUP_BATCH_CAP * initial;
    if (cost) { assert(limit * cost <= remaining); assert((limit + 1) * cost > remaining); }
    else assert.equal(limit, 10000000); budgetCases++;
  }
  for (const initial of [NaN, Infinity, -1, HEAP_START - 1, HEAP_START + 0.5, Number.MAX_SAFE_INTEGER + 1, BATCH_USED_BYTE_CAP + 1]) { assert.throws(() => warmupWorkLimit(initial, 1)); budgetCases++; }
  for (const cost of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) { assert.throws(() => warmupWorkLimit(HEAP_START, cost)); budgetCases++; }
  const boundary = WARMUP_USED_BYTE_CAP / WARMUP_BATCH_CAP;
  assert.equal(warmupWorkLimit(boundary - 1, WARMUP_BATCH_CAP), 1);
  for (const [initial,cost] of [[boundary,1],[boundary-1,WARMUP_BATCH_CAP+1],[boundary+1,1]]) assert.throws(() => warmupWorkLimit(initial,cost));
  budgetCases += 4;
  const calibrationCases = [
    [{repeat:3,repeatCap:66,repeatCapReason:'used-byte-budget',samples:[50,51,52],step:0},'normal-target',true],
    [{repeat:66,repeatCap:66,repeatCapReason:'used-byte-budget',samples:[20,22,21],step:15},'memory-ceiling-floor',true],
    [{repeat:66,repeatCap:66,repeatCapReason:'used-byte-budget',samples:[20,19.999,22],step:2},'below-memory-ceiling-floor',false],
    [{repeat:10000000,repeatCap:10000000,repeatCapReason:'global-repeat-limit',samples:[25,28,27],step:2},'global-repeat-limit',false],
    [{repeat:30,repeatCap:66,repeatCapReason:'used-byte-budget',samples:[25,28,27],step:15},'calibration-step-limit',false],
    [{repeat:30,repeatCap:66,repeatCapReason:'used-byte-budget',samples:[25,28,27],step:2},'continue',false],
    [{repeat:66,repeatCap:66,repeatCapReason:'used-byte-budget',samples:[NaN,28,27],step:2},'invalid-duration',false],
  ];
  for (const [input,reason,accepted] of calibrationCases) { const actual = calibrationDecision(input); assert.equal(actual.reason, reason); assert.equal(actual.accepted, accepted); }
  assert.equal(CASES.length, 9); assert.equal(CASES.filter(c => c.target).length, 3);
  assert.throws(() => canonicalWorkload({...CASES[0], size:1}), /frozen case/);
  const rows = []; let observations = 0;
  for (const workload of CASES) {
    const pair = apis.map(api => checkFixture(api, workload));
    const common = ({observations, ...rest}) => rest;
    assert.deepEqual(common(pair[0]),common(pair[1]));
    assert.equal(pair[0].observations.outputShapeSha256,pair[1].observations.outputShapeSha256);
    const pin = allocationPins().rows[workload.name];
    if (workload.target) assert(pin.candidate.next < pin.baseline.next); else assert.deepEqual(pin.candidate,pin.baseline);
    for (let arm = 0; arm < apis.length; arm++) for (const repeat of [1,2,3,17]) {
      const p = fixture(apis[arm],workload), result=runBatch(p,workload,repeat), o=verifyBatch(p,workload,repeat,result), l=p.limits;
      assert.equal(o.usedDeltaBytes,allocationFor(pin[arm ? 'candidate' : 'baseline'],repeat));
      assert(l.initialUsedBytes+l.repeatCap*l.worstBytesPerIteration<=l.batchUsedByteCap);
      assert(l.initialUsedBytes*l.maxWarmupBatches+l.maxWarmupScans*l.worstBytesPerIteration<=l.warmupUsedByteCap);
      observations++;
    }
    if (!workload.target) assert.deepEqual(pair[0].observations,pair[1].observations);
    rows.push({name:workload.name,baseline:pair[0].observations,candidate:pair[1].observations,limits:pair[0].limits});
  }
  // Verify old-byte corruption and result corruption cannot be silently accepted.
  const w=CASES[2],p=fixture(apis[1],w),r=runBatch(p,w,1);r.checksum.count++;assert.throws(()=>verifyBatch(p,w,1,r));r.checksum.count--;
  new Uint8Array(p.owner.memory.buffer)[HEAP_START]^=1;assert.throws(()=>verifyBatch(p,w,1,r),/Old published bytes/);
  console.log(JSON.stringify({passed:true,clockFree:true,latencyCollected:false,runtime:process.versions.bun?'bun':'node',budgetCases,calibrationCases:calibrationCases.length,cases:CASES.length,observations,rows},null,2));
} finally { Date.now=originalNow;globalThis.performance=originalPerformance; }
