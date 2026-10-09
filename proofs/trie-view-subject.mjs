// One fresh process, one public workload, one physical sibling package. This
// module has no controller/build import and cannot import a comparison build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CONFIG } from './trie-view-protocol.mjs';
import { CASES, fixture, verifyFixture, snapshot, normalizeSink } from './trie-view-workloads.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const helperNames = ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs'];
let imported = false;

export function validateEntry(entryUrl, subjectUrl = import.meta.url) {
  const url = new URL(entryUrl);
  assert.equal(url.protocol, 'file:', 'Subject entry must be a file URL');
  assert.equal(url.search, '', 'Subject entry cannot have URL search parameters');
  assert.equal(url.hash, '', 'Subject entry cannot have a URL fragment');
  const expected = new URL('../dist/shared.js', subjectUrl);
  assert.equal(url.href, expected.href, 'Subject must import its own sibling dist/shared.js');
  const entry = fileURLToPath(url), subject = fileURLToPath(subjectUrl), root = dirname(dirname(subject));
  for (const path of [root, subject, entry, join(root, 'package.json')]) {
    assert.equal(realpathSync(path), resolve(path), `Subject physical path contains a symlink: ${path}`);
    assert.equal(lstatSync(path).isSymbolicLink(), false, `Subject physical path is a symlink: ${path}`);
  }
  const packageBytes = readFileSync(join(root, 'package.json'));
  const packageData = JSON.parse(packageBytes);
  assert.equal(packageData.name, 'zerocopy', 'Subject needs the original zerocopy package');
  assert.equal(packageData.type, 'module');
  return { entryUrl: url.href, physicalRoot: root, physicalEntry: entry,
    physicalPackage: join(root, 'package.json'), packageSha256: sha256(packageBytes) };
}

export function requireTimingAuthorization(phase, env = process.env) {
  if (phase === 'verify') return;
  assert.equal(env.GITHUB_ACTIONS, 'true', 'No local timings: pilot/measure run only in clean GitHub CI');
  assert.equal(env.TRIE_VIEW_GATE_TIMING, '1', 'Timing needs the explicit clean-CI gate marker');
}

export function parseRequest(args) {
  assert.ok(args.length === 3 || args.length === 5,
    'Usage: trie-view-subject.mjs <entry-file-URL> <workload-name> <verify|pilot|measure> [repeat warmupOperations]');
  const [entryUrl, name, phase] = args;
  assert.ok(CASES.some(spec => spec.name === name), 'Unknown frozen workload');
  assert.ok(['verify', 'pilot', 'measure'].includes(phase), 'Unknown subject phase');
  assert.equal(args.length, phase === 'measure' ? 5 : 3, 'Fixed work is required only for measured subjects');
  const request = { entryUrl, name, phase };
  if (phase === 'measure') {
    assert.match(args[3], /^[1-9][0-9]*$/, 'repeat must be a positive integer');
    assert.match(args[4], /^[1-9][0-9]*$/, 'warmupOperations must be a positive integer');
    request.repeat = Number(args[3]); request.warmupOperations = Number(args[4]);
    assert.ok(Number.isSafeInteger(request.repeat) && request.repeat <= CONFIG.maxRepeat, 'repeat cap exceeded');
    assert.ok(Number.isSafeInteger(request.warmupOperations) && request.warmupOperations <= CONFIG.maxWarmupCalls, 'warmup work cap exceeded');
    assert.equal(request.warmupOperations % request.repeat, 0, 'Frozen warmup work must align to repeat');
  }
  return request;
}

function sourceReceipt() {
  return Object.fromEntries(helperNames.map(name => {
    const file = fileURLToPath(new URL(name, import.meta.url));
    assert.equal(realpathSync(file), resolve(file), `Source helper contains a symlink: ${name}`);
    assert.equal(lstatSync(file).isSymbolicLink(), false, `Source helper is a symlink: ${name}`);
    return [name, sha256(readFileSync(file))];
  }));
}
function runtimeReceipt() {
  return { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node,
    versions: { ...process.versions }, platform: process.platform, arch: process.arch,
    execPath: process.execPath, execArgv: [...process.execArgv], pid: process.pid };
}
function positiveDuration(ms) { assert.ok(Number.isFinite(ms) && ms > 0, 'Timer returned a nonpositive/nonfinite duration'); }

