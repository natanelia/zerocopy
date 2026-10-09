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
      aaDiagnostics[arm] = {interval, individualBlockRatios: aa[arm].map(Math.exp), flagged, design: 'within-quartet repeated-arm roles; not an independent A/A experiment', twoPercentEquivalence: interval.low >= 1/1.02 && interval.high <= 1.02};
      if (flagged) flags.push(`${arm} A/A drift or >5% block discrepancy`);
    }
  }
  cells.push({runtime, case: spec.id, operation: spec.operation, role: spec.role, itemsPerOperation: spec.itemsPerOperation, units: spec.unit, baseline: absolute.baseline.length ? summary(absolute.baseline) : null, candidate: absolute.candidate.length ? summary(absolute.candidate) : null, blockLogs, pointwise95PercentInterval: interval, aaDiagnostics, flags, decision: interval ? pointwiseDecision(interval, protocol.statistics, flags.length === 0) : 'inconclusive: fewer than four complete original blocks', processResults});
}
const materialLossCells = cells.filter(cell => cell.decision === 'material loss supported in this cell').map(cell => ({runtime:cell.runtime,case:cell.case}));
const primaryGainCells = cells.filter(cell => cell.role === 'primary' && cell.decision === 'worthwhile gain supported in this cell').map(cell => ({runtime:cell.runtime,case:cell.case}));
const inconclusiveCells = cells.filter(cell => cell.decision.startsWith('inconclusive')).map(cell => ({runtime:cell.runtime,case:cell.case}));
const historicalLimitations = {
  baselineCommit: 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad',
  candidateCommit: '2ee42fdac4020d637d9909db25297ba978b0aeaa',
  fullSuites: {defaultTestTimeoutMs: 5000, baseline: {passed: 770, total: 774, timeouts: 4}, candidate: {passed: 758, total: 774, timeouts: 16}, resolved: false},
  freshGatesDoNotResolveHistoricalFailures: true,
  focusedEvidenceDoesNotReplaceFullGates: true,
  rejectedAllocationFixture: 'Failure occurs before batchAt; it does not test a mid-recursion trap, complete transactional allocation rollback, or recovery after every possible trap.',
  partialCompactionRows: {count: 5, recorded: ['size', 'order'], notRecorded: ['root hashes', 'payload hashes'], laterFixturesDoNotExpandHistoricalCoverage: true},
  unicodeRegression: 'Map equality checks normalization and last values, not iteration order; separate differential ordered-entry digests check order.',
  mechanism: 'The 256-to-64-byte fill requests 192 fewer initialization byte positions per qualifying partition. It does not establish latency, throughput, physical-store count, total bandwidth, allocation, retained heap, backing-buffer or RSS savings.',
  historicalUnperformed: ['browser-engine runs', 'a complete new all-green full suite', 'package publication check', 'latency study'],
  retainedCorrectedPreparationFailures: ['missing declaration output before initial baseline Redux/typed-values checks', 'initial diagnostic WAT import order and consequent missing observer binary', 'initial Git commit attempt without author identity'],
  experimentalScope: 'Selected Linux x64 Node/Bun cells and pointwise intervals; no universal, simultaneous-confidence, browser/ARM or physical-memory conclusion.'
};
const memoryReporting = {
  sampledSubjectRss: {unit: 'bytes', meaning: 'Maximum of subject samples; not an exact peak'},
  sampledControllerRss: {unit: 'bytes', meaning: 'Maximum of controller samples; not an exact peak'},
  arenaCapacity: {unit: 'bytes', meaning: 'Per-Arena backing capacity; not a sum or physical-memory cap'},
  resourceUsageMaxRSS: {api: 'process.resourceUsage().maxRSS', platform: 'linux', unit: 'KiB', bytesPerUnit: 1024,
    runtimes: {node: 'v22.23.3', bun: '1.4.2'}, meaning: 'Process-reported high-water RSS; separate from sampled RSS and Arena capacity'}
};
const screenDecision = materialLossCells.length ? 'No promotion: at least one supported material loss' : primaryGainCells.length ? 'Useful primary lead; selected inconclusive controls remain unresolved and promotion is not authorized' : 'Weak or inconclusive: no clean primary 5% gain; screen ends without promotion';
const result = {scope: protocol.purpose, historicalLimitations, memoryReporting, screenDecision, materialLossCells, primaryGainCells, inconclusiveCells, runAdmission: {complete: runAdmitted, ledgerStatus: ledger.status, finalVerification: ledger.verificationAfter ?? null, deadline: ledger.deadline ?? null}, admission: JSON.parse(readFileSync(new URL('./admission.json', import.meta.url), 'utf8')), interpretation: 'Candidate/baseline latency ratio; smaller is faster. Four process blocks, not individual chunks, are inferential units. Intervals are pointwise and exploratory, with no multiplicity or cross-platform assurance. Admission metadata records fresh exact-arm gates separately from the immutable historical batch-clear failures and coverage limits; a later pass does not erase those original limitations. This exploratory x64 screen alone cannot authorize PR promotion, browser or ARM claims. Incomplete whole-run admission or absent final source verification blocks supported cell conclusions while retaining original ratios and evidence. Original failures and diagnostics remain visible; no outcome-driven reruns.', cells};
writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify(result, null, 2)+'\n', {flag: 'wx'});
console.log(JSON.stringify({cells: cells.length, analysis: path.join(directory, 'analysis.json')}));
