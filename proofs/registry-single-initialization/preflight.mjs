/** Correctness/build evidence only. No CLI can request a pilot or measured kernel. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, sourcePaths } from '../worker-arena-source-guard.mjs';
import { config, verifyPrimaryBytes, verifyTrackedSources, captureBuilds } from './preflight-guard.mjs';
import { sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment, treeManifest } from './package-tools.mjs';

const proofRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [arch, outputArg] = process.argv.slice(2);
assert(['arm64', 'x64'].includes(arch) && outputArg && process.argv.length === 4, 'Usage: node preflight.mjs arm64|x64 NEW_OUTPUT');
const output = resolve(outputArg);
assert(!existsSync(output), 'Preflight output must be new');
mkdirSync(output, { recursive: true });
for (const d of ['raw', 'inputs', 'worktrees', 'neutral', 'temporary']) mkdirSync(join(output, d));
const node = realpathSync(process.execPath);
const bun = realpathSync(process.env.BUN_EXECUTABLE);
const roots = Object.fromEntries(config.variants.map(role => [role, join(output, 'worktrees', role)]));
const record = {
  schemaVersion: 1, mode: config.mode, status: 'preparing', startedAt: new Date().toISOString(),
  config, configSha256: sha256(readFileSync(new URL('./preflight.json', import.meta.url))),
  proofCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proofRoot, encoding: 'utf8' }).trim(),
  runner: Object.fromEntries(['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'RUNNER_ARCH', 'RUNNER_OS', 'ImageOS', 'ImageVersion'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
  host: { arch: process.arch, platform: process.platform, osRelease: release(), cpus: cpus() },
  invocations: [], fixtureResults: [], measuredSubjects: 0, pilotSubjects: 0,
};
const checkpoint = () => writeFileSync(join(output, 'summary.json'), JSON.stringify(record, null, 2) + '\n');
checkpoint();
let ordinal = 0;
const commandEnv = { ...process.env, TMPDIR: join(output, 'temporary'), NODE_DISABLE_COMPILE_CACHE: '1' };
delete commandEnv.NODE_OPTIONS; delete commandEnv.BUN_OPTIONS;
function run(label, executable, args, cwd, env = commandEnv) {
  const id = String(++ordinal).padStart(3, '0');
  const item = { id, label, executable, args, cwd, startedAt: new Date().toISOString(), status: 'running' };
  record.invocations.push(item); checkpoint();
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(output, 'raw', id + '.stdout'), result.stdout ?? '');
  writeFileSync(join(output, 'raw', id + '.stderr'), result.stderr ?? '');
  Object.assign(item, { status: result.status === 0 ? 'completed' : 'failed', exitStatus: result.status,
    signal: result.signal, error: result.error?.message, stdoutSha256: sha256(result.stdout ?? ''),
    stderrSha256: sha256(result.stderr ?? ''), finishedAt: new Date().toISOString() });
  checkpoint();
  if (result.status !== 0) {
    console.error(result.stdout ?? ''); console.error(result.stderr ?? '');
    throw new Error(label + ' failed: ' + (result.error?.message ?? result.status));
  }
  console.log('PASS ' + label);
  return result.stdout;
}
function archiveAvailableInputs(role) {
  const dest = join(output, 'inputs', role), errors = [], retained = [];
  mkdirSync(dest, { recursive: true });
  const take = (label, operation) => {
    try { operation(); retained.push(label); }
    catch (error) { errors.push({ label, error: error.stack ?? String(error) }); }
  };
  take('pinned-source-tar', () => execFileSync('git', ['archive', '--format=tar', '--output=' + join(dest, 'source.tar'), config.pins[role]], { cwd: proofRoot }));
  if (existsSync(roots[role])) {
    if (existsSync(join(roots[role], 'dist'))) take('available-dist', () => cpSync(join(roots[role], 'dist'), join(dest, 'dist'), { recursive: true }));
    if (existsSync(join(roots[role], 'package.json'))) take('package.json', () => cpSync(join(roots[role], 'package.json'), join(dest, 'package.json')));
    let paths = [];
    take('source-path-discovery', () => { paths = sourcePaths(roots[role]); });
    for (const path of paths) take('guarded-source/' + path, () => {
      const target = join(dest, 'guarded-source', path);
      mkdirSync(dirname(target), { recursive: true }); cpSync(join(roots[role], path), target);
    });
    take('worktree-status', () => writeFileSync(join(dest, 'worktree-status.txt'), execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: roots[role] })));
  }
  take('available-input-manifest', () => writeFileSync(join(dest, 'available-input-manifest.json'), JSON.stringify(treeManifest(dest), null, 2) + '\n'));
  const result = { role, worktreeExisted: existsSync(roots[role]), retained, errors };
  writeFileSync(join(dest, 'retention.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

try {
  assert.equal(process.platform, config.toolchain.platform);
  assert.equal(process.arch, arch);
  assert.equal(process.versions.node, config.toolchain.node);
  assert.equal(process.versions.bun, undefined);
  assert.deepEqual(process.execArgv, []);
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Only the first workflow attempt is admitted');
  const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: proofRoot, encoding: 'utf8' }).trim().split(/\s+/).slice(1);
  assert.deepEqual(parents, [config.runtimeParent], 'Proof commit must have exactly one parent: frozen cleanup');
  assert.equal(execFileSync('git', ['rev-parse', config.runtimeParent + '^{tree}'], { cwd: proofRoot, encoding: 'utf8' }).trim(), config.runtimeTree);
  const changed = execFileSync('git', ['diff', '--name-only', config.runtimeParent, 'HEAD'], { cwd: proofRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert(changed.length > 0 && changed.every(p => p.startsWith('proofs/registry-single-initialization/') || p === '.github/workflows/registry-single-initialization-preflight.yml'), 'Preflight commit must be proof-only');
  record.originalSubject = verifyPrimaryBytes(proofRoot);
  cpSync(join(proofRoot, 'proofs/registry-single-initialization'), join(output, 'inputs', 'proof'), { recursive: true });
  cpSync(join(proofRoot, '.github/workflows/registry-single-initialization-preflight.yml'), join(output, 'inputs', 'workflow.yml'));
  record.proofInputs = treeManifest(join(output, 'inputs', 'proof'));
  assert.deepEqual(treeManifest(join(proofRoot, 'proofs/registry-single-initialization')), record.proofInputs);
  record.workflowSha256 = sha256(readFileSync(join(proofRoot, '.github/workflows/registry-single-initialization-preflight.yml')));
  for (const role of config.variants) run('worktree-' + role, 'git', ['worktree', 'add', '--detach', roots[role], config.pins[role]], proofRoot);
  record.exactSourceDelta = verifyTrackedSources(roots); checkpoint();
  run('protocol-tests', node, ['--test', 'proofs/registry-single-initialization/preflight.node.mjs'], proofRoot);
  run('install', bun, ['install'], proofRoot);
  const bunVersion = run('bun-version', bun, ['--version'], proofRoot).trim();
  assert.equal(bunVersion, config.toolchain.bun);
  const ascPackage = join(proofRoot, 'node_modules/assemblyscript/package.json');
  const ascCompiler = join(proofRoot, 'node_modules/assemblyscript/dist/asc.js');
  const tsPackage = join(proofRoot, 'node_modules/typescript/package.json');
  const tsCompiler = join(proofRoot, 'node_modules/typescript/lib/typescript.js');
  assert.equal(JSON.parse(readFileSync(ascPackage)).version, config.toolchain.assemblyscript);
  assert.equal(JSON.parse(readFileSync(tsPackage)).version, config.toolchain.typescript);
  record.tools = {
    node: { version: process.versions.node, sha256: sha256(readFileSync(node)), versions: process.versions },
    bun: { version: bunVersion, sha256: sha256(readFileSync(bun)), revision: run('bun-revision', bun, ['--revision'], proofRoot).trim() },
    assemblyscript: { version: config.toolchain.assemblyscript, packageSha256: sha256(readFileSync(ascPackage)), compilerSha256: sha256(readFileSync(ascCompiler)) },
    typescript: { version: config.toolchain.typescript, packageSha256: sha256(readFileSync(tsPackage)), compilerSha256: sha256(readFileSync(tsCompiler)) },
  };
  const compilers = join(output, 'inputs', 'compilers'); mkdirSync(compilers);
  for (const [name, path] of Object.entries({ 'assemblyscript-package.json': ascPackage, 'asc.js': ascCompiler, 'typescript-package.json': tsPackage, 'typescript.js': tsCompiler })) cpSync(path, join(compilers, name));
  record.status = 'building'; checkpoint();
  for (const role of config.variants) {
    symlinkSync(join(proofRoot, 'node_modules'), join(roots[role], 'node_modules'), 'dir');
    for (const script of ['build:wasm', 'build:browser', 'build:types']) run(role + '-' + script, bun, ['run', script], roots[role]);
  }
  record.buildsBefore = captureBuilds(roots); checkpoint();
  const workerProofs = Object.fromEntries(config.prerequisites.workerProofs.map(path => [path, readFileSync(join(proofRoot, path))]));
  for (const [path, bytes] of Object.entries(workerProofs)) assert.deepEqual(bytes, execFileSync('git', ['show', config.pins.cleanup + ':' + path], { cwd: proofRoot }));
  record.workerProofSha256 = Object.fromEntries(Object.entries(workerProofs).map(([path, bytes]) => [path, sha256(bytes)]));
  record.status = 'checking'; checkpoint();
  for (const role of config.variants) {
    for (const script of config.prerequisites.typeScripts) run(role + '-' + script, bun, ['run', script], roots[role]);
    run(role + '-worker-types', node, [join(proofRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.worker.json'], roots[role]);
    const tests = [...config.prerequisites.commonTests, ...(role === 'main' ? [] : config.prerequisites.registryTests)];
    run(role + '-supported-focused-tests', bun, ['--bun', join(proofRoot, 'node_modules/vitest/vitest.mjs'), 'run', ...tests], roots[role]);
    run(role + '-package-consumer', bun, ['run', 'check:package'], roots[role]);
    mkdirSync(join(output, 'inputs', role), { recursive: true });
    run(role + '-pack', 'npm', ['pack', '--ignore-scripts', '--pack-destination', join(output, 'inputs', role)], roots[role]);
    const context = sourceContext(roots[role]), canonical = join(output, 'neutral', 'subject');
    const original = readFileSync(new URL('./original-subject.mjs', import.meta.url));
    const owned = readFileSync(new URL('./owned-subject.mjs', import.meta.url));
    const env = cleanEnvironment({ ...commandEnv, TMPDIR: join(output, 'temporary') });
    for (const path of Object.keys(workerProofs)) {
      const before = stageCanonical(context, canonical, original, workerProofs);
      run(role + '-neutral-' + path, node, [join(canonical, path)], canonical, env);
      checkAfterSubject(context, canonical, before);
    }
    for (const fixture of [{ subject: 'original', arenas: 1 }, { subject: 'original', arenas: 512 }, { subject: 'owned', arenas: 512 }]) {
      const subject = fixture.subject === 'original' ? original : owned;
      const before = stageCanonical(context, canonical, subject);
      const request = { operation: 'warmNestedRead', arenas: fixture.arenas, phase: 'correctness', settings: {} };
      const stdout = run(role + '-fixture-' + fixture.subject + '-' + fixture.arenas, node, ['--expose-gc', join(canonical, 'subject.mjs'), JSON.stringify(request)], canonical, env);
      checkAfterSubject(context, canonical, before);
      const events = stdout.trim().split('\n').map(line => JSON.parse(line));
      assert(events.every(e => e.event !== 'batch'), 'Correctness cannot execute pilot, warmup or sample batches');
      const result = events.at(-1).result;
      assert.equal(events.at(-1).event, 'result');
      assert.deepEqual(result.request, request);
      assert.equal(result.metadata.harnessSha256, sha256(subject));
      assert.equal(result.metadata.executableSha256, record.tools.node.sha256);
      assert.equal(result.metadata.arch, arch);
      assert.equal(result.metadata.entrySha256, before.entries.find(e => e.path === 'dist/shared.js').sha256);
      assert.equal(result.calibration.length + result.warmup.length + result.measured.length, 0);
      if (fixture.subject === 'original') {
        const expected = role === 'main' ? fixture.arenas ** 2 : fixture.arenas;
        assert.equal(result.dependencySets, expected);
        assert.equal(result.traversedArenaValues, expected);
      } else assert.equal(result.correctness.retainedOwnedSnapshot, true);
      record.fixtureResults.push({ role, ...fixture, result }); checkpoint();
    }
  }
  record.buildsAfter = captureBuilds(roots);
  assert.deepEqual(record.buildsAfter, record.buildsBefore, 'Source or built inputs changed during correctness checks');
  assert.deepEqual(treeManifest(join(output, 'inputs', 'proof')), record.proofInputs);
  assert.deepEqual(treeManifest(join(proofRoot, 'proofs/registry-single-initialization')), record.proofInputs, 'Live proof files changed');
  assert.equal(sha256(readFileSync(join(proofRoot, '.github/workflows/registry-single-initialization-preflight.yml'))), record.workflowSha256);
  assert.equal(sha256(readFileSync(node)), record.tools.node.sha256);
  assert.equal(sha256(readFileSync(bun)), record.tools.bun.sha256);
  assert.equal(sha256(readFileSync(ascPackage)), record.tools.assemblyscript.packageSha256);
  assert.equal(sha256(readFileSync(ascCompiler)), record.tools.assemblyscript.compilerSha256);
  assert.equal(sha256(readFileSync(tsPackage)), record.tools.typescript.packageSha256);
  assert.equal(sha256(readFileSync(tsCompiler)), record.tools.typescript.compilerSha256);
  record.integrityComplete = true; record.status = 'passed-correctness-build-only';
  record.receipt = {
    proofCommit: record.proofCommit, configSha256: record.configSha256, arch,
    pins: Object.fromEntries(config.variants.map(role => [role, config.pins[role]])),
    originalSubject: record.originalSubject, tools: record.tools,
    builds: Object.fromEntries(config.variants.map(role => [role, {
      source: record.buildsAfter[role].source.sha256, emittedJs: record.buildsAfter[role].build.sha256,
      wasm: record.buildsAfter[role].wasm.sha256, completeDist: record.buildsAfter[role].completeDist.sha256,
    }])),
    correctness: 'passed', integrityComplete: true, measuredSubjects: 0, pilotSubjects: 0,
  };
} catch (error) {
  record.status = 'failed'; record.error = error.stack ?? String(error);
  process.exitCode = 1; console.error(record.error);
} finally {
  // Preserve available inputs even when a build or the first digest guard failed.
  record.inputRetention = [];
  for (const role of config.variants) {
    try { record.inputRetention.push(archiveAvailableInputs(role)); }
    catch (error) { record.inputRetention.push({ role, errors: [{ error: error.stack ?? String(error) }] }); }
  }
  if (record.inputRetention.some(item => item.errors.length)) {
    record.status = 'failed'; record.integrityComplete = false; process.exitCode = 1;
    if (record.receipt) writeFileSync(join(output, 'provisional-receipt-not-approved.json'), JSON.stringify(record.receipt, null, 2) + '\n');
    delete record.receipt;
  }
  if (record.status === 'failed' && existsSync(join(output, 'neutral'))) {
    // A staging-integrity failure must retain the offending package, not just its source.
    try {
      const failedStage = join(output, 'inputs', 'failed-neutral');
      cpSync(join(output, 'neutral'), failedStage, { recursive: true });
      record.failedStageRetention = { copied: true };
      try { record.failedStageRetention.manifest = treeManifest(failedStage); }
      catch (error) { record.failedStageRetention.manifestError = error.stack ?? String(error); }
    } catch (error) {
      record.failedStageRetention = { copied: false, error: error.stack ?? String(error) };
      process.exitCode = 1;
    }
  }
  if (record.status === 'passed-correctness-build-only') {
    writeFileSync(join(output, 'receipt.json'), JSON.stringify(record.receipt, null, 2) + '\n');
    console.log('REGISTRY_PREFLIGHT_RECEIPT=' + JSON.stringify(record.receipt));
  }
  record.finishedAt = new Date().toISOString(); checkpoint();
}
