import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

const baselineCommit = '3331f2f0e9e0c3c61832e5f04b12e18c1889d96c';
const positive = (name, fallback, integer = false) => {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isFinite(value) && value > 0 && (!integer || Number.isSafeInteger(value)), `Invalid ${name}: ${value}`);
  return value;
};
const configuration = {
  rounds: positive('ROUNDS', 4, true), samples: positive('SAMPLES', 15, true),
  targetBatchMs: positive('TARGET_BATCH_MS', 10), maxRepeat: 128,
  calibration: { initialRepeat: 1, growthFactor: 2, pilotsPerRepeat: 1 }, subjectTimeoutMs: 120000,
  warmup: { minCalls: 16, minDurationMs: 100, requireBothThresholds: true, gcEveryCalls: 16, durationIncludesGC: true },
  gcBeforeCalibrationAndSamples: true, caseFilter: process.env.CASE_FILTER ?? null,
};
const methodDescription = config => `Fresh process per variant, case and round; ${config.rounds} rounds with alternating variant order and ${config.samples} samples per subject; full compact including fresh arena construction timed; fixture construction, explicit GC and complete result validation outside timing; warmup requires both ${config.warmup.minCalls} calls and ${config.warmup.minDurationMs}ms, including GC every ${config.warmup.gcEveryCalls} calls; calibration uses ${config.calibration.pilotsPerRepeat} pilot per repeat, starting at ${config.calibration.initialRepeat} and multiplying by ${config.calibration.growthFactor}, targeting ${config.targetBatchMs}ms up to ${config.maxRepeat} compactions; full raw samples and below-target flags retained.`;
const median = list => { const a = [...list].sort((x, y) => x - y); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const digest = value => createHash('sha256').update(value).digest('hex');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cases = [];
for (const size of [32, 4096, 32769]) for (const kind of ['list', 'queue', 'linked', 'doubly']) for (const type of ['number', 'boolean']) {
  cases.push({ kind, type, size, name: `${kind}/${type}/${size}` });
}
for (const kind of ['list', 'queue', 'linked', 'doubly']) for (const type of ['string', 'object']) cases.push({ kind, type, size: 4096, name: `${kind}/${type}/4096` });

function valuesOf(value, kind) {
  if (kind !== 'queue') return value.toArray();
  const result = [];
  while (value.size) { result.push(value.peek()); value = value.dequeue(); }
  return result;
}

async function runCase(modulePath, workload) {
  const S = await import(pathToFileURL(modulePath).href), { kind, type, size } = workload;
  const offset = kind === 'queue' ? 37 : 0;
  const expected = Array.from({ length: size + offset }, (_, i) => type === 'number' ? (i % 13 ? i / 8 : -0)
    : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `value/${i}/界🙂` : { i, child: { active: i % 3 === 0 } });
  let fixture = kind === 'list' ? new S.SharedList(type).pushMany(expected) : kind === 'queue' ? new S.SharedQueue(type)
    : kind === 'linked' ? new S.SharedLinkedList(type) : new S.SharedDoublyLinkedList(type);
  if (kind !== 'list') for (const value of expected) fixture = kind === 'queue' ? fixture.enqueue(value) : fixture.append(value);
  for (let i = 0; i < offset; i++) fixture = fixture.dequeue();
  const model = expected.slice(offset);
  const check = result => {
    assert.deepEqual(valuesOf(result, kind), model);
    assert.equal(result.size, size);
    assert.deepEqual(valuesOf(fixture, kind), model);
  };
  const gc = () => { if (typeof Bun !== 'undefined') Bun.gc(true); else globalThis.gc?.(); };
  const measure = repeat => {
    let last, count = 0;
    const started = performance.now();
    for (let i = 0; i < repeat; i++) { last = S.compact(fixture); count += last.size; }
    const elapsed = performance.now() - started;
    assert.equal(count, size * repeat);
    return { elapsed, last };
  };
  check(S.compact(fixture));
  const warmStarted = performance.now(); let warmups = 0;
  do { measure(1); warmups++; if (!(warmups % configuration.warmup.gcEveryCalls)) gc(); }
  while (warmups < configuration.warmup.minCalls || performance.now() - warmStarted < configuration.warmup.minDurationMs);
  let repeat = configuration.calibration.initialRepeat, calibration;
  const calibrationAttempts = [];
  const { targetBatchMs, maxRepeat } = configuration;
  while (true) {
    gc(); calibration = measure(repeat); check(calibration.last);
    calibrationAttempts.push({ repeat, elapsedMs: calibration.elapsed });
    if (calibration.elapsed >= targetBatchMs || repeat >= maxRepeat) break;
    repeat *= configuration.calibration.growthFactor;
  }
  const samples = [], batches = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    gc(); const result = measure(repeat);
    samples.push(result.elapsed / repeat); batches.push(result.elapsed);
    if (sample === 0 || sample === configuration.samples - 1) check(result.last);
  }
  return { ...workload, configuration, repeat, warmups, samplesMs: samples, batchesMs: batches, medianMs: median(samples),
    calibrationAttempts, calibrationTargetReached: calibration.elapsed >= targetBatchMs, hitMaxRepeat: repeat >= maxRepeat,
    belowTargetBatches: batches.filter(ms => ms < targetBatchMs).length,
    gcAvailable: typeof Bun !== 'undefined' || typeof globalThis.gc === 'function' };
}

