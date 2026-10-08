import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, lstatSync, realpathSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

export const PINS = Object.freeze({
  main: '3331f2f0e9e0c3c61832e5f04b12e18c1889d96c',
  old: 'c5a242cd641e4ee96005296fab485e332a1394b7',
  narrow: 'b1e3d9d27b55ce5c4a0267f99b72c6862a58bf59',
});
export const CASES = Object.freeze([
  { kind: 'list', type: 'number', size: 0, name: 'list/number/0' },
  { kind: 'linked', type: 'number', size: 31, name: 'linked/number/31' },
  { kind: 'doubly', type: 'number', size: 32, name: 'doubly/number/32' },
  { kind: 'linked', type: 'boolean', size: 32, name: 'linked/boolean/32' },
].map(Object.freeze));
// Deliberately fixed before the run: there are no timing/tuning environment
// overrides, and pilots never change warmup, GC policy or sample counts.
export const PROTOCOL = Object.freeze({
  version: 1, runtime: 'bun', bunVersion: '1.4.2', platform: 'linux', arch: 'arm64',
  warmupCalls: 512, warmupGcEveryCalls: 32,
  pilotReplicates: 3, pilotRepeat: 64, pilotSamples: 5,
  targetBatchMs: 20, maxRepeat: 2048, samplesPerSubject: 15, cycles: 6,
  subjectTimeoutMs: 120000, gcBeforeEveryBatch: true, gcInsideTimedRegion: false,
  automaticGcMayOccurInsideTimedRegion: true,
});
export const COMPARISONS = Object.freeze([
  { name: 'main-vs-old', a: 'main', b: 'old' },
  { name: 'main-vs-narrow', a: 'main', b: 'narrow' },
  { name: 'main-vs-main-aa', a: 'main', b: 'main' },
].map(Object.freeze));
export const median = values => {
  assert.ok(values.length); const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const harness = fileURLToPath(import.meta.url);
const root = resolve(dirname(harness), '..');
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
export const guardedPath = name => !name.includes('/') && (/\.(?:ts|wasm)$/.test(name) && !name.endsWith('.test.ts') || name === 'package.json')
  || /^scripts\/build-[^/]+$/.test(name);
export function assertOnlyCompactionDiff(main, candidate) {
  const names = [...new Set([...Object.keys(main), ...Object.keys(candidate)])].sort();
  assert.deepEqual(names.filter(name => main[name] !== candidate[name]), ['compaction.ts']);
}
export function buildManifest(directory) {
  assert.equal(realpathSync(directory), resolve(directory), 'Bundle root must be a canonical directory, not a symlink');
  const files = {};
  const visit = (path, prefix = '') => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name), relative = prefix + name, stat = lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, `Bundle symlink is forbidden: ${relative}`);
      if (stat.isDirectory()) visit(file, relative + '/');
      else { assert.ok(stat.isFile(), `Unexpected bundle entry: ${relative}`); files[relative] = sha256(readFileSync(file)); }
    }
  };
  visit(directory); return files;
}
export const buildDigest = directory => sha256(JSON.stringify(buildManifest(directory)));
export function materializeBundle(source, neutral, expectedDigest) {
  assert.notEqual(resolve(source), resolve(neutral));
  assert.equal(realpathSync(neutral), resolve(neutral), 'Neutral directory must not resolve through a symlink');
  assert.equal(buildDigest(source), expectedDigest, 'Source bundle changed before copying');
  for (const name of readdirSync(neutral)) rmSync(join(neutral, name), { recursive: true, force: true });
  cpSync(source, neutral, { recursive: true, dereference: false });
  assert.equal(buildDigest(neutral), expectedDigest, 'Copied bundle differs from its source');
  assert.equal(realpathSync(join(neutral, 'shared.js')), join(resolve(neutral), 'shared.js'));
  return pathToFileURL(join(neutral, 'shared.js')).href;
}
export function neutralRequest(spec, neutralDirectory, digest) {
  // Deliberate allowlist: no role, variant label, pin or source checkout path
  // enters the child request or the collection-measurement kernel.
  return { phase: spec.phase, caseName: spec.caseName, repeat: spec.phase === 'pilot' ? PROTOCOL.pilotRepeat : spec.repeat,
    workPlanSHA256: spec.workPlanSHA256 ?? null, neutralDirectory, buildDigest: digest };
}
export function subjectEnvironment(environment) {
  const next = { ...environment };
  for (const key of ['FOCUSED_MAIN_DIR', 'FOCUSED_OLD_DIR', 'FOCUSED_NARROW_DIR']) delete next[key];
  return next;
}
function runtimeMetadata() {
  return { bun: process.versions.bun, node: process.versions.node, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), execArgv: process.execArgv };
}
function requireRuntime() {
  assert.equal(process.versions.bun, PROTOCOL.bunVersion, 'This diagnostic is pinned to Bun 1.4.2');
  assert.equal(process.platform, PROTOCOL.platform); assert.equal(process.arch, PROTOCOL.arch);
}
export function measurementSchedule() {
  const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2], [2, 0, 1], [0, 2, 1]];
  const schedule = [];
  for (let cycle = 0; cycle < PROTOCOL.cycles; cycle++) {
    const caseOrder = CASES.map((_value, index) => (index + cycle) % CASES.length);
    if (cycle % 2) caseOrder.reverse();
    for (const caseIndex of caseOrder) for (const comparisonIndex of orders[cycle]) {
      const comparison = COMPARISONS[comparisonIndex];
      const order = (cycle + comparisonIndex) % 2 ? ['B', 'A', 'A', 'B'] : ['A', 'B', 'B', 'A'];
      schedule.push({ cycle, case: CASES[caseIndex], comparison, order });
    }
  }
  return schedule;
}
export function chooseWorkPlan(pilots) {
  const plans = {};
  for (const workload of CASES) {
    const perBuild = {};
    for (const variant of Object.keys(PINS)) {
      const selected = pilots.filter(row => row.variant === variant && row.case.name === workload.name);
      assert.equal(selected.length, PROTOCOL.pilotReplicates, `Missing pilots: ${variant}/${workload.name}`);
      assert.deepEqual(selected.map(row => row.replicate).sort(), [0, 1, 2], 'Pilot replicates must be distinct');
      for (const row of selected) {
        assert.equal(row.result.repeat, PROTOCOL.pilotRepeat);
        assert.equal(row.result.samples.length, PROTOCOL.pilotSamples);
        assert.ok(row.result.samples.every(sample => Number.isFinite(sample.perOperationMs) && sample.perOperationMs > 0));
      }
      perBuild[variant] = median(selected.map(row => median(row.result.samples.map(sample => sample.perOperationMs))));
    }
    // The fastest build's median pilot rate sizes the common batch. Every
    // measured build and A/A role uses this one count without recalibration.
    const fastestMedianMs = Math.min(...Object.values(perBuild));
    const requestedRepeat = Math.max(1, Math.ceil(PROTOCOL.targetBatchMs / fastestMedianMs));
    let repeat = 1; while (repeat < requestedRepeat && repeat < PROTOCOL.maxRepeat) repeat *= 2;
    plans[workload.name] = { repeat, requestedRepeat, perBuildMedianMs: perBuild, fastestMedianMs,
      capped: requestedRepeat > PROTOCOL.maxRepeat, predictedFastestBatchMs: repeat * fastestMedianMs };
  }
  return plans;
}
export function summarizeQuartet(row) {
  assert.equal(row.subjects.length, 4);
  const a = row.subjects.filter(subject => subject.role === 'A').map(subject => subject.result.medianMs);
  const b = row.subjects.filter(subject => subject.role === 'B').map(subject => subject.result.medianMs);
  assert.equal(a.length, 2); assert.equal(b.length, 2);
  return { aMedianMs: median(a), bMedianMs: median(b), ratio: median(a) / median(b),
    shortBatches: row.subjects.reduce((sum, subject) => sum + subject.result.shortBatches, 0) };
}

