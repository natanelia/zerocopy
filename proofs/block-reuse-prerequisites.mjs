/** Deterministic prerequisite gate. Roots must contain installed dependencies.
 * Never checks out revisions, installs dependencies, or collects latency.
 * Retains source, commands, stdout/stderr, artifacts and compiler/resolution
 * identities in evidenceRoot, including when a subprocess fails.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runCommand, COMMAND_LIMITS } from './block-reuse-command.mjs';
import { CONFIG, CORE_SOURCE_SHA256, CORE_WASM_SHA256 } from './block-reuse-protocol.mjs';

const helper = fileURLToPath(import.meta.url);
const worker = fileURLToPath(new URL('./block-reuse-worker.mjs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const inside = (path, parent) => path === parent || path.startsWith(parent + sep);
const artifact = file => ({ bytes: statSync(file).size, sha256: sha256(readFileSync(file)) });
const inventoryHash = files => sha256(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));

// Preserve the audited command/evidence mechanics. Block allocation changes
// intentionally alter new addresses and allocation frontiers; source and WASM
// pins plus logical fixtures replace heap-specific binary-equivalence checks.
export const deterministicHelperProvenance = {
  relationship: 'Adapted from the audited heap insertion gate; linked/doubly snapshots and cross-version workers replace heap fixtures',
  originalCommit: 'b52aefded8b724e21cd7ddd2713836689ddee299',
  originalTree: '1e742055d4da30a7bf29cc7653f78018db96c0e0',
  originalFiles: {
    'heap-insert-command.mjs': 'e8156bf7eaa58fd417b8ff717322cfad3e70df4fdf81e01a068b8803ba90f473',
    'heap-insert-prerequisites.mjs': 'a3a9b30e27befaa8b30af39dbbf9647c95345efa814010e9df68c29b64f8c5c0',
    'heap-insert-worker.mjs': '23e43afd1a3fc87d8cc14bacfd746dcba85f3636931d04173d10af8b67a2a13c',
  },
};
const compilerVersions = Object.freeze({ assemblyscript: '0.28.20', binaryen: '131.0.0-nightly.20260721',
  typescript: '5.9.3', 'bun-types': '1.4.2', vitest: '4.1.11' });
const coreWasmPaths = Object.freeze(['persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm',
  'singly-linked-list.wasm', 'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm']);
function checkCoreSource(arm, name) {
  arm.coreSource = artifact(join(arm.root, 'persistent-core.as.ts'));
  assert.equal(arm.coreSource.sha256, CORE_SOURCE_SHA256[name], `${name}: pinned core source changed`);
}
function checkCoreWasm(arm, name) {
  for (const path of coreWasmPaths) {
    const file = arm.wasm.files.find(file => file.path === path);
    assert(file, `${name}: missing core WASM ${path}`);
    assert.equal(file.sha256, CORE_WASM_SHA256[name], `${name}: pinned core WASM differs: ${path}`);
  }
  arm.coreWasm = arm.wasm.files.find(file => file.path === 'persistent-core.wasm');
}

function filesUnder(root, exclude = () => false) {
  const result = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name), path = relative(root, absolute).split(sep).join('/');
      if (exclude(absolute, path)) continue;
      const info = lstatSync(absolute);
      if (info.isDirectory()) visit(absolute);
      else if (info.isFile()) result.push({ path, ...artifact(absolute) });
      else if (info.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${absolute}`);
    }
  }
  visit(root); return result;
}
function copyInventory(root, files, destination) {
  for (const { path } of files) {
    const target = join(destination, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, path), target);
  }
}
function executable(command) {
  // Preserve the invocation name: npm's Bun shim may resolve to bun.exe, whose
  // directory does not contain the plain `bun` command used by package scripts.
  if (isAbsolute(command) || command.includes(sep)) return resolve(command);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, command);
    if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
  }
  throw new Error(`Executable not found: ${command}`);
}
function sourceInventory(root, evidenceRoot, otherRoot) {
  return filesUnder(root, (absolute, path) => (inside(evidenceRoot, root) && inside(absolute, evidenceRoot))
    || (inside(otherRoot, root) && inside(absolute, otherRoot))
    || path.split('/').some(part => ['node_modules', '.git', 'dist', 'build', '.proof-tools', '.proof-baseline'].includes(part))
    || /\.(?:wasm|wat|log|tgz)$/.test(path));
}
function dependencyIdentity(root, name) {
  const require = createRequire(join(root, 'package.json'));
  const direct = join(root, 'node_modules', name, 'package.json');
  const packageFile = existsSync(direct) ? direct : require.resolve(name + '/package.json');
  const directory = realpathSync(dirname(packageFile));
  const files = filesUnder(directory, (_absolute, path) => path.split('/').includes('node_modules'));
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  return { name, version: pkg.version, resolvedDirectory: directory, sha256: inventoryHash(files), files };
}
function captureResolution(root, destination) {
  const locks = [];
  for (const path of ['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'node_modules/.package-lock.json']) {
    if (!existsSync(join(root, path))) continue;
    locks.push({ path, ...artifact(join(root, path)) });
    const target = join(destination, 'lockfiles', path);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, path), target);
  }
  const packages = [], visited = new Set();
  function scan(directory, logical) {
    if (!existsSync(directory)) return;
    const resolved = realpathSync(directory);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) { scan(join(directory, name), logical + '/' + name); continue; }
      const packageRoot = join(directory, name), packageFile = join(packageRoot, 'package.json');
      if (!existsSync(packageFile)) continue;
      const pkg = JSON.parse(readFileSync(packageFile, 'utf8')), path = logical + '/' + name + '/package.json';
      packages.push({ path, name: pkg.name, version: pkg.version, resolvedRoot: realpathSync(packageRoot), ...artifact(packageFile) });
      const target = join(destination, 'installed-package-manifests', path);
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(packageFile, target);
      scan(join(packageRoot, 'node_modules'), logical + '/' + name + '/node_modules');
    }
  }
  scan(join(root, 'node_modules'), 'node_modules');
  const result = { locks, packages, packageManifestSha256: inventoryHash(packages),
    lockStatus: locks.length ? 'Exact available lockfiles preserved' : 'No lockfile present; installed package manifests and compiler contents identify this resolution' };
  json(join(destination, 'dependency-resolution.json'), result); return result;
}
function gitIdentity(root) {
  const get = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const top = get(['rev-parse', '--show-toplevel']);
  if (!top || realpathSync(top) !== realpathSync(root)) return null;
  return { head: get(['rev-parse', 'HEAD']), tree: get(['rev-parse', 'HEAD^{tree}']),
    status: get(['status', '--porcelain=v1']), diff: get(['diff', '--binary', 'HEAD']) };
}

/** Return {baseline, candidate, runtimes, evidenceRoot, manifestPath} only on
 * complete success. Each arm contains root, evidenceDirectory, source,
 * compilers, resolution, wasm, dist, entry, commands and complete. wasm/dist
 * contain {files:[{path,bytes,sha256}],sha256}; entry.path is root/dist/shared.js.
 * The manifest and complete subprocess logs persist incrementally on failure.
 */
