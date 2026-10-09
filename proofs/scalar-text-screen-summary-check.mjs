/** Deterministic synthetic fixtures only: no runtime import, timing, or real clock sampling. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'scalar-text-screen-summary-check-'));
const aliases = ['A0', 'A1', 'B0', 'B1'];
const stages = ['ordinary-import', 'ordinary-construction-after-import', 'unused-query-creation',
  'first-valid-query-and-access', 'first-query-and-access-on-second-memory'];
const manifest = { cases: [{ id: 'synthetic-case' }], design: {
  calibrationTargetNs: 20_000_000, maximumRepeats: 1024, warmMaterialityMargin: 0.02,
  warmBlocks: 8, coldBlocks: 8, aliases,
} };
const tCritical = 2.364624251, lowerMargin = 1 / 1.02;
let fixtures = 0;
function fixture(name, { warmCandidate = Array(8).fill(0.8), warmMainAA = Array(8).fill(1),
  warmCandidateAA = Array(8).fill(1), coldCandidate = Array(8).fill(1.2),
  coldMainAA = Array(8).fill(1), coldCandidateAA = Array(8).fill(1),
  mutate = () => {}, writeComplete = true, complete = true, append = '' } = {}) {
  fixtures++;
  const dir = join(root, name), rows = [];
  mkdirSync(join(dir, 'timing'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (let block = 0; block < 8; block++) {
    rows.push({ kind: 'warm-start', block, timer: { p99PairNs: 50 }, floorNs: 10_000_000 });
    for (const arm of aliases) {
      const factor = arm === 'A0' ? 1 : arm === 'A1' ? warmMainAA[block]
        : warmCandidate[block] * (arm === 'B1' ? warmCandidateAA[block] : 1);
      rows.push({ kind: 'calibration', block, id: 'synthetic-case', arm, repeats: 1024,
        elapsedNs: 20_000_000, terminal: true, targetReached: true, cappedBeforeTarget: false });
      for (let sample = 0; sample < 6; sample++) {
        const elapsedNs = (20_000_000 + block * 200_000) * factor;
        rows.push({ kind: 'warm', block, id: 'synthetic-case', arm, sample, repeats: 1024,
          elapsedNs, nsPerOperation: elapsedNs / 1024, floorNs: 10_000_000, belowFloor: false });
      }
    }
    rows.push({ kind: 'warm-complete', block });
    for (const arm of aliases) {
      const factor = arm === 'A0' ? 1 : arm === 'A1' ? coldMainAA[block]
        : coldCandidate[block] * (arm === 'B1' ? coldCandidateAA[block] : 1);
      rows.push({ kind: 'cold-start', block, arm });
      for (const stage of stages) rows.push({ kind: 'cold', block, arm, stage,
        elapsedNs: (1_000_000 + block * 10_000) * factor });
      rows.push({ kind: 'cold-complete', block, arm, timer: { p99PairNs: 50 } });
    }
  }
  mutate(rows);
  writeFileSync(join(dir, 'timing', 'synthetic.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n' + append);
  if (writeComplete) writeFileSync(join(dir, 'timing', 'complete.json'), JSON.stringify({ complete, processes: 40 }));
  execFileSync(process.execPath, [fileURLToPath(new URL('./scalar-text-screen-summary.mjs', import.meta.url)), dir], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
}
const warm = summary => summary.rows.find(row => row.kind === 'warm');
const cold = (summary, stage = stages[0]) => summary.rows.find(row => row.kind === 'cold' && row.key === stage);
const effect = row => row.comparisons['candidate/main'];
const control = (row, name = 'main-A/A') => row.comparisons[name].aaControl;
const near = (actual, expected, tolerance = 1e-10) => assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function checkIntervals(row) {
  for (const comparison of Object.values(row.comparisons)) {
    assert.equal(comparison.blockLogRatios.length, 8);
    assert.equal(comparison.blockDeltaNs.length, 8);
    assert.equal(comparison.descriptive95Percent.length, 2);
    assert.equal(comparison.descriptive95PercentDeltaNs.length, 2);
    assert(Number.isFinite(comparison.meanDeltaNs));
  }
}
function invalid(row, reason) {
  assert.equal(row.dataQualityValid, false);
  assert.equal(row.inconclusive, true);
  assert(row.reasons.includes(reason), `${reason}: ${row.reasons.join(', ')}`);
  if (row.kind === 'warm') assert.equal(effect(row).warmMateriality.status, 'not-interpretable-data-quality');
}

const success = fixture('success-at-exact-target-and-cap'), valid = warm(success);
assert.equal(success.complete, true);
assert.equal(success.campaignReasons.length, 0);
assert.deepEqual(success.design.aliases, aliases);
assert.deepEqual(success.interval, { independentBlocks: 8, degreesOfFreedom: 7, studentTCritical95: tCritical });
assert.equal(success.rows.length, 6);
assert.equal(valid.independentBlocks, 8);
assert.equal(valid.dataQualityValid, true);
assert.equal(effect(valid).warmMateriality.status, 'material-gain-evidence');
assert.equal(effect(valid).warmMateriality.pointRegion, 'below-margin');
assert.deepEqual(effect(valid).warmMateriality.bounds, [lowerMargin, 1.02]);
assert(valid.blocks.every(block => Object.values(block.calibration).every(x => x.terminal && x.targetReached && !x.cappedBeforeTarget)));
assert(valid.blocks.every(block => block.pairedObservations.length === 6));
assert.equal(success.rawObservations.length, success.allRawRows);
assert.equal(success.rawObservations[0].file, 'synthetic.jsonl');
assert.equal(success.rawObservations[0].line, 1);
near(effect(valid).geometricRatio, 0.8);
checkIntervals(valid);
assert.equal(success.biasCorrectionApplied, false);

// The precise df=7 interval is based on eight block summaries, never 48 batches.
const deltas = effect(valid).blockDeltaNs;
const average = deltas.reduce((a, b) => a + b, 0) / 8;
const variance = deltas.reduce((n, x) => n + (x - average) ** 2, 0) / 7;
const halfWidth = tCritical * Math.sqrt(variance / 8);
near(effect(valid).descriptive95PercentDeltaNs[0], average - halfWidth);
near(effect(valid).descriptive95PercentDeltaNs[1], average + halfWidth);

const capped = warm(fixture('capped-between-floor-and-target', { mutate(rows) {
  for (const r of rows.filter(r => r.kind === 'calibration' && r.arm === 'B1')) Object.assign(r,
    { elapsedNs: 15_000_000, targetReached: false, cappedBeforeTarget: true });
} }));
invalid(capped, 'calibration capped before target');
assert(!capped.reasons.includes('duration/timer floor'));
assert(capped.blocks.every(block => block.calibration.B1.cappedBeforeTarget));
checkIntervals(capped);

const missingTerminal = warm(fixture('nonterminal-is-not-terminal', { mutate(rows) {
  for (const r of rows.filter(r => r.kind === 'calibration' && r.arm === 'B1')) Object.assign(r,
    { repeats: 512, elapsedNs: 15_000_000, terminal: false, targetReached: false, cappedBeforeTarget: false });
} }));
invalid(missingTerminal, 'missing terminal calibration');
assert(missingTerminal.blocks.every(block => block.calibration.B1 === null));
checkIntervals(missingTerminal);

const duplicateTerminal = warm(fixture('duplicate-terminal', { mutate(rows) {
  rows.push({ ...rows.find(r => r.kind === 'calibration'), repeats: 512 });
} }));
invalid(duplicateTerminal, 'duplicate terminal calibration');
const trailingCalibration = warm(fixture('nonterminal-after-terminal', { mutate(rows) {
  rows.push({ ...rows.find(r => r.kind === 'calibration'), repeats: 512, elapsedNs: 15_000_000,
    terminal: false, targetReached: false, cappedBeforeTarget: false });
} }));
invalid(trailingCalibration, 'invalid terminal calibration');

const subpercent = warm(fixture('subpercent-ci-excludes-parity-valid', { warmMainAA: Array(8).fill(1.005) }));
assert.equal(subpercent.dataQualityValid, true);
assert.equal(control(subpercent).pointOutsideMargin, false);
assert.equal(control(subpercent).intervalExcludesOne, true);
assert.equal(control(subpercent).imbalance, false);
assert.equal(control(subpercent).status, 'detectable-nonmaterial-control');
assert(subpercent.comparisons['main-A/A'].descriptive95PercentDeltaNs[0] > 0);
assert.equal(control(subpercent).biasCorrectionApplied, false);
near(effect(subpercent).geometricRatio, 0.8 / Math.sqrt(1.005));
const materialControl = warm(fixture('material-main-aa-invalid', { warmMainAA: Array(8).fill(1.03) }));
invalid(materialControl, 'main-A/A imbalance');
assert.equal(control(materialControl).pointOutsideMargin, true);
assert.equal(control(materialControl).intervalExcludesOne, true);
checkIntervals(materialControl);
const materialCandidateControl = warm(fixture('material-candidate-aa-invalid', { warmCandidateAA: Array(8).fill(0.97) }));
invalid(materialCandidateControl, 'candidate-A/A imbalance');
const uncertain = warm(fixture('above-two-percent-with-parity-compatible-ci', {
  warmMainAA: [0.85, 0.9, 0.95, 1, 1.1, 1.15, 1.2, 1.25],
}));
assert.equal(uncertain.dataQualityValid, true);
assert.equal(control(uncertain).pointOutsideMargin, true);
assert.equal(control(uncertain).intervalExcludesOne, false);
assert.equal(control(uncertain).uncertain, true);
assert.equal(control(uncertain).status, 'uncertain-control');
checkIntervals(uncertain);
const directionalUncertain = warm(fixture('directional-nonmaterial-point-material-interval', {
  warmMainAA: [0.995, 1.001, 1.007, 1.013, 1.017, 1.023, 1.029, 1.035],
}));
assert.equal(directionalUncertain.dataQualityValid, true);
assert.equal(control(directionalUncertain).pointOutsideMargin, false);
assert.equal(control(directionalUncertain).intervalExcludesOne, true);
assert.equal(control(directionalUncertain).uncertain, true);
assert.equal(control(directionalUncertain).status, 'uncertain-control');


const within = warm(fixture('within-multiplicative-margin', { warmCandidate: Array(8).fill(0.99) }));
assert.equal(effect(within).warmMateriality.status, 'within-margin-evidence');
const nearLower = warm(fixture('reciprocal-gain-boundary', { warmCandidate: Array(8).fill(0.9802) }));
assert.equal(effect(nearLower).warmMateriality.status, 'material-gain-evidence');
const justInside = warm(fixture('inside-reciprocal-boundary', { warmCandidate: Array(8).fill(0.9805) }));
assert.equal(effect(justInside).warmMateriality.status, 'within-margin-evidence');
const loss = warm(fixture('material-loss', { warmCandidate: Array(8).fill(1.04) }));
assert.equal(effect(loss).warmMateriality.status, 'material-loss-evidence');
const unresolved = warm(fixture('interval-crosses-margin', { warmCandidate: [0.95, 1.03, 0.96, 1.02, 0.97, 1.01, 0.98, 1] }));
assert.equal(unresolved.dataQualityValid, true);
assert.equal(effect(unresolved).warmMateriality.status, 'unresolved');

// Median of six paired logs differs from log of the arithmetic median ratio.
const medianFixture = warm(fixture('paired-median-reduction', { mutate(rows) {
  const factors = [0.7, 0.95, 0.8, 0.9, 0.75, 0.85];
  for (const r of rows.filter(r => r.kind === 'warm' && r.arm.startsWith('B'))) {
    r.elapsedNs = (20_000_000 + r.block * 200_000) * factors[r.sample];
    r.nsPerOperation = r.elapsedNs / r.repeats;
  }
} }));
assert.equal(medianFixture.dataQualityValid, true);
near(effect(medianFixture).geometricRatio, Math.sqrt(0.8 * 0.85));
near(effect(medianFixture).blockDeltaNs[0], -0.175 * 20_000_000 / 1024);

for (const row of success.rows.filter(row => row.kind === 'cold')) {
  assert.equal(row.independentBlocks, 8);
  assert.equal(row.dataQualityValid, true);
  checkIntervals(row);
  const comparison = effect(row);
  near(comparison.meanDeltaNs, 207_000);
  assert(comparison.descriptive95PercentDeltaNs[0] > 0);
  assert(comparison.descriptive95PercentDeltaNs[0] < 207_000);
  assert(comparison.descriptive95PercentDeltaNs[1] > 207_000);
  assert.equal(comparison.warmMateriality, undefined);
  assert.deepEqual(row.comparisons['main-A/A'].descriptive95PercentDeltaNs, [0, 0]);
}
const coldImbalance = fixture('cold-small-aa-ci-excludes-parity', { coldMainAA: Array(8).fill(1.005) });
for (const row of coldImbalance.rows.filter(row => row.kind === 'cold')) {
  invalid(row, 'main-A/A imbalance');
  assert.equal(control(row).pointOutsideMargin, false);
  assert.equal(control(row).intervalExcludesOne, true);
  checkIntervals(row);
  assert(effect(row).descriptive95PercentDeltaNs[0] > 0);
  assert(row.comparisons['main-A/A'].descriptive95PercentDeltaNs[0] > 0);
}
const coldWide = cold(fixture('cold-aa-point-outside-ten-percent', { coldMainAA: [0.6, 0.7, 0.8, 1.1, 1.5, 1.6, 1.8, 2] }));
invalid(coldWide, 'main-A/A imbalance');
assert.equal(control(coldWide).pointOutsideMargin, true);
assert.equal(control(coldWide).intervalExcludesOne, false);
checkIntervals(coldWide);

const coldFloor = cold(fixture('cold-timer-floor', { mutate(rows) {
  rows.find(r => r.kind === 'cold' && r.arm === 'B1').elapsedNs = 4999;
} }));
invalid(coldFloor, 'duration/timer floor');
checkIntervals(coldFloor);
const coldMinimum = cold(fixture('cold-absolute-minimum-floor', { mutate(rows) {
  for (const r of rows.filter(r => r.kind === 'cold-complete')) r.timer.p99PairNs = 1;
  rows.find(r => r.kind === 'cold' && r.arm === 'B1').elapsedNs = 999;
} }));
invalid(coldMinimum, 'duration/timer floor');
const warmFloor = warm(fixture('warm-ten-ms-floor', { mutate(rows) {
  const r = rows.find(r => r.kind === 'warm');
  r.elapsedNs = 9_999_999; r.nsPerOperation = r.elapsedNs / r.repeats;
  r.belowFloor = false; // The analyzer checks the duration instead of trusting this flag.
} }));
invalid(warmFloor, 'duration/timer floor');
const warmTimer = warm(fixture('warm-timer-dependent-floor', { mutate(rows) {
  for (const r of rows.filter(r => r.kind === 'warm-start')) { r.timer.p99PairNs = 25_000; r.floorNs = 25_000_000; }
  for (const r of rows.filter(r => r.kind === 'warm')) r.floorNs = 25_000_000;
} }));
invalid(warmTimer, 'duration/timer floor');
const drift = warm(fixture('early-late-drift', { mutate(rows) {
  for (const r of rows.filter(r => r.kind === 'warm' && r.sample >= 3)) {
    r.elapsedNs *= 1.11; r.nsPerOperation = r.elapsedNs / r.repeats;
  }
} }));
invalid(drift, 'early/late drift >10%');
checkIntervals(drift);

for (const [name, options] of [
  ['missing-controller-marker', { writeComplete: false }], ['false-controller-marker', { complete: false }],
  ['nonboolean-controller-marker', { complete: 'true' }],
]) {
  const partial = fixture(name, options);
  assert.equal(partial.complete, false);
  for (const row of partial.rows) { invalid(row, 'incomplete controller'); checkIntervals(row); }
}
const missingWarmComplete = fixture('missing-warm-complete', { mutate(rows) {
  rows.splice(rows.findIndex(r => r.kind === 'warm-complete'), 1);
} });
invalid(warm(missingWarmComplete), 'incomplete warm process');
checkIntervals(warm(missingWarmComplete));
const missingColdComplete = fixture('missing-cold-complete', { mutate(rows) {
  rows.splice(rows.findIndex(r => r.kind === 'cold-complete'), 1);
} });
invalid(cold(missingColdComplete), 'incomplete cold process');
checkIntervals(cold(missingColdComplete));
const duplicate = fixture('duplicate-warm-observation', { mutate(rows) {
  rows.push({ ...rows.find(r => r.kind === 'warm') });
} });
invalid(warm(duplicate), 'duplicate observation');
assert.equal(warm(duplicate).independentBlocks, 7);
assert.equal(effect(warm(duplicate)).descriptive95Percent, null);
assert.equal(duplicate.rawObservations.length, success.rawObservations.length + 1);
const missing = fixture('missing-warm-observation', { mutate(rows) {
  rows.splice(rows.findIndex(r => r.kind === 'warm'), 1);
} });
invalid(warm(missing), 'missing or duplicate paired observation');
assert.equal(warm(missing).independentBlocks, 7);
const missingCold = fixture('missing-cold-stage', { mutate(rows) {
  rows.splice(rows.findIndex(r => r.kind === 'cold'), 1);
} });
invalid(cold(missingCold), 'missing or duplicate paired observation');
assert.equal(cold(missingCold).independentBlocks, 7);
for (const [name, observation] of [
  ['unknown-kind', { kind: 'mystery', block: 0 }],
  ['unknown-alias', { kind: 'warm', block: 0, id: 'synthetic-case', arm: 'C0', sample: 0 }],
  ['unknown-sample', { kind: 'warm', block: 0, id: 'synthetic-case', arm: 'A0', sample: 6 }],
  ['unknown-block', { kind: 'cold', block: 8, arm: 'A0', stage: stages[0] }],
  ['unknown-stage', { kind: 'cold', block: 0, arm: 'A0', stage: 'extra-stage' }],
]) {
  const result = fixture(name, { mutate(rows) { rows.push(observation); } });
  invalid(warm(result), name === 'unknown-kind' ? 'unrecognized or malformed observation' : 'unrecognized observation coordinates');
  checkIntervals(warm(result));
  assert.deepEqual(result.rawObservations.at(-1).record, observation);
}
const truncated = fixture('truncated-jsonl', { append: '{"kind":' });
invalid(warm(truncated), 'unrecognized or malformed observation');
assert.equal(truncated.rawObservations.at(-1).record.rawLine, '{"kind":');
const zero = warm(fixture('invalid-numeric-observation', { mutate(rows) {
  rows.find(r => r.kind === 'warm').nsPerOperation = 0;
} }));
invalid(zero, 'invalid numeric observation');

console.log(JSON.stringify({ passed: true, syntheticOnly: true, realClockSamples: 0, fixtures, evidence: root }));