// Timed bodies contain only the exact fixed-count public workload. Sink checks,
// serialisation, hashes and shared-memory receipts are outside these boundaries.
function timedBatch(f, repeat, result) {
  const start = performance.now();
  const value = f.execute(repeat);
  const ms = performance.now() - start;
  positiveDuration(ms);
  const sink = normalizeSink(value);
  assert.deepEqual(sink, f.expectedSink, 'Timed operation returned the wrong terminal value');
  result.sink = sink;
  return ms;
}
function fail(result, flag) {
  result.flags.push(flag);
  throw new Error(flag);
}
// Synthetic tests supply invented durations and a fake clock; production is
// wired to timedBatch/performance.now immediately below in subject().
export function runPilot(result, batch, now) {
  const prewarm = result.prewarm = { targetMs: CONFIG.pilotWarmupMs, elapsedMs: 0,
    wallElapsedMs: 0, operations: 0, batches: [], capped: false };
  result.probes = [];
  const start = now();
  let repeat = CONFIG.pilotWarmupMinCalls;
  // Pilot-only adaptation is bounded by frozen time and operation limits. It
  // stops only after BOTH the duration target and minimum call count are met.
  while (prewarm.elapsedMs < CONFIG.pilotWarmupMs || prewarm.operations < CONFIG.pilotWarmupMinCalls) {
    if (prewarm.operations + repeat > CONFIG.maxWarmupCalls) {
      prewarm.capped = true; fail(result, 'pilot prewarm work cap');
    }
    const ms = batch(repeat); positiveDuration(ms);
    prewarm.batches.push({ repeat, ms }); prewarm.operations += repeat; prewarm.elapsedMs += ms;
    prewarm.wallElapsedMs = now() - start;
    if (prewarm.wallElapsedMs > CONFIG.pilotWarmupMaxMs) {
      prewarm.capped = true; fail(result, 'pilot prewarm time cap');
    }
    repeat = Math.min(CONFIG.maxRepeat, Math.max(CONFIG.pilotWarmupMinCalls,
      Math.ceil(repeat * Math.min(8, CONFIG.pilotCalibrationTargetMs / ms))));
  }
  repeat = 1;
  for (let step = 0; step < CONFIG.pilotCalibrationSteps; step++) {
    const probe = { repeat, samples: [] };
    result.probes.push(probe);
    for (let sample = 0; sample < CONFIG.pilotSamples; sample++) {
      const ms = batch(repeat); positiveDuration(ms); probe.samples.push(ms);
    }
    // Include every completed post-prewarm sample, including the final step.
    result.estimateMsPerOperation = Math.min(...result.probes.flatMap(p => p.samples.map(ms => ms / p.repeat)));
    if (Math.min(...probe.samples) >= CONFIG.pilotCalibrationTargetMs) return;
    if (repeat === CONFIG.maxRepeat) fail(result, 'pilot calibration repeat cap');
    repeat = Math.min(CONFIG.maxRepeat, Math.max(repeat + 1,
      Math.ceil(repeat * Math.min(8, Math.max(1.2, CONFIG.pilotCalibrationTargetMs / Math.min(...probe.samples) * 1.05)))));
  }
  fail(result, 'pilot calibration step cap');
}

