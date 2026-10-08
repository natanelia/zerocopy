/** Separate bounded diagnostic. Never invokes or edits the historical runner. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocol, randomSource, shuffle, scheduleCase, variantFor, summarizeCase, applyRunIntegrity } from './registry-attachment-protocol.mjs';
import { PROOF_PATHS, pinnedGuard, sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment } from './registry-attachment-guard.mjs';
import { sha256 } from './worker-arena-source-guard.mjs';

const [baselineArg, candidateArg, group, outputArg, option] = process.argv.slice(2);
assert(baselineArg && candidateArg && ['x64', 'arm64'].includes(group) && outputArg && [undefined, '--correctness-only'].includes(option),
  'Usage: node proofs/run-registry-attachment-controls.mjs BASELINE CANDIDATE x64|arm64 NEW_OUTPUT [--correctness-only]');
const correctnessOnly = option === '--correctness-only';
const proofRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), output = resolve(outputArg);
assert(!existsSync(output), 'Output must be new; never overwrite, resume, or retry a diagnostic');
mkdirSync(output, { recursive: true }); mkdirSync(join(output, 'raw'));
const baseline = realpathSync(baselineArg), candidate = realpathSync(candidateArg);
const selected = protocol.cases.filter(row => row.arch === group);
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'registry-controls-'))), canonical = join(temporary, 'subject');
const childEnv = cleanEnvironment(), executable = realpathSync(process.execPath);
const subjectBytes = readFileSync(new URL('./registry-attachment-subject.mjs', import.meta.url));
const originalProofs = Object.fromEntries(['worker-arenas', 'node-worker', 'typed-json-worker'].map(name => [`proofs/${name}.mjs`, readFileSync(join(proofRoot, `proofs/${name}.mjs`))]));
let ordinal = 0;
const record = {
  schemaVersion: 1, status: 'preparing', startedAt: new Date().toISOString(), correctnessOnly, protocol,
  manifestSha256: sha256(readFileSync(new URL('./registry-attachment-controls.manifest.json', import.meta.url))),
  node: { version: process.version, versions: process.versions, executable, sha256: sha256(readFileSync(executable)), execArgv: process.execArgv },
  host: { platform: process.platform, arch: process.arch, cpu: cpus(), loadavg: loadavg(), osRelease: release() },
  runner: Object.fromEntries(['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'RUNNER_ARCH', 'RUNNER_OS', 'ImageOS', 'ImageVersion'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
  runtimeSettings: { childEnvironment: childEnv, flags: ['--expose-gc'], jit: 'default; no tier, seed, optimization, affinity, or frequency controls', compileCache: 'disabled for every subject', workerSubjects: 'fresh process each time', roleMetadataInSubject: false },
  canonicalPackagePath: canonical, canonicalEntryPath: join(canonical, 'dist/shared.js'), canonicalRunnerPath: join(canonical, 'subject.mjs'),
  schedule: selected.map((row, index) => ({ ...row, schedule: scheduleCase(protocol.seed + protocol.cases.indexOf(row)), pilotOrder: shuffle(['baseline', 'candidate'], randomSource(protocol.seed + 100 + index)) })),
  correctness: [], rows: selected.map(row => ({ ...row, pilots: {}, plan: null, blocks: [] })), invocations: [],
};
function checkpoint() {
  for (const row of record.rows) row.summary = applyRunIntegrity(summarizeCase(row.blocks), record);
  const positive = record.rows.find(row => row.role === 'positive-control');
  record.positiveControlConfirmed = positive ? positive.summary.inferenceValid && positive.summary.arms.ab.inference?.ci95[1] < 1 : null;
  record.reviewRestriction = 'Diagnostic only. Historical adverse/inconclusive results remain; no blanket acceptance or causal attribution.';
  if (positive && !record.positiveControlConfirmed) record.reviewRestriction += ' Positive control not yet confirmed; x64 primary inference cannot support acceptance.';
  writeFileSync(join(output, 'summary.json'), JSON.stringify(record, null, 2) + '\n');
}
checkpoint();
try {
  assert.equal(process.platform, protocol.toolchain.platform); assert.equal(process.arch, group);
  assert(!process.versions.bun, 'Controller must use Node');
  if (!correctnessOnly) assert.equal(process.versions.node, protocol.toolchain.node, 'Exact prospectively pinned Node required');
  assert.deepEqual(process.execArgv, [], 'Controller cannot inject Node flags');
  const guard = pinnedGuard(baseline, candidate, proofRoot); record.guard = guard;
  writeFileSync(join(output, 'source-guard-before.json'), JSON.stringify(guard, null, 2));
  record.sourceGuardSha256 = sha256(readFileSync(join(output, 'source-guard-before.json')));
  const contexts = { baseline: sourceContext(baseline), candidate: sourceContext(candidate) };
  assert.deepEqual(contexts.baseline.packageBytes, contexts.candidate.packageBytes, 'Original package bytes must match');
  record.sourceContexts = Object.fromEntries(Object.entries(contexts).map(([v, c]) => [v, { packageSha256: sha256(c.packageBytes), completeDist: c.distManifest }]));
  // Archive every input, not just hashes, alongside immutable historical evidence.
  for (const variant of ['baseline', 'candidate']) {
    const dest = join(output, 'inputs', variant); mkdirSync(dest, { recursive: true });
    cpSync(contexts[variant].dist, join(dest, 'dist'), { recursive: true });
    writeFileSync(join(dest, 'package.json'), contexts[variant].packageBytes);
    for (const file of guard[variant].source.files) {
      const target = join(dest, 'guarded-source', file.path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(guard[variant].root, file.path), target);
    }
  }
  for (const path of PROOF_PATHS) { const target = join(output, 'inputs', 'proof', path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(proofRoot, path), target); }
  if (!correctnessOnly) {
    const bunExecutable = realpathSync(process.env.BUN_EXECUTABLE ?? '');
    const bunVersion = execFileSync(bunExecutable, ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(bunVersion, protocol.toolchain.bun);
    const asc = JSON.parse(readFileSync(join(proofRoot, 'node_modules/assemblyscript/package.json'))).version;
    assert.equal(asc, protocol.toolchain.assemblyscript);
    record.buildTools = { bunExecutable, bunVersion, bunSha256: sha256(readFileSync(bunExecutable)), assemblyscript: asc,
      assemblyscriptPackageSha256: sha256(readFileSync(join(proofRoot, 'node_modules/assemblyscript/package.json'))),
      assemblyscriptCompilerSha256: sha256(readFileSync(join(proofRoot, 'node_modules/assemblyscript/dist/asc.js'))) };
  }
  const settingsFor = row => ({ samples: protocol.samples, warmups: protocol.warmups, minimumBatchMs: protocol.minimumBatchMs,
    pilotTargetBatchMs: protocol.pilotTargetBatchMs, pilotMaximumBatches: protocol.pilotMaximumBatches,
    initialIterations: protocol.pilotBounds[row.operation].initial, maximumIterations: protocol.pilotBounds[row.operation].maximum });
  function invoke(variant, request, context, proofPath = null) {
    const before = stageCanonical(contexts[variant], canonical, subjectBytes, proofPath ? originalProofs : {});
    const name = String(++ordinal).padStart(4, '0'), startedAt = new Date().toISOString(), start = performance.now();
    const args = proofPath ? [join(canonical, proofPath)] : ['--expose-gc', join(canonical, 'subject.mjs'), JSON.stringify(request)];
    const invocation = { ordinal, variant, context, startedAt, command: [executable, ...args], stageBefore: before, status: 'running' };
    record.invocations.push(invocation); checkpoint();
    const result = spawnSync(executable, args, { cwd: canonical, env: childEnv, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(join(output, 'raw', `${name}.stdout`), result.stdout ?? ''); writeFileSync(join(output, 'raw', `${name}.stderr`), result.stderr ?? '');
    Object.assign(invocation, { status: result.status === 0 ? 'completed' : 'failed', exitStatus: result.status, signal: result.signal, error: result.error?.message, wallMs: performance.now() - start,
      stdout: `raw/${name}.stdout`, stderr: `raw/${name}.stderr`, stdoutSha256: sha256(result.stdout ?? ''), stderrSha256: sha256(result.stderr ?? '') });
    checkpoint();
    invocation.stageAfter = checkAfterSubject(contexts[variant], canonical, before);
    assert.equal(result.status, 0, `Subject ${name} failed; retained evidence, no retry: ${result.error?.message ?? result.stderr}`);
    if (proofPath) { checkpoint(); return { ordinal, proofPath, passed: true }; }
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).event, 'result', 'Subject did not finish; raw JSONL is retained');
    const parsed = events.at(-1).result;
    assert.deepEqual(events.filter(event => event.event === 'batch').map(event => event.row), [...parsed.calibration, ...parsed.warmup, ...parsed.measured]);
    writeFileSync(join(output, 'raw', `${name}.json`), JSON.stringify(parsed, null, 2));
    assert.deepEqual(parsed.request, request);
    assert.equal(parsed.metadata.versions.node, process.versions.node); assert.equal(parsed.metadata.arch, group);
    assert.equal(parsed.metadata.executableSha256, record.node.sha256); assert.equal(parsed.metadata.cwd, canonical);
    assert.equal(parsed.metadata.entryPath, record.canonicalEntryPath); assert.equal(parsed.metadata.harnessSha256, sha256(subjectBytes));
    assert.equal(parsed.metadata.entrySha256, before.entries.find(e => e.path === 'dist/shared.js').sha256);
    assert.equal(parsed.metadata.packageSha256, sha256(contexts[variant].packageBytes));
    assert.equal(parsed.dependencySets, variant === 'baseline' ? request.arenas ** 2 : request.arenas);
    assert.equal(parsed.traversedArenaValues, variant === 'baseline' ? request.arenas ** 2 : request.arenas);
    if (request.phase === 'measure') {
      assert.equal(parsed.calibration.length, 0); assert.equal(parsed.warmup.length, protocol.warmups); assert.equal(parsed.measured.length, protocol.samples);
      assert.equal(parsed.iterations, request.iterations);
      for (const batch of [...parsed.warmup, ...parsed.measured]) {
        assert.equal(batch.iterations, request.iterations); assert(Number.isFinite(batch.elapsedMs) && batch.elapsedMs > 0);
        assert.equal(batch.msPerOperation, batch.elapsedMs / request.iterations); assert.equal(batch.shortBatch, batch.elapsedMs < protocol.minimumBatchMs);
      }
    }
    return { ordinal, result: parsed };
  }
  record.status = 'correctness'; checkpoint();
  for (const variant of ['baseline', 'candidate']) {
    for (const proofPath of Object.keys(originalProofs)) record.correctness.push({ variant, ...invoke(variant, null, { phase: 'real-worker-correctness' }, proofPath) });
    for (const row of record.rows) record.correctness.push({ variant, caseId: row.id, ...invoke(variant, { operation: row.operation, arenas: row.arenas, phase: 'correctness', settings: settingsFor(row) }, { phase: 'fixture-correctness', caseId: row.id }) });
  }
  if (!correctnessOnly) {
    record.status = 'pilots'; checkpoint();
    // Finish and save ALL disposable pilots and frozen plans before any timing sample.
    for (const row of record.rows) {
      const scheduled = record.schedule.find(s => s.id === row.id);
      for (const variant of scheduled.pilotOrder) {
        row.pilots[variant] = invoke(variant, { operation: row.operation, arenas: row.arenas, phase: 'pilot', settings: settingsFor(row) }, { phase: 'pilot', caseId: row.id }); checkpoint();
      }
      const iterations = Math.max(...Object.values(row.pilots).map(p => p.result.prescribedIterations));
      assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= protocol.pilotBounds[row.operation].maximum, 'Pilot exceeds prospective work bound; stop before measurements');
      row.plan = { iterations, warmupOperationsPerProcess: protocol.warmups * iterations, measuredOperationsPerProcess: protocol.samples * iterations, frozenAt: new Date().toISOString() }; checkpoint();
    }
    record.plansFrozenAt = new Date().toISOString();
    writeFileSync(join(output, 'frozen-plans.json'), JSON.stringify({ protocolSha256: record.manifestSha256, schedule: record.schedule, plans: record.rows.map(row => ({ id: row.id, pilots: row.pilots, plan: row.plan })) }, null, 2));
    record.frozenPlansSha256 = sha256(readFileSync(join(output, 'frozen-plans.json')));
    record.status = 'measuring'; checkpoint();
    for (const row of record.rows) for (const planned of record.schedule.find(s => s.id === row.id).schedule) {
      const block = { ...planned, subjects: [] }; row.blocks.push(block); checkpoint();
      for (const role of planned.roles) {
        const variant = variantFor(planned.mode, role);
        block.subjects.push({ role, variant, ...invoke(variant, { operation: row.operation, arenas: row.arenas, phase: 'measure', iterations: row.plan.iterations, settings: settingsFor(row) }, { caseId: row.id, ...planned, role }) }); checkpoint();
      }
      console.log(`${row.id} ${planned.mode} quartet ${planned.quartet}/8 ${planned.order} retained`);
    }
    assert.equal(record.frozenPlansSha256, sha256(readFileSync(join(output, 'frozen-plans.json'))));
  }
  const after = pinnedGuard(baseline, candidate, proofRoot);
  writeFileSync(join(output, 'source-guard-after.json'), JSON.stringify(after, null, 2));
  assert.deepEqual(after, guard, 'Sources, builds or proof changed during study');
  record.integrityComplete = true;
  record.status = correctnessOnly ? 'correctness-completed-no-timings' : 'completed'; record.finishedAt = new Date().toISOString(); checkpoint();
} catch (error) {
  record.status = 'failed'; record.error = error.stack ?? String(error); record.finishedAt = new Date().toISOString(); checkpoint(); throw error;
} finally { rmSync(temporary, { recursive: true, force: true }); }
