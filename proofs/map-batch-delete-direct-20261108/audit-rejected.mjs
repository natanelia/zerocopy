import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { study } from './workloads.mjs';

// This verifies a rejected, cancelled experiment. It never collects timings,
// completes the partial study, or treats missing A/A/reference runs as passed.
const folder = dirname(fileURLToPath(import.meta.url));
const archive = join(folder, 'validation/attempt1');
const candidate = resolve(process.argv[2] ?? join(folder, '../..'));
const baseline = process.argv[3] && resolve(process.argv[3]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => {
  const bytes = readFileSync(path);
  return path.endsWith('.gz') ? gunzipSync(bytes) : bytes;
};
const json = path => JSON.parse(read(path).toString('utf8'));
const median = xs => {
  const values = [...xs].sort((a, b) => a - b), center = (values.length - 1) / 2;
  return (values[Math.floor(center)] + values[Math.ceil(center)]) / 2;
};
const near = (actual, expected) => assert.ok(
  Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-10), `${actual} != ${expected}`);
const provenance = json(join(archive, 'provenance.json'));
assert.equal(provenance.runId, 42495937874);
assert.equal(provenance.jobId, 128778192941);
assert.equal(provenance.artifactId, 13625657254);
assert.equal(provenance.artifactZipSha256, 'c37be353f9a48f2044bf4b925df2e93a26c7839fa0c3cb08eff6c30584f9630d');
for (const file of provenance.retainedFiles) {
  assert.ok(!file.retained.startsWith('/') && !file.retained.split('/').includes('..'));
  const path = join(archive, file.retained), bytes = readFileSync(path), original = read(path);
  assert.equal(bytes.length, file.retainedBytes);
  assert.equal(digest(bytes), file.retainedSha256, file.retained);
  assert.equal(original.length, file.originalBytes);
  assert.equal(digest(original), file.originalSha256, file.retained);
}
const metadata = json(join(archive, 'github-metadata.json'));
assert.equal(metadata.run.id, provenance.runId);
assert.equal(metadata.run.conclusion, 'cancelled');
assert.equal(metadata.run.head_sha, provenance.headSha);
assert.equal(metadata.jobs.jobs[0].conclusion, 'cancelled');
assert.equal(metadata.artifacts.artifacts[0].digest, `sha256:${provenance.artifactZipSha256}`);
const pilotPath = join(archive, 'results/pilot-v3.json.gz');
const partialPath = join(archive, 'results/formal.json.gz');
const pilot = json(pilotPath), partial = json(partialPath);
const originalPilotPath = join(folder, 'results/pilot.json.gz');
assert.equal(digest(read(originalPilotPath)), digest(read(join(archive, 'results/pilot.json.gz'))));
const verify = (path, root) => JSON.parse(execFileSync(process.execPath,
  [join(folder, 'verify.mjs'), path, ...(root ? [root] : [])], { encoding: 'utf8' }));
