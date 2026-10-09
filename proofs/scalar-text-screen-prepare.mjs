/** Fresh serial Node-screen and scalar correctness gates. This never invokes timing. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, delimiter, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { hash } from './scalar-text-screen-inventory.mjs';
const [outArg, bunArg] = process.argv.slice(2);
assert(outArg && bunArg, 'new-output-directory pinned-bun-executable required');
assert.equal(process.version, 'v22.23.3');
const root = resolve(import.meta.dirname, '..'), out = resolve(outArg), bun = resolve(bunArg), node = process.execPath;
const base = join(out, 'baseline'), logs = join(out, 'logs');
mkdirSync(out); mkdirSync(logs); mkdirSync(base);
const sourceTree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
const env = { ...process.env, PATH: [dirname(node), dirname(bun), process.env.PATH].join(delimiter) };
assert.equal(execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(), '1.4.2');
assert.equal(execFileSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' }).trim(), '');
execFileSync('git', ['worktree', 'add', '--detach', base, 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad'], { cwd: root, stdio: 'inherit' });
symlinkSync(join(root, 'node_modules'), join(base, 'node_modules'));
const checks = [];
function run(id, executable, args, cwd = root, extras = {}) {
  const stdout = openSync(join(logs, id + '.stdout'), 'wx'), stderr = openSync(join(logs, id + '.stderr'), 'wx');
  let result;
  try { result = spawnSync(executable, args, { cwd, env: { ...env, ...extras }, stdio: ['ignore', stdout, stderr], timeout: 180000, killSignal: 'SIGKILL' }); }
  finally { closeSync(stdout); closeSync(stderr); }
  const check = { id, executable, args, cwd, status: result.status, signal: result.signal, error: result.error?.message ?? null };
  checks.push(check); writeFileSync(join(out, 'checks.partial.json'), JSON.stringify(checks, null, 2) + '\n');
  console.log(JSON.stringify({ id, status: result.status, signal: result.signal, error: check.error }));
  return result.status === 0;
}
run('synthetic-activation', node, ['proofs/scalar-text-screen-activation-check.mjs']);
run('synthetic-summary', node, ['proofs/scalar-text-screen-summary-check.mjs']);
for (const [role, cwd] of [['baseline', base], ['candidate', root]]) {
  run(role + '-build-wasm', node, ['scripts/build-wasm.mjs'], cwd);
  run(role + '-build-browser', bun, ['scripts/build-browser.ts'], cwd);
  run(role + '-build-types', node, ['node_modules/typescript/bin/tsc', '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false', '--outDir', 'dist/types'], cwd);
  const typed = [['typecheck', []], ['redux-types', ['-p', 'tsconfig.redux.json']], ['values-types', ['-p', 'tsconfig.typed-values.json']],
    ['values-inexact-types', ['-p', 'tsconfig.typed-values.json', '--exactOptionalPropertyTypes', 'false']],
    ['geometry-types', ['-p', 'tsconfig.geometry.json']], ['worker-types', ['-p', 'tsconfig.worker.json']], ['text-types', ['-p', 'tsconfig.text-search.json']]];
  for (const [id, args] of typed) run(role + '-' + id, node, ['node_modules/typescript/bin/tsc', '--noEmit', ...args], cwd);
  // Vitest 4.1.11 keys cached results by project name plus relative filename.
  // A task-local cache is the only configuration change; all concurrency,
  // isolation, assertions and timeouts are inherited from the standard config.
  const cacheDir = join(out, role + '-vitest-cache');
  mkdirSync(cacheDir);
  const resultsDir = join(cacheDir, 'vitest', 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  mkdirSync(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, 'results.json');
  const emptyCache = '{"version":"4.1.11","results":[]}';
  writeFileSync(resultsPath, emptyCache);
  const configPath = join(out, role + '-vitest.config.mts');
  writeFileSync(configPath, `import original from ${JSON.stringify(pathToFileURL(join(cwd, 'vitest.config.ts')).href)};\nexport default { ...original, cacheDir: ${JSON.stringify(cacheDir)} };\n`);
  const cacheReceipt = { role, unchangedConfigSha256: hash(readFileSync(join(cwd, 'vitest.config.ts'))),
    configPath, configSha256: hash(readFileSync(configPath)), resultsPath,
    beforeSha256: hash(readFileSync(resultsPath)), beforeContents: emptyCache,
    rule: 'Only cacheDir differs; original test settings are inherited unchanged' };
  writeFileSync(join(logs, role + '-cache-before.json'), JSON.stringify(cacheReceipt, null, 2) + '\n');
  run(role + '-unit-integration', bun, ['--bun', 'node_modules/vitest/vitest.mjs', 'run', '--config', configPath], cwd);
  cacheReceipt.afterSha256 = existsSync(resultsPath) ? hash(readFileSync(resultsPath)) : null;
  writeFileSync(join(logs, role + '-cache-after.json'), JSON.stringify(cacheReceipt, null, 2) + '\n');
  for (const file of ['worker-tasks', 'list-query', 'list-query-regression', 'memory-startup']) run(role + '-' + file, node, ['--test', `proofs/${file}.mjs`], cwd);
  run(role + '-docs-unit', node, ['--test', 'scripts/check-docs.node.mjs'], cwd);
  run(role + '-docs-links', node, ['scripts/check-docs.mjs'], cwd);
  run(role + '-docs-examples', node, ['scripts/check-doc-examples.mjs'], cwd);
  run(role + '-worker-docs-node', node, ['scripts/check-worker-docs.mjs', '--node-only'], cwd);
  for (const file of ['node-worker', 'redux-node', 'typed-json-worker']) run(role + '-' + file, node, [`proofs/${file}.mjs`], cwd);
  run(role + '-package', node, ['scripts/check-package.mjs'], cwd);
  run(role + '-historical-evidence', node, ['proofs/restore-local-evidence.mjs'], cwd);
  run(role + '-existing-text', node, ['--test', 'proofs/text-kernel.mjs', 'proofs/text-batch.mjs', 'proofs/text-search.mjs'], cwd,
    { TEXT_KERNEL_ENTRY: join(cwd, 'persistent-core.wasm'), QUERY_PROOF_ENTRY: pathToFileURL(join(cwd, 'dist/shared.js')).href });
}
run('scalar-proof-build', node, ['proofs/scalar-text-filter-build.mjs']);
run('scalar-correctness-node', node, ['--test', 'proofs/scalar-text-filter-correctness.mjs']);
run('scalar-correctness-bun', bun, ['proofs/scalar-text-filter-correctness.mjs']);
run('cross-format', node, ['proofs/scalar-text-filter-format.mjs', pathToFileURL(join(base, 'dist/shared.js')).href, pathToFileURL(join(root, 'dist/shared.js')).href]);
const staged = run('stage-inventory', node, ['proofs/scalar-text-screen-stage.mjs', out, base, bun]);
if (staged) run('public-case-correctness', node, ['proofs/scalar-text-screen-run.mjs', 'check', out]);
assert.equal(execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim(), sourceTree, 'Index changed during preflight');
assert.equal(execFileSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Tracked source changed during preflight');
const complete = staged && checks.every(x => x.status === 0);
const gate = { complete, timingsRun: false, sourceTree, manifestSha256: staged ? hash(readFileSync(join(out, 'manifest.json'))) : null,
  checks, logs: readdirSync(logs).sort().map(file => ({ file: 'logs/' + file, sha256: hash(readFileSync(join(logs, file))) })) };
writeFileSync(join(out, 'gates.json'), JSON.stringify(gate, null, 2) + '\n');
console.log(JSON.stringify({ complete, failed: checks.filter(x => x.status !== 0).map(x => x.id), timingsRun: false }));
process.exitCode = complete ? 0 : 1;
