/** One finite hosted correctness job. No retries, performance subjects or publishing. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const baseline = '52d5fb012eb1f568e11807b7cb2a66c4566589e2';
const baselineTree = '0bc8d2425fe82e0b70bbb8558deb175536f90e9d';
const localSource = '135826dc0e0a9bd5a5c7fe5d852b114823b9b22b';
const sourceTree = '04198d71977f68e12aa30d39ecab50515362da9d';
const localRuntime = 'dc7ed0a5ee0aca2f54d1da34e4c3fbeef7938468';
const runtimeTree = '1dcb5301fdeddedef5f885eb13b868c9167b2736';
const common = ['bulk-input-storage.test.ts', 'proofs/bulk-input-collisions.json', 'proofs/bulk-input-workers.mjs'];
const gateFiles = ['.github/workflows/bulk-input-storage-validation.yml', 'proofs/bulk-input-hosted.mjs'];
assert.equal(process.versions.node, '22.23.3');
assert.equal(process.versions.bun, undefined);
assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_SHA, 'Run only in the reviewed hosted job');
const checkout = process.cwd(), root = join(process.env.RUNNER_TEMP, 'bulk-input'), evidence = join(root, 'evidence');
assert.ok(!existsSync(root), 'A prior attempt must not be overwritten or resumed');
mkdirSync(evidence, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const json = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const receipts = [];
function run(id, argv, cwd = checkout, env = {}, timeout) {
  assert.ok(!existsSync(join(evidence, `${id}.log`)), `Duplicate command: ${id}`);
  console.log(`Starting ${id}: ${argv.join(' ')}`);
  const fd = openSync(join(evidence, `${id}.log`), 'wx');
  let result;
  try { result = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout }); }
  finally { closeSync(fd); }
  receipts.push({ id, argv, cwd, env, status: result.status, signal: result.signal, error: result.error?.message ?? null });
  json('commands.json', receipts);
  console.log(`${id}: exit ${result.status}, signal ${result.signal ?? 'none'}`);
  assert.equal(result.error, undefined, `${id}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${id}: see preserved ${id}.log`);
}
function git(args, cwd = checkout, env = {}) {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function projectedTree(commit, removed, index) {
  const env = { GIT_INDEX_FILE: join(root, index) };
  git(['read-tree', commit], checkout, env);
  git(['update-index', '--force-remove', '--', ...removed], checkout, env);
  return git(['write-tree'], checkout, env);
}
function inventory(directory) {
  const result = {};
  function visit(relative = '') {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const path = join(relative, name), file = join(directory, path);
      if (statSync(file).isDirectory()) visit(path);
      else result[path] = { bytes: statSync(file).size, sha256: sha(readFileSync(file)) };
    }
  }
  if (existsSync(directory)) visit();
  return result;
}
function buildInventory(arm) {
  const directory = join(root, arm);
  const wasm = existsSync(directory) ? Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.wasm')).sort().map(name => {
    const bytes = readFileSync(join(directory, name)); return [name, { bytes: bytes.length, sha256: sha(bytes) }];
  })) : {};
  return { wasm, dist: inventory(join(directory, 'dist')) };
}
let complete = false;
try {
  const transport = git(['rev-parse', 'HEAD']);
  assert.equal(transport, process.env.GITHUB_SHA);
  assert.equal(git(['rev-parse', `${baseline}^{tree}`]), baselineTree);
  assert.equal(projectedTree(transport, gateFiles, 'source.index'), sourceTree);
  assert.equal(projectedTree(transport, [...gateFiles, ...common], 'runtime.index'), runtimeTree);
  assert.deepEqual(git(['diff', '--name-only', baseline, transport]).split('\n').sort(), ['arena.ts', ...common, ...gateFiles].sort());
  const identity = { baseline, baselineTree, transport, transportTree: git(['rev-parse', 'HEAD^{tree}']), localSource, sourceTree, localRuntime, runtimeTree,
    projection: 'Remove exactly the two gate files for the source tree, then the three common test files for the runtime tree.',
    versions: process.versions, runner: { os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH, image: process.env.ImageOS, imageVersion: process.env.ImageVersion },
    files: Object.fromEntries(['arena.ts', 'persistent-core.as.ts', ...common, ...gateFiles].map(name => [name, sha(readFileSync(join(checkout, name)))])) };
  json('sources.json', identity);
  run('bun-version', ['bun', '--version']);
  assert.equal(readFileSync(join(evidence, 'bun-version.log'), 'utf8').trim(), '1.4.2');
  for (const [arm, commit] of [['baseline', baseline], ['candidate', transport]]) {
    git(['worktree', 'add', '--detach', join(root, arm), commit]);
    run(`archive-${arm}`, ['git', 'archive', '--format=tar', `--output=${join(evidence, `${arm}-source.tar`)}`, commit]);
  }
  for (const name of common) copyFileSync(join(root, 'candidate', name), join(root, 'baseline', name));
  run('archive-common-overlay', ['tar', '-cf', join(evidence, 'baseline-common-overlay.tar'), ...common], join(root, 'candidate'));
  for (const arm of ['baseline', 'candidate']) {
    run(`install-${arm}`, ['bun', 'install'], join(root, arm));
    copyFileSync(join(root, arm, 'bun.lock'), join(evidence, `${arm}-bun.lock`));
    run(`dependencies-${arm}`, ['bun', 'pm', 'ls', '--all'], join(root, arm));
  }
  assert.equal(sha(readFileSync(join(evidence, 'baseline-bun.lock'))), sha(readFileSync(join(evidence, 'candidate-bun.lock'))), 'Dependency resolutions differ');
  const commands = [
    ['build-wasm', ['bun', 'run', 'build:wasm']], ['build-browser', ['bun', 'run', 'build:browser']], ['build-types', ['bun', 'run', 'build:types']],
    ['typecheck', ['bun', 'run', 'typecheck']], ['typecheck-redux', ['bun', 'run', 'typecheck:redux']], ['typecheck-values', ['bun', 'run', 'typecheck:values']], ['typecheck-geometry', ['bun', 'run', 'typecheck:geometry']],
    ['typecheck-worker', ['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.worker.json']], ['test', ['bun', 'run', 'test']],
    ['worker-tasks', ['node', '--test', 'proofs/worker-tasks.mjs']], ['list-query', ['node', '--test', 'proofs/list-query.mjs']], ['list-query-regression', ['node', '--test', 'proofs/list-query-regression.mjs']], ['memory-startup', ['node', '--test', 'proofs/memory-startup.mjs']],
    ['check-docs-unit', ['node', '--test', 'scripts/check-docs.node.mjs']], ['check-docs', ['node', 'scripts/check-docs.mjs', '--base', baseline, '--preserve']], ['check-doc-examples', ['node', 'scripts/check-doc-examples.mjs']],
    ['install-chromium', ['bunx', 'playwright', 'install', '--with-deps', 'chromium']], ['check-doc-browser', ['node', 'scripts/check-doc-browser.mjs']], ['check-worker-docs', ['node', 'scripts/check-worker-docs.mjs']],
    ['node-worker', ['node', 'proofs/node-worker.mjs']], ['redux-node', ['node', 'proofs/redux-node.mjs']], ['typed-json-worker', ['node', 'proofs/typed-json-worker.mjs']],
    ['check-package', ['bun', 'run', 'check:package']], ['restore-evidence', ['node', 'proofs/restore-local-evidence.mjs']], ['worker-sessions', ['node', 'proofs/worker-sessions.mjs']], ['test-browser', ['bun', 'run', 'test:browser']],
  ];
  for (const arm of ['baseline', 'candidate']) for (const [id, argv] of commands) {
    if (id === 'install-chromium' && arm === 'candidate') continue;
    const env = id === 'test' ? { BULK_INPUT_ARM: arm, BULK_INPUT_RUNTIME: 'bun', BULK_INPUT_REPORT: join(evidence, `${arm}-cases.json`) } : {};
    run(`${arm}-${id}`, argv, join(root, arm), env);
  }
  for (const producer of ['baseline', 'candidate']) run(`workers-${producer}`,
    ['node', 'proofs/bulk-input-workers.mjs', root, producer, join(evidence, `${producer}-workers.json`), 'node'], join(root, 'candidate'), {}, 120000);

  const reports = Object.fromEntries(['baseline', 'candidate'].map(arm => {
    const report = read(join(evidence, `${arm}-cases.json`));
    assert.equal(report.arm, arm); assert.equal(report.runtime.bun, '1.4.2'); assert.equal(report.rows.length, 42);
    const rows = Object.fromEntries(report.rows.map(row => [row.name, row])); assert.equal(Object.keys(rows).length, 42);
    for (const type of ['string', 'object']) assert.deepEqual(rows[`zero/journal/${type}`].requests, [0]);
    return [arm, rows];
  }));
  assert.deepEqual(Object.keys(reports.baseline).sort(), Object.keys(reports.candidate).sort());
  const allocations = [];
  for (const [name, before] of Object.entries(reports.baseline)) {
    const after = reports.candidate[name];
    if (name.startsWith('boundary/')) {
      const [, type, raw] = name.split('/'), n = Number(raw);
      const saving = n > 0 && n <= 12288 ? Math.ceil(4 * n / 8) * 8 + (type === 'object' && n % 2 ? 4 : 0) : 0;
      assert.equal(before.used - after.used, saving, name); assert.equal(before.logical, after.logical, name); assert.equal(before.size, after.size, name);
      if (!saving) assert.deepEqual(before, after, name);
      allocations.push({ name, saving, baselineUsed: before.used, candidateUsed: after.used, baselineBacking: before.backing, candidateBacking: after.backing });
    } else if (/^(invalid|control|zero)\//.test(name) || name === 'error/serialization') assert.deepEqual(before, after, name);
  }
  for (const producer of ['baseline', 'candidate']) {
    const report = read(join(evidence, `${producer}-workers.json`));
    assert.equal(report.runtime.node, '22.23.3'); assert.equal(report.runtime.bun, undefined); assert.equal(report.rows.length, 4);
    assert.deepEqual(report.rows.map(row => `${row.reader}/${row.copy}`).sort(), ['baseline/false', 'baseline/true', 'candidate/false', 'candidate/true']);
    for (const row of report.rows) {
      assert.equal(row.producer, producer); assert.equal(row.exit, 0); assert.equal(row.phase, 'done');
      assert.equal(row.oldSize, 12288); assert.equal(row.nextSize, 12293); assert.equal(row.runtime.node, '22.23.3'); assert.equal(row.runtime.bun, undefined);
    }
  }
  for (const arm of ['baseline', 'candidate']) {
    assert.equal(git(['rev-parse', 'HEAD'], join(root, arm)), arm === 'baseline' ? baseline : transport);
    assert.equal(git(['diff', '--name-only', 'HEAD'], join(root, arm)), '', `${arm}: tracked source changed`);
    for (const name of common) assert.equal(sha(readFileSync(join(root, arm, name))), identity.files[name]);
  }
  const outputs = Object.fromEntries(['baseline', 'candidate'].map(arm => [arm, buildInventory(arm)]));
  const fixed = output => ({ wasm: output.wasm, declarations: Object.fromEntries(Object.entries(output.dist).filter(([name]) => name.endsWith('.d.ts'))) });
  for (const arm of ['baseline', 'candidate']) { assert.equal(Object.keys(outputs[arm].wasm).length, 12); assert.equal(Object.keys(fixed(outputs[arm]).declarations).length, 41); }
  assert.deepEqual(fixed(outputs.baseline), fixed(outputs.candidate), 'WASM or declarations differ');
  json('result.json', { status: 'passed', baseline, localSource, localRuntime, transport, ordinaryFullSuiteRuntime: 'Bun 1.4.2', newCorpusRows: 84, actualNodeWorkers: 8, allocations,
    originalLocalSelectedSuiteGate: 'failed; baseline map-set-index existing 5000ms timeout; unchanged',
    originalLocalSupplement: 'failed; final reconciler detected live mutable request recording; unchanged',
    scope: 'Fresh hosted ordinary correctness and finite allocation checks. No latency, retained-heap, RSS or chart result.' });
  complete = true;
} catch (error) {
  json('failure.json', { message: error.message, stack: error.stack, completedCommands: receipts.length });
  console.error(error); process.exitCode = 1;
} finally {
  json('outputs.json', Object.fromEntries(['baseline', 'candidate'].map(arm => [arm, buildInventory(arm)])));
  json('status.json', { complete, attemptedCommands: receipts.length, retries: 0, laterCommands: complete ? 'none' : 'unstarted after first failure' });
}
