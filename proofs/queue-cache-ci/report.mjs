import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {median, summary, logInterval, pointwiseDecision, hasCompleteReplicates} from './math.mjs';

const directory = path.resolve(process.argv[2]);
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(path.join(directory, 'ledger.json'), 'utf8'));
assert.equal(ledger.mode, 'run', 'Untimed fixtures have no latency report');
const runAdmitted = ledger.status === 'complete' && ledger.verificationAfter?.ok === true && !ledger.deadline && !ledger.fatalOwnedProcess;
const sha = text => createHash('sha256').update(text).digest('hex');
assert.equal(ledger.manifestSha256, sha(readFileSync(new URL('./manifest.json', import.meta.url))));
const records = new Map();
for (const slot of ledger.slots) {
  if (slot.status !== 'complete') continue;
  const bytes = readFileSync(path.join(directory, `${slot.id}.stdout.jsonl`));
  assert.equal(sha(bytes), slot.stdoutSha256);
  records.set(slot.id, bytes.toString().trim().split('\n').map(x => JSON.parse(x)));
}
const cells = [];
for (const runtime of protocol.runtimes) for (const spec of protocol.cases) {
  const blockLogs = [], aa = {baseline: [], candidate: []}, absolute = {baseline: [], candidate: []};
  const flags = runAdmitted ? [] : ['whole-run admission incomplete or final source verification absent'], processResults = [];
  for (let block = 0; block < protocol.blocks; block++) {
    const medians = {baseline: [], candidate: []};
    for (const slot of ledger.slots.filter(x => x.runtime === runtime && x.block === block)) {
      const rows = records.get(slot.id);
      if (!rows) { flags.push(`failed/missing original slot ${slot.id}`); continue; }
      const entry = rows.find(x => x.kind === 'case' && x.case === spec.id);
      const diagnostic = rows.find(x => x.kind === 'diagnostics' && x.case === spec.id);
      assert(entry && diagnostic);
      const samples = entry.rows.filter(x => x.phase === 'measurement');
      assert.equal(samples.length, protocol.measurement.samples);
      const stats = summary(samples.map(x => x.nsPerOperation));
      absolute[slot.arm].push(stats.median); medians[slot.arm][slot.replicate] = stats.median;
      processResults.push({slot: slot.id, block, arm: slot.arm, replicate: slot.replicate, stats, individualDurationsMs: samples.map(x => x.durationMs), operations: samples[0].operations, diagnostic});
      for (const f of ['calibrationFloor', 'calibrationWarmupFlag', 'minimumDurationFloor', 'insufficientWarmup', 'warmupFlag', 'variabilityFlag']) if (diagnostic[f]) flags.push(`${slot.id}: ${f}`);
    }
    if (hasCompleteReplicates(medians)) {
      blockLogs.push((Math.log(medians.candidate[0]) + Math.log(medians.candidate[1]) - Math.log(medians.baseline[0]) - Math.log(medians.baseline[1])) / 2);
      for (const arm of ['baseline', 'candidate']) aa[arm].push(Math.log(medians[arm][1] / medians[arm][0]));
    }
  }
  const interval = blockLogs.length === protocol.blocks ? logInterval(blockLogs, protocol.statistics.tCritical) : null;
  const aaDiagnostics = {};
  for (const arm of ['baseline', 'candidate']) {
    if (aa[arm].length === protocol.blocks) {
      const interval = logInterval(aa[arm], protocol.statistics.tCritical);
      const threshold = Math.log(1 + protocol.statistics.aaDiagnosticFraction);
      const flagged = aa[arm].some(x => Math.abs(x) > threshold) || interval.low > 1 || interval.high < 1;
      aaDiagnostics[arm] = {interval, individualBlockRatios: aa[arm].map(Math.exp), flagged};
      if (flagged) flags.push(`${arm} A/A drift or >5% block discrepancy`);
    }
  }
  cells.push({runtime, case: spec.id, operation: spec.operation, units: spec.unit, itemsPerOperation: spec.itemsPerOperation, baseline: absolute.baseline.length ? summary(absolute.baseline) : null, candidate: absolute.candidate.length ? summary(absolute.candidate) : null, blockLogs, pointwise95PercentInterval: interval, aaDiagnostics, flags, decision: interval ? pointwiseDecision(interval, protocol.statistics, flags.length === 0) : 'inconclusive: fewer than four complete original blocks', processResults});
}
const result = {scope: protocol.purpose, runAdmission: {complete: runAdmitted, ledgerStatus: ledger.status, finalVerification: ledger.verificationAfter ?? null, deadline: ledger.deadline ?? null}, admission: JSON.parse(readFileSync(new URL('./admission.json', import.meta.url), 'utf8')), interpretation: 'Candidate/baseline latency ratio; smaller is faster. Four process blocks, not individual chunks, are inferential units. Intervals are pointwise and exploratory, with no multiplicity or cross-platform assurance. Fresh exact-source baseline and candidate standard gates passed before this screen; the historical focused evidence is separate. This exploratory x64 screen alone cannot authorize PR promotion, browser or ARM claims. Incomplete whole-run admission or absent final source verification blocks supported cell conclusions while retaining original ratios and evidence. Original failures and diagnostics remain visible; no outcome-driven reruns.', cells};
writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify(result, null, 2)+'\n', {flag: 'wx'});
console.log(JSON.stringify({cells: cells.length, analysis: path.join(directory, 'analysis.json')}));
