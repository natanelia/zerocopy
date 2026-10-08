import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, readdirSync, lstatSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, resolve, join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { median, sha256, workloadCases, prepareComparison, bundleManifest } from './map-projection-performance.mjs';

const PINS = Object.freeze({ baseline: '3773c6e519c7c0958da13727ed1082f449f3ee25', candidate: 'e24d28d588efbc2164aaa04de5ae52c06d334309' });
const SHARED_HARNESS_SHA256 = 'f3d44dd2ea1241440a9237b14fb9161a5e9536bab015cbae7197062ba500c2ba';
const CASES = Object.freeze([
  { group: 'node-bun', runtime: 'node', name: 'ordered/number/32/values' },
  { group: 'node-bun', runtime: 'node', name: 'sorted-custom/number/4096/values' },
  { group: 'node-bun', runtime: 'bun', name: 'sorted-custom/object/4096/values' },
  { group: 'webkit', runtime: 'webkit', name: 'ordered-updated/object/32/keys' },
  { group: 'firefox', runtime: 'firefox', name: 'ordered-updated/object/4096/entries' },
  { group: 'firefox', runtime: 'firefox', name: 'ordered/object/4096/values' },
]);
const QUARTETS = 4;
const SEED = 20261008;
const LATENCY_MARGIN = 1.02;
const CONFIDENCE_LEVEL = 0.95;
// Two-sided 95% Student t critical value, df = four quartet means minus one.
const T_CRITICAL_DF3 = 3.182446305284263;
const measurementConfig = runtime => ({ samples: ['node', 'bun'].includes(runtime) ? 21 : 15, targetBatchMs: 10, warmupMs: 150, warmupMinElements: 1048576, maxWarmupMs: 10000 });

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
  const { expectedJson, ...result } = raw;
  return { ...result, digest: sha256(expectedJson) };
}
function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], p10: sorted[Math.floor(sorted.length * 0.1)], median: median(sorted), p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) };
}
function intervalFromQuartetLogs(quartetLogMeans) {
  assert.equal(quartetLogMeans.length, QUARTETS);
  const meanLog = quartetLogMeans.reduce((a, b) => a + b, 0) / QUARTETS;
  const sampleVariance = quartetLogMeans.reduce((sum, value) => sum + (value - meanLog) ** 2, 0) / (QUARTETS - 1);
  const standardError = Math.sqrt(sampleVariance / QUARTETS), halfWidth = T_CRITICAL_DF3 * standardError;
  const estimate = Math.exp(meanLog), lower = Math.exp(meanLog - halfWidth), upper = Math.exp(meanLog + halfWidth);
  return {
    estimator: 'geometric mean of right/left process-median latency ratios, equally weighted by quartet',
    unit: 'quartet mean of two adjacent-pair log latency ratios', quartetCount: QUARTETS, degreesOfFreedom: 3,
    confidenceLevel: CONFIDENCE_LEVEL, sides: 2, criticalValue: T_CRITICAL_DF3,
    meanLogLatencyRatio: meanLog, quartetLogMeans, standardErrorLogRatio: standardError,
    geometricMeanLatencyRatio: estimate, lower, upper, declaredLatencyMargin: LATENCY_MARGIN,
    numericalInterpretation: lower > LATENCY_MARGIN ? 'detected_material_slowdown' : upper <= LATENCY_MARGIN ? 'within_declared_margin' : 'inconclusive',
  };
}
function summarizeCase(row) {
  const output = {};
  for (const mode of ['ab', 'aa-baseline']) {
    const blocks = row.blocks.filter(block => block.mode === mode), pairs = [], quartetLogMeans = [];
    for (const block of blocks) {
      if (block.subjects.length !== 4) continue;
      const quartetLogs = [];
      for (const i of [0, 2]) {
        const adjacent = block.subjects.slice(i, i + 2), left = adjacent.find(s => s.role === 'left'), right = adjacent.find(s => s.role === 'right');
        const leftMs = median(left.samples) / left.repeat, rightMs = median(right.samples) / right.repeat;
        const latencyRatio = rightMs / leftMs, logLatencyRatio = Math.log(latencyRatio);
        pairs.push({ block: block.block, pairInQuartet: i / 2, firstRole: adjacent[0].role, leftMsPerScan: leftMs, rightMsPerScan: rightMs, latencyRatio, speedup: 1 / latencyRatio, logLatencyRatio });
        quartetLogs.push(logLatencyRatio);
      }
      quartetLogMeans.push((quartetLogs[0] + quartetLogs[1]) / 2);
    }
    const subjects = blocks.flatMap(block => block.subjects);
    const flags = {
      belowTargetBatches: subjects.reduce((sum, s) => sum + s.belowTargetBatches, 0),
      warmupCappedSubjects: subjects.filter(s => s.warmup.capped).length,
      warmupTimeShortSubjects: subjects.filter(s => s.warmupTimeShort).length,
      warmupWorkShortSubjects: subjects.filter(s => s.warmupWorkShort).length,
    };
    output[mode] = {
      pairCount: pairs.length, pairs,
      descriptiveMedianLatencyRatio: pairs.length ? median(pairs.map(p => p.latencyRatio)) : null,
      descriptiveMedianSpeedup: pairs.length ? median(pairs.map(p => p.speedup)) : null,
      pairLatencyRatioSpread: pairs.length ? spread(pairs.map(p => p.latencyRatio)) : null,
      leftSubjectMsPerScan: subjects.some(s => s.role === 'left') ? spread(subjects.filter(s => s.role === 'left').map(s => median(s.samples) / s.repeat)) : null,
      rightSubjectMsPerScan: subjects.some(s => s.role === 'right') ? spread(subjects.filter(s => s.role === 'right').map(s => median(s.samples) / s.repeat)) : null,
      ...flags,
      measurementFlagsClear: Object.values(flags).every(value => value === 0),
      inference: quartetLogMeans.length === QUARTETS ? intervalFromQuartetLogs(quartetLogMeans) : null,
      comparison: mode === 'ab' ? 'right candidate / left baseline' : 'right baseline copy / left baseline copy; null-control variability only',
    };
  }
  return output;
}

