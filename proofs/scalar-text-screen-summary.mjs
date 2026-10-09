/** Frozen descriptive process-block analysis. Never imports a runtime or samples a clock. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

assert(process.argv[2], 'Provide the staged evidence directory');
const root = resolve(process.argv[2]), dir = join(root, 'timing');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const aliases = ['A0', 'A1', 'B0', 'B1'];
const stages = ['ordinary-import', 'ordinary-construction-after-import', 'unused-query-creation',
  'first-valid-query-and-access', 'first-query-and-access-on-second-memory'];
const design = { calibrationTargetNs: 20_000_000, maximumRepeats: 1024, warmMaterialityMargin: 0.02,
  warmBlocks: 8, coldBlocks: 8, aliases };
for (const [key, value] of Object.entries(design)) assert.deepEqual(manifest.design[key], value, `Frozen design: ${key}`);
assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'At least one frozen case is required');
const caseIds = manifest.cases.map(x => x.id);
assert(caseIds.every(id => typeof id === 'string' && id.length > 0), 'Case IDs must be nonempty strings');
assert.equal(new Set(caseIds).size, caseIds.length, 'Case IDs must be unique');
const tCritical = 2.364624251, lowerMargin = 1 / 1.02, upperMargin = 1.02;
const median = values => { const a = [...values].sort((a, b) => a - b), i = a.length >> 1; return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
const repeatsValid = x => Number.isInteger(x) && x >= 1 && x <= design.maximumRepeats && (x & (x - 1)) === 0;
const timerValid = x => x && positive(x.p99PairNs);
const reasons = values => [...new Set(values)];
const contrasts = { 'candidate/main': ['B', 'A'], 'main-A/A': ['A1', 'A0'], 'candidate-A/A': ['B1', 'B0'] };
const logs = (values, arm) => arm.length === 1 ? mean([Math.log(values[arm + '0']), Math.log(values[arm + '1'])]) : Math.log(values[arm]);
const ns = (values, arm) => arm.length === 1 ? mean([values[arm + '0'], values[arm + '1']]) : values[arm];
function interval(samples) {
  if (samples.length !== 8) return null;
  const avg = mean(samples), variance = samples.reduce((sum, x) => sum + (x - avg) ** 2, 0) / 7;
  const error = tCritical * Math.sqrt(variance / 8);
  return { mean: avg, bounds: [avg - error, avg + error] };
}

const campaignReasons = [], rawObservations = [];
let files = [];
try { files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); }
catch { campaignReasons.push('missing timing directory'); }
for (const file of files) {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) {
    let record;
    try { record = JSON.parse(lines[i]); }
    catch { record = { kind: 'unparseable-record', rawLine: lines[i] }; }
    rawObservations.push({ file, line: i + 1, record });
  }
}
const raw = rawObservations.map(x => x.record);
const recognizedKinds = new Set(['warm-start', 'calibration', 'warm', 'warm-complete', 'cold-start', 'cold', 'cold-complete']);
const admitted = [], seen = new Set();
for (const r of raw) {
  if (!r || typeof r !== 'object' || !recognizedKinds.has(r.kind)) {
    campaignReasons.push('unrecognized or malformed observation'); continue;
  }
  if (!Number.isInteger(r.block) || r.block < 0 || r.block >= 8 ||
      (['calibration', 'warm', 'cold-start', 'cold', 'cold-complete'].includes(r.kind) && !aliases.includes(r.arm)) ||
      (['calibration', 'warm'].includes(r.kind) && !caseIds.includes(r.id)) ||
      (r.kind === 'warm' && (!Number.isInteger(r.sample) || r.sample < 0 || r.sample >= 6)) ||
      (r.kind === 'cold' && (!stages.includes(r.stage) || r.sample !== undefined))) {
    campaignReasons.push('unrecognized observation coordinates'); continue;
  }
  const identity = JSON.stringify([r.kind, r.block, r.arm, r.id, r.kind === 'calibration' ? r.repeats : r.sample, r.stage]);
  if (seen.has(identity)) campaignReasons.push('duplicate observation');
  seen.add(identity);
  admitted.push(r);
}
let complete = false, completion = null;
try { completion = JSON.parse(readFileSync(join(dir, 'complete.json'), 'utf8')); complete = completion.complete === true; }
catch {}
if (!complete) campaignReasons.push('incomplete controller');
if (completion?.processes !== undefined && completion.processes !== 40) campaignReasons.push('unexpected completed process count');
const find = (kind, block, arm) => admitted.filter(r => r.kind === kind && r.block === block && (arm === undefined || r.arm === arm));
const warmTimers = new Map(), coldTimers = new Map();
for (let block = 0; block < 8; block++) {
  const starts = find('warm-start', block), ends = find('warm-complete', block);
  if (starts.length !== 1 || ends.length !== 1) campaignReasons.push('incomplete warm process');
  if (starts.length === 1 && timerValid(starts[0].timer)) {
    warmTimers.set(block, starts[0].timer);
    if (starts[0].floorNs !== Math.max(10_000_000, 1000 * starts[0].timer.p99PairNs)) campaignReasons.push('invalid warm process floor');
  } else campaignReasons.push('missing or invalid warm timer');
  for (const arm of aliases) {
    const starts = find('cold-start', block, arm), ends = find('cold-complete', block, arm);
    if (starts.length !== 1 || ends.length !== 1) campaignReasons.push('incomplete cold process');
    if (ends.length === 1 && timerValid(ends[0].timer)) coldTimers.set(`${block}/${arm}`, ends[0].timer);
    else campaignReasons.push('missing or invalid cold timer');
  }
}

const outputs = [];
for (const kind of ['warm', 'cold']) for (const key of kind === 'warm' ? caseIds : stages) {
  const rows = admitted.filter(r => r.kind === kind && (kind === 'warm' ? r.id : r.stage) === key);
  const blocks = [], rowReasons = [];
  for (let block = 0; block < 8; block++) {
    const blockRows = rows.filter(r => r.block === block), paired = [], blockReasons = [], calibration = {}, drift = {};
    let belowFloor = false;
    for (const sample of kind === 'warm' ? [0, 1, 2, 3, 4, 5] : [undefined]) {
      const current = blockRows.filter(r => r.sample === sample);
      if (current.length !== 4 || aliases.some(arm => current.filter(r => r.arm === arm).length !== 1)) {
        blockReasons.push('missing or duplicate paired observation'); continue;
      }
      let validNumbers = true;
      for (const r of current) {
        if (!positive(r.elapsedNs) || (kind === 'warm' && (!positive(r.nsPerOperation) || !repeatsValid(r.repeats) ||
            r.nsPerOperation !== r.elapsedNs / r.repeats || typeof r.belowFloor !== 'boolean'))) validNumbers = false;
        const timer = kind === 'warm' ? warmTimers.get(block) : coldTimers.get(`${block}/${r.arm}`);
        const floor = kind === 'warm' ? Math.max(10_000_000, 1000 * (timer?.p99PairNs ?? Infinity))
          : Math.max(1000, 100 * (timer?.p99PairNs ?? Infinity));
        belowFloor ||= !timer || r.elapsedNs < floor || (kind === 'warm' && r.belowFloor);
        if (kind === 'warm' && r.floorNs !== floor) blockReasons.push('invalid warm observation floor');
      }
      if (!validNumbers) { blockReasons.push('invalid numeric observation'); continue; }
      const values = Object.fromEntries(current.map(r => [r.arm, kind === 'warm' ? r.nsPerOperation : r.elapsedNs]));
      paired.push(Object.fromEntries(Object.entries(contrasts).map(([name, [a, b]]) => [name,
        { logRatio: logs(values, a) - logs(values, b), deltaNs: ns(values, a) - ns(values, b) }])));
    }
    if (belowFloor) blockReasons.push('duration/timer floor');
    if (kind === 'warm') {
      for (const arm of aliases) {
        const records = admitted.filter(r => r.kind === 'calibration' && r.block === block && r.id === key && r.arm === arm);
        const terminals = records.filter(r => r.terminal === true), terminal = terminals.length === 1 ? terminals[0] : null;
        if (!terminal) blockReasons.push(terminals.length ? 'duplicate terminal calibration' : 'missing terminal calibration');
        if (records.some(r => !repeatsValid(r.repeats) || !positive(r.elapsedNs) || typeof r.terminal !== 'boolean' ||
            r.targetReached !== (r.elapsedNs >= design.calibrationTargetNs) ||
            r.cappedBeforeTarget !== (r.repeats === design.maximumRepeats && r.elapsedNs < design.calibrationTargetNs) ||
            r.terminal !== (r.targetReached || r.cappedBeforeTarget)) || (terminal && terminal !== records.at(-1))) {
          blockReasons.push('invalid terminal calibration');
        }
        calibration[arm] = terminal ? { repeats: terminal.repeats, elapsedNs: terminal.elapsedNs, terminal: true,
          targetReached: terminal.elapsedNs >= design.calibrationTargetNs,
          cappedBeforeTarget: terminal.repeats === design.maximumRepeats && terminal.elapsedNs < design.calibrationTargetNs } : null;
        if (calibration[arm]?.cappedBeforeTarget) blockReasons.push('calibration capped before target');
        else if (calibration[arm] && !calibration[arm].targetReached) blockReasons.push('incomplete calibration');
        const observations = blockRows.filter(r => r.arm === arm);
        if (observations.length === 6 && observations.every(r => positive(r.nsPerOperation))) {
          drift[arm] = median(observations.filter(r => r.sample >= 3).map(r => r.nsPerOperation)) /
            median(observations.filter(r => r.sample < 3).map(r => r.nsPerOperation));
          if (drift[arm] < 0.9 || drift[arm] > 1.1) blockReasons.push('early/late drift >10%');
        }
      }
      const terminalRepeats = Object.values(calibration).map(x => x?.repeats);
      if (terminalRepeats.every(repeatsValid) && blockRows.some(r => r.repeats !== Math.max(...terminalRepeats))) {
        blockReasons.push('inconsistent fixed repeat count');
      }
    }
    rowReasons.push(...blockReasons);
    if (paired.length !== (kind === 'warm' ? 6 : 1)) continue;
    blocks.push({ block, belowFloor, drift, calibration, reasons: reasons(blockReasons),
      pairedObservations: paired, comparisons: Object.fromEntries(Object.keys(contrasts).map(name => [name, {
        logRatio: median(paired.map(x => x[name].logRatio)), deltaNs: median(paired.map(x => x[name].deltaNs)),
      }])) });
  }
  const comparisons = Object.fromEntries(Object.keys(contrasts).map(name => {
    const blockLogRatios = blocks.map(b => b.comparisons[name].logRatio), blockDeltaNs = blocks.map(b => b.comparisons[name].deltaNs);
    const ratios = interval(blockLogRatios), deltas = interval(blockDeltaNs);
    return [name, { geometricRatio: ratios ? Math.exp(ratios.mean) : null,
      descriptive95Percent: ratios?.bounds.map(Math.exp) ?? null,
      meanDeltaNs: deltas?.mean ?? null, descriptive95PercentDeltaNs: deltas?.bounds ?? null,
      blockLogRatios, blockDeltaNs, medianDeltaNs: blocks.length ? median(blockDeltaNs) : null }];
  }));
  if (blocks.length !== 8) rowReasons.push('incomplete blocks');
  for (const name of ['main-A/A', 'candidate-A/A']) {
    const comparison = comparisons[name], ci = comparison.descriptive95Percent;
    const bounds = kind === 'warm' ? [lowerMargin, upperMargin] : [0.9, 1.1];
    const pointOutsideMargin = ci ? comparison.geometricRatio < bounds[0] || comparison.geometricRatio > bounds[1] : null;
    const intervalExcludesOne = ci ? ci[0] > 1 || ci[1] < 1 : null;
    const imbalance = ci ? (kind === 'warm' ? pointOutsideMargin && intervalExcludesOne : pointOutsideMargin || intervalExcludesOne) : null;
    const uncertain = ci ? !imbalance && (ci[0] < bounds[0] || ci[1] > bounds[1]) : null;
    comparison.aaControl = { bounds, pointOutsideMargin, intervalExcludesOne, imbalance, uncertain,
      status: !ci ? 'incomplete-control' : imbalance ? 'imbalance' : uncertain ? 'uncertain-control'
        : intervalExcludesOne ? 'detectable-nonmaterial-control' : 'parity-compatible-control',
      rule: kind === 'warm' ? 'point outside multiplicative 2% margin AND 95% CI excludes 1'
        : 'point outside [0.9, 1.1] OR 95% CI excludes 1', biasCorrectionApplied: false };
    if (imbalance) rowReasons.push(name + ' imbalance');
  }
  const allReasons = reasons([...campaignReasons, ...rowReasons]), dataQualityValid = allReasons.length === 0;
  if (kind === 'warm') {
    const comparison = comparisons['candidate/main'], ci = comparison.descriptive95Percent;
    comparison.warmMateriality = { margin: design.warmMaterialityMargin, bounds: [lowerMargin, upperMargin],
      pointRegion: comparison.geometricRatio === null ? null : comparison.geometricRatio < lowerMargin ? 'below-margin'
        : comparison.geometricRatio > upperMargin ? 'above-margin' : 'within-margin',
      status: !dataQualityValid || !ci ? 'not-interpretable-data-quality'
        : ci[1] < lowerMargin ? 'material-gain-evidence'
        : ci[0] > upperMargin ? 'material-loss-evidence'
        : ci[0] >= lowerMargin && ci[1] <= upperMargin ? 'within-margin-evidence' : 'unresolved' };
  }
  outputs.push({ kind, key, independentBlocks: blocks.length, expectedBlocks: 8, reasons: allReasons, dataQualityValid,
    inconclusive: !dataQualityValid, comparisons, blocks });
}
const summary = { complete, campaignReasons: reasons(campaignReasons), design,
  independentUnit: 'process block; never batches, aliases, workloads, or cold stages',
  ratioMeaning: 'numerator latency / denominator latency; below 1 means faster',
  pairedReduction: 'Within each warm process block, median of six paired log ratios and median of six paired absolute deltas; cold has one paired observation per block.',
  interval: { independentBlocks: 8, degreesOfFreedom: 7, studentTCritical95: tCritical },
  qualityMeaning: 'Validity is separate from effect materiality. Incomplete controller or invalid data prevents interpretation; retained intervals remain descriptive only.',
  coldMeaning: 'Absolute paired deltas and descriptive intervals are retained for every contrast, including A/A; no percentage-only cold materiality threshold.',
  intervalWarning: 'Small-sample descriptive paired-log and paired-absolute-delta Student-t intervals; not simultaneous confidence, stable machine replication, or an adoption gate.',
  biasCorrectionApplied: false, rows: outputs, allRawRows: raw.length, rawObservations };
writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ complete, rows: outputs.length, inconclusive: outputs.filter(x => x.inconclusive).length,
  campaignReasons: summary.campaignReasons }));