export async function prerequisites({ baselineRoot, candidateRoot, evidenceRoot, node = 'node', bun = 'bun' }) {
  assert(baselineRoot && candidateRoot && evidenceRoot, 'Both package roots and evidenceRoot are required');
  const roots = { baseline: realpathSync(resolve(baselineRoot)), candidate: realpathSync(resolve(candidateRoot)) };
  assert.notEqual(roots.baseline, roots.candidate, 'Arms must have separate package roots');
  evidenceRoot = resolve(evidenceRoot);
  for (const name of ['baseline', 'candidate']) for (const root of Object.values(roots)) {
    const destination = join(evidenceRoot, name);
    assert(root !== evidenceRoot && !inside(root, destination), 'Source roots must not be equal to evidenceRoot or inside per-arm artifact destinations');
  }
  mkdirSync(evidenceRoot, { recursive: true });
  const manifestPath = join(evidenceRoot, 'prerequisites.json');
  assert(!existsSync(manifestPath), 'Use a fresh evidenceRoot; previous prerequisite evidence must not be overwritten');
  const report = { schema: 'zerocopy-block-reuse-prerequisites/v1', complete: false, started: new Date().toISOString(),
    evidenceRoot, manifestPath, provenance: deterministicHelperProvenance, commands: [], arms: {} };
  const persist = () => json(manifestPath, report);
  persist(); let sequence = 0;
  const run = async (name, command, args, cwd, directory, env = process.env) => {
    mkdirSync(directory, { recursive: true });
    const prefix = join(directory, `${String(++sequence).padStart(3, '0')}-${name}`);
    const timeoutMs = /-(?:version|architecture)$/.test(name) ? COMMAND_LIMITS.metadataMs
      : name.endsWith('-test') ? COMMAND_LIMITS.testMs : name.includes('-build-') ? COMMAND_LIMITS.buildMs
      : name.includes('-check-package') ? COMMAND_LIMITS.packageMs : name.startsWith('built-block-workers-') ? COMMAND_LIMITS.workersMs
      : COMMAND_LIMITS.typecheckMs;
    const entry = { name, command, args, cwd, prefix, timeoutMs, started: new Date().toISOString(), complete: false };
    report.commands.push(entry); persist();
    try {
      Object.assign(entry, await runCommand({ name, command, args, cwd, env, prefix, timeoutMs }));
      entry.stdoutIdentity = artifact(entry.stdout); entry.stderrIdentity = artifact(entry.stderr);
      if (!entry.complete) throw new Error(`Prerequisite ${name} failed (status=${entry.status}, signal=${entry.signal}, timedOut=${entry.timedOut}); see ${entry.stdout} and ${entry.stderr}`);
    } catch (error) { entry.error = String(error.stack ?? error); throw error; }
    finally { persist(); }
    return entry;
  };
  const collectOutputs = arm => {
    const directory = arm.evidenceDirectory, root = arm.root, other = roots[root === roots.baseline ? 'candidate' : 'baseline'];
    const wasmFiles = filesUnder(root, (absolute, path) => (inside(evidenceRoot, root) && inside(absolute, evidenceRoot))
      || (inside(other, root) && inside(absolute, other))
      || path.split('/').some(part => ['node_modules', '.git', 'dist', 'build', '.proof-tools', '.proof-baseline'].includes(part)))
      .filter(file => file.path.endsWith('.wasm'));
    arm.wasm = { files: wasmFiles, sha256: inventoryHash(wasmFiles) };
    rmSync(join(directory, 'wasm'), { recursive: true, force: true }); copyInventory(root, wasmFiles, join(directory, 'wasm'));
    if (existsSync(join(root, 'dist'))) {
      const files = filesUnder(join(root, 'dist')); arm.dist = { files, sha256: inventoryHash(files) };
      rmSync(join(directory, 'dist'), { recursive: true, force: true }); copyInventory(join(root, 'dist'), files, join(directory, 'dist'));
      if (existsSync(join(root, 'dist/shared.js'))) arm.entry = { path: join(root, 'dist/shared.js'), ...artifact(join(root, 'dist/shared.js')) };
    }
    persist();
  };
  try {
    for (const [name, root] of Object.entries(roots)) {
      const directory = join(evidenceRoot, name); mkdirSync(directory, { recursive: true });
      const arm = report.arms[name] = { root, evidenceDirectory: directory, complete: false, git: gitIdentity(root), commands: [] };
      const files = sourceInventory(root, evidenceRoot, roots[name === 'baseline' ? 'candidate' : 'baseline']);
      arm.source = { files, sha256: inventoryHash(files) }; copyInventory(root, files, join(directory, 'source'));
      checkCoreSource(arm, name);
      json(join(directory, 'source-inventory.json'), arm.source); persist();
    }
    for (const [name, root] of Object.entries(roots)) {
      const arm = report.arms[name], directory = arm.evidenceDirectory;
      arm.resolution = captureResolution(root, directory);
      arm.compilers = {};
      for (const [dependency, version] of Object.entries(compilerVersions)) {
        arm.compilers[dependency] = dependencyIdentity(root, dependency);
        assert.equal(arm.compilers[dependency].version, version, `${name}: unexpected ${dependency} version`);
      }
      json(join(directory, 'compiler-identities.json'), arm.compilers); persist();
    }
    const nodePath = executable(node), bunPath = executable(bun);
    const env = { ...process.env, PATH: [dirname(nodePath), dirname(bunPath), process.env.PATH ?? ''].join(delimiter),
      npm_config_cache: join(evidenceRoot, 'npm-cache') };
    mkdirSync(env.npm_config_cache, { recursive: true });
    report.runtimes = { node: { path: nodePath, realpath: realpathSync(nodePath), ...artifact(nodePath) },
      bun: { path: bunPath, realpath: realpathSync(bunPath), ...artifact(bunPath) } };
    for (const [name, path] of [['node', nodePath], ['bun', bunPath]]) {
      const command = await run(name + '-version', path, ['--version'], roots.candidate, join(evidenceRoot, 'logs'), env);
      report.runtimes[name].version = readFileSync(command.stdout, 'utf8').trim();
      const architecture = await run(name + '-architecture', path, ['--eval', 'console.log(process.arch)'],
        roots.candidate, join(evidenceRoot, 'logs'), env);
      report.runtimes[name].arch = readFileSync(architecture.stdout, 'utf8').trim();
      assert.equal(report.runtimes[name].arch, CONFIG.architecture, `${name}: this gate requires ${CONFIG.architecture}`);
    }
    assert.equal(report.runtimes.node.version, 'v' + CONFIG.runtimes.node, 'Unexpected Node version');
    assert.equal(report.runtimes.bun.version, CONFIG.runtimes.bun, 'Unexpected Bun version');
    report.harness = {};
    for (const file of [helper, worker, ...['block-reuse-command.mjs', 'block-reuse-protocol.mjs',
      'block-reuse-workloads.mjs', 'block-reuse-workloads.node.mjs'].map(name => fileURLToPath(new URL('./' + name, import.meta.url)))]) {
      const name = file.split(sep).at(-1); report.harness[name] = artifact(file);
      mkdirSync(join(evidenceRoot, 'harness'), { recursive: true }); copyFileSync(file, join(evidenceRoot, 'harness', name));
    }
    for (const [name, root] of Object.entries(roots)) {
      const arm = report.arms[name], directory = arm.evidenceDirectory, files = arm.source.files;
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      for (const script of ['build:wasm', 'build:browser', 'build:types', 'test', 'typecheck', 'typecheck:values', 'typecheck:redux', 'typecheck:geometry']) {
        assert.equal(typeof pkg.scripts[script], 'string', `${name}: missing required script ${script}`);
      }
      try {
        for (const script of ['build:wasm', 'build:browser', 'build:types']) {
          arm.commands.push(await run(name + '-' + script.replaceAll(':', '-'), bunPath, ['run', script], root, join(directory, 'logs'), env));
          collectOutputs(arm);
        }
        assert(arm.wasm.files.length > 0, 'Build emitted no wasm'); checkCoreWasm(arm, name);
        assert(arm.entry, 'Build did not emit dist/shared.js');
        assert(arm.dist.files.some(file => file.path === 'types/shared.d.ts'), 'Build did not emit public declarations');
        // No case filter or smoke-only success path: the package standard test
        // script runs the complete Vitest suite under Bun.
        for (const script of ['test', 'typecheck', 'typecheck:values', 'typecheck:redux', 'typecheck:geometry']) {
          arm.commands.push(await run(name + '-' + script.replaceAll(':', '-'), bunPath, ['run', script], root, join(directory, 'logs'), env));
        }
        arm.commands.push(await run(name + '-typecheck-worker', nodePath,
          ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json'], root, join(directory, 'logs'), env));
        arm.commands.push(await run(name + '-check-package', nodePath, ['scripts/check-package.mjs'], root, join(directory, 'logs'), env));
        const after = sourceInventory(root, evidenceRoot, roots[name === 'baseline' ? 'candidate' : 'baseline']);
        assert.deepEqual(after, files, `${name}: source changed during prerequisites`); arm.prepared = true;
      } finally { collectOutputs(arm); }
      json(join(directory, 'manifest.json'), arm); persist();
    }
    for (const dependency of Object.keys(report.arms.baseline.compilers)) {
      assert.equal(report.arms.baseline.compilers[dependency].sha256, report.arms.candidate.compilers[dependency].sha256,
        `Compiler/declaration/test dependency differs between arms: ${dependency}`);
    }
    assert.deepEqual(report.arms.baseline.wasm.files.map(file => file.path), report.arms.candidate.wasm.files.map(file => file.path), 'WASM file inventory differs');
    // This candidate intentionally changes the shared core; unrelated kernels must match.
    const kernels = arm => arm.wasm.files.filter(file => /^(?:numeric-kernels(?:-simd)?|geometry-kernels)\.wasm$/.test(file.path));
    assert.deepEqual(kernels(report.arms.baseline), kernels(report.arms.candidate), 'Unrelated kernel bytes differ');
    assert.notEqual(report.arms.baseline.wasm.sha256, report.arms.candidate.wasm.sha256, 'Expected changed fresh-block allocation WASM');
    const declarations = arm => arm.dist.files.filter(file => file.path.startsWith('types/'));
    assert.deepEqual(declarations(report.arms.baseline), declarations(report.arms.candidate), 'Public declarations differ');
    for (const [runtime, command] of [['node', nodePath], ['bun', bunPath]]) {
      await run('block-reuse-clock-free-fixtures-' + runtime, command,
        [join(roots.candidate, 'proofs/block-reuse-workloads.node.mjs'), join(roots.baseline, 'dist/shared.js'), join(roots.candidate, 'dist/shared.js')],
        roots.candidate, join(evidenceRoot, 'logs'), env);
      await run('built-block-workers-' + runtime, command,
        [worker, roots.baseline, roots.candidate, join(evidenceRoot, 'built-checks')], roots.candidate, join(evidenceRoot, 'logs'), env);
    }
    for (const [name, arm] of Object.entries(report.arms)) {
      const before = arm.dist.sha256, wasmBefore = arm.wasm.sha256;
      collectOutputs(arm); assert.equal(arm.dist.sha256, before, 'Built artifact changed during deterministic checks');
      assert.equal(arm.wasm.sha256, wasmBefore, 'Wasm changed during deterministic checks');
      checkCoreSource(arm, name); checkCoreWasm(arm, name);
      for (const dependency of Object.keys(compilerVersions)) assert.deepEqual(dependencyIdentity(arm.root, dependency),
        arm.compilers[dependency], `${name}: ${dependency} content or resolution changed during prerequisites`);
      arm.resolutionAfter = captureResolution(arm.root, join(arm.evidenceDirectory, 'resolution-after'));
      assert.deepEqual(arm.resolutionAfter, arm.resolution, `${name}: dependency resolution changed during prerequisites`);
      const other = roots[arm.root === roots.baseline ? 'candidate' : 'baseline'];
      assert.deepEqual(sourceInventory(arm.root, evidenceRoot, other), arm.source.files, 'Source changed during built checks');
      arm.complete = true; json(join(arm.evidenceDirectory, 'manifest.json'), arm);
    }
    report.complete = true; report.finished = new Date().toISOString(); persist();
    return { baseline: report.arms.baseline, candidate: report.arms.candidate, runtimes: report.runtimes, evidenceRoot, manifestPath };
  } catch (error) {
    report.failure = { message: String(error.stack ?? error), date: new Date().toISOString() }; persist(); throw error;
  }
}
