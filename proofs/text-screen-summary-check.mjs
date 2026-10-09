/** Synthetic regression fixtures only: never import a runtime or sample a clock. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'text-screen-summary-check-'));
const arms = ['A0', 'A1', 'B0', 'B1', 'C0', 'C1'];
const stages = ['ordinary-import', 'ordinary-construction-after-import', 'unused-query-creation',
  'first-valid-query-and-access', 'first-query-and-access-on-second-memory'];
const manifest = { cases: [{ id: 'synthetic-case' }], design: {
  calibrationTargetNs: 20000000, maximumRepeats: 1024, warmMaterialityMargin: 0.02,
} };
function fixture(name, { capped = false, missing = false, simd = Array(6).fill(0.8) } = {}) {
  const dir = join(root, name), rows = [];
  mkdirSync(join(dir, 'timing'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (let block = 0; block < 6; block++) for (const arm of arms) {
    const factor = arm.startsWith('B') ? 1.2 : arm.startsWith('C') ? simd[block] : 1;
    const cappedBeforeTarget = capped && arm === 'C1';
    if (!(missing && arm === 'C1')) rows.push({ kind: 'calibration', block, id: 'synthetic-case', arm,
      repeats: 1024, elapsedNs: cappedBeforeTarget ? 15000000 : 20000000,
      terminal: true, targetReached: !cappedBeforeTarget, cappedBeforeTarget });
    for (let sample = 0; sample < 6; sample++) rows.push({ kind: 'warm', block, id: 'synthetic-case', arm, sample,
      repeats: 1024, elapsedNs: 15000000 * factor, nsPerOperation: 15000000 * factor / 1024, belowFloor: false });
  }
  for (let block = 0; block < 8; block++) for (const arm of arms) {
    const factor = arm.startsWith('B') ? 1.2 : arm.startsWith('C') ? 0.8 : 1;
    for (const stage of stages) rows.push({ kind: 'cold', block, arm, stage, elapsedNs: (1000000 + block * 10000) * factor });
    rows.push({ kind: 'cold-complete', block, arm, timer: { p99PairNs: 50 } });
  }
  writeFileSync(join(dir, 'timing', 'synthetic.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(dir, 'timing', 'complete.json'), '{"complete":true}');
  execFileSync(process.execPath, [new URL('./text-screen-summary.mjs', import.meta.url).pathname, dir], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(dir, 'summary.json')));
}
const warm = summary => summary.rows.find(row => row.kind === 'warm');
const capped = warm(fixture('capped-between-floor-and-target', { capped: true }));
assert.equal(capped.independentBlocks, 6);
assert(capped.reasons.includes('calibration capped before target'));
assert(!capped.reasons.includes('duration/timer floor'));
assert.equal(capped.dataQualityValid, false);
assert.equal(capped.inconclusive, true);
assert(capped.blocks.every(block => block.calibration.C1.cappedBeforeTarget));
assert.equal(capped.comparisons['simd/main'].warmMateriality.status, 'not-interpretable-data-quality');
const success = fixture('target-exactly-at-cap'), valid = warm(success);
assert.equal(valid.dataQualityValid, true);
assert.equal(valid.comparisons['simd/main'].warmMateriality.status, 'material-gain-evidence');
assert.equal(valid.comparisons['scalar/main'].warmMateriality.status, 'material-loss-evidence');
assert(valid.blocks.every(block => !block.calibration.C1.cappedBeforeTarget));
const within = warm(fixture('within-two-percent', { simd: Array(6).fill(0.99) }));
assert.equal(within.comparisons['simd/main'].warmMateriality.status, 'within-margin-evidence');
const unresolved = warm(fixture('interval-crosses-margin', { simd: [0.95, 1.03, 0.96, 1.02, 0.97, 1.01] }));
assert.equal(unresolved.dataQualityValid, true);
assert.equal(unresolved.comparisons['simd/main'].warmMateriality.status, 'unresolved');
assert(warm(fixture('missing-terminal', { missing: true })).reasons.includes('missing terminal calibration'));
for (const row of success.rows.filter(row => row.kind === 'cold')) {
  assert.equal(row.independentBlocks, 8);
  assert.equal(row.dataQualityValid, true);
  const comparison = row.comparisons['simd/main'];
  assert.equal(comparison.meanDeltaNs, -207000);
  assert(comparison.descriptive95PercentDeltaNs[0] < -207000);
  assert(comparison.descriptive95PercentDeltaNs[1] > -207000);
  assert(comparison.descriptive95PercentDeltaNs[1] < 0);
  assert.equal(comparison.warmMateriality, undefined);
}
console.log(JSON.stringify({ passed: true, syntheticOnly: true, realClockSamples: 0, fixtures: 5, evidence: root }));
