/** Descriptive block-level comparisons. No performance acceptance or deletion. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]), dir = join(root, 'timing');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json')));
const median = values => { const a = [...values].sort((a, b) => a - b), i = a.length >> 1; return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const raw = readdirSync(dir).filter(name => name.endsWith('.jsonl')).flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return [{ kind: 'truncated-line', file: name }]; }
}));
const contrasts = { 'scalar/main': ['B', 'A'], 'simd/scalar': ['C', 'B'], 'simd/main': ['C', 'A'],
  'main-A/A': ['A1', 'A0'], 'scalar-A/A': ['B1', 'B0'], 'simd-A/A': ['C1', 'C0'] };
const logs = (values, arm) => arm.length === 1 ? mean([Math.log(values[arm + '0']), Math.log(values[arm + '1'])]) : Math.log(values[arm]);
const ns = (values, arm) => arm.length === 1 ? mean([values[arm + '0'], values[arm + '1']]) : values[arm];
function interval(samples, expected) {
  if (samples.length !== expected) return null;
  const avg = mean(samples), variance = samples.reduce((n, x) => n + (x - avg) ** 2, 0) / (samples.length - 1);
  const error = (expected === 6 ? 2.570582 : 2.364624) * Math.sqrt(variance / samples.length);
  return { mean: avg, bounds: [avg - error, avg + error] };
}
const outputs = [];
for (const kind of ['warm', 'cold']) {
  const keys = kind === 'warm' ? manifest.cases.map(x => x.id) : ['ordinary-import', 'ordinary-construction-after-import',
    'unused-query-creation', 'first-valid-query-and-access', 'first-query-and-access-on-second-memory'];
  for (const key of keys) {
    const rows = raw.filter(r => r.kind === kind && (kind === 'warm' ? r.id : r.stage) === key);
    const blocks = [];
    for (const block of [...new Set(rows.map(r => r.block))]) {
      const blockRows = rows.filter(r => r.block === block), paired = [];
      let belowFloor = false;
      for (const sample of kind === 'warm' ? [0, 1, 2, 3, 4, 5] : [undefined]) {
        const current = blockRows.filter(r => r.sample === sample);
        if (current.length !== 6) continue;
        const values = Object.fromEntries(current.map(r => [r.arm, kind === 'warm' ? r.nsPerOperation : r.elapsedNs]));
        if (new Set(current.map(r => r.arm)).size !== 6) continue;
        for (const r of current) {
          const timer = raw.find(x => x.kind === 'cold-complete' && x.arm === r.arm && x.block === r.block)?.timer;
          belowFloor ||= kind === 'warm' ? r.belowFloor : !timer || r.elapsedNs < Math.max(1000, 100 * timer.p99PairNs);
        }
        paired.push(Object.fromEntries(Object.entries(contrasts).map(([name, [a, b]]) => [name, { logRatio: logs(values, a) - logs(values, b), deltaNs: ns(values, a) - ns(values, b) }])));
      }
      if (paired.length !== (kind === 'warm' ? 6 : 1)) continue;
      const drift = {}, calibration = {};
      if (kind === 'warm') for (const arm of ['A0', 'A1', 'B0', 'B1', 'C0', 'C1']) {
        const r = blockRows.filter(x => x.arm === arm);
        drift[arm] = median(r.filter(x => x.sample >= 3).map(x => x.nsPerOperation)) / median(r.filter(x => x.sample < 3).map(x => x.nsPerOperation));
        const terminal = raw.filter(x => x.kind === 'calibration' && x.block === block && x.id === key && x.arm === arm).at(-1);
        calibration[arm] = terminal ? {
          repeats: terminal.repeats, elapsedNs: terminal.elapsedNs,
          targetReached: terminal.elapsedNs >= manifest.design.calibrationTargetNs,
          cappedBeforeTarget: terminal.repeats === manifest.design.maximumRepeats && terminal.elapsedNs < manifest.design.calibrationTargetNs,
        } : null;
      }
      blocks.push({ block, belowFloor, drift, calibration, comparisons: Object.fromEntries(Object.keys(contrasts).map(name => [name, {
        logRatio: median(paired.map(x => x[name].logRatio)), deltaNs: median(paired.map(x => x[name].deltaNs)),
      }])) });
    }
    const expectedBlocks = kind === 'warm' ? 6 : 8;
    const comparisons = Object.fromEntries(Object.keys(contrasts).map(name => {
      const blockLogRatios = blocks.map(b => b.comparisons[name].logRatio), blockDeltaNs = blocks.map(b => b.comparisons[name].deltaNs);
      const ratios = interval(blockLogRatios, expectedBlocks), deltas = interval(blockDeltaNs, expectedBlocks);
      return [name, { geometricRatio: ratios ? Math.exp(ratios.mean) : null,
        descriptive95Percent: ratios?.bounds.map(Math.exp) ?? null,
        meanDeltaNs: deltas?.mean ?? null, descriptive95PercentDeltaNs: deltas?.bounds ?? null,
        blockLogRatios, blockDeltaNs, medianDeltaNs: blocks.length ? median(blockDeltaNs) : null }];
    }));
    const reasons = [];
    if (blocks.length !== expectedBlocks) reasons.push('incomplete blocks');
    if (blocks.some(b => b.belowFloor)) reasons.push('duration/timer floor');
    if (kind === 'warm' && blocks.some(b => Object.values(b.calibration).some(x => !x))) reasons.push('missing terminal calibration');
    if (blocks.some(b => Object.values(b.calibration).some(x => x?.cappedBeforeTarget))) reasons.push('calibration capped before target');
    if (blocks.some(b => Object.values(b.calibration).some(x => x && !x.targetReached && !x.cappedBeforeTarget))) reasons.push('incomplete calibration');
    if (blocks.some(b => Object.values(b.drift).some(r => r < 0.9 || r > 1.1))) reasons.push('early/late drift >10%');
    for (const name of ['main-A/A', 'scalar-A/A', 'simd-A/A']) {
      const x = comparisons[name], ci = x.descriptive95Percent;
      if (ci && (ci[0] > 1 || ci[1] < 1 || x.geometricRatio < 0.9 || x.geometricRatio > 1.1)) reasons.push(name + ' imbalance');
    }
    const dataQualityValid = reasons.length === 0;
    if (kind === 'warm') for (const name of ['scalar/main', 'simd/scalar', 'simd/main']) {
      const ci = comparisons[name].descriptive95Percent, margin = manifest.design.warmMaterialityMargin;
      assert.equal(margin, 0.02, 'Frozen warm materiality margin must be 2%');
      comparisons[name].warmMateriality = { margin, status: !dataQualityValid || !ci ? 'not-interpretable-data-quality'
        : ci[1] < 1 - margin ? 'material-gain-evidence'
        : ci[0] > 1 + margin ? 'material-loss-evidence'
        : ci[0] >= 1 - margin && ci[1] <= 1 + margin ? 'within-margin-evidence' : 'unresolved' };
    }
    outputs.push({ kind, key, independentBlocks: blocks.length, expectedBlocks, reasons, dataQualityValid,
      inconclusive: !dataQualityValid, comparisons, blocks });
  }
}
let complete = false;
try { complete = JSON.parse(readFileSync(join(dir, 'complete.json'))).complete === true; } catch {}
const summary = { complete, independentUnit: 'process block; never batches, aliases, workloads, or cold stages',
  ratioMeaning: 'numerator latency / denominator latency; below 1 means faster',
  qualityMeaning: 'dataQualityValid/inconclusive describe data quality only; warmMateriality is a separate 2% exploratory effect assessment',
  coldMeaning: 'Absolute paired deltas and descriptive intervals plus ratios; no percentage-only cold materiality threshold',
  intervalWarning: 'Small-sample descriptive paired-log ratio and paired-absolute-delta Student-t intervals; not simultaneous confidence, stable machine replication, or an adoption gate.',
  rows: outputs, allRawRows: raw.length };
writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ complete, rows: outputs.length, inconclusive: outputs.filter(x => x.inconclusive).length }));