function verifySources(directories) {
  const tracked = {}, files = new Set();
  for (const [variant, directory] of Object.entries(directories)) {
    assert.equal(git(directory, 'rev-parse', 'HEAD'), PINS[variant], `Wrong ${variant} commit`);
    tracked[variant] = git(directory, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    for (const name of [...tracked[variant], ...readdirSync(directory), ...readdirSync(join(directory, 'scripts')).map(name => `scripts/${name}`)]) {
      if (guardedPath(name)) files.add(name);
    }
  }
  const paths = [...files].sort(), sources = {}, builds = {}, state = {};
  for (const [variant, directory] of Object.entries(directories)) {
    const trackedSet = new Set(tracked[variant]);
    sources[variant] = Object.fromEntries(paths.map(name => [name, existsSync(join(directory, name)) ? sha256(readFileSync(join(directory, name))) : null]));
    const changedTrackedPaths = git(directory, 'diff', '--name-only', 'HEAD', '--', ...paths).split('\n').filter(Boolean);
    const untrackedSourcePaths = paths.filter(name => sources[variant][name] !== null && !trackedSet.has(name) && !name.endsWith('.wasm'));
    assert.deepEqual(changedTrackedPaths, [], `Dirty ${variant} production`); assert.deepEqual(untrackedSourcePaths, [], `Untracked ${variant} production`);
    for (const name of paths.filter(name => !name.endsWith('.wasm'))) {
      assert.equal(sha256(execFileSync('git', ['-C', directory, 'show', `${PINS[variant]}:${name}`])), sources[variant][name], `Unpinned ${variant}/${name}`);
    }
    builds[variant] = buildManifest(join(directory, 'dist'));
    assert.ok(Object.hasOwn(builds[variant], 'shared.js'));
    state[variant] = { gitHead: PINS[variant], dirtyProduction: false, changedTrackedPaths, untrackedSourcePaths,
      generatedWasmPaths: paths.filter(name => name.endsWith('.wasm') && !trackedSet.has(name) && sources[variant][name] !== null) };
  }
  assertOnlyCompactionDiff(sources.main, sources.old); assertOnlyCompactionDiff(sources.main, sources.narrow);
  for (const variant of ['old', 'narrow']) for (const name of paths.filter(name => name.endsWith('.wasm'))) {
    assert.equal(sources[variant][name], sources.main[name], `WASM differs: ${variant}/${name}`);
  }
  return { sourceState: state, sourceSHA256: sources, buildSHA256: builds,
    buildDigests: Object.fromEntries(Object.entries(builds).map(([variant, manifest]) => [variant, sha256(JSON.stringify(manifest))])) };
}

async function measureKernel(entry, workload, repeat, samples) {
  const S = await import(pathToFileURL(entry).href), { kind, type, size } = workload;
  const expected = Array.from({ length: size }, (_, i) => type === 'number' ? i % 13 ? i / 8 : -0 : i % 3 === 0);
  let fixture = kind === 'list' ? new S.SharedList(type).pushMany(expected)
    : kind === 'linked' ? new S.SharedLinkedList(type) : new S.SharedDoublyLinkedList(type);
  if (kind !== 'list') for (const value of expected) fixture = fixture.append(value);
  const sourceBefore = S.getWorkerData({ fixture }, { copy: true });
  const check = value => { assert.equal(value.size, size); assert.deepEqual(value.toArray(), expected); assert.deepEqual(fixture.toArray(), expected); };
  const batch = count => {
    let last, visited = 0; const started = performance.now();
    for (let i = 0; i < count; i++) { last = S.compact(fixture); visited += last.size; }
    const elapsedMs = performance.now() - started;
    assert.equal(visited, count * size); return { last, elapsedMs, perOperationMs: elapsedMs / count };
  };
  const gc = () => { const started = performance.now(); Bun.gc(true); return performance.now() - started; };
  check(S.compact(fixture)); // One identical pre-warm correctness call per subject.
  const warmStarted = performance.now(); let warmupGcMs = 0, warmupGcCalls = 0;
  for (let i = 0; i < PROTOCOL.warmupCalls; i++) {
    const result = batch(1); assert.equal(result.last.size, size);
    if ((i + 1) % PROTOCOL.warmupGcEveryCalls === 0) { warmupGcMs += gc(); warmupGcCalls++; }
  }
  const warmupElapsedMs = performance.now() - warmStarted;
  const memoryBefore = process.memoryUsage(), measurements = [];
  for (let sample = 0; sample < samples; sample++) {
    const explicitGcMs = gc(), startedAt = new Date().toISOString(), result = batch(repeat);
    check(result.last);
    measurements.push({ sample, startedAt, repeat, explicitGcMs, elapsedMs: result.elapsedMs, perOperationMs: result.perOperationMs,
      short: result.elapsedMs < PROTOCOL.targetBatchMs });
  }
  const sourceAfter = S.getWorkerData({ fixture }, { copy: true });
  assert.deepEqual(sourceAfter.structures, sourceBefore.structures);
  assert.equal(sourceAfter.arenas.length, sourceBefore.arenas.length);
  for (let i = 0; i < sourceBefore.arenas.length; i++) assert.equal(Buffer.compare(sourceBefore.arenas[i].copy, sourceAfter.arenas[i].copy), 0);
  return { case: workload, repeat, preWarmCorrectnessCalls: 1, warmupCalls: PROTOCOL.warmupCalls, warmupElapsedMs, warmupGcMs, warmupGcCalls,
    memoryBefore, memoryAfter: process.memoryUsage(), samples: measurements,
    medianMs: median(measurements.map(sample => sample.perOperationMs)), shortBatches: measurements.filter(sample => sample.short).length };
}

async function runSubject(spec) {
  requireRuntime();
  assert.deepEqual(Object.keys(spec).sort(), ['phase', 'caseName', 'repeat', 'workPlanSHA256', 'neutralDirectory', 'buildDigest'].sort());
  assert.ok(['pilot', 'measure'].includes(spec.phase));
  const workload = CASES.find(item => item.name === spec.caseName); assert.ok(workload, 'Unexpected workload');
  const entry = join(spec.neutralDirectory, 'shared.js');
  const copiedBefore = buildDigest(spec.neutralDirectory); assert.equal(copiedBefore, spec.buildDigest);
  assert.equal(realpathSync(entry), entry, 'Entry URL must resolve to the neutral file itself');
  const repeat = spec.repeat, samples = spec.phase === 'pilot' ? PROTOCOL.pilotSamples : PROTOCOL.samplesPerSubject;
  if (spec.phase === 'pilot') assert.equal(repeat, PROTOCOL.pilotRepeat);
  assert.ok(Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= PROTOCOL.maxRepeat && (repeat & (repeat - 1)) === 0);
  const result = await measureKernel(entry, workload, repeat, samples);
  const copiedAfter = buildDigest(spec.neutralDirectory); assert.equal(copiedAfter, copiedBefore, 'Neutral bundle changed in the subject');
  return { ...result, phase: spec.phase, buildDigest: spec.buildDigest, copiedBefore, copiedAfter,
    neutralEntryURL: pathToFileURL(entry).href, workPlanSHA256: spec.workPlanSHA256, protocol: PROTOCOL, runtime: runtimeMetadata() };
}

async function runStudy() {
  requireRuntime();
  const directories = Object.fromEntries(Object.keys(PINS).map(variant => {
    const value = process.env[`FOCUSED_${variant.toUpperCase()}_DIR`]; assert.ok(value, `Missing FOCUSED_${variant.toUpperCase()}_DIR`); return [variant, resolve(value)];
  }));
  const verified = verifySources(directories);
  const output = resolve(process.env.OUTPUT ?? 'proofs/results/primitive-compaction-focused/study.json'); mkdirSync(dirname(output), { recursive: true });
  const neutralRoot = realpathSync(mkdtempSync(join(os.tmpdir(), 'zerocopy-compaction-subject-')));
  const neutralPackage = join(neutralRoot, 'package.json'), packageDigest = verified.sourceSHA256.main['package.json'];
  writeFileSync(neutralPackage, readFileSync(join(directories.main, 'package.json')));
  assert.equal(sha256(readFileSync(neutralPackage)), packageDigest);
  const neutralDirectory = join(neutralRoot, 'dist'); mkdirSync(neutralDirectory);
  const neutralEntryURL = pathToFileURL(join(neutralDirectory, 'shared.js')).href;
  const report = { schema: 1, protocol: PROTOCOL, pins: PINS, cases: CASES, comparisons: COMPARISONS, ...verified,
    sourceDirectories: directories, neutralEntryURL, neutralPackageSHA256: packageDigest,
    harnessGitHead: git(root, 'rev-parse', 'HEAD'), harnessSHA256: sha256(readFileSync(harness)), runtime: runtimeMetadata(),
    startedAt: new Date().toISOString(), status: 'running', phase: 'pilots', pilots: [], workPlan: null, quartets: [], summary: [],
    method: `One pinned build per fresh Bun process, always imported from the same canonical neutral entry URL. Verified bundle bytes are copied between serial subjects without symlinks, and checked before/after each subject; selected provenance is excluded from child requests and kernel inputs. Disposable fixed-count pilots from all three builds choose one frozen repeat count per case. Every subject has exactly ${PROTOCOL.warmupCalls} warmup calls, with synchronous explicit GC every ${PROTOCOL.warmupGcEveryCalls} calls and before every batch; automatic GC may occur during timed allocation. Three comparisons, including main A/A, are interleaved on one runner in balanced ABBA/BAAB quartets. No per-subject recalibration, flag tuning, sample removal, or performance pass threshold.` };
  const save = () => {
    report.summary = CASES.flatMap(workload => COMPARISONS.map(comparison => {
      const complete = report.quartets.filter(row => row.case.name === workload.name && row.comparison.name === comparison.name && row.summary);
      return { case: workload.name, comparison: comparison.name, completedQuartets: complete.length, expectedQuartets: PROTOCOL.cycles,
        medianQuartetRatio: complete.length ? median(complete.map(row => row.summary.ratio)) : null,
        ratios: complete.map(row => row.summary.ratio), shortBatches: complete.reduce((sum, row) => sum + row.summary.shortBatches, 0) };
    }));
    const temp = `${output}.tmp-${process.pid}`; writeFileSync(temp, JSON.stringify(report, null, 2)); renameSync(temp, output);
  };
  const subject = spec => {
    report.activeSubject = { ...spec, startedAt: new Date().toISOString() }; save();
    const sourceBundle = join(directories[spec.variant], 'dist'), expectedDigest = verified.buildDigests[spec.variant];
    assert.equal(sha256(readFileSync(neutralPackage)), packageDigest, 'Neutral module context changed');
    assert.equal(materializeBundle(sourceBundle, neutralDirectory, expectedDigest), neutralEntryURL);
    report.activeSubject.copiedBefore = buildDigest(neutralDirectory); save();
    const startedAt = new Date().toISOString();
    const child = spawnSync(process.execPath, [harness, '--subject', JSON.stringify(neutralRequest(spec, neutralDirectory, expectedDigest))],
      { env: subjectEnvironment(process.env), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: PROTOCOL.subjectTimeoutMs });
    const copiedAfter = buildDigest(neutralDirectory);
    report.activeSubject.copiedAfter = copiedAfter; save();
    assert.equal(copiedAfter, expectedDigest, 'Copied bundle changed across a child process');
    assert.equal(sha256(readFileSync(neutralPackage)), packageDigest, 'Neutral module context changed across a child process');
    assert.equal(buildDigest(sourceBundle), expectedDigest, 'Source bundle changed across a child process');
    if (child.status !== 0) throw new Error(`${spec.variant}/${spec.caseName}: ${child.error?.message || child.stderr || `exit ${child.status}, signal ${child.signal}`}`);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.protocol, PROTOCOL); assert.equal(result.buildDigest, expectedDigest);
    assert.equal(result.copiedBefore, expectedDigest); assert.equal(result.copiedAfter, expectedDigest); assert.equal(result.neutralEntryURL, neutralEntryURL);
    assert.equal(result.phase, spec.phase); assert.equal(result.case.name, spec.caseName);
    assert.equal(result.runtime.bun, PROTOCOL.bunVersion); assert.equal(result.runtime.platform, PROTOCOL.platform); assert.equal(result.runtime.arch, PROTOCOL.arch);
    assert.equal(result.warmupCalls, PROTOCOL.warmupCalls); assert.equal(result.preWarmCorrectnessCalls, 1);
    assert.equal(result.warmupGcCalls, PROTOCOL.warmupCalls / PROTOCOL.warmupGcEveryCalls);
    assert.equal(result.repeat, spec.phase === 'pilot' ? PROTOCOL.pilotRepeat : spec.repeat);
    assert.equal(result.workPlanSHA256, spec.workPlanSHA256 ?? null);
    assert.equal(result.samples.length, spec.phase === 'pilot' ? PROTOCOL.pilotSamples : PROTOCOL.samplesPerSubject);
    for (const sample of result.samples) {
      assert.equal(sample.repeat, result.repeat); assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0);
      assert.equal(sample.perOperationMs, sample.elapsedMs / result.repeat); assert.equal(sample.short, sample.elapsedMs < PROTOCOL.targetBatchMs);
    }
    delete report.activeSubject; return { pin: PINS[spec.variant], neutralEntryURL, copiedBefore: expectedDigest, copiedAfter,
      startedAt, finishedAt: new Date().toISOString(), result };
  };
  save();
  try {
    const variants = Object.keys(PINS);
    for (let replicate = 0; replicate < PROTOCOL.pilotReplicates; replicate++) for (let caseIndex = 0; caseIndex < CASES.length; caseIndex++) {
      const workload = CASES[(caseIndex + replicate) % CASES.length];
      for (let position = 0; position < variants.length; position++) {
        const variant = variants[(position + replicate + caseIndex) % variants.length];
        report.pilots.push({ replicate, case: workload, variant, ...subject({ phase: 'pilot', variant, caseName: workload.name }) }); save();
      }
    }
    report.workPlan = chooseWorkPlan(report.pilots); report.workPlanSHA256 = sha256(JSON.stringify(report.workPlan)); report.phase = 'measurement'; save();
    for (const scheduled of measurementSchedule()) {
      const row = { ...scheduled, subjects: [] }; report.quartets.push(row); save();
      for (let position = 0; position < row.order.length; position++) {
        const role = row.order[position], variant = role === 'A' ? row.comparison.a : row.comparison.b;
        row.subjects.push({ position, role, variant, ...subject({ phase: 'measure', variant, caseName: row.case.name,
          repeat: report.workPlan[row.case.name].repeat, workPlanSHA256: report.workPlanSHA256 }) }); save();
      }
      row.summary = summarizeQuartet(row); save();
      console.error(`${row.case.name} ${row.comparison.name} cycle${row.cycle + 1} ${row.order.join('')}: ${row.summary.ratio.toFixed(4)}x`);
    }
    assert.deepEqual(verifySources(directories), verified, 'Sources or built bundles changed during the study');
    report.status = 'complete'; report.phase = 'complete'; report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify(report.summary, null, 2));
  } catch (error) { report.status = 'failed'; report.error = String(error); report.finishedAt = new Date().toISOString(); save(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === harness) {
  if (process.argv[2] === '--subject') process.stdout.write(JSON.stringify(await runSubject(JSON.parse(process.argv[3]))));
  else await runStudy();
}
