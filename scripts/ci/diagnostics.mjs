import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kernelCompiler } from '../../proofs/kernel-provenance.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export const suites = ['compatibility', 'json', 'utf8', 'numeric', 'geometry', 'spatial', 'memory'];
const numericBaseline = '75e3626ccc6400d1ae195aefdd3526906622009e';

export function configuration(env = process.env) {
  const suite = env.DIAGNOSTIC_SUITE || 'compatibility';
  const architecture = env.DIAGNOSTIC_ARCHITECTURE || 'x64';
  const nodeVersion = env.DIAGNOSTIC_NODE_VERSION || '22';
  const browserInput = env.DIAGNOSTIC_BROWSERS || 'false';
  const baselineRef = env.DIAGNOSTIC_BASELINE_REF?.trim() || 'main';
  assert(suites.includes(suite), 'Choose one supported diagnostic suite');
  assert(['x64', 'arm64'].includes(architecture), 'Choose x64 or arm64');
  assert(['22', '24'].includes(nodeVersion), 'Choose Node 22 or 24');
  assert(['true', 'false'].includes(browserInput), 'Browser selection must be true or false');
  const browsers = browserInput === 'true';
  assert(!browsers || architecture === 'x64', 'Browser diagnostics require the x64 runner');
  assert(!browsers || suite !== 'memory', 'The memory suite measures Node workers; disable browsers');
  // A Git ref is data, never shell text, a revision expression, or an option.
  assert(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baselineRef) && !baselineRef.includes('..'),
    'Baseline must be a branch, tag, or commit ID');
  return { suite, architecture, nodeVersion, browsers, baselineRef };
}

