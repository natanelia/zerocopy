import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, renameSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { prepareComparison, bundleManifest, sha256, median, BASELINE_COMMIT } from './block-traversal-source.mjs';
import { CASES } from './block-traversal-workloads.mjs';
export { CASES };
export const CONFIG = Object.freeze({ blocks: 4, samples: 21, targetBatchMs: 10, warmupMs: 150,
  warmupMinElements: 262144, maxWarmupMs: 10000, compactWarmupCalls: 512, compactGcEvery: 32,
  compactMaxRepeat: 2048, scanMaxRepeat: 10000000, subjectTimeoutMs: 120000,
  seed: 20261008, nonInferiorityMargin: 1.02, confidenceLevel: 0.95 });
export const MODES = Object.freeze([['ab', 'baseline', 'candidate'], ['aa-baseline', 'baseline', 'baseline']].map(Object.freeze));

// Neutral import/package copy and quartet aggregation adapted from the reviewed ordered-guard diagnostic.
function randomSource(seed) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }; }
function shuffle(values, random) { const result = [...values]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
export function makeSchedule(random) {
  // Rank four seeded keys within each comparison to predeclare exactly
  // two quartets of each shape, independently of pilot or measured timings.
  const plan = Array.from({ length: CONFIG.blocks }, (_, block) => shuffle(MODES, random).map(([mode, left, right]) => ({ block, mode, left, right, orientationKey: random(), roles: [] }))).flat();
  for (const [mode] of MODES) {
    const group = plan.filter(p => p.mode === mode).sort((a, b) => a.orientationKey - b.orientationKey || a.block - b.block);
    group.forEach((p, rank) => { p.roles = rank < 2 ? ['left', 'right', 'right', 'left'] : ['right', 'left', 'left', 'right']; });
  }
  for (const p of plan) delete p.orientationKey;
  return plan;
}
export function prepareSubject(source, neutral, manifest, packageSha256) {
  const packageBytes = readFileSync(join(dirname(dirname(source)), 'package.json'));
  assert.equal(sha256(packageBytes), packageSha256, 'Source package context changed');
  rmSync(neutral, { recursive: true, force: true });
  cpSync(dirname(source), join(neutral, 'dist'), { recursive: true });
  writeFileSync(join(neutral, 'package.json'), packageBytes);
  const entry = join(neutral, 'dist', basename(source));
  assert.deepEqual(bundleManifest(entry), manifest);
  assert.equal(sha256(readFileSync(join(neutral, 'package.json'))), packageSha256);
  return entry;
}
export function hasControlDrift(interval) {
  if (interval.quartets !== CONFIG.blocks || interval.lower === null || interval.upper === null) return false;
  const outsideBand = interval.geometricMean < 1 / CONFIG.nonInferiorityMargin || interval.geometricMean > CONFIG.nonInferiorityMargin;
  return outsideBand && (interval.lower > 1 || interval.upper < 1);
}
export function summarize(row) {
  const result = {};
  for (const [mode, left, right] of MODES) {
    const blocks = row.blocks.filter(block => block.mode === mode && block.subjects.length === 4), pairs = [], logs = [];
    for (const block of blocks) {
      const local = [];
      for (let i = 0; i < 4; i += 2) {
        const pair = block.subjects.slice(i, i + 2), a = pair.find(x => x.role === 'left'), b = pair.find(x => x.role === 'right');
        const leftMs = median(a.samples) / a.repeat, rightMs = median(b.samples) / b.repeat;
        const p = { block: block.block, pair: i / 2, firstRole: pair[0].role, leftMs, rightMs, latencyRatio: rightMs / leftMs };
        pairs.push(p); local.push(Math.log(p.latencyRatio));
      }
      logs.push((local[0] + local[1]) / 2);
    }
    const subjects = blocks.flatMap(block => block.subjects);
    result[mode] = { leftBuild: left, rightBuild: right, ratioDirection: `${right}/${left}`, pairs, quartetLogLatencyRatios: logs,
      interval: logInterval(logs), leftMedianMs: pairs.length ? median(pairs.map(p => p.leftMs)) : null, rightMedianMs: pairs.length ? median(pairs.map(p => p.rightMs)) : null,
      belowTargetBatches: subjects.reduce((n, s) => n + s.belowTargetBatches, 0), warmupCappedSubjects: subjects.filter(s => s.warmup.capped).length,
      warmupTimeShortSubjects: subjects.filter(s => s.warmupTimeShort).length, warmupWorkShortSubjects: subjects.filter(s => s.warmupWorkShort).length };
  }
  const controlDrift = hasControlDrift(result['aa-baseline'].interval);
  for (const summary of Object.values(result)) {
    summary.controlDrift = controlDrift;
    summary.inferenceUsable = !controlDrift && summary.interval.quartets === 4 && !row.plan?.repeatCapped && !row.plan?.pilotWarmupCapped &&
      !summary.belowTargetBatches && !summary.warmupCappedSubjects && !summary.warmupTimeShortSubjects && !summary.warmupWorkShortSubjects;
    summary.conclusion = controlDrift ? 'control-drift-inconclusive'
      : summary.inferenceUsable ? summary.interval.classification : 'inconclusive (incomplete or flagged timings)';
  }
  return result;
}
export function logInterval(values) {
  // Student t interval on independent quartet log-latency ratios. Batch samples
  // and the two adjacent pairs inside a quartet are not independent replicates.
  const n = values.length;
  if (!n) return { quartets: 0, geometricMean: null, lower: null, upper: null, classification: 'inconclusive' };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { quartets: n, geometricMean: Math.exp(mean), lower: null, upper: null, classification: 'inconclusive' };
  const critical = [0, 12.7062047364, 4.3026527297, 3.1824463053, 2.7764451052, 2.5705818356, 2.4469118511, 2.3646242516, 2.3060041352, 2.2621571628, 2.228138852, 2.2009851601][n - 1];
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1), half = critical * Math.sqrt(variance / n);
  const lower = Math.exp(mean - half), upper = Math.exp(mean + half);
  return { quartets: n, geometricMean: Math.exp(mean), lower, upper, confidenceLevel: 0.95, margin: 1.02,
    classification: lower > 1.02 ? 'detected material loss' : upper <= 1.02 ? 'evidence within margin' : 'inconclusive' };
}

