/** Fixed process-pair analysis. Serial blocks are never independent replicates. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { median, summary } from './math.mjs';

export function interval(ratios, critical) {
  const s = summary(ratios.map(Math.log)), radius = critical * s.sd / Math.sqrt(ratios.length);
  return { n: ratios.length, df: ratios.length - 1, ratio: Math.exp(s.mean), low: Math.exp(s.mean - radius), high: Math.exp(s.mean + radius), meanLog: s.mean, sdLog: s.sd };
}
const logicalKeys = ['stage', 'block', 'epochBefore', 'epochAfter', 'phase', 'startPhase', 'size', 'calls', 'logical', 'retainedLogical', 'seedLogical', 'freshReaderVerified'];
const logicalRow = row => Object.fromEntries(logicalKeys.map(key => [key, row[key]]));
export function validateReport(report, slot, spec, matrix) {
  for (const [key, value] of Object.entries({ cell: slot.case, label: slot.label, pair: slot.pairIndex, kind: slot.pairKind, runtime: slot.runtime })) assert.equal(report[key], value, key);
  assert.equal(report.complete, true); assert.equal(report.failure, null);
  assert.equal(report.warmups, matrix.warmups); assert.equal(report.measuredSamples, matrix.measuredSamples);
  if (slot.runtime === 'node') { assert.equal(report.versions.node, '22.23.3'); assert.equal(report.versions.bun, undefined); }
  else assert.equal(report.versions.bun, '1.4.2');
  assert.equal(report.rows.length, 30);
  report.rows.forEach((row, block) => {
    assert(Object.values(row).every(v => v === null || ['string', 'number', 'boolean'].includes(typeof v)));
    assert.equal(row.block, block); assert.equal(row.stage, block < 20 ? 'warmup' : 'measured');
    assert(row.verified && row.errorName === null && row.errorMessage === null);
    assert.equal(row.freshReaderVerified, true);
    assert(Number.isFinite(row.ms) && row.ms > 0); assert.equal(row.calls, spec.callsPerSample);
    assert.equal(row.epochBefore, block * spec.callsPerSample); assert.equal(row.epochAfter, (block + 1) * spec.callsPerSample);
    assert.equal(row.phase, (row.epochAfter - 1) % spec.updatePhases);
    assert.equal(row.startPhase, spec.regime === 'fresh-creation' || block === 0 ? -1 : (row.epochBefore - 1) % spec.updatePhases);
    assert.equal(row.size, spec.regime === 'fresh-creation' ? spec.count : spec.seedCount);
    for (const key of ['logical', 'retainedLogical', 'seedLogical']) assert.match(row[key], /^[a-f0-9]{64}$/);
    for (const key of ['beforeUsed', 'used', 'beforeBacking', 'backing']) assert(Number.isSafeInteger(row[key]) && row[key] >= 65536);
    assert(row.used >= row.beforeUsed && row.used <= row.backing && row.beforeUsed <= row.beforeBacking);
    assert(row.backing >= row.beforeBacking && row.backing <= matrix.maximumObservedWasmBackingBytes);
    assert.equal(row.backing % 65536, 0); assert.equal(row.beforeBacking % 65536, 0);
    assert.equal(row.usedIncrement, row.used - row.beforeUsed); assert.equal(row.copySpanBytes, row.used); assert.equal(row.grew, row.backing > row.beforeBacking);
    if (spec.regime === 'fresh-creation') { assert.equal(row.beforeUsed, 65536); assert.equal(row.beforeBacking, 131072); }
    else if (block) { assert.equal(row.beforeUsed, report.rows[block - 1].used); assert.equal(row.beforeBacking, report.rows[block - 1].backing); }
  });
  const measured = report.rows.slice(20).map(row => row.ms);
  return { medianMs: median(measured), medianMsPerCall: median(measured) / spec.callsPerSample,
    minimumRawBlockMs: Math.min(...report.rows.map(row => row.ms)), minimumMeasuredBlockMs: Math.min(...measured),
    earlyMedianMs: median(measured.slice(0, 5)), lateMedianMs: median(measured.slice(5)), short: median(measured) < 0.1 };
}

export function analyze(observations, schedule, matrix) {
  assert.equal(observations.length, 80); assert.equal(schedule.length, 80);
  const processes = [], pairs = [], flags = [], groups = new Map(), aaByEngine = { node: [], bun: [] };
  for (let i = 0; i < 80; i += 2) {
    const two = [i, i + 1].map(index => {
      const slot = schedule[index], report = observations[index], spec = matrix.cells.find(c => c.id === slot.case);
      const stats = validateReport(report, slot, spec, matrix);
      processes.push({ id: slot.id, runtime: slot.runtime, cell: slot.case, label: slot.label, kind: slot.pairKind, pair: slot.pairIndex, ...stats,
        allocationByEpoch: report.rows.map(({ block, stage, epochAfter, beforeUsed, used, usedIncrement, beforeBacking, backing, grew, copySpanBytes }) => ({ block, stage, epochAfter, beforeUsed, used, usedIncrement, beforeBacking, backing, grew, copySpanBytes })) });
      if (stats.short) flags.push({ kind: 'short-interval', runtime: slot.runtime, cell: slot.case, process: slot.id, engineDiagnostic: slot.pairKind === 'aa' });
      return { slot, report, spec, stats };
    });
    const [x, y] = two;
    for (const key of ['runtime', 'case', 'pairKind', 'pairIndex']) assert.equal(x.slot[key], y.slot[key]);
    assert.deepEqual(x.report.rows.map(logicalRow), y.report.rows.map(logicalRow), 'Paired logical/history mismatch');
    const leftLabel = x.slot.pairKind === 'aa' ? 'left' : 'baseline', rightLabel = x.slot.pairKind === 'aa' ? 'right' : 'candidate';
    const left = two.find(r => r.slot.label === leftLabel), right = two.find(r => r.slot.label === rightLabel); assert(left && right);
    const r = { runtime: x.slot.runtime, cell: x.slot.case, kind: x.slot.pairKind, pair: x.slot.pairIndex,
      leftMedianMs: left.stats.medianMs, rightMedianMs: right.stats.medianMs, ratio: right.stats.medianMs / left.stats.medianMs,
      earlyRatio: right.stats.earlyMedianMs / left.stats.earlyMedianMs, lateRatio: right.stats.lateMedianMs / left.stats.lateMedianMs };
    r.trajectoryRatio = r.lateRatio / r.earlyRatio; pairs.push(r);
    if (r.kind === 'aa') {
      aaByEngine[r.runtime].push(r);
      if (Math.abs(Math.log(r.ratio)) > Math.log(1.02)) flags.push({ ...r, kind: 'aa-noise' });
    } else { const key = `${r.runtime}/${r.cell}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
  }
  for (const runtime of ['node', 'bun']) assert.equal(aaByEngine[runtime].length, 2);
  const cells = [];
  for (const spec of matrix.cells) for (const [runtime, count] of Object.entries(spec.abPairs)) {
    const group = groups.get(`${runtime}/${spec.id}`); assert.equal(group?.length, count);
    assert.deepEqual(group.map(r => r.pair).sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i));
    const ratios = group.map(r => r.ratio), result = { runtime, cell: spec.id, role: spec.role, ratios, range: [Math.min(...ratios), Math.max(...ratios)], pairs: group,
      aaLogDeviations: aaByEngine[runtime].map(r => ({ cell: r.cell, logRatio: Math.log(r.ratio) })), repeatedAdverse: ratios.every(r => r > 1) };
    if (spec.role === 'primary') {
      result.interval = interval(ratios, matrix.analysis.t975[runtime]);
      result.supportedMaterialLoss = result.interval.low > 1.02;
      result.supportedAdverseEffect = result.interval.low > 1;
      result.supportedSubMaterialSlowdown = result.interval.low > 1 && result.interval.high < 1.02;
      const up = group.filter(r => Math.log(r.trajectoryRatio) > Math.log(1.02)).length;
      const down = group.filter(r => Math.log(r.trajectoryRatio) < -Math.log(1.02)).length;
      result.trajectory = { up, down, threshold: matrix.analysis.trajectorySameDirectionPairCount[runtime] };
      if (up >= result.trajectory.threshold || down >= result.trajectory.threshold) flags.push({ kind: 'trajectory-sensitive', runtime, cell: spec.id, ...result.trajectory });
    } else if (ratios.every(r => r > 1.02) || (spec.control && ratios.every(r => r < 1 / 1.02))) flags.push({ kind: 'secondary-or-control', runtime, cell: spec.id, ratios });
    cells.push(result);
  }
  assert.equal(cells.filter(c => c.role === 'primary').length, 4);
  const primary = cells.filter(c => c.role === 'primary');
  const classification = primary.some(c => c.supportedMaterialLoss) ? 'supported-material-loss'
    : flags.length || primary.some(c => c.interval.high >= 1.02) ? 'inconclusive' : 'strong-primary-margin-pass';
  return { complete: true, classification, model: matrix.analysis, flags, cells, pairs, processes,
    secondaryCaveat: 'Eight Node secondary/control cells have only two process pairs; no general regression clearance.',
    decisionLayer: matrix.analysis.decisionLayer };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [canonicalArg, output] = process.argv.slice(2), data = JSON.parse(readFileSync(canonicalArg, 'utf8'));
  const result = analyze(data.observations, data.schedule, data.matrix);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ classification: result.classification, processes: result.processes.length, primary: 4, flags: result.flags.length }));
}