export function plan(config, { root = repository, output, baseline } = {}) {
  const results = resolve(output || join(tmpdir(), 'zerocopy-diagnostic-plan'));
  const before = baseline || join(tmpdir(), 'zerocopy-diagnostic-baseline');
  const steps = [], fixedOutputs = [];
  const add = (name, command, args, env = {}) => steps.push({ name, command, args, env });
  const node = (name, args, env) => add(name, 'node', args, env);
  const bun = (name, args, env) => add(name, 'bun', args, env);
  const types = (...names) => names.forEach(name => bun(name, ['run', name]));
  const outputFile = name => join(results, 'measurements', name);
  const installBrowsers = engines => bun('Install selected browser engines', ['x', 'playwright', 'install', '--with-deps', ...engines]);
  const regressionEnv = { CI_REGRESSION_ARTIFACTS: join(results, 'regressions') };
  const baselineRef = ['json', 'utf8'].includes(config.suite) ? config.baselineRef
    : config.suite === 'numeric' && config.browsers ? numericBaseline : null;

  if (config.suite === 'compatibility') {
    node('Rust WASM build rejection guards', ['--test', 'scripts/rust-wasm.node.mjs']);
    node('Aligned and unaligned Rust geometry reads', ['proofs/rust-migration-20261115/geometry-abi.mjs']);
    node('Rust kernels with real workers', ['proofs/rust-migration-20261115/workers.mjs']);
    types('typecheck', 'typecheck:redux', 'typecheck:values', 'typecheck:geometry');
    for (const file of ['tsconfig.worker.json', 'tsconfig.numeric.json', 'tsconfig.text-search.json']) {
      bun(`Check ${file}`, ['x', 'tsc', '--noEmit', '-p', file]);
    }
    bun('Full Bun unit and integration suite', ['run', 'test']);
    node('Node allocation, codec, worker, and import-order regressions', ['scripts/ci/check-regressions.mjs', 'native'], regressionEnv);
    node('Real Node task lifecycle', ['--test', '--test-concurrency=1', '--test-timeout=15000',
      'proofs/worker-tasks.mjs', 'proofs/worker-task-lifecycle.node.mjs']);
    for (const file of ['node-worker.mjs', 'worker-sessions.mjs', 'redux-node.mjs', 'typed-json-worker.mjs']) {
      node(file, [`proofs/${file}`]);
    }
    bun('Installed package entrypoints', ['run', 'check:package']);
    if (config.browsers) {
      installBrowsers(['chromium']);
      bun('Full Chromium integration suite', ['run', 'test:browser']);
      node('Chromium checkpoint, heap, and list workers', ['scripts/ci/check-regressions.mjs', 'browser'], regressionEnv);
    }
  } else if (config.suite === 'json') {
    bun('Deep freezing and cached-read regressions', ['run', 'test', '--', 'freeze-json.test.ts', 'json-read-cache.test.ts']);
    node('Portable JSON correctness in Node', ['proofs/json-read-correctness.mjs']);
    bun('Portable JSON correctness in Bun', ['test', './proofs/json-read-correctness.mjs']);
    node('All Node and Bun JSON-read rounds', ['proofs/run-json-read.mjs', join(before, 'dist/shared.js'),
      'dist/shared.js', outputFile('native')], { JSON_READ_WARMUPS: '10', JSON_READ_SAMPLES: '12', JSON_READ_ROUNDS: '3' });
    if (config.browsers) {
      installBrowsers(['chromium', 'firefox', 'webkit']);
      node('All three browser JSON-read rounds', ['proofs/json-read-browser.mjs', join(before, 'dist/shared.js'),
        'dist/shared.js', outputFile('browsers.json')], { JSON_READ_WARMUPS: '5', JSON_READ_SAMPLES: '7', JSON_READ_ROUNDS: '3' });
    }
  } else if (config.suite === 'utf8') {
    bun('Native encoding and snapshot regressions', ['run', 'test', '--', 'utf8-write.test.ts']);
    node('All Node and Bun UTF-8 rounds', ['proofs/run-utf8-write.mjs', join(before, 'dist/shared.js'),
      'dist/shared.js', outputFile('native')]);
    if (config.browsers) {
      installBrowsers(['chromium', 'firefox', 'webkit']);
      node('All three browser UTF-8 engines', ['proofs/utf8-write-browser.mjs', join(before, 'dist/shared.js'),
        'dist/shared.js', outputFile('browsers.json')]);
    }
  } else if (config.suite === 'memory') {
    node('Memory accounting, worker parity, and retained snapshots', ['--test', 'proofs/investigation-memory-checks.mjs']);
    node('All original memory trials and worker architectures', ['proofs/investigation-memory.mjs'], { MEMORY_OUT: outputFile('memory') });
  } else {
    types('typecheck');
    if (config.suite === 'geometry') types('typecheck:geometry', 'typecheck:redux', 'typecheck:values');
    else {
      if (config.suite === 'numeric') types('typecheck:redux', 'typecheck:values');
      bun('Numeric public type declarations', ['x', 'tsc', '--noEmit', '-p', 'tsconfig.numeric.json']);
    }
    bun('Full source suite for the selected architecture', ['run', 'test']);
    if (config.suite !== 'geometry') {
      if (config.suite === 'spatial') node('Spatial worker correctness', ['proofs/spatial-worker.mjs']);
      node('Numeric worker correctness', ['proofs/numeric-worker.mjs']);
    }
    const driver = { numeric: 'numeric-benchmark', geometry: 'geometry-bbox', spatial: 'spatial-bulk-benchmark' }[config.suite];
    const prefix = { numeric: 'numeric', geometry: 'geometry-bbox-bulk', spatial: 'spatial-bulk' }[config.suite];
    for (const runtime of ['node', 'bun']) {
      add(`${runtime}: exact outputs and original 5% performance gate`, runtime, [`proofs/${driver}.mjs`], { PERF_GATE: '1' });
      fixedOutputs.push(`proofs/results/${prefix}-${runtime}-${config.architecture}.json`);
    }
    if (config.suite === 'spatial') {
      node('Retain the numeric regression gate', ['proofs/numeric-benchmark.mjs'], { PERF_GATE: '1' });
      fixedOutputs.push(`proofs/results/numeric-node-${config.architecture}.json`);
    }
    if (config.browsers) {
      installBrowsers(['chromium', 'firefox', 'webkit']);
      const browserDriver = { numeric: 'numeric-browser', geometry: 'geometry-browsers', spatial: 'spatial-browser' }[config.suite];
      node('All three browser correctness checks', [`proofs/${browserDriver}.mjs`]);
      fixedOutputs.push(`proofs/results/${config.suite}-browsers.json`);
    }
  }
  return { root, results, baselineRef, baselineDirectory: config.suite === 'numeric' ? join(root, '.numeric-baseline') : before, steps, fixedOutputs };
}

