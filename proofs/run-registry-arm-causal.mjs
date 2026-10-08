/** One bounded ARM causal study. Historical runner and runtime stay untouched. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocol, schedule, pilotOrder, stateFor, summarize } from './registry-arm-causal-protocol.mjs';
import { PROOF_PATHS, causalGuard, sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment, internalExports, publicationReceipt } from './registry-arm-causal-guard.mjs';
import { sha256 } from './worker-arena-source-guard.mjs';

const [baselineArg, candidateArg, outputArg, option] = process.argv.slice(2);
assert(baselineArg && candidateArg && outputArg && [undefined, '--correctness-only'].includes(option),
  'Usage: node proofs/run-registry-arm-causal.mjs BASELINE CANDIDATE NEW_OUTPUT [--correctness-only]');
const correctnessOnly = option === '--correctness-only', proofRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(outputArg), baseline = realpathSync(baselineArg), candidate = realpathSync(candidateArg);
assert(!existsSync(output), 'New output required; never overwrite, resume or retry a study');
mkdirSync(join(output, 'raw'), { recursive: true });
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'registry-causal-'))), canonical = join(temporary, 'subject');
const childEnv = cleanEnvironment(), executable = realpathSync(process.execPath);
const subjectBytes = readFileSync(new URL('./registry-arm-causal-subject.mjs', import.meta.url));
const graphBytes = readFileSync(new URL('./registry-arm-causal-graph.mjs', import.meta.url));
const censusBytes = readFileSync(new URL('./registry-arm-causal-census.mjs', import.meta.url));
const originalProofs = Object.fromEntries(['worker-arenas', 'node-worker', 'typed-json-worker'].map(name => [`proofs/${name}.mjs`, readFileSync(join(proofRoot, `proofs/${name}.mjs`))]));
const settings = Object.fromEntries(['samples', 'warmups', 'minimumBatchMs', 'pilotTargetBatchMs', 'pilotMaximumBatches', 'initialIterations', 'maximumIterations'].map(name => [name, protocol[name]]));
let ordinal = 0;
const record = {
  schemaVersion: 1, status: 'preparing', startedAt: new Date().toISOString(), correctnessOnly, protocol,
  manifestSha256: sha256(readFileSync(new URL('./registry-arm-causal.manifest.json', import.meta.url))),
  node: { version: process.version, versions: process.versions, executable, sha256: sha256(readFileSync(executable)), execArgv: process.execArgv },
  host: { platform: process.platform, arch: process.arch, cpu: cpus(), loadavg: loadavg(), osRelease: release() },
  runner: Object.fromEntries(['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'RUNNER_ARCH', 'RUNNER_OS', 'ImageOS', 'ImageVersion'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
  runtimeSettings: { childEnvironment: childEnv, timingFlags: protocol.timingFlags, censusFlags: protocol.censusFlags, traceFlags: protocol.traceFlags, jit: 'default for timing; diagnostics separately labeled and never analyzed as samples', compileCache: 'disabled', subjects: 'fresh process for each invocation' },
  canonicalPackagePath: canonical, canonicalEntryPath: join(canonical, 'dist/shared.js'), canonicalRunnerPath: join(canonical, 'subject.mjs'),
  schedule: schedule(), pilotOrder: pilotOrder(), correctness: [], census: [], pilots: {}, plan: null, blocks: [], diagnostics: [], invocations: [],
};
function checkpoint() {
  record.summary = summarize(record.blocks, record);
  record.reviewRestriction = 'Causal diagnostic only; retain prior ARM/x64 results, all confounders and memory/export gains. No production acceptance or architecture attribution.';
  writeFileSync(join(output, 'summary.json'), JSON.stringify(record, null, 2) + '\n');
}
checkpoint();
try {
  assert.equal(process.platform, protocol.toolchain.platform); assert(!process.versions.bun);
  assert.deepEqual(process.execArgv, [], 'Controller cannot inject engine flags');
  if (!correctnessOnly) {
    assert.equal(process.arch, protocol.scope.arch); assert.equal(process.versions.node, protocol.toolchain.node);
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push'); assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
    assert.equal(process.env.GITHUB_REF, `refs/heads/${protocol.publication.branch}`);
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH));
    assert.equal(event.before, protocol.publication.before); assert.equal(event.forced, false);
    assert.equal(event.after, process.env.GITHUB_SHA); record.pushReceipt = { before: event.before, after: event.after, forced: event.forced };
    record.publicationReceipt = publicationReceipt(proofRoot, process.env.GITHUB_SHA);
  }
  const guard = causalGuard(baseline, candidate, proofRoot); record.guard = guard;
  writeFileSync(join(output, 'source-guard-before.json'), JSON.stringify(guard, null, 2));
  record.sourceGuardSha256 = sha256(readFileSync(join(output, 'source-guard-before.json')));
  const contexts = { baseline: sourceContext(baseline), candidate: sourceContext(candidate) };
  assert.deepEqual(contexts.baseline.packageBytes, contexts.candidate.packageBytes);
  record.sourceContexts = Object.fromEntries(Object.entries(contexts).map(([variant, context]) => [variant, { packageSha256: sha256(context.packageBytes), completeDist: context.distManifest }]));
  for (const variant of ['baseline', 'candidate']) {
    const dest = join(output, 'inputs', variant); mkdirSync(dest, { recursive: true });
    cpSync(contexts[variant].dist, join(dest, 'dist'), { recursive: true }); writeFileSync(join(dest, 'package.json'), contexts[variant].packageBytes);
    for (const file of guard[variant].source.files) {
      const target = join(dest, 'guarded-source', file.path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(guard[variant].root, file.path), target);
    }
  }
  for (const path of PROOF_PATHS) { const target = join(output, 'inputs', 'proof', path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(proofRoot, path), target); }
  if (!correctnessOnly) {
    const bunExecutable = realpathSync(process.env.BUN_EXECUTABLE ?? ''), bunVersion = execFileSync(bunExecutable, ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(bunVersion, protocol.toolchain.bun);
    const ascPackage = join(proofRoot, 'node_modules/assemblyscript/package.json');
    assert.equal(JSON.parse(readFileSync(ascPackage)).version, protocol.toolchain.assemblyscript);
    record.buildTools = { bunExecutable, bunVersion, bunSha256: sha256(readFileSync(bunExecutable)), assemblyscript: protocol.toolchain.assemblyscript,
      assemblyscriptPackageSha256: sha256(readFileSync(ascPackage)), assemblyscriptCompilerSha256: sha256(readFileSync(join(proofRoot, 'node_modules/assemblyscript/dist/asc.js'))) };
  }
  function invoke(state, request, context, proofPath = null) {
    const { variant } = protocol.states[state];
    // Census code is absent from staged pilots/timings/traces. Instrumentation
    // cannot accidentally survive a previous process or staging directory.
    const extra = proofPath ? originalProofs : { 'graph.mjs': graphBytes, 'internals.mjs': internalExports(contexts[variant]), ...(request.phase === 'census' ? { 'census.mjs': censusBytes } : {}) };
    const before = stageCanonical(contexts[variant], canonical, subjectBytes, extra);
    const name = String(++ordinal).padStart(4, '0'), startedAt = new Date().toISOString();
    const flags = request?.phase === 'census' ? protocol.censusFlags : request?.phase === 'trace' ? protocol.traceFlags : protocol.timingFlags;
    const args = proofPath ? [join(canonical, proofPath)] : [...flags, join(canonical, 'subject.mjs'), JSON.stringify(request)];
    const invocation = { ordinal, state, variant, context, startedAt, command: [executable, ...args], stageBefore: before, status: 'running', stdout: `raw/${name}.stdout`, stderr: `raw/${name}.stderr`, events: `raw/${name}.jsonl` };
    record.invocations.push(invocation); checkpoint();
    const fds = [invocation.stdout, invocation.stderr, invocation.events].map(path => openSync(join(output, path), 'wx'));
    let result;
    try { result = spawnSync(executable, args, { cwd: canonical, env: childEnv, stdio: ['ignore', ...fds], timeout: 180000 }); }
    finally { for (const fd of fds) closeSync(fd); }
    Object.assign(invocation, { status: result.status === 0 ? 'completed' : 'failed', exitStatus: result.status, signal: result.signal, error: result.error?.message, finishedAt: new Date().toISOString(),
      stdoutSha256: sha256(readFileSync(join(output, invocation.stdout))), stderrSha256: sha256(readFileSync(join(output, invocation.stderr))), eventsSha256: sha256(readFileSync(join(output, invocation.events))) });
    checkpoint();
    invocation.stageAfter = checkAfterSubject(contexts[variant], canonical, before);
    assert.equal(result.status, 0, `Subject ${name} failed; raw output retained, no retry: ${result.error?.message ?? result.signal}`);
    if (proofPath) { checkpoint(); return { ordinal, proofPath, passed: true }; }
    const events = readFileSync(join(output, invocation.events), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).event, 'result'); const parsed = events.at(-1).result;
    assert.deepEqual(events.filter(event => event.event === 'batch').map(event => event.row), [...parsed.calibration, ...parsed.warmup, ...parsed.measured]);
    writeFileSync(join(output, 'raw', `${name}.json`), JSON.stringify(parsed, null, 2));
    assert.deepEqual(parsed.request, request); assert.equal(parsed.metadata.versions.node, process.versions.node); assert.equal(parsed.metadata.arch, process.arch);
    assert.deepEqual(parsed.metadata.execArgv, flags); assert.equal(parsed.metadata.executableSha256, record.node.sha256);
    assert.equal(parsed.metadata.cwd, canonical); assert.equal(parsed.metadata.entryPath, record.canonicalEntryPath);
    assert.equal(parsed.metadata.harnessSha256, sha256(subjectBytes)); assert.equal(parsed.metadata.entrySha256, before.entries.find(e => e.path === 'dist/shared.js').sha256);
    assert.equal(parsed.metadata.packageSha256, sha256(contexts[variant].packageBytes));
    assert.equal(parsed.dependencySets, variant === 'baseline' ? 512 ** 2 : 512); assert.equal(parsed.traversedArenaValues, variant === 'baseline' ? 512 ** 2 : 512);
    assert.equal(parsed.graph.treatment, request.treatment); assert.equal(parsed.graph.arenas, 512);
    const dense = state === 'B' || state === 'D';
    assert.equal(parsed.graph.distinctLookupMaps, dense ? 512 : 1); assert.equal(parsed.graph.lookupEntries, dense ? 261632 : 512);
    assert.equal(parsed.graph.selfEntries, dense ? 0 : 512); assert.equal(parsed.graph.sharedFastExport, state === 'C');
    if (request.phase === 'census') { assert(parsed.census?.wrappersRestored); assert.equal(parsed.weakMaps.alive, state === 'D' ? 512 : 0); }
    else { assert.equal(parsed.census, null); assert.equal(parsed.weakMaps, null); assert(!before.entries.some(e => e.path === 'census.mjs')); }
    if (['measure', 'trace'].includes(request.phase)) {
      assert.equal(parsed.calibration.length, 0); assert.equal(parsed.warmup.length, 3); assert.equal(parsed.measured.length, 7); assert.equal(parsed.iterations, request.iterations);
      for (const batch of [...parsed.warmup, ...parsed.measured]) {
        assert.equal(batch.iterations, request.iterations); assert(Number.isFinite(batch.elapsedMs) && batch.elapsedMs > 0);
        assert.equal(batch.msPerOperation, batch.elapsedMs / request.iterations); assert.equal(batch.shortBatch, batch.elapsedMs < protocol.minimumBatchMs);
      }
    }
    return { ordinal, result: parsed };
  }
  const requestFor = (state, phase, iterations) => ({ operation: 'warmNestedRead', arenas: 512, treatment: protocol.states[state].treatment, phase, settings, ...(iterations ? { iterations } : {}) });
  record.status = 'correctness'; checkpoint();
  for (const state of ['B', 'C']) for (const path of Object.keys(originalProofs)) record.correctness.push({ state, ...invoke(state, null, { phase: 'real-worker-correctness' }, path) });
  for (const state of Object.keys(protocol.states)) {
    record.census.push({ state, ...invoke(state, requestFor(state, 'census'), { phase: 'untimed-census' }) }); checkpoint();
  }
  if (!correctnessOnly) {
    record.status = 'pilots'; checkpoint();
    for (const state of record.pilotOrder) { record.pilots[state] = invoke(state, requestFor(state, 'pilot'), { phase: 'pilot' }); checkpoint(); }
    const iterations = Math.max(...Object.values(record.pilots).map(pilot => pilot.result.prescribedIterations));
    assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= protocol.maximumIterations);
    record.plan = { iterations, warmupOperationsPerProcess: 3 * iterations, measuredOperationsPerProcess: 7 * iterations, frozenAt: new Date().toISOString() };
    writeFileSync(join(output, 'frozen-plan.json'), JSON.stringify({ manifestSha256: record.manifestSha256, schedule: record.schedule, pilots: record.pilots, plan: record.plan }, null, 2));
    record.frozenPlanSha256 = sha256(readFileSync(join(output, 'frozen-plan.json')));
    record.status = 'measuring'; checkpoint();
    for (const planned of record.schedule) {
      const block = { ...planned, subjects: [] }; record.blocks.push(block); checkpoint();
      for (const role of planned.roles) {
        const state = stateFor(planned.arm, role);
        block.subjects.push({ role, state, ...invoke(state, requestFor(state, 'measure', iterations), { phase: 'measure', ...planned, role }) }); checkpoint();
      }
      console.log(`${planned.arm} quartet ${planned.quartet}/8 ${planned.order} retained`);
    }
    assert.equal(record.blocks.flatMap(block => block.subjects).length, protocol.measuredSubjects);
    assert.equal(sha256(readFileSync(join(output, 'frozen-plan.json'))), record.frozenPlanSha256);
    record.status = 'tracing'; checkpoint();
    for (const state of Object.keys(protocol.states)) {
      record.diagnostics.push({ state, ...invoke(state, requestFor(state, 'trace', iterations), { phase: 'diagnostic-JIT-GC-not-inference' }) }); checkpoint();
    }
  }
  const after = causalGuard(baseline, candidate, proofRoot);
  writeFileSync(join(output, 'source-guard-after.json'), JSON.stringify(after, null, 2)); assert.deepEqual(after, guard);
  record.integrityComplete = true; record.status = correctnessOnly ? 'correctness-completed-no-timings' : 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
} catch (error) {
  record.status = 'failed'; record.error = error.stack ?? String(error); record.finishedAt = new Date().toISOString(); checkpoint(); throw error;
} finally { rmSync(temporary, { recursive: true, force: true }); }