// Exported for deterministic synthetic tests. Production passes only the real
// timedBatch callback; tests pass invented durations and execute no workloads.
export function runFixedMeasure(request, result, batch) {
  assert.ok(Number.isSafeInteger(request.repeat) && request.repeat > 0 && request.repeat <= CONFIG.maxRepeat, 'repeat cap or invalid work');
  assert.ok(Number.isSafeInteger(request.warmupOperations) && request.warmupOperations > 0
    && request.warmupOperations <= CONFIG.maxWarmupCalls, 'warmup cap or invalid work');
  assert.equal(request.warmupOperations % request.repeat, 0, 'Frozen warmup must align to repeat');
  result.repeat = request.repeat;
  result.prescribedWarmupOperations = request.warmupOperations;
  const warmup = result.warmup = { operations: 0, elapsedMs: 0, batches: [], capped: false };
  result.samples = [];
  // The work count, not elapsed time, terminates measured-process warmup.
  while (warmup.operations < request.warmupOperations) {
    const repeat = Math.min(request.repeat, request.warmupOperations - warmup.operations);
    const ms = batch(repeat); positiveDuration(ms);
    warmup.batches.push({ repeat, ms }); warmup.operations += repeat; warmup.elapsedMs += ms;
  }
  if (warmup.elapsedMs < CONFIG.minWarmupMs) result.flags.push('warmup below floor');
  for (let sample = 0; sample < CONFIG.samples; sample++) {
    const ms = batch(request.repeat); positiveDuration(ms); result.samples.push(ms);
  }
  if (result.samples.some(ms => ms < CONFIG.minBatchMs)) result.flags.push('batch below floor');
  result.belowFloorBatches = result.samples.filter(ms => ms < CONFIG.minBatchMs).length;
  result.warmupTimeShort = warmup.elapsedMs < CONFIG.minWarmupMs;
}

export async function subject(request) {
  const result = { schemaVersion: 1, phase: request.phase, workload: request.name,
    entryUrl: request.entryUrl, runtime: runtimeReceipt(), status: 'running', flags: [] };
  let f, before;
  try {
    requireTimingAuthorization(request.phase);
    assert.equal(process.execArgv.length, 0, 'Subject requires default JIT flags');
    assert.ok(!process.env.NODE_OPTIONS && !process.env.BUN_OPTIONS, 'Subject requires default runtime options');
    result.physical = validateEntry(request.entryUrl);
    result.sourceSha256 = sourceReceipt();
    assert.equal(imported, false, 'One build and one workload are allowed in each subject process');
    imported = true;
    const api = await import(request.entryUrl);
    f = fixture(api, request.name);
    const verified = verifyFixture(f);
    result.expectedDigest = verified.expectedDigest;
    result.actualDigest = verified.actualDigest;
    result.shape = verified.shape; result.sink = verified.sink;
    before = snapshot(f);
    result.guards = { before };
    if (request.phase === 'pilot') runPilot(result, repeat => timedBatch(f, repeat, result), () => performance.now());
    else if (request.phase === 'measure') runFixedMeasure(request, result, repeat => timedBatch(f, repeat, result));
    else assert.equal(request.phase, 'verify');
    const after = snapshot(f);
    result.guards.after = after;
    assert.deepEqual(after, before, 'Public read workload changed immutable payload or shared allocator');
    const verifiedAfter = verifyFixture(f);
    assert.equal(verifiedAfter.expectedDigest, result.expectedDigest);
    assert.equal(verifiedAfter.actualDigest, result.actualDigest);
    assert.deepEqual(snapshot(f), before, 'Post-run verification changed immutable payload or allocation');
    Object.assign(result.guards, { allocatedSharedBytes: 0, immutableBytes: true,
      expectedDigest: result.expectedDigest, beforeDigest: verified.actualDigest, afterDigest: verifiedAfter.actualDigest });
    assert.deepEqual(sourceReceipt(), result.sourceSha256, 'Subject source dependency changed during process');
    assert.deepEqual(validateEntry(request.entryUrl), result.physical, 'Original physical package changed during process');
    result.status = 'completed';
  } catch (error) {
    result.status = 'failed'; result.error = String(error?.stack ?? error);
    // Preserve partial timing arrays and try to retain after-state even when a
    // timer, public operation, guard, or explicit cap fails.
    if (f && before && !result.guards.after) {
      try { result.guards.after = snapshot(f); }
      catch (guardError) { result.guards.afterError = String(guardError?.stack ?? guardError); }
    }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let result;
  try { result = await subject(parseRequest(process.argv.slice(2))); }
  catch (error) { result = { schemaVersion: 1, status: 'failed', phase: process.argv[4] ?? null,
    workload: process.argv[3] ?? null, flags: [], error: String(error?.stack ?? error) }; }
  console.log(JSON.stringify(result));
  if (result.status !== 'completed') process.exitCode = 1;
}
