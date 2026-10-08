/** Repeated balanced ABBA/BAAB blocks in isolated, source-guarded processes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_COMMIT, manifest, sha256, sourceGuard } from './worker-arena-source-guard.mjs';

const [baselineArg, candidateArg, outputArg] = process.argv.slice(2);
if (!baselineArg || !candidateArg || !outputArg) throw new Error('Usage: CANDIDATE_SHA=<full SHA> node proofs/run-worker-arenas.mjs BASELINE_CHECKOUT CANDIDATE_CHECKOUT OUTPUT_DIRECTORY');
const baseline = resolve(baselineArg), candidate = resolve(candidateArg), output = resolve(outputArg);
const counts = (process.env.ARENA_COUNTS ?? '1,2,12,32,512').split(',').map(Number);
const runtimes = (process.env.ARENA_RUNTIMES ?? 'node,bun').split(',');
const blocks = Number(process.env.ARENA_BLOCKS ?? 4);
const samples = Number(process.env.SAMPLES ?? 7), warmups = Number(process.env.WARMUPS ?? 3), minimumBatchMs = Number(process.env.MIN_BATCH_MS ?? 10);
assert(Number.isInteger(blocks) && blocks >= 4 && blocks % 2 === 0, 'Use at least four balanced process blocks');
assert(Number.isInteger(samples) && samples >= 3 && Number.isInteger(warmups) && warmups >= 1);
assert(Number.isFinite(minimumBatchMs) && minimumBatchMs > 0);
assert(counts.every(count => Number.isInteger(count) && count > 0) && new Set(counts).size === counts.length);
assert(runtimes.every(runtime => ['node', 'bun'].includes(runtime)) && new Set(runtimes).size === runtimes.length);
const harness = fileURLToPath(new URL('./worker-arena-benchmark.mjs', import.meta.url));
const driverSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
mkdirSync(output, { recursive: true });
const proofManifest = manifest(candidate, [
  '.github/workflows/worker-arena-performance.yml', 'worker-attachment.test.ts',
  'proofs/worker-arenas.mjs', 'proofs/worker-arena-benchmark.mjs', 'proofs/run-worker-arenas.mjs',
  'proofs/worker-arena-source-guard.mjs', 'proofs/worker-arena-source-guard.test.mjs',
]);
const guard = { ...sourceGuard(baseline, candidate, process.env.CANDIDATE_SHA), proofManifest };
const guardPath = `${output}/source-guard.json`;
writeFileSync(guardPath, JSON.stringify(guard, null, 2));
assert.equal(guard.passed, true, guard.errors.join('; '));
const guardSha256 = sha256(readFileSync(guardPath));
const expectedProofHash = path => proofManifest.files.find(file => file.path === path)?.sha256;
const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const drift = (a, b) => Math.max(a / b, b / a);
const summary = {
  date: new Date().toISOString(), driverSha256, sourceGuardSha256: guardSha256,
  baselineCommit: BASELINE_COMMIT, candidateCommit: guard.candidate.commit,
  configuration: { counts, runtimes, blocks, samples, warmups, minimumBatchMs, maximumControlDrift: 1.15, balancedOrders: ['ABBA', 'BAAB'] },
  blocks: [], comparisons: [], complete: false,
};
function summarize() {
  summary.comparisons = [];
  for (const runtime of runtimes) for (const arenas of counts) for (const operation of ['attach', 'reexport', 'warmNestedRead', 'coldNestedRead']) {
    const rows = summary.blocks.filter(row => row.runtime === runtime && row.arenas === arenas && row.operation === operation);
    if (!rows.length) continue;
    const sufficient = rows.length === blocks;
    const diagnostic = operation === 'coldNestedRead';
    const adequate = rows.every(row => row.shortBatchCount === 0);
    const baselineMedians = rows.flatMap(row => [row.msPerOperation.a1, row.msPerOperation.a2]);
    const candidateMedians = rows.flatMap(row => [row.msPerOperation.b1, row.msPerOperation.b2]);
    const acrossBlockBaselineDrift = Math.max(...baselineMedians) / Math.min(...baselineMedians);
    const acrossBlockCandidateDrift = Math.max(...candidateMedians) / Math.min(...candidateMedians);
    const stable = Math.max(acrossBlockBaselineDrift, acrossBlockCandidateDrift) <= 1.15;
    summary.comparisons.push({
      runtime, arenas, operation, effectiveBlocks: rows.length, requestedBlocks: blocks,
      medianBlockRatio: diagnostic ? null : median(rows.map(row => row.candidateOverBaseline)),
      blockRatios: diagnostic ? null : rows.map(row => row.candidateOverBaseline),
      shortBatchCount: rows.reduce((sum, row) => sum + row.shortBatchCount, 0),
      acrossBlockBaselineDrift, acrossBlockCandidateDrift,
      maximumBaselineDrift: Math.max(...rows.map(row => row.baselineDrift)),
      maximumCandidateDrift: Math.max(...rows.map(row => row.candidateDrift)),
      interpretation: diagnostic ? 'diagnostic-only; no equivalence or non-regression conclusion' : !sufficient ? 'incomplete-blocks' : !adequate ? 'inconclusive-short-batches' : !stable ? 'inconclusive-control-drift' : 'eligible-for-review; not automatic performance acceptance',
    });
  }
  writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
}
for (const runtime of runtimes) for (const count of counts) for (let block = 0; block < blocks; block++) {
  const sequence = block % 2 === 0 ? ['a1', 'b1', 'b2', 'a2'] : ['b1', 'a1', 'a2', 'b2'];
  const runs = {};
  for (const label of sequence) {
    const variant = label.startsWith('a') ? 'baseline' : 'candidate';
    const checkout = variant === 'baseline' ? baseline : candidate;
    const command = ['--expose-gc', harness, checkout, String(count)];
    const result = spawnSync(runtime, command, {
      encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, SAMPLES: String(samples), WARMUPS: String(warmups), MIN_BATCH_MS: String(minimumBatchMs), ARENA_SOURCE_GUARD: guardPath, ARENA_VARIANT: variant, MODE: 'timing-and-memory' },
    });
    const file = `${output}/${runtime}-${count}-block${block + 1}-${label}`;
    writeFileSync(`${file}.stdout`, result.stdout ?? '');
    writeFileSync(`${file}.stderr`, result.stderr ?? '');
    if (result.status !== 0) throw new Error(`${runtime} ${count} block${block + 1} ${label} failed: ${result.error?.message ?? result.status}; see ${file}.stderr`);
    runs[label] = JSON.parse(result.stdout);
    writeFileSync(`${file}.json`, JSON.stringify({ ...runs[label], command: [runtime, ...command], driverSha256, block: block + 1, sequence }, null, 2));
    assert.equal(runs[label].metadata.sourceGuardSha256, guardSha256);
    assert.equal(runs[label].metadata.harnessSha256, expectedProofHash('proofs/worker-arena-benchmark.mjs'));
    assert.equal(runs[label].metadata.sourceGuardModuleSha256, expectedProofHash('proofs/worker-arena-source-guard.mjs'));
    assert.equal(runs[label].configuration.explicitGcAvailable, true);
    assert.deepEqual(runs[label].rows.map(row => row.name), ['attach', 'reexport', 'warmNestedRead', 'coldNestedRead']);
    assert.equal(runs[label].metadata.commit, guard[variant].commit);
    assert.equal(runs[label].configuration.samples, samples);
    assert.equal(runs[label].configuration.warmups, warmups);
    assert.equal(runs[label].dependencySets, variant === 'baseline' ? count * count : count);
    assert.equal(runs[label].traversedArenaValues, variant === 'baseline' ? count * count : count);
    for (const row of runs[label].rows) {
      assert.equal(row.effectiveSamples, samples); assert.equal(row.effectiveWarmups, warmups);
      assert.equal(row.measured.length, samples); assert.equal(row.warmup.length, warmups);
      for (const batch of [...row.warmup, ...row.measured]) {
        assert(Number.isFinite(batch.elapsedMs) && batch.elapsedMs > 0 && batch.iterations === row.iterations);
        assert.equal(batch.shortBatch, batch.elapsedMs < minimumBatchMs);
      }
    }
  }
  for (let index = 0; index < runs.a1.rows.length; index++) {
    const operation = runs.a1.rows[index].name;
    const medians = Object.fromEntries(Object.entries(runs).map(([label, run]) => [label, median(run.rows[index].samples)]));
    summary.blocks.push({
      runtime, arenas: count, operation, block: block + 1, order: sequence.map(label => label[0].toUpperCase()).join(''),
      msPerOperation: medians, candidateOverBaseline: operation === 'coldNestedRead' ? null : Math.sqrt((medians.b1 / medians.a1) * (medians.b2 / medians.a2)),
      baselineDrift: drift(medians.a1, medians.a2), candidateDrift: drift(medians.b1, medians.b2),
      shortBatchCount: Object.values(runs).reduce((sum, run) => sum + run.rows[index].shortBatchCount, 0),
    });
  }
  summarize();
  console.log(`${runtime}: ${count} arenas, ${block + 1}/${blocks} balanced blocks retained`);
}
const finalGuard = { ...sourceGuard(baseline, candidate, process.env.CANDIDATE_SHA), proofManifest: manifest(candidate, proofManifest.files.map(file => file.path)) };
writeFileSync(`${output}/source-guard-after.json`, JSON.stringify(finalGuard, null, 2));
assert.equal(finalGuard.passed, true, finalGuard.errors.join('; '));
assert.equal(finalGuard.baseline.source.sha256, guard.baseline.source.sha256);
assert.equal(finalGuard.candidate.source.sha256, guard.candidate.source.sha256);
assert.equal(finalGuard.baseline.build.sha256, guard.baseline.build.sha256);
assert.equal(finalGuard.candidate.build.sha256, guard.candidate.build.sha256);
assert.equal(finalGuard.proofManifest.sha256, proofManifest.sha256);
summary.complete = true;
summarize();