/** One build per fresh child; requests contain no variant or role labels. */
export async function measureSingle({ entryUrl, harnessUrl, workload, phase, repeat: commonRepeat, warmupScans: commonWarmupScans }) {
  const S = await import(entryUrl), { fixture, equal, materialize } = await import(harnessUrl);
  const { item, expected } = fixture(S, workload), { operation, size } = workload;
  const allocating = operation === 'compact', reverse = operation.endsWith('Reverse');
  const want = reverse ? expected.slice().reverse() : expected;
  equal(materialize(allocating ? S.compact(item) : item, operation), want, 'pre-warm correctness');
  const expectedJson = JSON.stringify(want);
  let last;
  const scan = repeat => {
    let count = 0;
    if (allocating) for (let i = 0; i < repeat; i++) { last = S.compact(item); count += last.size; }
    else if (operation === 'forEach' || operation === 'forEachReverse') {
      for (let i = 0; i < repeat; i++) item[operation](value => { if (value !== undefined) count++; });
    } else for (let i = 0; i < repeat; i++) { last = item[operation](); count += last.length; }
    return count;
  };
  const gc = () => {
    if (!allocating) return 0;
    last = undefined;
    const start = performance.now();
    if (process.versions.bun) Bun.gc(true);
    else { if (typeof globalThis.gc !== 'function') throw new Error('Compaction requires --expose-gc'); globalThis.gc(); }
    return performance.now() - start;
  };
  const timed = repeat => {
    const start = performance.now(), count = scan(repeat), ms = performance.now() - start;
    if (count !== size * repeat) throw new Error('Scan count mismatch');
    return ms;
  };
  const warm = (batchRepeat, requiredScans, requireElapsedTime) => {
    const start = performance.now(), result = { scans: 0, batches: [], elapsedMs: 0, explicitGcMs: 0, gcCalls: 0, capped: false };
    while (result.scans < requiredScans || requireElapsedTime && result.elapsedMs < CONFIG.warmupMs) {
      if (performance.now() - start >= CONFIG.maxWarmupMs) { result.capped = true; break; }
      const batch = allocating ? CONFIG.compactGcEvery : batchRepeat;
      const count = result.scans < requiredScans ? Math.min(batch, requiredScans - result.scans) : batch;
      const ms = timed(count); result.batches.push({ repeat: count, ms }); result.scans += count; result.elapsedMs += ms;
      if (allocating) { result.explicitGcMs += gc(); result.gcCalls++; }
    }
    result.wallMs = performance.now() - start; return result;
  };
  const validateLast = () => {
    if (allocating && last) equal(last.toArray(), expected, 'last compaction');
    else if (last) equal(last, want, 'last array');
    globalThis.__blockTraversalSink = last;
  };
  if (phase === 'pilot') {
    let repeat = allocating ? 8 : size <= 32 ? 128 : 2;
    const warmup = warm(repeat, allocating ? CONFIG.compactWarmupCalls : Math.ceil(CONFIG.warmupMinElements / Math.max(1, size)), !allocating);
    const calibration = [], maximum = allocating ? CONFIG.compactMaxRepeat : CONFIG.scanMaxRepeat;
    for (let attempt = 0; attempt < 16; attempt++) {
      const samples = [], gcMs = [];
      for (let i = 0; i < 3; i++) { gcMs.push(gc()); samples.push(timed(repeat)); }
      validateLast(); calibration.push({ repeat, samples, explicitGcMs: gcMs });
      const fastest = Math.min(...samples), capped = repeat === maximum && fastest < CONFIG.targetBatchMs * 1.25;
      if (fastest >= CONFIG.targetBatchMs * 1.25 || capped) return { phase, expectedJson, repeat, minMsPerScan: fastest / repeat, warmup, calibration, repeatCapped: capped };
      repeat = Math.min(maximum, Math.ceil(repeat * Math.min(16, Math.max(1.1, CONFIG.targetBatchMs * 1.5 / Math.max(fastest, 0.001)))));
    }
    throw new Error(`Pilot failed to calibrate: ${workload.name}`);
  }
  assert.equal(phase, 'measure');
  assert.ok(Number.isSafeInteger(commonRepeat) && commonRepeat > 0);
  assert.ok(Number.isSafeInteger(commonWarmupScans) && commonWarmupScans > 0);
  if (allocating) { assert.equal(commonWarmupScans, CONFIG.compactWarmupCalls); assert.ok(commonRepeat <= CONFIG.compactMaxRepeat); }
  const warmup = warm(commonRepeat, commonWarmupScans, false), samples = [], explicitGcMs = [];
  for (let sample = 0; sample < CONFIG.samples; sample++) { explicitGcMs.push(gc()); samples.push(timed(commonRepeat)); }
  validateLast();
  return { phase, expectedJson, repeat: commonRepeat, prescribedWarmupScans: commonWarmupScans, warmup, samples, explicitGcMs,
    belowTargetBatches: samples.filter(ms => ms < CONFIG.targetBatchMs).length,
    warmupTimeShort: !allocating && warmup.elapsedMs < CONFIG.warmupMs, warmupWorkShort: warmup.scans !== commonWarmupScans };
}
function finish(raw) { const { expectedJson, ...rest } = raw; return { ...rest, digest: sha256(expectedJson) }; }
export function freezePlan(workload, pilots) {
  assert.equal(new Set(pilots.map(p => p.digest)).size, 1, 'Pilot outputs differ');
  const repeat = Math.max(...pilots.map(p => p.repeat)), fastest = Math.min(...pilots.map(p => p.minMsPerScan));
  assert.ok(Number.isFinite(fastest) && fastest > 0);
  const warmupScans = workload.operation === 'compact' ? CONFIG.compactWarmupCalls
    : Math.ceil(Math.max(Math.ceil(CONFIG.warmupMinElements / Math.max(1, workload.size)), Math.ceil(CONFIG.warmupMs * 1.25 / fastest)) / repeat) * repeat;
  return { repeat, warmupScans, fastestPilotMsPerScan: fastest, expectedDigest: pilots[0].digest,
    repeatCapped: pilots.some(p => p.repeatCapped), pilotWarmupCapped: pilots.some(p => p.warmup.capped) };
}
export function gateStatus(record) {
  if (record.status !== 'completed' || record.rows.length !== CASES.length) return 'incomplete';
  let loss = false, flags = false, controlDrift = false, targetGain = false;
  for (const row of record.rows) {
    if (row.plan.repeatCapped || row.plan.pilotWarmupCapped) flags = true;
    for (const mode of MODES.map(m => m[0])) {
      const s = row.summary[mode];
      if (s.controlDrift) controlDrift = true;
      if (s.interval.quartets !== 4 || s.belowTargetBatches || s.warmupCappedSubjects || s.warmupTimeShortSubjects || s.warmupWorkShortSubjects) flags = true;
      if (mode === 'ab' && s.inferenceUsable && s.interval.lower > 1.02) loss = true;
      if (mode === 'ab' && s.inferenceUsable && row.size > 32 && s.interval.upper < 1) targetGain = true;
    }
  }
  return loss ? 'detected-material-loss' : controlDrift ? 'control-drift-inconclusive' : flags ? 'flagged-inconclusive' : !targetGain ? 'no-established-target-gain' : 'eligible-for-later-correctness';
}
async function main() {
  if (process.argv[2] === '--subject') { console.log(JSON.stringify(finish(await measureSingle(JSON.parse(process.argv[3]))))); return; }
  const [baseline, candidate, output = 'proofs/results/block-traversal/result.json'] = process.argv.slice(2);
  if (!baseline || !candidate) throw new Error('Usage: node|bun proofs/block-traversal-performance.mjs BASE/dist/shared.js HEAD/dist/shared.js OUTPUT.json');
  assert.equal(process.arch, 'x64', 'The first gate is x64 only');
  const runtime = process.versions.bun ? 'bun' : 'node', comparison = prepareComparison(baseline, candidate), random = randomSource(CONFIG.seed);
  const cases = shuffle(CASES, random), temporary = mkdtempSync(join(os.tmpdir(), 'block-traversal-neutral-')), neutral = join(temporary, 'subject');
  const entry = join(neutral, 'dist', 'shared.js'), helper = fileURLToPath(new URL('./block-traversal-workloads.mjs', import.meta.url));
  const packageSha256 = comparison.sourceManifests.baseline.files['package.json'];
  const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), runtime, config: CONFIG,
    baselineCommit: BASELINE_COMMIT, ...comparison, caseOrder: cases.map(c => c.name), rows: [],
    packageContext: { sha256: packageSha256, relativeEntry: 'dist/shared.js', copiedVerbatim: true },
    controller: { node: process.version, bun: process.versions.bun ?? null, arch: process.arch, platform: process.platform, cpu: os.cpus()[0]?.model },
    harnessSha256: Object.fromEntries(['block-traversal-performance.mjs', 'block-traversal-workloads.mjs', 'block-traversal-source.mjs'].map(file => [file, sha256(readFileSync(new URL(file, import.meta.url)))])),
    method: 'One immutable build per fresh process at the same neutral dist/shared.js path, preserving original package.json bytes and complete dist layout. One disposable pilot per build/case freezes common timed repeats and scan warmup work before all A/B and baseline A/A subjects. Exactly two ABBA and two BAAB quartets per mode, seeded and interleaved. The independent replicate is each quartet mean log latency ratio, not its two pairs or batches. Unadjusted direct A/A, absolute durations, raw samples, calibration, warmup, explicit GC and flags are retained. A matched A/A geometric ratio outside [1/1.02,1.02] whose 95% interval excludes 1 makes that row control-drift-inconclusive; A/B is never normalized by A/A. Compaction includes fresh Arena construction, uses 512 fixed warmup calls with GC outside timing every 32 warmup calls and before every batch, and permits automatic GC during timed allocation. No timing-driven retries or exclusions. 95% df3 Student-t log intervals use a predeclared 2% candidate-latency margin; lower>1.02 is material loss, upper<=1.02 within margin, otherwise inconclusive. Stage eligibility requires no detected material loss, matched-control drift or validity flags and at least one established target gain; inconclusive cells remain inconclusive and eligibility is not an acceptance certificate. Timed forEach kernels count nonundefined callback values; timed array kernels consume returned-array lengths, and compaction consumes result sizes. expectedDigest validates the reference and untimed correctness checks, not every timed value. Claims are limited to those workloads. Imports, construction, output validation and count assertions stay outside timed batches.' };
  const checkpoint = () => { for (const row of record.rows) row.summary = summarize(row); record.gate = gateStatus(record); mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output + '.tmp', JSON.stringify(record, null, 2) + '\n'); renameSync(output + '.tmp', output); };
  let sequence = 0;
  const subject = (build, request) => {
    assert.equal(prepareSubject(comparison.paths[build], neutral, comparison.manifests[build], packageSha256), entry);
    const ordinal = sequence++, startedAt = new Date().toISOString(), start = performance.now();
    const args = [...(runtime === 'node' ? ['--expose-gc'] : []), fileURLToPath(import.meta.url), '--subject', JSON.stringify({ ...request, entryUrl: pathToFileURL(entry).href, harnessUrl: pathToFileURL(helper).href })];
    const child = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CONFIG.subjectTimeoutMs,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } });
    if (child.status !== 0) throw new Error(String(child.error ?? child.stderr ?? child.stdout));
    assert.deepEqual(bundleManifest(entry), comparison.manifests[build]);
    assert.equal(sha256(readFileSync(join(neutral, 'package.json'))), packageSha256);
    return { sequence: ordinal, build, startedAt, wallMs: performance.now() - start, ...JSON.parse(child.stdout) };
  };
  try {
    for (const workload of cases) {
      const row = { ...workload, pilots: {}, pilotOrder: shuffle(['baseline', 'candidate'], random), blocks: [] }; record.rows.push(row);
      for (const build of row.pilotOrder) row.pilots[build] = subject(build, { workload, phase: 'pilot' });
      row.plan = freezePlan(workload, Object.values(row.pilots)); row.schedule = makeSchedule(random); checkpoint();
      for (const planned of row.schedule) {
        const block = { ...planned, subjects: [] }; row.blocks.push(block);
        for (const role of planned.roles) {
          const result = subject(planned[role], { workload, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans });
          assert.equal(result.digest, row.plan.expectedDigest); block.subjects.push({ role, ...result });
        }
        checkpoint(); console.log(`${runtime} ${workload.name} quartet ${planned.block + 1} ${planned.mode}`);
      }
      for (const summary of Object.values(row.summary)) { assert.equal(summary.pairs.length, 8); assert.equal(summary.interval.quartets, 4); }
    }
    for (const build of ['baseline', 'candidate']) assert.deepEqual(bundleManifest(comparison.paths[build]), comparison.manifests[build]);
    assert.deepEqual(prepareComparison(baseline, candidate).sourceManifests, comparison.sourceManifests);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); record.finishedAt = new Date().toISOString(); checkpoint(); throw error; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
