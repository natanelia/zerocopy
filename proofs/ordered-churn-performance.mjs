import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, renameSync } from 'node:fs';
import { dirname, resolve, join, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { median, sha256, prepareComparison, bundleManifest, BASELINE_COMMIT } from './ordered-churn-source.mjs';
import { workloadCases } from './ordered-churn-workloads.mjs';

function configuration() {
  const numeric = (name, fallback, low, high, integer = false) => {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(n) || n < low || n > high || integer && !Number.isInteger(n)) throw new Error(`Invalid ${name}: ${n}`);
    return n;
  };
  const runtime = process.env.RUNTIME ?? 'node', suite = process.env.SUITE ?? 'all';
  if (!['node', 'bun', 'chromium', 'firefox', 'webkit'].includes(runtime)) throw new Error(`Invalid RUNTIME: ${runtime}`);
  if (!['all', 'controls', 'targets', 'crossover', 'gate'].includes(suite)) throw new Error(`Invalid SUITE: ${suite}`);
  return {
    runtime, suite, blocks: numeric('BLOCKS', 4, 2, 12, true),
    samples: numeric('SAMPLES', ['node', 'bun'].includes(runtime) ? 21 : 15, 5, 100, true),
    targetBatchMs: numeric('TARGET_BATCH_MS', 10, 1, 100),
    warmupMs: numeric('WARMUP_MS', 150, 25, 1000),
    warmupMinElements: numeric('WARMUP_MIN_ELEMENTS', 262144, 65536, 16777216, true),
    maxWarmupMs: numeric('MAX_WARMUP_MS', 10000, 1000, 30000),
    nonInferiorityMargin: 1.02, confidenceLevel: 0.95,
    seed: numeric('SEED', 20261008, 1, 0xffffffff, true),
    caseFilter: process.env.CASE_FILTER ?? null,
    candidateAAFilter: process.env.CANDIDATE_AA_FILTER ?? '^controls/(replaced|sorted-custom)/',
  };
}