if (process.argv[2] === '--case') {
  process.stdout.write(JSON.stringify(await runCase(process.argv[3], JSON.parse(process.argv[4]))));
} else {
  const before = resolve(process.env.BASELINE_DIR ?? '../zerocopy-baseline-333');
  const after = resolve(process.env.CANDIDATE_DIR ?? root);
  const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  const heads = { baseline: git(before, 'rev-parse', 'HEAD'), candidate: git(after, 'rev-parse', 'HEAD') };
  assert.equal(heads.baseline, baselineCommit, 'Baseline commit changed');
  assert.equal(git(after, 'merge-base', 'HEAD', baselineCommit), baselineCommit, 'Candidate does not descend from pinned baseline');
  const guardedPath = name => !name.includes('/') && (/\.(?:ts|wasm)$/.test(name) && !name.endsWith('.test.ts') || name === 'package.json')
    || /^scripts\/build-[^/]+$/.test(name);
  const namesAtHead = directory => git(directory, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  const namesOnDisk = directory => [
    ...readdirSync(directory), ...readdirSync(join(directory, 'scripts')).map(name => `scripts/${name}`),
  ].filter(guardedPath);
  const tracked = { baseline: namesAtHead(before), candidate: namesAtHead(after) };
  // Include additions and deletions in either tree, including untracked source.
  // Generated WASM is compared between builds; its producing sources/scripts
  // and package versions must match the pinned baseline except compaction.ts.
  const files = [...new Set([...tracked.baseline, ...tracked.candidate, ...namesOnDisk(before), ...namesOnDisk(after)].filter(guardedPath))].sort();
  const manifests = {};
  const builds = {};
  const wasm = {};
  const sourceState = {};
  for (const [label, directory] of [['baseline', before], ['candidate', after]]) {
    manifests[label] = Object.fromEntries(files.map(name => [name, existsSync(join(directory, name)) ? digest(readFileSync(join(directory, name))) : null]));
    builds[label] = Object.fromEntries(readdirSync(join(directory, 'dist')).filter(name => name.endsWith('.js')).sort()
      .map(name => [name, digest(readFileSync(join(directory, 'dist', name)))]));
    wasm[label] = Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.wasm')).sort()
      .map(name => [name, digest(readFileSync(join(directory, name)))]));
    const trackedSet = new Set(tracked[label]);
    const changedTrackedPaths = git(directory, 'diff', '--name-only', 'HEAD', '--', ...files).split('\n').filter(Boolean);
    const untrackedSourcePaths = files.filter(name => manifests[label][name] !== null && !trackedSet.has(name) && !name.endsWith('.wasm'));
    sourceState[label] = { gitHead: heads[label], dirtyProduction: changedTrackedPaths.length > 0 || untrackedSourcePaths.length > 0,
      changedTrackedPaths, untrackedSourcePaths,
      generatedWasmPaths: files.filter(name => manifests[label][name] !== null && !trackedSet.has(name) && name.endsWith('.wasm')) };
  }
  assert.deepEqual(files.filter(name => manifests.baseline[name] !== manifests.candidate[name]), ['compaction.ts']);
  assert.deepEqual(wasm.baseline, wasm.candidate, 'Unchanged WASM sources must produce identical binaries');
  assert.equal(sourceState.baseline.dirtyProduction, false, 'Baseline production source is dirty');
  for (const name of files.filter(name => !name.endsWith('.wasm'))) {
    assert.equal(digest(execFileSync('git', ['-C', before, 'show', `${baselineCommit}:${name}`])), manifests.baseline[name], `Baseline source differs: ${name}`);
  }
  const selected = cases.filter(row => !configuration.caseFilter || new RegExp(configuration.caseFilter).test(row.name));
  assert.ok(selected.length, 'No selected workloads');
  const mode = process.env.BENCH_MODE ?? 'ab';
  assert.ok(['ab', 'aa-baseline', 'aa-candidate'].includes(mode));
  const paths = mode === 'aa-baseline' ? { baseline: before, candidate: before }
    : mode === 'aa-candidate' ? { baseline: after, candidate: after } : { baseline: before, candidate: after };
  const output = resolve(process.env.OUTPUT ?? `primitive-compaction-${mode}-${typeof Bun === 'undefined' ? 'node' : 'bun'}.json`);
  mkdirSync(resolve(output, '..'), { recursive: true });
  const rows = [];
  const report = { schema: 1, measuredAt: new Date().toISOString(), status: 'running', baselineCommit, mode, configuration,
    sourceState, sourceSHA256: manifests, buildSHA256: builds, wasmSHA256: wasm,
    harnessSHA256: digest(readFileSync(fileURLToPath(import.meta.url))),
    runtime: { node: process.versions.node, bun: process.versions.bun, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
    method: methodDescription(configuration), summary: [], rows };
  const save = () => {
    report.summary = selected.map(workload => {
      const complete = rows.filter(row => row.workload.name === workload.name && Number.isFinite(row.ratio));
      return { name: workload.name, completedRounds: complete.length, expectedRounds: configuration.rounds,
        ratio: complete.length ? median(complete.map(row => row.ratio)) : null };
    });
    const temporary = `${output}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(report, null, 2)); renameSync(temporary, output);
  };
  save();
  try {
    for (const workload of selected) for (let round = 0; round < configuration.rounds; round++) {
      const variants = {}, order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      const row = { workload, round, order, variants }; rows.push(row);
      for (const label of order) {
        report.activeSubject = { name: workload.name, round, variant: label, startedAt: new Date().toISOString() }; save();
        const args = [...(typeof Bun === 'undefined' ? ['--expose-gc'] : []), fileURLToPath(import.meta.url), '--case', join(paths[label], 'dist/shared.js'), JSON.stringify(workload)];
        const child = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, maxBuffer: 8 * 1024 * 1024, timeout: configuration.subjectTimeoutMs });
        if (child.status !== 0) throw new Error(`${workload.name}/${label}: ${child.error?.message || child.stderr || child.stdout || `exit ${child.status}, signal ${child.signal}`}`);
        variants[label] = JSON.parse(child.stdout);
        assert.deepEqual(variants[label].configuration, configuration, 'Subject configuration differs from the report');
        delete report.activeSubject; save();
      }
      row.ratio = variants.baseline.medianMs / variants.candidate.medianMs;
      delete report.activeSubject; save();
      console.error(`${workload.name} round ${round + 1}: ${row.ratio.toFixed(3)}x`);
    }
    report.status = 'complete'; report.finishedAt = new Date().toISOString(); save();
  } catch (error) {
    report.status = 'failed'; report.error = String(error); report.finishedAt = new Date().toISOString(); save(); throw error;
  }
  console.log(JSON.stringify(report.summary, null, 2)); console.error(`Wrote ${output}`);
}
