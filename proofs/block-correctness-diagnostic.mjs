// Checks only. No performance module or subject is imported or invoked.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, save, TEST_TIMEOUT_MS } from './block-correctness-command.mjs';
import { HERE, PROOF, PINS, FILES, sha256, digest, inventory, copyFiles, exactTree, proofIdentity,
  verifyInvocation, dependencyIdentity, cacheReceipt, configSource } from './block-correctness-identity.mjs';

export function readTrace(directory, source = 'reporter') {
  return inventory(directory).filter(file => file.path.startsWith(source + '-')).flatMap(file => {
    const text = readFileSync(join(directory, file.path), 'utf8');
    assert(text.endsWith('\n'), `Partial trace record: ${file.path}`);
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  });
}
export function validateTrace(records, arm) {
  const expectedFiles = PINS[arm].testFiles.map(f => f.path).sort();
  for (const event of ['module-queued', 'module-collected', 'module-start']) assert.deepEqual(records.filter(r => r.event === event).map(r => r.relativeFile).sort(), expectedFiles, `Missing/duplicate ${event}`);
  const end = records.filter(r => r.event === 'run-end');
  assert.equal(end.length, 1, 'Exactly one completed full run required');
  assert.equal(end[0].reason, 'passed'); assert.deepEqual(end[0].unhandledErrors, []);
  const modules = records.filter(r => r.event === 'module-end');
  assert.deepEqual(modules.map(r => r.relativeFile).sort(), PINS[arm].testFiles.map(f => f.path).sort());
  assert(modules.every(r => r.state === 'passed'));
  const tests = records.filter(r => r.event === 'test-result');
  assert.equal(tests.length, arm === 'baseline' ? 774 : 784);
  assert.equal(new Set(tests.map(r => r.id)).size, tests.length);
  assert.deepEqual(records.filter(r => r.event === 'test-ready').map(r => r.id).sort(), tests.map(r => r.id).sort());
  assert(tests.every(r => r.state === 'passed'), 'Skipped, failed, or pending tests cannot seal this diagnostic');
  return { modules: modules.length, tests: tests.length, reason: end[0].reason };
}
export function validateObservation(directory, arm, root) {
  const result = validateTrace(readTrace(directory), arm);
  const expectedFiles = PINS[arm].testFiles.map(f => f.path).sort();
  const workers = readTrace(directory, 'worker');
  assert(workers.length && workers.every(r => r.workerId !== null && r.poolId !== null && r.isMainThread === false), 'Missing direct worker identity');
  for (const event of ['worker-collect-start', 'worker-module-start', 'worker-module-end']) {
    assert.deepEqual(workers.filter(r => r.event === event).map(r => relative(root, r.file)).sort(), expectedFiles, `Missing/duplicate ${event}`);
  }
  for (const event of ['worker-import-start', 'worker-import-end']) {
    assert.deepEqual(workers.filter(r => r.event === event && r.importSource === 'collect').map(r => relative(root, r.file)).sort(), expectedFiles, `Missing/duplicate ${event}`);
  }
  const finished = workers.filter(r => r.event === 'worker-test-result');
  assert.equal(finished.length, result.tests); assert(finished.every(r => r.state === 'pass'));
  const ids = finished.map(r => r.id).sort();
  assert.deepEqual(workers.filter(r => r.event === 'worker-test-ready').map(r => r.id).sort(), ids);
  assert.deepEqual(readTrace(directory).filter(r => r.event === 'test-result').map(r => r.id).sort(), ids);
  const sequence = readTrace(directory, 'sequencer').filter(r => r.event === 'default-sequencer-order');
  assert.equal(sequence.length, 1);
  for (const list of [sequence[0].input, sequence[0].output]) {
    assert.deepEqual(list.map(r => r.file).sort(), expectedFiles);
    for (const row of list) { assert.equal(row.priorResult, null); assert.equal(row.stats.size, PINS[arm].testFiles.find(f => f.path === row.file).bytes); }
  }
  return { ...result, workerRecords: workers.length, sortedQueue: sequence[0].output.map(r => r.file) };
}
export function sealArtifacts(directory) {
  const files = inventory(directory).filter(file => !['artifacts.json', 'SHA256SUMS'].includes(file.path));
  save(join(directory, 'artifacts.json'), { schema: 1, completeArchiveInventory: true, files });
  writeFileSync(join(directory, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.path}\n`).join('')
    + `${digest(join(directory, 'artifacts.json')).sha256}  artifacts.json\n`);
  return files;
}
function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const file = join(directory, name); if (existsSync(file)) return resolve(file);
  }
  throw new Error(`Missing executable ${name}`);
}
function preserveBuild(root, arm, target) {
  const wasm = PINS[arm].wasm.map(({ path }) => ({ path, ...digest(join(root, path)) }));
  const dist = inventory(join(root, 'dist'));
  copyFiles(root, wasm, join(target, 'wasm')); copyFiles(join(root, 'dist'), dist, join(target, 'dist'));
  save(join(target, 'build.json'), { wasm, dist });
  assert.deepEqual(wasm, PINS[arm].wasm, `${arm}: rebuilt WASM differs from original CI`);
  assert.deepEqual(dist, PINS[arm].dist, `${arm}: rebuilt dist differs from original CI`);
  return { wasm, dist };
}
export async function runDiagnostic(directory) {
  directory = resolve(directory);
  assert(!existsSync(directory), 'Evidence directory must be brand new; never overwrite or resume');
  mkdirSync(directory, { recursive: true }); mkdirSync(join(directory, 'logs'));
  const manifest = { schema: 1, purpose: 'block-correctness-diagnostic-v1', noPerformanceStage: true,
    complete: false, historicalGate: PINS.original, started: new Date().toISOString(), commands: [], arms: {} };
  const persist = () => save(join(directory, 'diagnostic.json'), manifest);
  persist();
  let seq = 0;
  const invoke = async (name, command, args, cwd, timeoutMs, env = process.env) => {
    const entry = { name, command, args, cwd, timeoutMs, planned: true };
    manifest.commands.push(entry); persist();
    Object.assign(entry, await runCommand({ name, command, args, cwd, timeoutMs, env,
      prefix: join(directory, 'logs', `${String(++seq).padStart(2, '0')}-${name}`) }));
    entry.stdoutIdentity = digest(entry.stdout); entry.stderrIdentity = digest(entry.stderr);
    entry.samplesIdentity = digest(entry.samples); persist();
    return entry;
  };
  const requireCommand = async (...args) => {
    const result = await invoke(...args); assert(result.complete, `Command failed: ${result.name}`); return result;
  };
  try {
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.version, PINS.runtimes.node.version);
    manifest.proof = proofIdentity();
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    manifest.invocation = verifyInvocation(process.env, event, manifest.proof.ref);
    save(join(directory, 'push-event.json'), event);
    copyFiles(PROOF, FILES.map(path => ({ path })), join(directory, 'harness'));
    const node = executable('node'), bun = executable('bun');
    manifest.runtimes = {};
    for (const [name, path] of Object.entries({ node, bun })) {
      const pin = PINS.runtimes[name], actual = { path, realpath: realpathSync(path), ...digest(path) };
      assert.equal(actual.sha256, pin.sha256, `Changed ${name} executable`); assert.equal(actual.bytes, pin.bytes);
      const command = await requireCommand(`${name}-version`, path, ['--version'], PROOF, 30000);
      actual.version = readFileSync(command.stdout, 'utf8').trim(); assert.equal(actual.version, pin.version);
      manifest.runtimes[name] = actual;
    }
    assert(!existsSync(join(PROOF, 'node_modules')), 'Fresh proof checkout must not have a dependency/cache install');
    const lock = join(PROOF, 'bun.lock'); assert(!existsSync(lock), 'Fresh proof checkout must not have a prior lock/install');
    assert.equal(digest(join(HERE, 'block-correctness.bun.lock')).sha256, PINS.lockSha256);
    copyFileSync(join(HERE, 'block-correctness.bun.lock'), lock);
    await requireCommand('locked-dependencies', bun, ['install', '--frozen-lockfile'], PROOF, 180000);
    assert.equal(digest(lock).sha256, PINS.lockSha256); copyFileSync(lock, join(directory, 'bun.lock'));
    manifest.compilers = {};
    for (const [name, pin] of Object.entries(PINS.compilers)) {
      const actual = dependencyIdentity(PROOF, name);
      assert.equal(actual.version, pin.version); assert.equal(actual.sha256, pin.sha256, `Changed compiler/runtime dependency: ${name}`);
      manifest.compilers[name] = actual;
    }
    for (const [path, hash] of Object.entries(PINS.apiFiles)) assert.equal(digest(join(PROOF, 'node_modules', path)).sha256, hash, `Changed observed Vitest API: ${path}`);
    save(join(directory, 'compiler-identities.json'), manifest.compilers);
    await requireCommand('diagnostic-fake-events-node', node, ['--test', join(HERE, 'block-correctness-protocol.node.mjs')], PROOF, 30000);
    await requireCommand('diagnostic-fake-events-bun', bun, ['test', join(HERE, 'block-correctness-protocol.node.mjs')], PROOF, 30000);
    // Every build and both empty caches are validated before either suite is admitted.
    for (const arm of ['baseline', 'candidate']) {
      const root = directory + '-' + arm, target = join(directory, arm), cache = join(target, 'cache');
      assert(!existsSync(root)); mkdirSync(target); mkdirSync(cache); mkdirSync(join(target, 'trace'));
      await requireCommand(`${arm}-worktree`, 'git', ['worktree', 'add', '--detach', root, PINS[arm].commit], PROOF, 30000);
      symlinkSync(join(PROOF, 'node_modules'), join(root, 'node_modules'));
      const source = exactTree(root, PINS[arm].commit, { runtime: true }); assert.equal(source.tree, PINS[arm].tree);
      copyFiles(root, source.files, join(target, 'source')); save(join(target, 'source.json'), source);
      manifest.arms[arm] = { root, target, cache, source, complete: false };
      for (const script of ['build:wasm', 'build:browser', 'build:types']) await requireCommand(`${arm}-${script.replace(':', '-')}`, bun, ['run', script], root, 180000);
      manifest.arms[arm].build = preserveBuild(root, arm, target);
      assert.deepEqual(exactTree(root, PINS[arm].commit, { runtime: true }), source);
      const before = cacheReceipt(cache); assert.deepEqual(before.files, []); save(join(target, 'cache-before.json'), before);
      manifest.arms[arm].cacheBefore = before;
      const config = join(target, 'diagnostic.config.mjs'); writeFileSync(config, configSource(root, cache), { flag: 'wx' });
      manifest.arms[arm].config = { path: config, ...digest(config) }; persist();
    }
    assert.notEqual(manifest.arms.baseline.cacheBefore.realpath, manifest.arms.candidate.cacheBefore.realpath);
    assert.equal(manifest.arms.baseline.cacheBefore.inventorySha256, manifest.arms.candidate.cacheBefore.inventorySha256);
    // One fixed full suite per arm. A failed/timeout baseline still permits candidate only after verified owned cleanup.
    for (const arm of ['baseline', 'candidate']) {
      const entry = manifest.arms[arm], { root, target, cache, config } = entry;
      assert.deepEqual(cacheReceipt(cache), entry.cacheBefore, `${arm}: cache changed before admission`);
      entry.env = { BLOCK_DIAGNOSTIC_ARM: arm, BLOCK_DIAGNOSTIC_CACHE: cache, BLOCK_DIAGNOSTIC_TRACE: join(target, 'trace'), BLOCK_DIAGNOSTIC_PINS: join(HERE, 'block-correctness-pins.json') };
      entry.test = await invoke(`${arm}-full-suite`, bun, ['--bun', 'node_modules/vitest/vitest.mjs', 'run', '--config', config.path],
        root, TEST_TIMEOUT_MS, { ...process.env, ...entry.env });
      entry.cacheAfter = cacheReceipt(cache); save(join(target, 'cache-after.json'), entry.cacheAfter);
      assert.deepEqual(exactTree(root, PINS[arm].commit, { runtime: true }), entry.source);
      assert.deepEqual(preserveBuild(root, arm, target), entry.build);
      try { entry.trace = validateObservation(join(target, 'trace'), arm, root); entry.complete = entry.test.complete; }
      catch (error) { entry.traceFailure = String(error.stack ?? error); entry.complete = false; }
      persist();
      assert.equal(entry.test.cleanup?.status, 'verified-no-live-processes', 'Unverified cleanup stops further work');
      assert.equal(entry.test.interrupted, null, 'Interruption stops further work');
    }
    for (const [name, before] of Object.entries(manifest.compilers)) assert.deepEqual(dependencyIdentity(PROOF, name), before, `Changed compiler package during run: ${name}`);
    for (const [path, hash] of Object.entries(PINS.apiFiles)) assert.equal(digest(join(PROOF, 'node_modules', path)).sha256, hash, `Changed observed Vitest API after run: ${path}`);
    assert.equal(digest(join(PROOF, 'bun.lock')).sha256, PINS.lockSha256);
    assert.deepEqual(proofIdentity(), manifest.proof);
    manifest.complete = Object.values(manifest.arms).every(arm => arm.complete);
    manifest.conclusion = manifest.complete ? 'correctness-only-observed-pass; separate timing recovery still requires review' : 'failed-or-incomplete; original gate remains failed';
  } catch (error) { manifest.failure = String(error.stack ?? error); }
  finally {
    for (const [arm, entry] of Object.entries(manifest.arms)) {
      try {
        const wasm = PINS[arm].wasm.filter(({ path }) => existsSync(join(entry.root, path))).map(({ path }) => ({ path, ...digest(join(entry.root, path)) }));
        const dist = inventory(join(entry.root, 'dist'));
        copyFiles(entry.root, wasm, join(entry.target, 'partial-build/wasm'));
        copyFiles(join(entry.root, 'dist'), dist, join(entry.target, 'partial-build/dist'));
        save(join(entry.target, 'partial-build.json'), { wasm, dist });
      } catch (error) { entry.retentionFailure = String(error.stack ?? error); manifest.complete = false; }
    }
    manifest.conclusion = manifest.complete ? 'correctness-only-observed-pass; separate timing recovery still requires review' : 'failed-or-incomplete; original gate remains failed';
    manifest.finished = new Date().toISOString(); persist(); sealArtifacts(directory);
  }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'run') process.exitCode = (await runDiagnostic(directory)).complete ? 0 : 1;
  else if (mode === 'seal-partial') { assert(directory && existsSync(directory)); sealArtifacts(resolve(directory)); }
  else throw new Error('Only run or seal-partial is supported');
}