function randomSource(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

// Serialized unchanged into each browser. It imports ONE build, constructs ONE
// fixture and has ONE lexical scan function. Build/role labels never enter it.
export async function measureSingle({ entryUrl, harnessUrl, workload, config, phase, repeat: commonRepeat, warmupScans: commonWarmupScans }) {
  const S = await import(entryUrl), { churnFixture, equal } = await import(harnessUrl);
  const { size, kind, type, operation, history, pattern } = workload;
  let fixture, expected;
  const value = i => type === 'number' ? i + 0.25 : { i, values: [i, i + 1] };
  if (kind === 'ordered' || kind === 'replaced') {
    const result = churnFixture(S, size, history, type, pattern); fixture = result.map; expected = result.expected;
    if (kind === 'replaced') { const key = expected[0][0]; fixture = fixture.set(key, -1); expected[0][1] = -1; }
  } else if (kind === 'ordered-set') {
    S.resetOrderedMap(); fixture = new S.SharedOrderedSet(); const native = new Set();
    for (let i = 0; i < size; i++) { fixture = fixture.add(i); native.add(i); }
    for (let i = size; i < history; i++) { const key = i % size; fixture = fixture.delete(key).add(key); native.delete(key); native.add(key); }
    expected = [...native];
  } else if (kind === 'list') {
    expected = Array.from({ length: size }, (_, i) => i + 0.25); fixture = new S.SharedList('number').pushMany(expected);
  } else {
    S.resetSortedMap(); S.resetMap();
    fixture = kind === 'map' ? new S.SharedMap(type) : new S.SharedSortedMap(type, kind === 'sorted-custom' ? (a, b) => b.localeCompare(a) : undefined);
    for (let i = 0; i < size; i++) fixture = fixture.set(`key-${i}`, value(i));
    expected = [...fixture.entries()];
  }
  if (operation === 'keys') expected = expected.map(entry => entry[0]);
  else if (operation === 'values' && !['ordered-set', 'list'].includes(kind)) expected = expected.map(entry => entry[1]);
  const materialize = () => { if (operation !== 'forEach') return [...fixture[operation]()]; const result = []; fixture.forEach((v, k) => result.push([k, v])); return result; };
  equal(materialize(), expected, 'benchmark fixture');
  const expectedJson = JSON.stringify(expected, (_key, value) => typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value)) ? { number: Object.is(value, -0) ? '-0' : String(value) } : value);
  const scan = repeat => {
    let count = 0;
    if (operation === 'forEach') { for (let r = 0; r < repeat; r++) fixture.forEach(value => { if (value !== undefined) count++; }); }
    else { for (let r = 0; r < repeat; r++) for (const value of fixture[operation]()) if (value !== undefined) count++; }
    return count;
  };
  const timed = repeat => {
    const start = performance.now(), count = scan(repeat), ms = performance.now() - start;
    if (count !== size * repeat) throw new Error(`Count mismatch: ${workload.name}`);
    return ms;
  };
  const warm = (batchRepeat, requiredScans, requireElapsedTime) => {
    const started = performance.now(), result = { scans: 0, batches: [], elapsedMs: 0, capped: false };
    while (result.scans < requiredScans || requireElapsedTime && result.elapsedMs < config.warmupMs) {
      if (performance.now() - started >= config.maxWarmupMs) { result.capped = true; break; }
      const count = result.scans < requiredScans ? Math.min(batchRepeat, requiredScans - result.scans) : batchRepeat;
      const ms = timed(count);
      result.batches.push({ repeat: count, ms }); result.scans += count; result.elapsedMs += ms;
    }
    result.wallMs = performance.now() - started;
    return result;
  };
  if (phase === 'pilot') {
    let repeat = size === 32 ? 128 : 2;
    const warmup = warm(repeat, Math.ceil(config.warmupMinElements / size), true), calibration = [];
    for (let attempt = 0; attempt < 16; attempt++) {
      const samples = [timed(repeat), timed(repeat), timed(repeat)];
      calibration.push({ repeat, samples });
      const fastest = Math.min(...samples);
      if (fastest >= config.targetBatchMs * 1.25) {
        return { phase, expectedJson, repeat, minMsPerScan: fastest / repeat, warmup, calibration };
      }
      repeat = Math.ceil(repeat * Math.min(16, Math.max(1.1, config.targetBatchMs * 1.5 / Math.max(fastest, 0.001))));
      if (repeat > 10000000) throw new Error('Pilot repeat limit exceeded');
    }
    throw new Error(`Pilot could not calibrate: ${workload.name}`);
  }
  if (!Number.isSafeInteger(commonRepeat) || commonRepeat < 1 || !Number.isSafeInteger(commonWarmupScans) || commonWarmupScans < 1) throw new Error('Invalid frozen work counts');
  // Measured processes do not calibrate themselves. Both builds get exactly the
  // same preset warmup scans and timed repeats; timing cannot select the work.
  const warmup = warm(commonRepeat, commonWarmupScans, false), samples = [];
  for (let i = 0; i < config.samples; i++) samples.push(timed(commonRepeat));
  return {
    phase, expectedJson, repeat: commonRepeat, prescribedWarmupScans: commonWarmupScans, warmup, samples,
    belowTargetBatches: samples.filter(ms => ms < config.targetBatchMs).length,
    warmupTimeShort: warmup.elapsedMs < config.warmupMs,
    warmupWorkShort: warmup.scans !== commonWarmupScans,
  };
}

