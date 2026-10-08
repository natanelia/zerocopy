import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { logInterval, summarizeCase, measureSingle } from './ordered-churn-performance.mjs';
import { workloadCases } from './ordered-churn-workloads.mjs';
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
for (const [latency, classification] of [[1.01, 'evidence within margin'], [1.03, 'detected material loss']]) {
  const result = logInterval(Array(4).fill(Math.log(latency)));
  close(result.geometricMean, latency); close(result.lower, latency); close(result.upper, latency); assert.equal(result.classification, classification); assert.equal(result.quartets, 4);
}
const uncertain = logInterval([0.98, 1.00, 1.02, 1.04].map(Math.log));
assert(uncertain.lower < 1.02 && uncertain.upper > 1.02); assert.equal(uncertain.classification, 'inconclusive');
assert.equal(logInterval([0]).classification, 'inconclusive');
const small = logInterval([0.99, 1.01].map(Math.log)), larger = logInterval([0.99, 1.01, 0.99, 1.01].map(Math.log));
assert(small.upper - small.lower > larger.upper - larger.lower);
const blocks = Array.from({ length: 4 }, (_, block) => ({ block, mode: 'ab', subjects: ['left', 'right', 'right', 'left'].map(role => ({ role, repeat: 1,
  samples: Array(21).fill(role === 'left' ? 10 : 10.1), belowTargetBatches: 0, warmup: { capped: false }, warmupTimeShort: false, warmupWorkShort: false })) }));
const summary = summarizeCase({ blocks }).ab; assert.equal(summary.pairCount, 8); assert.equal(summary.latencyRatioInterval.quartets, 4); close(summary.latencyRatioInterval.geometricMean, 1.01);
assert.equal(summary.ratioDirection, 'candidate/baseline');
const rows = workloadCases(); assert.equal(rows.length, 32); assert.equal(rows.filter(row => row.gate).length, 14); assert.equal(new Set(rows.map(row => row.name)).size, rows.length);
const entryUrl = pathToFileURL(resolve(process.argv[2] ?? 'dist/shared.js')).href, harnessUrl = new URL('./ordered-churn-checks.mjs', import.meta.url).href;
const config = { samples: 1, maxWarmupMs: 30000, warmupMs: 0, targetBatchMs: 1 };
const checked = [];
for (const workload of rows) {
  const result = await measureSingle({ entryUrl, harnessUrl, workload, config, phase: 'measure', repeat: 1, warmupScans: 1 });
  assert.equal(result.warmup.scans, 1); assert.equal(result.samples.length, 1); assert.equal(JSON.parse(result.expectedJson).length, workload.size);
  checked.push(workload.name);
}
const result = { purpose: 'Fixture, measurement-function and statistics correctness only; these one-scan samples are not speed evidence.', runtime: process.version, bun: process.versions.bun ?? null, entryUrl, checked, independentQuartetStatisticsChecked: true };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
