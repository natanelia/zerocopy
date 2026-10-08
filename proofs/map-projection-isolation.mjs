import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve, join, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { median, sha256, workloadCases, prepareComparison, bundleManifest } from './map-projection-performance.mjs';

// Pin immutable source commits explicitly; never infer them from branch names.
const BASELINE_COMMIT = process.env.BASELINE_COMMIT;
const CANDIDATE_COMMIT = process.env.CANDIDATE_COMMIT;
const SHARED_HARNESS_SHA256 = 'f79bfdf9052ec7489315d0f7841658bffb7e748b82441fd669efbc2f51ae831d';
const CONTROL_CASES = [
  'ordered-updated/number/32/entries', 'ordered-updated/object/32/entries',
  'ordered-updated/number/4096/entries', 'ordered-updated/object/4096/entries',
  'sorted-custom/object/4096/entries', 'sorted-custom/object/4096/values',
];
const TARGET_CASES = ['ordered/object/4096/keys', 'ordered/number/4096/values'];

function configuration() {
  const numeric = (name, fallback, low, high, integer = false) => {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(n) || n < low || n > high || integer && !Number.isInteger(n)) throw new Error(`Invalid ${name}: ${n}`);
    return n;
  };
  const runtime = process.env.RUNTIME ?? 'firefox', suite = process.env.SUITE ?? 'all';
  if (!['node', 'bun', 'chromium', 'firefox', 'webkit'].includes(runtime)) throw new Error(`Invalid RUNTIME: ${runtime}`);
  if (!['all', 'controls', 'targets'].includes(suite)) throw new Error(`Invalid SUITE: ${suite}`);
  return {
    runtime, suite, blocks: numeric('BLOCKS', 4, 2, 12, true),
    samples: numeric('SAMPLES', ['node', 'bun'].includes(runtime) ? 21 : 15, 5, 100, true),
    targetBatchMs: numeric('TARGET_BATCH_MS', 10, 1, 100),
    warmupMs: numeric('WARMUP_MS', 150, 25, 1000),
    warmupMinElements: numeric('WARMUP_MIN_ELEMENTS', 1048576, 65536, 16777216, true),
    maxWarmupMs: numeric('MAX_WARMUP_MS', 10000, 1000, 30000),
    seed: numeric('SEED', 20261008, 1, 0xffffffff, true),
    caseFilter: process.env.CASE_FILTER ?? null,
    candidateAAFilter: process.env.CANDIDATE_AA_FILTER ?? (runtime === 'firefox' ? '^ordered-updated/(number|object)/32/entries$' : null),
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
async function measureSingle({ entryUrl, workload, config, phase, repeat: commonRepeat, warmupScans: commonWarmupScans }) {
  const S = await import(entryUrl);
  const { size, kind, type, operation, collection } = workload;
  S.resetOrderedMap(); S.resetSortedMap();
  let fixture;
  if (collection === 'set') {
    fixture = kind === 'ordered-set' ? new S.SharedOrderedSet()
      : new S.SharedSortedSet(kind === 'sorted-set-custom' ? (a, b) => b.localeCompare(a) : undefined);
    for (let i = 0; i < size; i++) fixture = fixture.add(type === 'number' ? i : `item-${i}`);
  } else {
    fixture = kind.startsWith('ordered') ? new S.SharedOrderedMap(type)
      : new S.SharedSortedMap(type, kind === 'sorted-custom' ? (a, b) => b.localeCompare(a) : undefined);
    for (let i = 0; i < size; i++) fixture = fixture.set(`key-${i}`, type === 'number' ? i : { i, text: 'Résumé 🙂 '.repeat(12), values: [i, i + 1, i + 2] });
    if (kind === 'ordered-updated') for (let i = 0; i < size; i += 8) {
      fixture = fixture.delete(`key-${i}`).set(`key-${i}`, type === 'number' ? -i : { i: -i, text: 'replacement' });
    }
  }
  // Identical fixture/digest semantics to the pinned paired harness, including -0.
  const expectedJson = JSON.stringify([...fixture[operation]()], (_key, value) => typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value)) ? { projectionNumber: Object.is(value, -0) ? '-0' : String(value) } : value);
  const scan = repeat => {
    let count = 0;
    for (let r = 0; r < repeat; r++) for (const value of fixture[operation]()) if (value !== undefined) count++;
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
function summarizeCase(row) {
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
    summary[mode] = {
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

function verifyPinnedSources(comparison) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const [variant, ref] of Object.entries({ baseline: BASELINE_COMMIT, candidate: CANDIDATE_COMMIT })) {
    for (const [file, digest] of Object.entries(comparison.sourceManifests[variant].files)) {
      if (file === 'bun.lock') continue; // Generated by bun install; both builds share the identical installed toolchain.
      const expected = spawnSync('git', ['show', `${ref}:${file}`], { cwd: repo, encoding: null, maxBuffer: 16 * 1024 * 1024 });
      if (expected.status !== 0 || sha256(expected.stdout) !== digest) throw new Error(`Source does not match pinned ${variant} ${ref}: ${file}`);
    }
  }
}

async function main() {
  if (process.argv[2] === '--subject') {
    const request = JSON.parse(process.argv[3]);
    console.log(JSON.stringify(finishSubject(await measureSingle(request))));
    return;
  }
  const [baseline, candidate, output = 'proofs/results/map-projection-isolation/result.json'] = process.argv.slice(2);
  if (!baseline || !candidate) throw new Error('Usage: BASELINE_COMMIT=SHA CANDIDATE_COMMIT=SHA RUNTIME=firefox SUITE=controls node proofs/map-projection-isolation.mjs BASE/dist/shared.js CANDIDATE/dist/shared.js OUTPUT.json');
  const config = configuration(), browserMode = !['node', 'bun'].includes(config.runtime), random = randomSource(config.seed);
  if (!browserMode && (config.runtime === 'bun') !== Boolean(process.versions.bun)) throw new Error('Run the controller with the selected Node/Bun executable');
  const selectedNames = config.suite === 'controls' ? CONTROL_CASES : config.suite === 'targets' ? TARGET_CASES : [...CONTROL_CASES, ...TARGET_CASES];
  const selected = shuffle(workloadCases(config.caseFilter).filter(row => selectedNames.includes(row.name)), random);
  if (!selected.length) throw new Error('No selected diagnostic workloads');
  const sharedHarness = new URL('./map-projection-performance.mjs', import.meta.url);
  assert.equal(sha256(readFileSync(sharedHarness)), SHARED_HARNESS_SHA256, 'The shared fixture/source-manifest harness changed');
  assert.match(BASELINE_COMMIT ?? '', /^[a-f0-9]{40}$/, 'BASELINE_COMMIT must be a full immutable commit SHA');
  assert.match(CANDIDATE_COMMIT ?? '', /^[a-f0-9]{40}$/, 'CANDIDATE_COMMIT must be a full immutable commit SHA');
  const comparison = prepareComparison(baseline, candidate, 'ab');
  verifyPinnedSources(comparison);
  assert.deepEqual(comparison.sourceDiff, ['shared-ordered-map.ts', 'shared-sorted-map.ts']);
  const temporary = mkdtempSync(join(os.tmpdir(), 'map-projection-single-build-'));
  const copies = {};
  // A/A subjects use independent full copies and independent runtime processes.
  for (const variant of ['baseline', 'candidate']) for (const role of ['left', 'right']) {
    const dir = join(temporary, `${variant}-${role}`);
    cpSync(dirname(comparison.paths[variant]), dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const path = join(dir, basename(comparison.paths[variant]));
    assert.deepEqual(bundleManifest(path), comparison.manifests[variant]);
    copies[`${variant}-${role}`] = path;
  }
  let activeRoot, origin, server, launcher;
  const record = {
    schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), config,
    baselineCommit: BASELINE_COMMIT, candidateCommit: CANDIDATE_COMMIT,
    sourcePaths: comparison.sourcePaths, sourceManifests: comparison.sourceManifests, sourceDiff: comparison.sourceDiff, manifests: comparison.manifests,
    harnessSha256: { singleBuild: sha256(readFileSync(fileURLToPath(import.meta.url))), sharedFixtureAndManifests: SHARED_HARNESS_SHA256 },
    controller: { node: process.version, bun: process.versions.bun ?? null, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
    caseOrder: selected.map(row => row.name), rows: [],
    method: 'One complete build, fixture, and lexical scan function per fresh runtime process. Browser subjects launch a new browser process and close it before the next subject; build URLs use the same /subject/ path. Disposable one-build pilots choose a common timed repeat count from the faster build and a common warmup scan count. These work counts are frozen before measurements and are identical across every A/B and A/A subject for that case. Four randomized ABBA/BAAB blocks provide eight adjacent process pairs per mode by default. A/B and baseline A/A blocks are interleaved in a seeded, predeclared order; candidate A/A is included for the configured Firefox small-entry cases. Subjects never run concurrently. All raw timings, warmup batches, pilots, digests, flags and launch order are retained. Summaries use per-process scan medians, then independent adjacent-pair ratios; they never pool individual batch samples as independent process replicates and never divide A/B by A/A. No sample is discarded or retried based on timing. Caps and short batches are diagnostic flags, not silently treated as steady state. Completion establishes that the protocol ran, not that performance is regression-free. Process startup, imports, fixture construction, output validation, and count assertions are outside timed scans.',
  };
  const checkpoint = () => {
    for (const row of record.rows) row.summary = summarizeCase(row);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  };
  try {
    if (browserMode) {
      const engines = await import('playwright'); launcher = engines[config.runtime];
      server = createServer((req, res) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Single-build projection diagnostic</title>'); return; }
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
    const subject = async (entry, request) => {
      const sequence = ordinal++, startedAt = new Date().toISOString(), started = performance.now();
      let result, runtimeVersion;
      if (browserMode) {
        activeRoot = dirname(entry);
        const browser = await launcher.launch({ headless: true, ...(config.runtime === 'chromium' && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
        try {
          runtimeVersion = browser.version();
          const page = await browser.newPage(); await page.goto(origin);
          if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('Cross-origin isolation required');
          result = finishSubject(await page.evaluate(measureSingle, { ...request, entryUrl: `${origin}/subject/${basename(entry)}` }));
        } finally { await browser.close(); }
      } else {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--subject', JSON.stringify({ ...request, entryUrl: pathToFileURL(entry).href })], {
          encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' },
        });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout);
        result = JSON.parse(child.stdout); runtimeVersion = process.versions.bun ?? process.version;
      }
      return { sequence, startedAt, subjectWallMs: performance.now() - started, runtimeVersion, ...result };
    };
    for (const workload of selected) {
      const row = { ...workload, pilots: {}, pilotOrder: shuffle(['baseline', 'candidate'], random), blocks: [] }; record.rows.push(row);
      for (const variant of row.pilotOrder) {
        row.pilots[variant] = await subject(copies[`${variant}-left`], { workload, config, phase: 'pilot' });
      }
      assert.equal(row.pilots.baseline.digest, row.pilots.candidate.digest, `Pilot output differs: ${workload.name}`);
      const pilots = Object.values(row.pilots), repeat = Math.max(...pilots.map(p => p.repeat));
      const fastestMsPerScan = Math.min(...pilots.map(p => p.minMsPerScan));
      const requiredWarmupScans = Math.max(Math.ceil(config.warmupMinElements / workload.size), Math.ceil(config.warmupMs * 1.25 / fastestMsPerScan));
      const warmupScans = Math.ceil(requiredWarmupScans / repeat) * repeat;
      row.plan = { repeat, warmupScans, fastestPilotMsPerScan: fastestMsPerScan, expectedDigest: row.pilots.baseline.digest };
      const modes = ['ab'];
      if (CONTROL_CASES.includes(workload.name)) modes.push('aa-baseline');
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
          const result = await subject(copies[`${build}-${role}`], { workload, config, phase: 'measure', repeat, warmupScans });
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
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
  } catch (error) {
    record.status = 'failed'; record.finishedAt = new Date().toISOString(); record.error = String(error?.stack ?? error); checkpoint(); throw error;
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true }); comparison.cleanup();
  }
}
await main();
