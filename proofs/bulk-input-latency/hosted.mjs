/** Hosted transport. Workload/math unchanged; explicit cardinality-only analysis adaptation. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pins = {
  repository: 'natanelia/zerocopy', run: 37990109064, artifact: 11644597826,
  head: '18819a29da0436d2e7449072428a8eb601261a2e', tree: '6a7772ae89607f88a874a3d4449d2630f955cc6d',
  zipBytes: 2063613, zipSha256: '8aa0a338543bea260ce2b5d96286b4b215c56fb19a62f7a9a7f3d8bed74d1416',
  baseline: '52d5fb012eb1f568e11807b7cb2a66c4566589e2', baselineTree: '0bc8d2425fe82e0b70bbb8558deb175536f90e9d',
  artifactRuntime: 'dc7ed0a5ee0aca2f54d1da34e4c3fbeef7938468', artifactRuntimeTree: '1dcb5301fdeddedef5f885eb13b868c9167b2736',
  runtime: '3ef8785a06d9c52c9969e4809936dfadddd0b551', runtimeTree: 'a08504e9df7d830f32b2627e3d4825d4cbb367aa',
  commonSource: '533d92be348c976b47c2b6bab231aadf0bb42ccf', commonSourceTree: 'fd22294f24a618ad920eff3f7ace07afbcfa5476',
  lock: 'c7f59c139a7bdcb80941f0951aee705d30d606d699f08d2ab4600cf5f5cc128e',
};
const common = ['bulk-input-storage.test.ts', 'proofs/bulk-input-collisions.json', 'proofs/bulk-input-workers.mjs'];
const science = {
  'bulk-input-case.mjs': 'fbbcc04855c9b82efd8ea892dcffd49bfafeec41cc2becbf6c9c579a534625e9',
  'bulk-input-analysis.mjs': '40a9a2b8eff48597167a2b20856bdae313f37068662704c58bc11ab943231bc6',
  'math.mjs': '5d9bd04c6d51766e126aa7ec8dfbbac91a86d6bc75d6aa8fead3855b8c19480c',
  'supervise.py': '14ca60deec3dab98ffea94fb6006ea9b03167813d79a65b844e91e55a0478de0',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = path => digest(readFileSync(path));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function command(argv, cwd = process.cwd(), env = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.error, undefined, r.error?.message); assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
export async function supervisedPreparation(id, argv, cwd, evidence, python = 'python3') {
  const retained = join(evidence, 'prepare-' + id); mkdirSync(retained);
  const output = join(retained, 'command.log');
  const command = [python, join(here, 'supervise.py'), '--seconds', '180', '--rss-mib', '1024', '--cwd', cwd, '--output', output, '--', ...argv];
  await runOwnedController(command, cwd, retained, { controllerSeconds: 180, outerStepMinutes: 20, env: { ...process.env, GH_TOKEN: '' } });
  const receipt = read(output + '.json'); assert.deepEqual(receipt.command, argv); assert.equal(receipt.cwd, cwd);
  assert.equal(receipt.state, 'passed'); assert.equal(receipt.returncode, 0); assert.equal(receipt.supervisorLimit, null); assert.equal(receipt.primaryError, null);
  assert(receipt.cleanup.confirmedEmpty && receipt.cleanup.remainingGroupPids.length === 0 && receipt.cleanup.remainingBeforeCleanup.length === 0 && receipt.cleanup.errors.length === 0);
}
export function bind(value, replacements) {
  if (typeof value === 'string') { for (const [key, path] of Object.entries(replacements)) value = value.replaceAll('${' + key + '}', path); return value; }
  if (Array.isArray(value)) return value.map(v => bind(v, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, replacements)]));
  return value;
}
function inventory(root) {
  const result = {};
  function visit(relative = '') {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const key = join(relative, name), p = join(root, key), stat = statSync(p);
      if (stat.isDirectory()) visit(key);
      else result[key] = { bytes: stat.size, sha256: sha(p) };
    }
  }
  if (existsSync(root)) visit();
  return result;
}
function paths() {
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_SHA, 'Hosted job required');
  const root = join(process.env.RUNNER_TEMP, 'bulk-generic-latency');
  return { root, evidence: join(root, 'evidence'), screen: join(root, 'screen'), artifact: join(root, 'audited') };
}
async function prepare() {
  const { root, evidence, screen, artifact } = paths();
  assert(!existsSync(root), 'No retry/resume of an existing hosted attempt');
  mkdirSync(evidence, { recursive: true });
  try {
    const event = read(process.env.GITHUB_EVENT_PATH);
    save(join(evidence, 'event.json'), { name: process.env.GITHUB_EVENT_NAME, ref: event.ref, before: event.before, after: event.after, forced: event.forced, deleted: event.deleted, created: event.created });
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push'); assert.equal(process.env.GITHUB_REF, 'refs/heads/proof/bulk-generic-latency-20261009');
    assert.equal(event.ref, process.env.GITHUB_REF); assert.equal(event.before, pins.baseline); assert.equal(event.after, process.env.GITHUB_SHA);
    assert.equal(event.forced, false); assert.equal(event.deleted, false);
    assert.equal(process.env.GITHUB_REPOSITORY, pins.repository); assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
    assert.equal(process.env.RUNNER_ARCH, 'X64'); assert.equal(process.env.ImageOS, 'ubuntu24');
    assert.equal(process.versions.node, '22.23.3'); assert.equal(process.versions.bun, undefined);
    const node = realpathSync(process.execPath), bun = realpathSync(command(['which', 'bun'])), python = realpathSync(command(['which', 'python3']));
    assert.equal(command([bun, '--version']), '1.4.2');
    const checkout = process.cwd(), transport = command(['git', 'rev-parse', 'HEAD']);
    assert.equal(transport, process.env.GITHUB_SHA);
    assert.equal(command(['git', 'rev-parse', pins.baseline + '^{tree}']), pins.baselineTree);
    const gate = command(['git', 'ls-files', 'proofs/bulk-input-latency', '.github/workflows/bulk-input-latency.yml']).split('\n');
    const index = { GIT_INDEX_FILE: join(root, 'runtime.index') };
    command(['git', 'read-tree', transport], checkout, index);
    command(['git', 'update-index', '--force-remove', '--', ...gate], checkout, index);
    assert.equal(command(['git', 'write-tree'], checkout, index), pins.commonSourceTree);
    command(['git', 'update-index', '--force-remove', '--', ...common], checkout, index);
    assert.equal(command(['git', 'write-tree'], checkout, index), pins.runtimeTree);
    assert.equal(command(['git', 'diff', '--name-only', 'HEAD']), '', 'Tracked source changed');
    for (const [name, expected] of Object.entries(science)) assert.equal(sha(join(here, name)), expected);
    const machine = { study: 'fresh hosted study; no local observations pooled', runnerLabel: 'ubuntu-24.04', imageVersion: process.env.ImageVersion,
      image: process.env.ImageOS, runnerArch: process.env.RUNNER_ARCH, platform: platform(), kernel: release(), totalMemoryBytes: totalmem(),
      cpuModels: cpus().map(c => c.model), cpuInfo: readFileSync('/proc/cpuinfo', 'utf8'), osRelease: readFileSync('/etc/os-release', 'utf8'),
      runtime: { node: process.versions, bun: command([bun, '--version']), python: command([python, '--version']) },
      executables: [node, bun, python].map(path => ({ path, bytes: statSync(path).size, sha256: sha(path) })),
      github: { run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: transport, ref: process.env.GITHUB_REF },
      limitation: 'Runner class is fixed; standard hosted jobs do not guarantee a fixed CPU model or immutable image. Exact observed identity is bound before all subjects.' };
    save(join(evidence, 'machine.json'), machine);
    save(join(evidence, 'sources.json'), { ...pins, transport, transportTree: command(['git', 'rev-parse', 'HEAD^{tree}']),
      projectedRuntimeTree: pins.runtimeTree, projectedCommonSourceTree: pins.commonSourceTree, proofFiles: Object.fromEntries(gate.map(p => [p, sha(join(checkout, p))])), science,
      history: 'Fresh generic-only study. Combined-source fresh-string loss and unresolved object bounds remain preserved; both invalid local attempts stay unchanged. No observation pooling.',
      sourceFiles: Object.fromEntries(['arena.ts', ...common].map(p => [p, sha(join(checkout, p))])) });
    assert(process.env.GH_TOKEN, 'Read-only GitHub token required for pinned artifact');
    const api = 'https://api.github.com/repos/' + pins.repository;
    const headers = { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    async function getMeta(path, file) {
      const response = await fetch(api + path, { headers, signal: AbortSignal.timeout(120000) });
      const body = await response.text(); save(join(evidence, file), { path, status: response.status, bodyText: body });
      assert.equal(response.status, 200); return JSON.parse(body);
    }
    const run = await getMeta('/actions/runs/' + pins.run, 'download-run.json');
    assert.equal(run.id, pins.run); assert.equal(run.head_sha, pins.head); assert.equal(run.run_attempt, 1); assert.equal(run.conclusion, 'success');
    const meta = await getMeta('/actions/artifacts/' + pins.artifact, 'download-artifact.json');
    assert.equal(meta.id, pins.artifact); assert.equal(meta.expired, false); assert.equal(meta.workflow_run.id, pins.run); assert.equal(meta.workflow_run.head_sha, pins.head);
    const path = '/actions/artifacts/' + pins.artifact + '/zip';
    const redirect = await fetch(api + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    assert.equal(redirect.status, 302);
    const location = new URL(redirect.headers.get('location')); assert.equal(location.protocol, 'https:');
    // Never forward the GitHub token to artifact storage or record the signed URL.
    const response = await fetch(location, { signal: AbortSignal.timeout(120000) }); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    save(join(evidence, 'download-zip.json'), { apiPath: path, redirectStatus: redirect.status, storageOrigin: location.origin, status: response.status, bytes: bytes.length, sha256: digest(bytes) });
    writeFileSync(join(root, 'audited.zip'), bytes, { flag: 'wx' });
    assert.equal(bytes.length, pins.zipBytes); assert.equal(digest(bytes), pins.zipSha256);
    command([python, '-m', 'zipfile', '-e', join(root, 'audited.zip'), artifact]);
    assert.deepEqual(inventory(artifact), read(join(here, 'ARTIFACT-FILES.json')), 'Audited artifact file inventory differs');
    const source = read(join(artifact, 'evidence/sources.json'));
    for (const [k, expected] of Object.entries({ baseline: pins.baseline, baselineTree: pins.baselineTree, transport: pins.head, transportTree: pins.tree, localRuntime: pins.artifactRuntime, runtimeTree: pins.artifactRuntimeTree })) assert.equal(source[k], expected);
    for (const arm of ['baseline', 'candidate']) assert.equal(sha(join(artifact, 'evidence', arm + '-bun.lock')), pins.lock);
    // Reuse the exact baseline. Build only the new candidate; never substitute old candidate bytes.
    const expected = read(join(here, 'EXPECTED-OUTPUTS.json'));
    function buildInventory(directory) {
      return Object.fromEntries([
        ...readdirSync(directory).filter(name => name.endsWith('.wasm')).map(name => [name, sha(join(directory, name))]),
        ...Object.entries(inventory(join(directory, 'dist'))).map(([name, value]) => ['dist/' + name, value.sha256]),
      ]);
    }
    assert.deepEqual(buildInventory(join(artifact, 'baseline')), expected.baseline);
    copyFileSync(join(artifact, 'evidence/baseline-bun.lock'), join(checkout, 'bun.lock'));
    assert.equal(sha(join(checkout, 'bun.lock')), pins.lock);
    for (const [id, argv] of [
      ['install', [bun, 'install', '--frozen-lockfile']],
      ['wasm', [node, 'scripts/build-wasm.mjs']],
      ['browser', [bun, 'scripts/build-browser.ts']],
      ['types', [node, 'node_modules/typescript/bin/tsc', '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false', '--outDir', 'dist/types']],
    ]) await supervisedPreparation(id, argv, checkout, evidence, python);
    assert.equal(sha(join(checkout, 'bun.lock')), pins.lock);
    assert.equal(command(['git', 'diff', '--name-only', 'HEAD']), '', 'Candidate build changed tracked source');
    const actual = buildInventory(checkout); assert.deepEqual(actual, expected.candidate, 'Candidate build differs from reviewed generic-only outputs');
    assert.equal(Object.keys(actual).filter(p => p.endsWith('.wasm')).length, 12);
    assert.equal(Object.keys(actual).filter(p => p.endsWith('.d.ts')).length, 41);
    assert.equal(Object.keys(actual).filter(p => p.endsWith('.js')).length, 12);
    save(join(evidence, 'candidate-build.json'), { runtime: pins.runtime, commonSource: pins.commonSource, files: actual, lock: sha(join(checkout, 'bun.lock')) });
    copyFileSync(join(checkout, 'bun.lock'), join(evidence, 'candidate-bun.lock'));
    command(['git', 'archive', '--format=tar', '--output=' + join(evidence, 'candidate-source.tar'), 'HEAD']);
    const built = join(root, 'candidate-build');
    for (const name of Object.keys(actual)) { const target = join(built, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(checkout, name), target); }
    mkdirSync(screen);
    for (const name of readdirSync(here)) if (statSync(join(here, name)).isFile()) copyFileSync(join(here, name), join(screen, name));
    const inputs = [];
    for (const arm of ['baseline', 'candidate']) {
      const from = arm === 'baseline' ? join(artifact, arm, 'dist') : join(built, 'dist'), to = join(screen, 'fixtures', arm, 'dist'); mkdirSync(to, { recursive: true });
      const names = readdirSync(from).filter(n => n.endsWith('.js')).sort(); assert.equal(names.length, 12);
      for (const name of names) {
        const source = join(from, name), target = join(to, name); copyFileSync(source, target);
        inputs.push({ path: 'fixtures/' + arm + '/dist/' + name, source, bytes: statSync(target).size, sha256: sha(target) });
      }
    }
    save(join(screen, 'INPUTS.json'), inputs);
    const replacements = { SCREEN_DIR: screen, BUILDS: join(screen, 'fixtures'), OUTPUT: join(screen, 'execution'), NODE: node, BUN: bun };
    const schedule = bind(read(join(here, 'INVOCATIONS.json')).invocations, replacements);
    assert.equal(schedule.length, 76);
    for (const row of schedule) { assert.equal(row.supervisorArgv[row.supervisorArgv.indexOf('--seconds') + 1], '60'); assert.deepEqual(row.supervisorArgv.slice(row.supervisorArgv.indexOf('--') + 1), row.childArgv); }
    save(join(screen, 'SCHEDULE.json'), schedule);
    const childArgv = [node, join(screen, 'bulk-input-analysis.mjs'), join(screen, 'execution/canonical.json'), join(screen, 'execution/analysis.json')];
    save(join(screen, 'ANALYSIS-COMMAND.json'), { id: 'analysis', childArgv, supervisorArgv: [python, join(screen, 'supervise.py'), '--seconds', '60', '--rss-mib', '1024', '--cwd', screen, '--output', join(screen, 'execution/analysis.log'), '--', ...childArgv] });
    const matrix = read(join(screen, 'MATRIX.json')); assert.equal(matrix.childLimitSeconds, 60); assert.equal(matrix.supervisor.seconds, 60);
    const files = [];
    for (const directory of [screen, artifact, evidence, built]) for (const [path, value] of Object.entries(inventory(directory))) files.push({ path: join(directory, path), ...value });
    for (const path of [join(root, 'audited.zip'), node, bun, python, ...gate.map(p => join(checkout, p)), ...['arena.ts', ...common].map(p => join(checkout, p))]) files.push({ path, bytes: statSync(path).size, sha256: sha(path) });
    save(join(screen, 'FROZEN.json'), { state: 'fresh hosted study; no prior observations reused', files });
    const frozen = sha(join(screen, 'FROZEN.json'));
    save(join(evidence, 'prepared.json'), { frozen, scheduleSHA256: sha(join(screen, 'SCHEDULE.json')), machineSHA256: sha(join(evidence, 'machine.json')), python, screen });
    command([python, join(screen, 'run.py'), 'verify', frozen], screen);
    appendFileSync(process.env.GITHUB_OUTPUT, 'frozen=' + frozen + '\n');
    console.log('Exact audited inputs bound; 76 subjects remain unstarted. FROZEN ' + frozen);
  } catch (error) { save(join(evidence, 'prepare-failure.json'), { name: error.name, message: error.message, stack: error.stack }); throw error; }
}
export async function runOwnedController(argv, screen, evidence, options = {}) {
  save(join(evidence, 'controller-launch.json'), { argv, cwd: screen, utc: new Date().toISOString(), controllerSeconds: options.controllerSeconds ?? 2700, outerStepMinutes: options.outerStepMinutes ?? 47 });
  const fd = openSync(join(evidence, 'controller.log'), 'wx');
  let child, closed, observedTerminal = null, terminalWritten = false, receivedSignal = null, signalReceived;
  const interrupted = new Promise(resolve => { signalReceived = resolve; });
  const forward = signal => { receivedSignal ??= signal; if (child?.pid) child.kill(signal); signalReceived(signal); };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    child = spawn(argv[0], argv.slice(1), { cwd: screen, env: options.env ?? process.env, stdio: ['ignore', fd, fd] });
    closed = new Promise(resolve => {
      child.once('error', error => { observedTerminal = { code: null, signal: null, error: error.message }; resolve(observedTerminal); });
      child.once('close', (code, signal) => { observedTerminal = { code, signal, error: null }; resolve(observedTerminal); });
    });
    save(join(evidence, 'controller-process.json'), { pid: child.pid ?? null });
    console.log('Fixed controller started; original progress is written directly to evidence/controller.log');
    const outcome = await Promise.race([closed, interrupted.then(signal => { throw new Error('Controller wrapper received ' + signal); })]);
    save(join(evidence, 'controller-terminal.json'), { ...outcome, receivedSignal, utc: new Date().toISOString() });
    terminalWritten = true;
    assert.equal(outcome.error, null);
    assert.equal(outcome.code, 0, 'Original controller failed; no retries or replacements');
  } catch (error) { save(join(evidence, 'controller-transport-failure.json'), { name: error.name, message: error.message, receivedSignal }); throw error; }
  finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      async function waitForExit(milliseconds) {
        let timer;
        const exited = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
        clearTimeout(timer); return exited;
      }
      let exited = await waitForExit(8000), requestedKILL = false;
      if (!exited) { requestedKILL = true; child.kill('SIGKILL'); exited = await waitForExit(2000); }
      if (!exited) child.unref();
      save(join(evidence, 'controller-owner-cleanup.json'), { controllerPid: child.pid, requestedTERM: true, requestedKILL, controllerExited: exited, termAllowanceSeconds: 8, killAllowanceSeconds: 2,
        limitation: 'Subject process-group cleanup is established only by the original supervisor/controller receipts.' });
    }
    if (observedTerminal && !terminalWritten) save(join(evidence, 'controller-terminal.json'), { ...observedTerminal, receivedSignal, utc: new Date().toISOString() });
    closeSync(fd); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
async function run(frozen) {
  const { evidence, screen } = paths(), prepared = read(join(evidence, 'prepared.json'));
  assert.match(frozen, /^[a-f0-9]{64}$/); assert.equal(frozen, prepared.frozen); assert.equal(sha(join(screen, 'FROZEN.json')), frozen);
  await runOwnedController([prepared.python, join(screen, 'run.py'), 'run', frozen], screen, evidence);
}
function finalize() {
  const { root, evidence, screen } = paths(); mkdirSync(evidence, { recursive: true });
  const optional = path => existsSync(path) ? read(path) : null;
  let completion = null, failure = null, terminal = null, validationError = null;
  const receipts = [];
  try {
    completion = optional(join(screen, 'execution/completion.json')); failure = optional(join(screen, 'execution/failure.json'));
    terminal = optional(join(evidence, 'controller-terminal.json'));
    if (existsSync(join(screen, 'execution'))) for (const name of readdirSync(join(screen, 'execution')).filter(n => n.endsWith('.log.json'))) receipts.push({ file: name, ...read(join(screen, 'execution', name)) });
    assert.equal(process.env.PREPARE_OUTCOME, 'success'); assert.equal(process.env.MEASURE_OUTCOME, 'success');
    assert(completion && !failure, 'Original controller completion missing or failure present');
    assert(terminal && terminal.code === 0 && terminal.signal === null && terminal.error === null && terminal.receivedSignal === null, 'Original successful controller terminal receipt missing');
    const prepared = read(join(evidence, 'prepared.json')); command([prepared.python, join(screen, 'run.py'), 'verify', prepared.frozen], screen);
    assert.equal(command(['git', 'rev-parse', 'HEAD']), process.env.GITHUB_SHA);
    assert.equal(command(['git', 'diff', '--name-only', 'HEAD']), '', 'Tracked source changed after measurement');
    assert.equal(receipts.length, 77);
    assert(receipts.every(r => r.state === 'passed' && r.cleanup.confirmedEmpty));
  } catch (error) { validationError = { name: error.name, message: error.message, stack: error.stack }; }
  save(join(evidence, 'hosted-status.json'), { prepareStep: process.env.PREPARE_OUTCOME, measureStep: process.env.MEASURE_OUTCOME,
    originalControllerTerminal: terminal, completion, failure, validationError,
    status: validationError ? 'invalid-or-incomplete' : 'complete; statistical classification remains separate from CI completion',
    cleanupReceipts: receipts.map(r => ({ file: r.file, state: r.state, cleanup: r.cleanup })),
    missingCleanup: 'Any started subject without an original receipt has unknown cleanup; no receipt is reconstructed.',
    previousLocalAttempts: 'Both preserved invalid/incomplete; no rows pooled or partial effects substituted.' });
  save(join(evidence, 'final-inventory.json'), inventory(root));
  assert.equal(validationError, null, 'Hosted final validation failed; original error retained in hosted-status.json');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare') await prepare();
    else if (process.argv[2] === 'run') await run(process.argv[3]);
    else if (process.argv[2] === 'finalize') finalize();
    else throw new Error('Require prepare, run or finalize');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