// Include every copied regular file and directory; reject symlinks rather than
// following a variant-specific module/package path by accident.
function treeManifest(root) {
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), `Not a physical directory: ${root}`);
  const entries = [];
  const walk = dir => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name), name = relative(root, path).split(sep).join('/');
      if (item.isSymbolicLink()) throw new Error(`Symlink not permitted in copied build context: ${name}`);
      if (item.isDirectory()) { entries.push([name + '/', null]); walk(path); }
      else if (item.isFile()) entries.push([name, sha256(readFileSync(path))]);
      else throw new Error(`Non-regular build entry: ${name}`);
    }
  };
  walk(root);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
function sourceContext(entry) {
  assert.equal(basename(entry), 'shared.js');
  const dist = dirname(resolve(entry)), packagePath = join(dirname(dist), 'package.json');
  assert.ok(lstatSync(packagePath).isFile() && !lstatSync(packagePath).isSymbolicLink(), 'Source package.json must be a regular file');
  const packageBytes = readFileSync(packagePath), distFiles = treeManifest(dist);
  const manifest = Object.fromEntries([
    ['package.json', sha256(packageBytes)], ['dist/', null], ...Object.entries(distFiles).map(([name, digest]) => ['dist/' + name, digest]),
  ].sort(([a], [b]) => a.localeCompare(b)));
  return { entry: resolve(entry), dist, packagePath, packageBytes, manifest };
}
function currentSourceManifest(context) { return sourceContext(context.entry).manifest; }
function stageCanonical(context, canonicalRoot, runnerSource) {
  const sourceBefore = currentSourceManifest(context);
  assert.deepEqual(sourceBefore, context.manifest, 'Immutable source context changed before copy');
  rmSync(canonicalRoot, { recursive: true, force: true }); mkdirSync(canonicalRoot, { recursive: true });
  cpSync(context.dist, join(canonicalRoot, 'dist'), { recursive: true });
  // Preserve the complete original package context, not a synthesized type stub.
  writeFileSync(join(canonicalRoot, 'package.json'), context.packageBytes);
  writeFileSync(join(canonicalRoot, 'subject.mjs'), runnerSource);
  const expected = Object.fromEntries([...Object.entries(context.manifest), ['subject.mjs', sha256(runnerSource)]].sort(([a], [b]) => a.localeCompare(b)));
  const copied = treeManifest(canonicalRoot);
  assert.deepEqual(copied, expected, 'Canonical copied context differs before subject');
  const entry = join(canonicalRoot, 'dist', 'shared.js');
  assert.equal(realpathSync(entry), entry, 'Canonical entry must not resolve through a symlink');
  return { expected, copied, entry, sourceBefore };
}
function checkAfterSubject(context, canonicalRoot, expected) {
  const copied = treeManifest(canonicalRoot), source = currentSourceManifest(context);
  assert.deepEqual(copied, expected, 'Canonical copied context changed during subject');
  assert.deepEqual(source, context.manifest, 'Immutable source context changed during subject');
  return { copied, source };
}
function cleanSubjectEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (/^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|TZ|LC_[A-Z_]+)$/.test(name)) env[name] = value;
  // Only persistent loader/transpiler caches are disabled. JIT tiers stay normal.
  env.NODE_DISABLE_COMPILE_CACHE = '1';
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0';
  return env;
}
function verifyPinnedSources(comparison) {
  for (const [role, commit] of Object.entries(PINS)) {
    const cwd = dirname(dirname(comparison.paths[role]));
    for (const [file, digest] of Object.entries(comparison.sourceManifests[role].files)) {
      if (file === 'bun.lock') continue;
      const result = spawnSync('git', ['show', `${commit}:${file}`], { cwd, encoding: null, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0 || sha256(result.stdout) !== digest) throw new Error(`Source does not match ${role} ${commit}: ${file}`);
    }
  }
}

function selfTest() {
  assert.equal(intervalFromQuartetLogs([0, 0, 0, 0]).numericalInterpretation, 'within_declared_margin');
  assert.equal(intervalFromQuartetLogs(Array(4).fill(Math.log(1.03))).numericalInterpretation, 'detected_material_slowdown');
  assert.equal(intervalFromQuartetLogs([0.98, 1.01, 1.03, 1.04].map(Math.log)).numericalInterpretation, 'inconclusive');
  const geometric = Math.sqrt(1.04), result = intervalFromQuartetLogs(Array(4).fill(Math.log(geometric)));
  assert.ok(Math.abs(result.geometricMeanLatencyRatio - geometric) < 1e-12);
  assert.ok(Math.abs(result.geometricMeanLatencyRatio - 1.02) > 0.0001, 'CI estimator must not be the descriptive median');
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'projection-canonical-self-test-')));
  try {
    const packageText = '{"name":"fixture","type":"module","exports":{".":"./dist/shared.js"},"custom":"preserved"}\n';
    const make = (name, chunk) => {
      const base = join(root, name); mkdirSync(join(base, 'dist'), { recursive: true });
      writeFileSync(join(base, 'package.json'), packageText);
      writeFileSync(join(base, 'dist', 'shared.js'), `export { value } from './${chunk}.js';\n`);
      writeFileSync(join(base, 'dist', chunk + '.js'), 'export const value = 1;\n');
      return sourceContext(join(base, 'dist', 'shared.js'));
    };
    const a = make('a', 'chunk-a'), b = make('b', 'chunk-b'), canonical = join(root, 'subject'), runner = '// synthetic; never executed\n';
    const first = stageCanonical(a, canonical, runner); checkAfterSubject(a, canonical, first.expected);
    const second = stageCanonical(b, canonical, runner); assert.equal(first.entry, second.entry);
    assert.equal(readFileSync(join(canonical, 'package.json'), 'utf8'), packageText);
    assert.equal(existsSync(join(canonical, 'dist', 'chunk-a.js')), false);
    assert.equal(existsSync(join(canonical, 'dist', 'chunk-b.js')), true);
    checkAfterSubject(b, canonical, second.expected);
    writeFileSync(join(canonical, 'dist', 'chunk-b.js'), 'tampered');
    assert.throws(() => checkAfterSubject(b, canonical, second.expected), /changed during subject/);
    symlinkSync(join(b.dist, 'chunk-b.js'), join(a.dist, 'linked.js'));
    assert.throws(() => sourceContext(a.entry), /Symlink not permitted/);
    assert.ok(!Object.keys(cleanSubjectEnvironment()).some(key => /COMMIT|VARIANT|GITHUB|NODE_OPTIONS|BUN_OPTIONS/.test(key)));
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('Synthetic interval, canonical-copy, package-preservation, chunk replacement, tamper and symlink checks passed; no runtime workload executed.');
}