function finishSubject(raw) {
  const { expectedJson, ...row } = raw;
  return { ...row, digest: sha256(expectedJson) };
}
function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], p10: sorted[Math.floor(sorted.length * 0.1)], median: median(sorted), p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) };
}
export function logInterval(values) {
  // Student t interval on independent quartet log-latency ratios. Batch samples
  // and the two adjacent pairs inside a quartet are not independent replicates.
  const n = values.length, mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { quartets: n, geometricMean: Math.exp(mean), lower: null, upper: null, classification: 'inconclusive' };
  const critical = [0, 12.7062047364, 4.3026527297, 3.1824463053, 2.7764451052, 2.5705818356, 2.4469118511, 2.3646242516, 2.3060041352, 2.2621571628, 2.228138852, 2.2009851601][n - 1];
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1), half = critical * Math.sqrt(variance / n);
  const lower = Math.exp(mean - half), upper = Math.exp(mean + half);
  return { quartets: n, geometricMean: Math.exp(mean), lower, upper, confidenceLevel: 0.95, margin: 1.02,
    classification: lower > 1.02 ? 'detected material loss' : upper <= 1.02 ? 'evidence within margin' : 'inconclusive' };
}
export function summarizeCase(row) {
  const modes = [...new Set(row.blocks.map(block => block.mode))], summary = {};
  for (const mode of modes) {
    const blocks = row.blocks.filter(block => block.mode === mode), pairs = [];
    for (const block of blocks) for (let start = 0; start < 4; start += 2) {
      const subjects = block.subjects.slice(start, start + 2);
      if (subjects.length !== 2) continue;
      const left = subjects.find(s => s.role === 'left'), right = subjects.find(s => s.role === 'right');
      const leftMs = median(left.samples) / left.repeat, rightMs = median(right.samples) / right.repeat;
      pairs.push({ block: block.block, pairInBlock: start / 2, firstRole: subjects[0].role, leftMsPerScan: leftMs, rightMsPerScan: rightMs, ratio: leftMs / rightMs });
    }
    const subjects = blocks.flatMap(block => block.subjects);
    const quartetLogs = blocks.filter(block => block.subjects.length === 4).map(block => { const local = pairs.filter(pair => pair.block === block.block); return local.reduce((sum, pair) => sum - Math.log(pair.ratio), 0) / local.length; });
    summary[mode] = {
      ratioDirection: mode === 'ab' ? 'candidate/baseline' : 'identical-build right/left', latencyRatioInterval: logInterval(quartetLogs), quartetLogLatencyRatios: quartetLogs,
      pairCount: pairs.length, pairRatios: pairs.map(pair => pair.ratio), pairs,
      medianPairedRatio: pairs.length ? median(pairs.map(pair => pair.ratio)) : null,
      pairRatioSpread: pairs.length ? spread(pairs.map(pair => pair.ratio)) : null,
      leftSubjectMsPerScan: subjects.some(s => s.role === 'left') ? spread(subjects.filter(s => s.role === 'left').map(s => median(s.samples) / s.repeat)) : null,
      rightSubjectMsPerScan: subjects.some(s => s.role === 'right') ? spread(subjects.filter(s => s.role === 'right').map(s => median(s.samples) / s.repeat)) : null,
      belowTargetBatches: subjects.reduce((total, subject) => total + subject.belowTargetBatches, 0),
      warmupCappedSubjects: subjects.filter(s => s.warmup.capped).length,
      warmupTimeShortSubjects: subjects.filter(s => s.warmupTimeShort).length,
      warmupWorkShortSubjects: subjects.filter(s => s.warmupWorkShort).length,
    };
  }
  return summary;
}

