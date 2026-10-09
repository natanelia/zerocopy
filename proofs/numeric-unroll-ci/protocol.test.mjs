import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {median, summary, logInterval, selectCommonWork, pointwiseDecision, slotPlan, hasCompleteReplicates} from './math.mjs';
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
let checks = 0;
function check(fn) { fn(); checks++; }
check(() => assert.equal(median([4, 1, 2, 3]), 2.5));
check(() => assert.equal(median([1, 7, 3]), 3));
check(() => assert.equal(summary([1, 2, 3]).sd, 1));
check(() => assert.equal(summary([1, 2, 3]).mad, 1));
check(() => assert.deepEqual(selectCommonWork({ladder: [1, 2, 4]}, {1: [15], 2: [25], 4: [50]}, {1: [5], 2: [15], 4: [30]}, 12), {operations: 2, targetMet: true}));
check(() => assert.deepEqual(selectCommonWork({ladder: [1, 2]}, {1: [15], 2: [25]}, {1: [1], 2: [2]}, 12), {operations: 2, targetMet: false}));
check(() => assert.equal(logInterval(Array(4).fill(Math.log(0.9)), protocol.statistics.tCritical).ratio, 0.9));
check(() => assert.throws(() => logInterval([0, 0, 0], protocol.statistics.tCritical)));
check(() => { const a = logInterval([-0.03, -0.01, 0.01, 0.03], protocol.statistics.tCritical); assert(Math.abs(a.low*a.high-1) < 1e-12); assert(a.low < 1 && a.high > 1); });
check(() => { const a = logInterval([-0.03, -0.01, 0.01, 0.03], protocol.statistics.tCritical); const expected = Math.exp(protocol.statistics.tCritical*Math.sqrt(0.002/3)/2); assert(Math.abs(a.high-expected) < 1e-12); });
check(() => assert.equal(pointwiseDecision({low: 0.89, high: 0.94}, protocol.statistics, true), 'worthwhile gain supported in this cell'));
check(() => assert.equal(pointwiseDecision({low: 1.03, high: 1.05}, protocol.statistics, true), 'material loss supported in this cell'));
check(() => assert.match(pointwiseDecision({low: 0.89, high: 0.94}, protocol.statistics, false), /^inconclusive/));
check(() => assert.equal(pointwiseDecision({low: 0.98, high: 1.04}, protocol.statistics, true), 'inconclusive'));
const slots = slotPlan(protocol);
check(() => assert.equal(slots.length, 32));
check(() => assert.equal(new Set(slots.map(x => x.id)).size, slots.length));
for (const runtime of protocol.runtimes) for (let block = 0; block < 4; block++) for (const arm of ['baseline', 'candidate']) check(() => assert.deepEqual(slots.filter(x => x.runtime === runtime && x.block === block && x.arm === arm).map(x => x.replicate), [0, 1]));
for (const runtime of protocol.runtimes) for (let position = 0; position < 4; position++) check(() => assert.equal(slots.filter(x => x.runtime === runtime && x.position === position && x.arm === 'baseline').length, 2));
check(() => assert.equal(protocol.cases.length, 9));
check(() => assert(protocol.cases.every(x => new Set(x.ladder).size === x.ladder.length && x.ladder.every((n,i) => Number.isSafeInteger(n) && n > 0 && (i === 0 || n > x.ladder[i-1])))));
check(() => assert.equal(protocol.statistics.materialLossRatio, 1.02));
check(() => assert.equal(protocol.statistics.worthwhileGainRatio, 0.95));
check(() => assert.equal(protocol.measurement.warmupChunks, 32));
check(() => assert.equal(protocol.measurement.minimumWarmupBodyMs, 200));
check(() => assert.equal(protocol.calibration.warmupChunks, 32));
check(() => assert.equal(protocol.calibration.minimumWarmupBodyMs, 200));
check(() => assert.equal(protocol.measurement.samples, 7));


check(() => assert.deepEqual(protocol.cases.reduce((a, c) => ({...a, [c.operation]: (a[c.operation] ?? 0) + 1}), {}), {countInRange: 8, countPointsInBox: 1}));
check(() => assert.deepEqual(protocol.cases.filter(c => c.primary).map(c=>c.size), [4096,32768]));
check(() => assert.equal(protocol.firstUseStatus, 'unresolved; promotion blocked'));
check(() => assert.equal(protocol.resourceUnits['process.resourceUsage().maxRSS'], 'KiB (1024 bytes)'));
check(() => assert.equal(protocol.resourceUnits['process.memoryUsage().rss'], 'bytes'));
check(() => assert.equal(protocol.resourceUnits['controller.maximumRss'], 'bytes'));
check(() => assert.equal(protocol.cases.filter(c=>c.mode==='scalar').length,1));

check(() => assert(hasCompleteReplicates({baseline: [1, 2], candidate: [3, 4]})));
for (const arm of ['baseline', 'candidate']) {
  check(() => { const sparse = []; sparse[1] = 1; assert(!hasCompleteReplicates({...{baseline: [1, 2], candidate: [3, 4]}, [arm]: sparse})); });
  check(() => assert(!hasCompleteReplicates({...{baseline: [1, 2], candidate: [3, 4]}, [arm]: [1]})));
  for (const invalid of [undefined, null, NaN, Infinity, 0, -1]) for (const index of [0, 1]) check(() => {
    const pair = [1, 2]; pair[index] = invalid;
    assert(!hasCompleteReplicates({...{baseline: [1, 2], candidate: [3, 4]}, [arm]: pair}));
  });
}
console.log(JSON.stringify({deterministicChecks: checks, passed: true, timingRun: false}));