export function guardOutputs(root, paths) {
  for (const path of paths) {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd: root, stdio: 'ignore' }).status === 0;
    assert(!tracked && !existsSync(join(root, path)), `Refusing to overwrite existing evidence: ${path}`);
  }
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function resolveBaseline(root, ref) {
  for (const candidate of [`refs/remotes/origin/${ref}`, ref]) {
    const result = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`], { cwd: root, encoding: 'utf8' });
    if (result.status === 0 && /^[a-f0-9]{40}$/.test(result.stdout.trim())) return result.stdout.trim();
  }
  throw new Error(`Cannot resolve baseline ${ref}; use a fetched branch, tag, or full commit ID`);
}

export function execute(selected, config) {
  assert.equal(process.arch, config.architecture, 'Run on the selected architecture');
  assert.equal(process.versions.node.split('.')[0], config.nodeVersion, 'Run on the selected Node major');
  assert(!existsSync(selected.results), 'Use a new diagnostic output directory for each run');
  guardOutputs(selected.root, selected.fixedOutputs);
  mkdirSync(join(selected.results, 'measurements'), { recursive: true });
  mkdirSync(join(selected.results, 'logs'));
  const report = { ...config, startedAt: new Date().toISOString(), status: 'running', cpu: cpus()[0]?.model,
    node: process.version, bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
    candidateCommit: git(selected.root, 'rev-parse', 'HEAD'), candidateCompiler: kernelCompiler(selected.root), steps: [],
    comparison: 'Each revision builds with its own package manifest and dependencies. Ratios can include compiler/dependency differences; they do not isolate source-code changes.' };
  copyFileSync(join(selected.root, 'package.json'), join(selected.results, 'candidate-package.json'));
  const save = () => writeFileSync(join(selected.results, 'run.json'), JSON.stringify(report, null, 2) + '\n');
  const run = (step, cwd = selected.root) => {
    const index = report.steps.length + 1;
    console.log(`\n[${index}] ${step.name}\n${JSON.stringify([step.command, ...step.args])}`);
    const started = performance.now();
    // Fixed command arrays, one child at a time. No input is interpreted by a shell.
    const result = spawnSync(step.command, step.args, { cwd, env: { ...process.env, ...step.env },
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, killSignal: 'SIGKILL' });
    const log = `${String(index).padStart(2, '0')}.log`;
    writeFileSync(join(selected.results, 'logs', log), (result.stdout || '') + '\n' + (result.stderr || ''));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    report.steps.push({ ...step, cwd, log, elapsedMs: Math.round(performance.now() - started),
      status: result.status, signal: result.signal, error: result.error?.message });
    save();
    if (result.error || result.status !== 0) throw new Error(`${step.name} failed: ${result.error?.message || result.signal || result.status}`);
  };
  let ownsBaseline = false;
  save();
  try {
    if (selected.baselineRef) {
      assert(!existsSync(selected.baselineDirectory), 'Baseline directory already exists; refusing to overwrite it');
      report.baselineCommit = resolveBaseline(selected.root, selected.baselineRef);
      report.baselineRef = selected.baselineRef;
      run({ name: 'Check out the exact baseline', command: 'git', args: ['worktree', 'add', '--detach', selected.baselineDirectory, report.baselineCommit] });
      ownsBaseline = true;
      copyFileSync(join(selected.baselineDirectory, 'package.json'), join(selected.results, 'baseline-package.json'));
      // Historical AS sources must keep their recorded compiler dependencies,
      // even if a later candidate changes build tooling or removes that compiler.
      run({ name: 'Baseline: bun install', command: 'bun', args: ['install'] }, selected.baselineDirectory);
      report.baselineCompiler = kernelCompiler(selected.baselineDirectory);
      for (const args of [['run', 'build:wasm'], ['run', 'build:browser']]) {
        run({ name: `Baseline: bun ${args.join(' ')}`, command: 'bun', args }, selected.baselineDirectory);
      }
    }
    for (const step of selected.steps) run(step);
    report.status = 'success';
  } catch (error) {
    report.status = 'failure';
    report.error = error.stack || String(error);
    throw error;
  } finally {
    // Kernel drivers have fixed output names. They were checked absent and
    // untracked before running; copy only these fresh files, including failures.
    for (const path of selected.fixedOutputs) if (existsSync(join(selected.root, path))) {
      copyFileSync(join(selected.root, path), join(selected.results, 'measurements', path.split('/').at(-1)));
    }
    if (config.suite === 'geometry' && existsSync(join(selected.root, 'geometry-kernels.wat'))) {
      copyFileSync(join(selected.root, 'geometry-kernels.wat'), join(selected.results, 'geometry-kernels.wat'));
    }
    if (ownsBaseline) {
      const cleanup = spawnSync('git', ['worktree', 'remove', '--force', selected.baselineDirectory], { cwd: selected.root, encoding: 'utf8' });
      if (cleanup.status !== 0) report.cleanupError = cleanup.stderr || cleanup.error?.message;
    }
    report.finishedAt = new Date().toISOString();
    save();
  }
}

function main() {
  const config = configuration();
  assert(process.argv.length <= 3 && [undefined, '--validate', '--plan'].includes(process.argv[2]),
    'Usage: node scripts/ci/diagnostics.mjs [--validate|--plan]');
  if (process.argv[2] === '--validate') { console.log(JSON.stringify(config, null, 2)); return; }
  if (process.argv[2] === '--plan') { console.log(JSON.stringify(plan(config), null, 2)); return; }
  const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-diagnostics-'));
  try {
    const output = resolve(process.env.DIAGNOSTIC_OUTPUT || join(temporary, 'artifacts'));
    execute(plan(config, { output, baseline: join(temporary, 'baseline') }), config);
    console.log(`Diagnostics saved to ${output}`);
  } finally {
    // Keep local default artifacts available. Hosted runs use DIAGNOSTIC_OUTPUT.
    if (process.env.DIAGNOSTIC_OUTPUT) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