async function main() {
  if (process.argv[2] === '--subject') {
    const request = JSON.parse(process.argv[3]);
    console.log(JSON.stringify(finishSubject(await measureSingle(request))));
    return;
  }
  const [baseline, candidate, output = 'proofs/results/ordered-churn-performance/result.json'] = process.argv.slice(2);
  if (!baseline || !candidate) throw new Error('Usage: RUNTIME=node SUITE=all node proofs/ordered-churn-performance.mjs BASE/dist/shared.js CANDIDATE/dist/shared.js OUTPUT.json');
  const config = configuration(), browserMode = !['node', 'bun'].includes(config.runtime), random = randomSource(config.seed);
  if (!browserMode && (config.runtime === 'bun') !== Boolean(process.versions.bun)) throw new Error('Run the controller with the selected Node/Bun executable');
  const selected = shuffle(workloadCases(config.caseFilter).filter(row => config.suite === 'all' || config.suite === row.suite || config.suite === 'gate' && row.gate), random);
  if (!selected.length) throw new Error('No selected diagnostic workloads');
  const comparison = prepareComparison(baseline, candidate);
  const temporary = mkdtempSync(join(os.tmpdir(), 'ordered-churn-single-build-'));
  const neutral = join(temporary, 'subject'), entry = join(neutral, basename(comparison.paths.baseline));
  const helper = fileURLToPath(new URL('./ordered-churn-checks.mjs', import.meta.url));
  let activeRoot, origin, server, launcher;
  const record = {
    schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), config,
    baselineCommit: BASELINE_COMMIT, candidateCommit: comparison.candidateCommit,
    sourcePaths: comparison.sourcePaths, sourceManifests: comparison.sourceManifests, sourceDiff: comparison.sourceDiff, manifests: comparison.manifests,
    harnessSha256: { singleBuild: sha256(readFileSync(fileURLToPath(import.meta.url))), checks: sha256(readFileSync(helper)), sourceGuard: sha256(readFileSync(new URL('./ordered-churn-source.mjs', import.meta.url))), workloads: sha256(readFileSync(new URL('./ordered-churn-workloads.mjs', import.meta.url))) },
    controller: { node: process.version, bun: process.versions.bun ?? null, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
    caseOrder: selected.map(row => row.name), rows: [],
    method: 'One complete build, fixture, and lexical scan function per fresh runtime process. Browser subjects launch a new browser process and close it before the next subject; build URLs use the same /subject/ path. Disposable one-build pilots choose a common timed repeat count from the faster build and a common warmup scan count. These work counts are frozen before measurements and are identical across every A/B and A/A subject for that case. Four randomized ABBA/BAAB blocks provide eight adjacent process pairs per mode by default. A/B and baseline A/A blocks are interleaved in a seeded, predeclared order; candidate A/A is included for the configured control cases. Subjects never run concurrently. All raw timings, warmup batches, pilots, digests, flags and launch order are retained. Summaries use per-process scan medians, then independent adjacent-pair ratios; they never pool individual batch samples as independent process replicates and never divide A/B by A/A. The predeclared non-inferiority margin is 2% candidate latency. 95% Student-t intervals use independent quartet-mean log ratios, not the two within-quartet pairs or individual batches as independent samples. Lower bound >1.02 indicates a detected material loss, upper bound <=1.02 gives evidence within the margin, otherwise inconclusive. Small shifts, absolute timings and unadjusted A/A variation remain visible. No sample is discarded or retried based on timing. Caps and short batches are diagnostic flags, not silently treated as steady state. Completion establishes that the protocol ran, not that performance is regression-free. Process startup, imports, fixture construction, output validation, and count assertions are outside timed scans.',
  };
  const checkpoint = () => {
    for (const row of record.rows) row.summary = summarizeCase(row);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output + '.tmp', JSON.stringify(record, null, 2) + '\n'); renameSync(output + '.tmp', output);
  };
  try {
    if (browserMode) {
      const engines = await import('playwright'); launcher = engines[config.runtime];
      server = createServer((req, res) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
        if (req.url === '/harness.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(helper)); return; }
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Single-build ordered churn diagnostic</title>'); return; }
        const [, subject, ...parts] = new URL(req.url, 'http://localhost').pathname.split('/');
        const path = activeRoot && resolve(activeRoot, ...parts);
        if (subject !== 'subject' || !path || !path.startsWith(activeRoot + sep)) { res.writeHead(404); res.end(); return; }
        try { res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(readFileSync(path)); }
        catch { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
    }
    let ordinal = 0;
    const subject = async (variant, request) => {
      // Every child, including A/A, imports exactly the same real filesystem/URL
      // path. Replace the full tree only while the previous child is closed.
      rmSync(neutral, { recursive: true, force: true });
      cpSync(dirname(comparison.paths[variant]), neutral, { recursive: true });
      writeFileSync(join(neutral, 'package.json'), '{"type":"module"}\n');
      assert.deepEqual(bundleManifest(entry), comparison.manifests[variant]);
      const sequence = ordinal++, startedAt = new Date().toISOString(), started = performance.now();
      let result, runtimeVersion;
      if (browserMode) {
        activeRoot = dirname(entry);
        const browser = await launcher.launch({ headless: true, ...(config.runtime === 'chromium' && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
        try {
          runtimeVersion = browser.version();
          const page = await browser.newPage(); await page.goto(origin);
          if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('Cross-origin isolation required');
          result = finishSubject(await page.evaluate(measureSingle, { ...request, entryUrl: `${origin}/subject/${basename(entry)}`, harnessUrl: `${origin}/harness.mjs` }));
        } finally { await browser.close(); }
      } else {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--subject', JSON.stringify({ ...request, entryUrl: pathToFileURL(entry).href, harnessUrl: pathToFileURL(helper).href })], {
          encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' },
        });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout);
        result = JSON.parse(child.stdout); runtimeVersion = process.versions.bun ?? process.version;
      }
      assert.deepEqual(bundleManifest(entry), comparison.manifests[variant]);
      return { sequence, startedAt, subjectWallMs: performance.now() - started, runtimeVersion, ...result };
    };
    for (const workload of selected) {
      const row = { ...workload, pilots: {}, pilotOrder: shuffle(['baseline', 'candidate'], random), blocks: [] }; record.rows.push(row);
      for (const variant of row.pilotOrder) {
        row.pilots[variant] = await subject(variant, { workload, config, phase: 'pilot' });
      }
      assert.equal(row.pilots.baseline.digest, row.pilots.candidate.digest, `Pilot output differs: ${workload.name}`);
      const pilots = Object.values(row.pilots), repeat = Math.max(...pilots.map(p => p.repeat));
      const fastestMsPerScan = Math.min(...pilots.map(p => p.minMsPerScan));
      const requiredWarmupScans = Math.max(Math.ceil(config.warmupMinElements / workload.size), Math.ceil(config.warmupMs * 1.25 / fastestMsPerScan));
      const warmupScans = Math.ceil(requiredWarmupScans / repeat) * repeat;
      row.plan = { repeat, warmupScans, fastestPilotMsPerScan: fastestMsPerScan, expectedDigest: row.pilots.baseline.digest };
      const modes = ['ab'];
      if (workload.suite !== 'targets' || workload.size === 32) modes.push('aa-baseline');
      if (config.candidateAAFilter && new RegExp(config.candidateAAFilter).test(workload.name)) modes.push('aa-candidate');
      // Fix the whole schedule before observing any measured subject.
      row.schedule = Array.from({ length: config.blocks }, (_, block) => shuffle(modes, random).map(mode => {
        const roles = random() < 0.5 ? ['left', 'right', 'right', 'left'] : ['right', 'left', 'left', 'right'];
        return { block, mode, roles };
      })).flat();
      checkpoint();
      for (const planned of row.schedule) {
        const block = { ...planned, subjects: [] }; row.blocks.push(block);
        for (const role of planned.roles) {
          const build = planned.mode === 'ab' ? role === 'left' ? 'baseline' : 'candidate' : planned.mode === 'aa-baseline' ? 'baseline' : 'candidate';
          const result = await subject(build, { workload, config, phase: 'measure', repeat, warmupScans });
          assert.equal(result.digest, row.plan.expectedDigest, `Subject output differs: ${workload.name}/${planned.mode}`);
          block.subjects.push({ role, build, ...result });
        }
        checkpoint();
        console.log(`${config.runtime} ${workload.name} block ${planned.block + 1}/${config.blocks} ${planned.mode} ${planned.roles.join('-')}`);
      }
      row.summary = summarizeCase(row);
      for (const [mode, summary] of Object.entries(row.summary)) {
        assert.equal(summary.pairCount, config.blocks * 2);
        assert.equal(summary.pairs.filter(p => p.firstRole === 'left').length, config.blocks);
        assert.equal(summary.pairs.filter(p => p.firstRole === 'right').length, config.blocks);
        console.log(`${workload.name} ${mode}: ${summary.medianPairedRatio.toFixed(3)}x; independent pair range ${summary.pairRatioSpread.min.toFixed(3)}–${summary.pairRatioSpread.max.toFixed(3)}`);
      }
    }
    for (const variant of ['baseline', 'candidate']) assert.deepEqual(bundleManifest(comparison.paths[variant]), comparison.manifests[variant], 'A source bundle changed during the diagnostic');
    prepareComparison(baseline, candidate);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
  } catch (error) {
    record.status = 'failed'; record.finishedAt = new Date().toISOString(); record.error = String(error?.stack ?? error); checkpoint(); throw error;
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true }); comparison.cleanup();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
