import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, renameSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { measureSingle, logInterval } from './ordered-churn-performance.mjs';
import { prepareComparison, bundleManifest, sha256, median, BASELINE_COMMIT } from './ordered-churn-source.mjs';

export const ORIGINAL_COMMIT = '82f8d9cc9d81c459ecbd0d9c06189e0fa9ec5120';
export const CASES = Object.freeze([1, 32, 4096].flatMap(size => ['ordered', 'replaced'].map(kind => Object.freeze({
  suite: 'controls', kind, type: 'number', size, history: size, operation: 'entries', pattern: 'rotate',
  name: `controls/${kind}/number/${size}/${size}/rotate/entries`,
}))));
export const CONFIG = Object.freeze({ blocks: 4, samples: 21, targetBatchMs: 10, warmupMs: 150, warmupMinElements: 262144, maxWarmupMs: 10000,
  seed: 20261008, nonInferiorityMargin: 1.02, confidenceLevel: 0.95 });
export const MODES = Object.freeze([
  ['main-original', 'main', 'original'], ['main-reordered', 'main', 'reordered'], ['original-reordered', 'original', 'reordered'],
  ['aa-main', 'main', 'main'], ['aa-original', 'original', 'original'], ['aa-reordered', 'reordered', 'reordered'],
].map(Object.freeze));

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
export function prepareThree(main, original, reordered) {
  const previous = process.env.CANDIDATE_COMMIT;
  let oldComparison, newComparison;
  try {
    process.env.CANDIDATE_COMMIT = ORIGINAL_COMMIT;
    oldComparison = prepareComparison(main, original);
    if (previous === undefined) delete process.env.CANDIDATE_COMMIT; else process.env.CANDIDATE_COMMIT = previous;
    newComparison = prepareComparison(main, reordered);
  } finally { if (previous === undefined) delete process.env.CANDIDATE_COMMIT; else process.env.CANDIDATE_COMMIT = previous; }
  const roots = { main: dirname(dirname(resolve(main))), original: dirname(dirname(resolve(original))), reordered: dirname(dirname(resolve(reordered))) };
  const repo = roots.reordered, oldSource = readFileSync(join(roots.original, 'shared-ordered-map.ts'), 'utf8'), newSource = readFileSync(join(roots.reordered, 'shared-ordered-map.ts'), 'utf8');
  const before = 'if (!this.orderStable && this.tail > this.size && this.size > 0 && p &&';
  const after = 'if (this.tail > this.size && !this.orderStable && this.size > 0 && p &&';
  assert.equal(oldSource.split(before).length, 2, 'Original guard must occur exactly once');
  assert.equal(newSource, oldSource.replace(before, after), 'Reordered runtime must differ by precisely the approved condition order');
  // The measurement function, fixtures, source guard and interval formula are
  // frozen at the original experiment. No alternate kernel is introduced.
  const harness = {};
  for (const file of ['proofs/ordered-churn-performance.mjs', 'proofs/ordered-churn-checks.mjs', 'proofs/ordered-churn-source.mjs']) {
    harness[file] = sha256(readFileSync(join(repo, file)));
    assert.equal(harness[file], sha256(git(repo, ['show', `${ORIGINAL_COMMIT}:${file}`])), `Original harness changed: ${file}`);
  }
  assert.deepEqual(oldComparison.manifests.baseline, newComparison.manifests.baseline);
  assert.deepEqual(oldComparison.sourceManifests.candidate.wasm, newComparison.sourceManifests.candidate.wasm);
  return { pins: { main: BASELINE_COMMIT, original: ORIGINAL_COMMIT, reordered: newComparison.candidateCommit },
    paths: { main: resolve(main), original: resolve(original), reordered: resolve(reordered) },
    sourceManifests: { main: oldComparison.sourceManifests.baseline, original: oldComparison.sourceManifests.candidate, reordered: newComparison.sourceManifests.candidate },
    manifests: { main: oldComparison.manifests.baseline, original: oldComparison.manifests.candidate, reordered: newComparison.manifests.candidate },
    harnessSha256: { ...harness, focused: sha256(readFileSync(fileURLToPath(import.meta.url))) } };
}
function randomSource(seed) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }; }
function shuffle(values, random) { const result = [...values]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
export function makeSchedule(random) {
  // Keep the old random-draw count and mode order. Rank the four seeded keys
  // within each comparison to predeclare exactly two quartets of each shape.
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
  return result;
}
function finish(raw) { const { expectedJson, ...rest } = raw; return { ...rest, digest: sha256(expectedJson) }; }
async function main() {
  if (process.argv[2] === '--subject') { console.log(JSON.stringify(finish(await measureSingle(JSON.parse(process.argv[3]))))); return; }
  const [baseline, original, reordered, output = 'proofs/results/ordered-churn-guard-order/result.json'] = process.argv.slice(2);
  if (!baseline || !original || !reordered) throw new Error('Usage: node|bun proofs/ordered-churn-guard-order.mjs MAIN/dist/shared.js ORIGINAL/dist/shared.js REORDERED/dist/shared.js OUTPUT.json');
  const runtime = process.versions.bun ? 'bun' : 'node', config = { ...CONFIG, runtime };
  if (process.env.RUNTIME && process.env.RUNTIME !== runtime) throw new Error('Controller runtime mismatch');
  const comparison = prepareThree(baseline, original, reordered), random = randomSource(CONFIG.seed);
  const cases = shuffle(CASES, random), temporary = mkdtempSync(join(os.tmpdir(), 'ordered-guard-focused-')), neutral = join(temporary, 'subject'), entry = join(neutral, 'dist', basename(comparison.paths.main));
  const helper = fileURLToPath(new URL('./ordered-churn-checks.mjs', import.meta.url)), packageSha256 = comparison.sourceManifests.main.files['package.json'];
  const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), config, ...comparison, caseOrder: cases.map(c => c.name), rows: [],
    packageContext: { sha256: packageSha256, relativeEntry: 'dist/shared.js', copiedVerbatim: true },
    controller: { node: process.version, bun: process.versions.bun ?? null, arch: process.arch, platform: process.platform, cpu: os.cpus()[0]?.model },
    method: 'One immutable build per fresh process, with all three source variants measured on one runner and neutral import path, preserving the identical original package.json and dist-relative directory layout. One disposable pilot per build/case sets common repeats and warmup scans from the fastest of all three. The work plan is frozen before measured subjects. Exactly two ABBA and two BAAB quartets for each of main-original, main-reordered, original-reordered and matched A/A for every build are interleaved in seeded order. Every role uses a new process. Existing original-head fixture/kernel and 95% small-sample Student-t log interval are unchanged. The independent replicate is the quartet, not either within-quartet pair or the timed batches. Predeclared 2% right/left latency margin: lower>1.02 detected material loss; upper<=1.02 evidence within margin; otherwise inconclusive. A/A is descriptive, never used to adjust A/B. Absolute times, all samples, calibration, warmup, order and flags are retained. No timing-driven retries, sample exclusion, threshold edits, singleton fast path, or full-matrix promotion. Startup/import/construction/checks are outside timing.' };
  const checkpoint = () => { for (const row of record.rows) row.summary = summarize(row); mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output + '.tmp', JSON.stringify(record, null, 2) + '\n'); renameSync(output + '.tmp', output); };
  let ordinal = 0;
  const subject = (build, request) => {
    assert.equal(prepareSubject(comparison.paths[build], neutral, comparison.manifests[build], packageSha256), entry);
    const sequence = ordinal++, startedAt = new Date().toISOString(), started = performance.now();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--subject', JSON.stringify({ ...request, entryUrl: pathToFileURL(entry).href, harnessUrl: pathToFileURL(helper).href })],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } });
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    assert.deepEqual(bundleManifest(entry), comparison.manifests[build]);
    assert.equal(sha256(readFileSync(join(neutral, 'package.json'))), packageSha256);
    return { sequence, build, startedAt, wallMs: performance.now() - started, runtimeVersion: process.versions.bun ?? process.version, ...JSON.parse(child.stdout) };
  };
  try {
    for (const workload of cases) {
      const row = { ...workload, pilots: {}, pilotOrder: shuffle(['main', 'original', 'reordered'], random), blocks: [] }; record.rows.push(row);
      for (const build of row.pilotOrder) row.pilots[build] = subject(build, { workload, config, phase: 'pilot' });
      const pilots = Object.values(row.pilots); assert.equal(new Set(pilots.map(p => p.digest)).size, 1, 'Pilot outputs differ');
      const repeat = Math.max(...pilots.map(p => p.repeat)), fastest = Math.min(...pilots.map(p => p.minMsPerScan));
      const warmupScans = Math.ceil(Math.max(Math.ceil(CONFIG.warmupMinElements / workload.size), Math.ceil(CONFIG.warmupMs * 1.25 / fastest)) / repeat) * repeat;
      row.plan = { repeat, warmupScans, fastestPilotMsPerScan: fastest, expectedDigest: pilots[0].digest }; row.schedule = makeSchedule(random); checkpoint();
      for (const planned of row.schedule) {
        const block = { ...planned, subjects: [] }; row.blocks.push(block);
        for (const role of planned.roles) {
          const result = subject(planned[role], { workload, config, phase: 'measure', repeat, warmupScans }); assert.equal(result.digest, row.plan.expectedDigest);
          block.subjects.push({ role, ...result });
        }
        checkpoint(); console.log(`${runtime} ${workload.name} block ${planned.block + 1} ${planned.mode}`);
      }
      for (const [mode, result] of Object.entries(row.summary)) {
        assert.equal(result.pairs.length, 8); assert.equal(result.interval.quartets, 4); assert.equal(result.pairs.filter(p => p.firstRole === 'left').length, 4);
        console.log(`${workload.name} ${mode}: ${result.interval.geometricMean.toFixed(5)} [${result.interval.lower.toFixed(5)},${result.interval.upper.toFixed(5)}] ${result.interval.classification}`);
      }
    }
    for (const build of ['main', 'original', 'reordered']) assert.deepEqual(bundleManifest(comparison.paths[build]), comparison.manifests[build]);
    assert.deepEqual(prepareThree(baseline, original, reordered), comparison);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
  } catch (error) { record.status = 'failed'; record.finishedAt = new Date().toISOString(); record.error = String(error.stack ?? error); checkpoint(); throw error; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