async function main() {
  if (process.argv[2] === '--self-test') { selfTest(); return; }
  const [baseline, candidate, group, output] = process.argv.slice(2);
  if (!baseline || !candidate || !['node-bun', 'firefox', 'webkit'].includes(group) || !output) throw new Error('Usage: node proofs/map-projection-focused-controls.mjs BASE/dist/shared.js CANDIDATE/dist/shared.js node-bun|firefox|webkit OUTPUT.json');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Controller must run on Node22');
  assert.equal(sha256(readFileSync(new URL('./map-projection-performance.mjs', import.meta.url))), SHARED_HARNESS_SHA256);
  const comparison = prepareComparison(baseline, candidate, 'ab'); assert.deepEqual(comparison.sourceDiff, ['shared-sorted-map.ts']); verifyPinnedSources(comparison);
  const contexts = { baseline: sourceContext(comparison.paths.baseline), candidate: sourceContext(comparison.paths.candidate) };
  assert.deepEqual(contexts.baseline.packageBytes, contexts.candidate.packageBytes, 'Module package context must match between builds');
  const definitions = CASES.filter(c => c.group === group), random = randomSource(SEED), all = workloadCases();
  const selected = definitions.map(def => ({ ...def, workload: all.find(row => row.name === def.name) }));
  for (const def of selected) assert.equal(def.workload?.classification, 'control');
  const temporary = realpathSync(mkdtempSync(join(os.tmpdir(), 'projection-fixed-path-'))), canonicalRoot = join(temporary, 'subject');
  const runnerSource = `${measureSingle.toString()}\nconst request = JSON.parse(process.argv[2]);\nrequest.entryUrl = new URL('./dist/shared.js', import.meta.url).href;\nconst result = await measureSingle(request);\nconsole.log(JSON.stringify({ ...result, runtimeVersions: { node: process.versions.node, bun: process.versions.bun ?? null } }));\n`;
  const childEnv = cleanSubjectEnvironment();
  const executables = { node: realpathSync(process.execPath) };
  if (group === 'node-bun') {
    assert.ok(process.env.BUN_EXECUTABLE, 'BUN_EXECUTABLE must name the installed Bun binary'); executables.bun = realpathSync(process.env.BUN_EXECUTABLE);
    const probe = spawnSync(executables.bun, ['--version'], { encoding: 'utf8', env: childEnv }); assert.equal(probe.status, 0); assert.equal(probe.stdout.trim(), '1.4.2');
  }
  let server, origin, launcher, ordinal = 0;
  const record = {
    schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), group,
    baselineCommit: PINS.baseline, candidateCommit: PINS.candidate,
    sourcePaths: comparison.sourcePaths, sourceManifests: comparison.sourceManifests, sourceDiff: comparison.sourceDiff, manifests: comparison.manifests,
    completeCopiedSourceContexts: Object.fromEntries(Object.entries(contexts).map(([name, context]) => [name, context.manifest])),
    harnessSha256: { controller: sha256(readFileSync(fileURLToPath(import.meta.url))), measuredKernel: sha256(measureSingle.toString()), canonicalSubjectRunner: sha256(runnerSource), sharedFixtureAndManifests: SHARED_HARNESS_SHA256 },
    canonicalEntryPath: join(canonicalRoot, 'dist', 'shared.js'), canonicalRunnerPath: join(canonicalRoot, 'subject.mjs'),
    controller: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model }, executables,
    runtimeSettings: { childEnvironmentKeys: Object.keys(childEnv).sort(), NODE_DISABLE_COMPILE_CACHE: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', jitAndOptimizationTiers: 'unchanged defaults', browserProcesses: 'fresh for every subject', httpCacheControl: 'no-store' },
    preregistration: {
      allSixCases: CASES, selectedCases: definitions, quartetBlocksPerMode: QUARTETS, processPairsPerMode: 8, seed: SEED,
      latencyMargin: LATENCY_MARGIN, confidenceLevel: CONFIDENCE_LEVEL, interval: 'two-sided Student t over four quartet mean log latency ratios, df3',
      interpretation: 'lowerCI > 1.02: detected material slowdown; upperCI <= 1.02: evidence within declared margin; otherwise inconclusive. Intervals attach to the geometric-mean latency estimator, never descriptive medians. Pointwise intervals; no simultaneous or exact-zero claim. Measurement flags are reported alongside the numerical interpretation and restrict acceptance.',
      stoppingRule: 'One fixed batch; no sample filtering, timing-driven retries, extra quartets, or favorable-run selection. A/A is displayed directly, never subtracted or divided out.',
      priorRejection: 'The independently measured approximately4% Firefox loss in the earlier broad e206 variant remains rejected; this study only evaluates current-main377 versus sorted-onlye24.',
    },
    rows: [],
    method: 'Exactly the six predeclared runtime/workload cells. The Node22/Bun1.4.2 group shares one x64 runner and executes subjects serially; Firefox/WebKit groups run serially on their own clean x64 runners. Before every pilot or measured subject, the complete selected dist tree and exact original package.json are physically copied to the SAME canonical subject/dist/shared.js path; no variant URL or symlink is used. Content-hashed chunk names are unchanged. Every source/canonical file hash is checked before and after each subject and retained. Node/Bun execute a thin canonical subject.mjs containing only the unchanged one-build measurement kernel and fixed relative import; no variant labels, pins, or original source paths enter that kernel or its input. Browser subjects use one fixed HTTP URL backed by that same canonical directory and a fresh browser process. Only persistent loader/transpiler caches are disabled; no JIT tier or optimization flag is changed. Imports, staging, hashes, setup and validation are untimed. Disposable pilots freeze equal warmup scans and timed repeats for both builds. Four ABBA/BAAB quartets per mode balance adjacent-pair first order; A/B and baseline A/A modes are interleaved with balanced mode-first positions. All samples, flags and absolute timings are retained. Inference uses four quartet averages of the two pair log latency ratios, not pooled timed batches.',
  };
  const checkpoint = () => { for (const row of record.rows) row.summary = summarizeCase(row); mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); };
  try {
    if (group !== 'node-bun') {
      launcher = (await import('playwright'))[group];
      server = createServer((req, res) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Focused projection controls</title>'); return; }
        const path = resolve(canonicalRoot, '.' + new URL(req.url, 'http://localhost').pathname);
        if (!path.startsWith(canonicalRoot + sep)) { res.writeHead(404); res.end(); return; }
        try { res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.json') ? 'application/json' : 'text/javascript'); res.end(readFileSync(path)); }
        catch { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    }
    const subject = async (build, runtime, request) => {
      const context = contexts[build], staged = stageCanonical(context, canonicalRoot, runnerSource);
      const sequence = ordinal++, startedAt = new Date().toISOString(), started = performance.now();
      let raw, runtimeVersion, after;
      try {
        if (group === 'node-bun') {
          const child = spawnSync(executables[runtime], [join(canonicalRoot, 'subject.mjs'), JSON.stringify(request)], { cwd: canonicalRoot, env: childEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
          if (child.status !== 0) throw new Error(child.stderr || child.stdout);
          raw = JSON.parse(child.stdout);
          if (runtime === 'node') { assert.equal(raw.runtimeVersions.bun, null); assert.equal(raw.runtimeVersions.node, process.versions.node); runtimeVersion = raw.runtimeVersions.node; }
          else { assert.equal(raw.runtimeVersions.bun, '1.4.2'); runtimeVersion = raw.runtimeVersions.bun; }
        } else {
          const browser = await launcher.launch({ headless: true });
          try { runtimeVersion = browser.version(); const page = await browser.newPage(); await page.goto(origin); if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('Cross-origin isolation required'); raw = await page.evaluate(measureSingle, { ...request, entryUrl: `${origin}/dist/shared.js` }); }
          finally { await browser.close(); }
        }
      } finally { after = checkAfterSubject(context, canonicalRoot, staged.expected); }
      record.subjectRuntimeVersions ??= {};
      if (record.subjectRuntimeVersions[runtime]) assert.equal(runtimeVersion, record.subjectRuntimeVersions[runtime], 'Runtime version changed during study');
      else record.subjectRuntimeVersions[runtime] = runtimeVersion;
      return { sequence, startedAt, subjectWallMs: performance.now() - started, runtime, runtimeVersion,
        staging: { sourceBefore: staged.sourceBefore, canonicalBefore: staged.copied, canonicalAfter: after.copied, sourceAfter: after.source }, ...finishSubject(raw) };
    };
    for (const def of selected) {
      const workload = def.workload, config = measurementConfig(def.runtime);
      // These inputs contain workload/config data only, never variant metadata.
      const row = { ...workload, runtime: def.runtime, measurementConfig: config, pilots: {}, pilotOrder: shuffle(['baseline', 'candidate'], random), blocks: [] }; record.rows.push(row);
      for (const build of row.pilotOrder) row.pilots[build] = await subject(build, def.runtime, { workload, config, phase: 'pilot' });
      assert.equal(row.pilots.baseline.digest, row.pilots.candidate.digest);
      const pilots = Object.values(row.pilots), repeat = Math.max(...pilots.map(p => p.repeat)), fastest = Math.min(...pilots.map(p => p.minMsPerScan));
      const warmupScans = Math.ceil(Math.max(Math.ceil(config.warmupMinElements / workload.size), Math.ceil(config.warmupMs * 1.25 / fastest)) / repeat) * repeat;
      row.plan = { repeat, warmupScans, expectedDigest: row.pilots.baseline.digest, fastestPilotMsPerScan: fastest };
      const modeOrders = shuffle([['ab', 'aa-baseline'], ['aa-baseline', 'ab'], ['aa-baseline', 'ab'], ['ab', 'aa-baseline']], random);
      row.schedule = modeOrders.flatMap((modes, block) => modes.map(mode => ({ block, mode, roles: random() < 0.5 ? ['left', 'right', 'right', 'left'] : ['right', 'left', 'left', 'right'] })));
      checkpoint();
      for (const planned of row.schedule) {
        const block = { ...planned, subjects: [] }; row.blocks.push(block);
        for (const role of planned.roles) {
          const build = planned.mode === 'aa-baseline' || role === 'left' ? 'baseline' : 'candidate';
          const result = await subject(build, def.runtime, { workload, config, phase: 'measure', repeat, warmupScans });
          assert.equal(result.digest, row.plan.expectedDigest); block.subjects.push({ role, build, ...result });
        }
        checkpoint(); console.log(`${def.runtime} ${workload.name} quartet ${planned.block + 1}/${QUARTETS} ${planned.mode} ${planned.roles.join('-')}`);
      }
      row.summary = summarizeCase(row);
      for (const [mode, summary] of Object.entries(row.summary)) {
        assert.equal(summary.pairCount, 8); assert.equal(summary.pairs.filter(p => p.firstRole === 'left').length, 4);
        const ci = summary.inference; console.log(`${def.runtime} ${workload.name} ${mode}: geometric latency ${ci.geometricMeanLatencyRatio.toFixed(5)}, 95% quartet-t CI [${ci.lower.toFixed(5)}, ${ci.upper.toFixed(5)}], ${ci.numericalInterpretation}; flags clear=${summary.measurementFlagsClear}`);
      }
    }
    for (const role of ['baseline', 'candidate']) { assert.deepEqual(currentSourceManifest(contexts[role]), contexts[role].manifest); assert.deepEqual(bundleManifest(comparison.paths[role]), comparison.manifests[role]); }
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
  } catch (error) { record.status = 'failed'; record.finishedAt = new Date().toISOString(); record.error = String(error?.stack ?? error); checkpoint(); throw error; }
  finally { if (server?.listening) await new Promise(resolve => server.close(resolve)); rmSync(temporary, { recursive: true, force: true }); comparison.cleanup(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