const oldPilotCheck = verify(originalPilotPath);
const pilotCheck = verify(pilotPath, candidate);
assert.equal(pilotCheck.processes, 64);
assert.equal(pilot.mode, 'pilot');
assert.equal(pilot.source.after.commit, provenance.headSha);
assert.equal(pilot.source.before.commit, study.baseline);
assert.deepEqual(pilot.study, study);
assert.equal(partial.status, 'running');
assert.equal(partial.mode, 'formal');
assert.ok(!('completedAt' in partial) && !('failure' in partial));
assert.equal(partial.runs.length, 331);
assert.equal(partial.method.pairs, 6);
assert.equal(partial.method.minimumWarmupMs, 500);
assert.equal(partial.method.minimumWarmupBatches, 8);
assert.equal(partial.method.samples, 9);
assert.deepEqual(partial.method.cases, study.cases);
for (const field of ['schema', 'study', 'source', 'snapshots', 'driver', 'workload']) {
  assert.deepEqual(partial[field], pilot[field], field);
}
if (baseline) {
  for (const [field, directory] of [['sources', baseline], ['wasm', baseline], ['bundles', join(baseline, 'dist')]]) {
    for (const [name, hash] of Object.entries(pilot.source.before[field])) {
      assert.equal(digest(readFileSync(join(directory, name))), hash, name);
    }
  }
}
for (const name of ['aa', 'reference-comparison']) {
  assert.ok(!existsSync(join(archive, `results/${name}.json`)) && !existsSync(join(archive, `results/${name}.json.gz`)));
  assert.equal(provenance.studyStatus[name].status, 'not started');
}
const schedule = [];
for (let pair = 0; pair < 6; pair++) {
  for (const runtime of pair % 2 ? ['bun', 'node'] : ['node', 'bun']) {
    for (const spec of pair % 2 ? [...study.cases].reverse() : study.cases) {
      for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        schedule.push({ pair, runtime, caseName: spec.name, variant });
      }
    }
  }
}
assert.deepEqual(partial.runs.map(({ pair, runtime, caseName, variant }) => ({ pair, runtime, caseName, variant })), schedule.slice(0, 331));
const independent = json(join(archive, 'independent-review.partial.json'));
assert.equal(independent.passedAvailableRecordChecks, true);
assert.equal(independent.completeStudy, false);
assert.equal(independent.retimed, false);
assert.equal(independent.recordSha256['formal.json'], digest(read(partialPath)));
assert.equal(independent.recordSha256['pilot-v3.json'], digest(read(pilotPath)));
assert.equal(independent.independentScriptSha256, digest(readFileSync(join(folder, 'validation/independent-review.py'))));
assert.equal(independent.partialAuditSha256, digest(readFileSync(join(archive, 'audit-partial.py'))));
let outputs = 0, measuredBelow2ms = 0, previousEnd = Date.parse(partial.startedAt);
for (const run of partial.runs) {
  const spec = study.cases.find(row => row.name === run.caseName);
  const fixture = independent.independentlyReconstructedFixtures.find(row => row.name === run.caseName);
  assert.deepEqual(run.spec, spec);
  assert.equal(run.expectedDigest, fixture.expectedDigest);
  assert.equal(run.fixture.resultCount, fixture.resultCount);
  assert.equal(run.fixture.sourceConstruction, fixture.sourceConstruction);
  assert.equal(run.affinity, partial.host.affinity);
  assert.equal(run.stderr, '');
  assert.equal(run.executable, partial.method.runtimes[run.runtime]);
  assert.ok(run.warmupBatchMs.length >= 8 && run.warmupBatchMs.reduce((a, b) => a + b, 0) >= 500);
  assert.equal(run.sampleBatchMs.length, 9);
  const all = [...run.warmupBatchMs, ...run.sampleBatchMs];
  assert.ok(all.every(value => Number.isFinite(value) && value > 0));
  near(run.medianMs, median(run.sampleBatchMs) / spec.repetitions);
  assert.equal(run.verifiedOutputs, all.length * spec.repetitions);
  const start = Date.parse(run.startedAt), end = Date.parse(run.completedAt);
  assert.ok(start >= previousEnd && end >= start && all.reduce((a, b) => a + b, 0) <= end - start + 1);
  previousEnd = end;
  assert.equal(run.batchTiming.measuredBelow2ms, run.sampleBatchMs.filter(value => value < 2).length);
  assert.equal(run.batchTiming.warmupBelow2ms, run.warmupBatchMs.filter(value => value < 2).length);
  near(run.batchTiming.minimumMeasuredMs, Math.min(...run.sampleBatchMs));
  near(run.batchTiming.minimumObservedMs, Math.min(...all));
  outputs += run.verifiedOutputs; measuredBelow2ms += run.batchTiming.measuredBelow2ms;
}
assert.equal(partial.summary.length, 36);
for (const row of partial.summary) {
  const points = [];
  for (let pair = 0; pair < 6; pair++) {
    const selected = variant => partial.runs.find(run => run.pair === pair && run.runtime === row.runtime && run.caseName === row.name && run.variant === variant);
    const before = selected('before'), after = selected('after');
    if (!before || !after) continue;
    assert.deepEqual(before.fixture, after.fixture);
    assert.deepEqual(before.versions, after.versions);
    assert.equal(before.expectedDigest, after.expectedDigest);
    points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
  }
  assert.deepEqual(row.points, points);
  assert.equal(row.interval95, null, 'The incomplete study has no final intervals');
  near(row.beforeMs, median(points.map(point => point.before)));
  near(row.afterMs, median(points.map(point => point.after)));
  near(row.pairedRatio, Math.exp(points.reduce((sum, point) => sum + Math.log(point.ratio), 0) / points.length));
  assert.equal(row.fasterPairs, points.filter(point => point.ratio < 1).length);
  const audited = independent.partialFormal.rows.find(value => value.runtime === row.runtime && value.name === row.name);
  near(audited.pairedRatio, row.pairedRatio); assert.equal(audited.completedPairs, points.length);
}
assert.equal(outputs, independent.partialFormal.verifiedOutputs);
assert.equal(measuredBelow2ms, independent.partialFormal.measuredBatchesBelow2ms);
const allocations = ['before', 'after'].map(variant => json(join(archive, `ci-logs/allocation-${variant}.json`)));
for (const [index, variant] of ['before', 'after'].entries()) {
  const record = allocations[index], identity = pilot.source[variant];
  assert.equal(record.bundleSha256, identity.bundles['shared.js']);
  for (const name of study.changedSources) assert.equal(record.sourceHashes[name], identity.sources[name]);
  assert.equal(record.sourceHashes['persistent-core.wasm'], identity.wasm['persistent-core.wasm']);
  assert.equal(record.harnessSha256, digest(readFileSync(join(folder, 'allocation.mjs'))));
  assert.equal(record.workloadSha256, pilot.workload.sha256);
}
assert.equal(allocations[0].rows.length, allocations[1].rows.length);
for (let i = 0; i < allocations[0].rows.length; i++) {
  const before = allocations[0].rows[i], after = allocations[1].rows[i];
  for (const field of ['name', 'fixtureDigest', 'sourceCount', 'submittedKeys', 'distinctRequests', 'removedKeys']) {
    assert.equal(before[field], after[field]);
  }
  for (const row of [before, after]) {
    assert.equal(row.actualBytes, row.usedAfter - row.usedBefore);
    assert.equal(row.originalBytesUnchanged, true);
  }
}
for (const file of ['chromium.json', 'workers-current-reader.json', 'workers-old-reader.json']) {
  const record = json(join(archive, 'ci-logs', file));
  assert.equal(record.passed, true); assert.deepEqual(record.results.map(row => row.copy), [false, true]);
}
console.log(JSON.stringify({ verifiedArchive: true, experiment: 'rejected', completeFormalStudy: false,
  collectedNewTimings: false, historicalCandidate: pilot.source.after.commit, exactCandidateBuild: true,
  exactBaselineBuild: Boolean(baseline), preservedV2PilotProcesses: oldPilotCheck.processes,
  completeV3PilotProcesses: pilotCheck.processes, partialFormalProcesses: partial.runs.length,
  plannedFormalProcesses: schedule.length, partialMeasuredBatches: partial.runs.length * 9,
  partialMeasuredBatchesBelow2ms: measuredBelow2ms, partialVerifiedOutputs: outputs,
  missingStages: ['101 formal processes', 'all 32 A/A processes', 'all 54 reference comparison processes'],
  allocationCases: allocations[0].rows.length, conclusion: 'Archive integrity and completed correctness checks passed; performance candidate remains rejected.' }, null, 2));
