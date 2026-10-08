import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { median, sha256, workloadCases, prepareComparison, bundleManifest } from './map-projection-performance.mjs';

// One failing workload, immutable sources, and no production edits.
const PINS = Object.freeze({
  baseline: '3331f2f0e9e0c3c61832e5f04b12e18c1889d96c',
  'ordered-only': 'da448d13e6c6298933b69021ffaf15edb3046427',
  'sorted-only': 'd129c53f0e0f3db220c80f25f22cdaca2db31eac',
  full: 'e206725cf53bf07864fc05e76a39d794ad1c88c4',
});
const ALLOWED_DIFFS = Object.freeze({
  'ordered-only': ['shared-ordered-map.ts'],
  'sorted-only': ['shared-sorted-map.ts'],
  full: ['shared-ordered-map.ts', 'shared-sorted-map.ts'],
});
const WORKLOAD = 'sorted-custom/object/4096/entries';
const SHARED_HARNESS_SHA256 = 'f79bfdf9052ec7489315d0f7841658bffb7e748b82441fd669efbc2f51ae831d';
const MEASUREMENT_REFERENCE_COMMIT = PINS.full;

function configuration() {
  const numeric = (name, fallback, low, high, integer = false) => {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(n) || n < low || n > high || integer && !Number.isInteger(n)) throw new Error(`Invalid ${name}: ${n}`);
    return n;
  };
  const blocks = numeric('BLOCKS', 4, 4, 12, true);
  if (blocks % 4) throw new Error('BLOCKS must be a multiple of four for balanced source-comparison positions');
  return {
    runtime: 'firefox', blocks,
    samples: numeric('SAMPLES', 15, 5, 100, true),
    targetBatchMs: numeric('TARGET_BATCH_MS', 10, 1, 100),
    warmupMs: numeric('WARMUP_MS', 150, 25, 1000),
    warmupMinElements: numeric('WARMUP_MIN_ELEMENTS', 1048576, 65536, 16777216, true),
    maxWarmupMs: numeric('MAX_WARMUP_MS', 10000, 1000, 30000),
    seed: numeric('SEED', 20261008, 1, 0xffffffff, true),
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

function pinnedSource(entry, commit, sourceManifest) {
  // Sibling source commits can live in their own exact-SHA checkout. Archive
  // directories work too when their parent Git repository contains that SHA.
  const cwd = dirname(dirname(resolve(entry)));
  const git = args => {
    const result = spawnSync('git', args, { cwd, encoding: null, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Cannot inspect pinned source ${commit}: ${result.stderr}`);
    return result.stdout;
  };
  const tree = git(['rev-parse', `${commit}^{tree}`]).toString().trim();
  assert.match(tree, /^[0-9a-f]{40}$/);
  for (const [file, digest] of Object.entries(sourceManifest.files)) {
    if (file === 'bun.lock') continue; // Generated install record; all builds use one shared toolchain.
    assert.equal(sha256(git(['show', `${commit}:${file}`])), digest, `Source differs from ${commit}: ${file}`);
  }
  return { commit, tree };
}

async function main() {
  const [baseline, ordered, sorted, full, output = 'proofs/results/map-projection-source-split/firefox.json'] = process.argv.slice(2);
  if (!baseline || !ordered || !sorted || !full) throw new Error('Usage: node proofs/map-projection-source-split.mjs BASE/dist/shared.js ORDERED_ONLY/dist/shared.js SORTED_ONLY/dist/shared.js FULL/dist/shared.js OUTPUT.json');
  const config = configuration(), random = randomSource(config.seed);
  const workload = workloadCases(`^${WORKLOAD}$`)[0];
  const entries = { baseline: resolve(baseline), 'ordered-only': resolve(ordered), 'sorted-only': resolve(sorted), full: resolve(full) };
  assert.equal(sha256(readFileSync(new URL('./map-projection-performance.mjs', import.meta.url))), SHARED_HARNESS_SHA256, 'Shared fixture/manifest helper changed');
  const comparisons = {}, sources = {};
  for (const variant of ['ordered-only', 'sorted-only', 'full']) {
    const comparison = prepareComparison(entries.baseline, entries[variant], 'ab');
    assert.deepEqual(comparison.sourceDiff, ALLOWED_DIFFS[variant], `${variant} includes an unexpected production/build difference`);
    comparisons[variant] = comparison;
    if (!sources.baseline) sources.baseline = {
      ...pinnedSource(entries.baseline, PINS.baseline, comparison.sourceManifests.baseline),
      entry: entries.baseline, sourceManifest: comparison.sourceManifests.baseline, bundleManifest: comparison.manifests.baseline,
    };
    assert.deepEqual(comparison.manifests.baseline, sources.baseline.bundleManifest);
    sources[variant] = {
      ...pinnedSource(entries[variant], PINS[variant], comparison.sourceManifests.candidate),
      entry: entries[variant], sourceManifest: comparison.sourceManifests.candidate, bundleManifest: comparison.manifests.candidate,
      sourceDiff: comparison.sourceDiff,
    };
  }
  // Each split must contain the exact final wrapper, not a similar older patch.
  assert.equal(sources['ordered-only'].sourceManifest.files['shared-ordered-map.ts'], sources.full.sourceManifest.files['shared-ordered-map.ts']);
  assert.equal(sources['sorted-only'].sourceManifest.files['shared-sorted-map.ts'], sources.full.sourceManifest.files['shared-sorted-map.ts']);
  assert.equal(sources['ordered-only'].tree, '921d808a48ddb267dd78ca81bf6a4ed774a0b231');
  assert.equal(sources['sorted-only'].tree, '2e424f2acb479c314ddd51609e6a0b7fe08b4ed3');
  assert.equal(sources.full.tree, '55542bf8c75cfb4b4e18ce4e71d3b2543c6f00ef');

  const temporary = mkdtempSync(join(os.tmpdir(), 'map-projection-source-split-'));
  const copies = {};
  for (const [build, entry] of Object.entries(entries)) for (const role of ['left', 'right']) {
    const root = join(temporary, `${build}-${role}`);
    cpSync(dirname(entry), root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    const path = join(root, basename(entry));
    assert.deepEqual(bundleManifest(path), sources[build].bundleManifest, `Copied bundle changed: ${build}/${role}`);
    copies[`${build}-${role}`] = path;
  }
  let activeRoot, server, origin, ordinal = 0;
  const record = {
    schemaVersion: 1, experiment: 'ordered/sorted source-split; one Firefox workload', status: 'running', startedAt: new Date().toISOString(),
    config, workload: WORKLOAD, sourcePins: PINS, sources,
    harnessSha256: { sourceSplit: sha256(readFileSync(fileURLToPath(import.meta.url))), sharedFixtureAndManifests: SHARED_HARNESS_SHA256 },
    measurementReferenceCommit: MEASUREMENT_REFERENCE_COMMIT,
    controller: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
    rows: [],
    method: 'One failing workload only: sorted-custom/object/4096/entries. Main is compared with ordered-only, sorted-only, and full immutable variants, plus byte-identical baseline A/A. All four builds are source-verified against their Git commits; wrapper content and exact allowed source differences are checked before measurement. The single-build fixture, scanner, pilot/warmup and summarization kernels are unchanged from the reviewed e206 isolation protocol. One disposable pilot per build chooses a GLOBAL common timed repeat count and equal warmup scan count from the fastest build; these counts are frozen for every comparison and subject. Every subject starts a fresh Firefox browser process, imports one complete build at the same /subject/ URL, and closes before the next subject. The four comparison modes are serially interleaved with a seeded balanced Williams schedule on one CI runner: each mode occupies each comparison position once, and each directed within-block predecessor pair occurs once per four-block group. Each mode uses ABBA or BAAB, giving eight adjacent independent process pairs and balanced first-role order after four blocks. All raw samples, pilots, process order, source/bundle/harness hashes, digests and warmup/batch flags are retained. No timing-based sample filtering, retries, or A/A normalization. Ratios are main/variant, except the null A/A ratio between two identical main copies. Summaries are medians of adjacent-process median ratios, not pooled batch ratios. Source splitting can localize an association with a wrapper or their interaction; it cannot by itself prove a particular JIT mechanism. No performance threshold is used to turn measurement completion into acceptance.',
  };
  const checkpoint = () => {
    for (const row of record.rows) row.summary = summarizeCase(row);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  };
  try {
    const { firefox } = await import('playwright');
    server = createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Projection source-split diagnostic</title>'); return; }
      const [, subject, ...parts] = new URL(req.url, 'http://localhost').pathname.split('/');
      const path = activeRoot && resolve(activeRoot, ...parts);
      if (subject !== 'subject' || !path || !path.startsWith(activeRoot + sep)) { res.writeHead(404); res.end(); return; }
      try { res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(readFileSync(path)); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const subject = async (entry, request) => {
      const sequence = ordinal++, startedAt = new Date().toISOString(), started = performance.now();
      activeRoot = dirname(entry);
      const browser = await firefox.launch({ headless: true });
      let result, runtimeVersion;
      try {
        runtimeVersion = browser.version();
        const page = await browser.newPage(); await page.goto(origin);
        if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('Cross-origin isolation required');
        result = finishSubject(await page.evaluate(measureSingle, { ...request, entryUrl: `${origin}/subject/${basename(entry)}` }));
      } finally { await browser.close(); }
      return { sequence, startedAt, subjectWallMs: performance.now() - started, runtimeVersion, ...result };
    };
    const row = { ...workload, pilots: {}, pilotOrder: shuffle(Object.keys(entries), random), blocks: [] }; record.rows.push(row);
    for (const build of row.pilotOrder) row.pilots[build] = await subject(copies[`${build}-left`], { workload, config, phase: 'pilot' });
    const expectedDigest = row.pilots.baseline.digest;
    for (const pilot of Object.values(row.pilots)) assert.equal(pilot.digest, expectedDigest, 'Pilot outputs differ across source variants');
    const pilots = Object.values(row.pilots), repeat = Math.max(...pilots.map(p => p.repeat));
    const fastestMsPerScan = Math.min(...pilots.map(p => p.minMsPerScan));
    const requiredWarmupScans = Math.max(Math.ceil(config.warmupMinElements / workload.size), Math.ceil(config.warmupMs * 1.25 / fastestMsPerScan));
    const warmupScans = Math.ceil(requiredWarmupScans / repeat) * repeat;
    row.plan = { repeat, warmupScans, fastestPilotMsPerScan: fastestMsPerScan, expectedDigest };
    const modes = ['ordered-only', 'sorted-only', 'full', 'aa-baseline'];
    // Fix every comparison and role order before observing measured subjects.
    const williams = [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]];
    row.schedule = [];
    for (let group = 0; group < config.blocks; group += 4) {
      const labels = shuffle(modes, random), designs = shuffle(williams, random);
      for (let offset = 0; offset < 4; offset++) for (let position = 0; position < 4; position++) {
        row.schedule.push({ block: group + offset, position, mode: labels[designs[offset][position]],
          roles: random() < 0.5 ? ['left', 'right', 'right', 'left'] : ['right', 'left', 'left', 'right'] });
      }
    }
    for (const mode of modes) for (let position = 0; position < 4; position++) {
      assert.equal(row.schedule.filter(item => item.mode === mode && item.position === position).length, config.blocks / 4);
    }
    checkpoint();
    for (const planned of row.schedule) {
      const block = { ...planned, subjects: [] }; row.blocks.push(block);
      for (const role of planned.roles) {
        const build = role === 'left' || planned.mode === 'aa-baseline' ? 'baseline' : planned.mode;
        const result = await subject(copies[`${build}-${role}`], { workload, config, phase: 'measure', repeat, warmupScans });
        assert.equal(result.digest, expectedDigest, `Subject output differs: ${planned.mode}/${role}`);
        block.subjects.push({ role, build, sourceCommit: PINS[build], ...result });
      }
      checkpoint();
      console.log(`firefox ${WORKLOAD} block ${planned.block + 1}/${config.blocks} ${planned.mode} ${planned.roles.join('-')}`);
    }
    row.summary = summarizeCase(row);
    for (const [mode, summary] of Object.entries(row.summary)) {
      assert.equal(summary.pairCount, config.blocks * 2);
      assert.equal(summary.pairs.filter(p => p.firstRole === 'left').length, config.blocks);
      assert.equal(summary.pairs.filter(p => p.firstRole === 'right').length, config.blocks);
      console.log(`${mode}: ${summary.medianPairedRatio.toFixed(4)}x; pair range ${summary.pairRatioSpread.min.toFixed(4)}–${summary.pairRatioSpread.max.toFixed(4)}`);
    }
    for (const [build, entry] of Object.entries(entries)) assert.deepEqual(bundleManifest(entry), sources[build].bundleManifest, `Bundle changed during experiment: ${build}`);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
  } catch (error) {
    record.status = 'failed'; record.finishedAt = new Date().toISOString(); record.error = String(error?.stack ?? error); checkpoint(); throw error;
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
    for (const comparison of Object.values(comparisons)) comparison.cleanup();
  }
}
await main();
