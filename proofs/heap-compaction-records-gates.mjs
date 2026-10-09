// Full standard gates belong to the controlled CI job. This is never imported
// by the subject and never converts a timeout into a candidate correctness pass.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runOwnedCommand, assertOwnedClean, atomicJSON, interruption } from './heap-compaction-records-command.mjs';
import { saveFocusedReceipt } from './heap-compaction-records-evidence.mjs';
import { verifyActivation } from './heap-compaction-records-activation.mjs';
import { inspectArms } from './heap-compaction-records-discovery.mjs';
import { sourceManifest } from './heap-compaction-records-performance.mjs';
const root = resolve(import.meta.dirname, '..');
assert(process.env.HEAP_BASE && process.env.HEAP_PRIVATE_DIR, 'Explicit external baseline and private cache roots are required');
const baseline = resolve(process.env.HEAP_BASE);
const activation = verifyActivation(root, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env.GITHUB_EVENT_NAME);
assert(activation.enabled, 'Accepted creation-push activation is required before full gates');
const out = resolve(process.env.HEAP_RESULTS ?? join(root, 'proofs/results/heap-compaction-records'));
assert.equal(process.version, 'v22.23.3');
assert.equal(execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), '1.4.2');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const report = { activation, complete: false, passed: false, baseline: git(baseline, 'rev-parse', 'HEAD'), candidate: git(root, 'rev-parse', 'HEAD'), records: [] };
assert.equal(report.candidate, process.env.HEAP_EXPECTED_HEAD, 'Bind gates to the published exact head');
mkdirSync(out, { recursive: true });
assert(!existsSync(join(out, 'gates.json')), 'Refuse to overwrite a prior gate receipt');
const save = () => atomicJSON(join(out, 'gates.json'), report);
const steps = [
  ['build-wasm', ['node', 'scripts/build-wasm.mjs']], ['build-portable', ['bun', 'scripts/build-browser.ts']],
  ['build-types', ['node', 'node_modules/typescript/bin/tsc', '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false', '--outDir', 'dist/types']],
  ['types-main', ['node', 'node_modules/typescript/bin/tsc', '--noEmit']],
  ...['redux', 'typed-values', 'geometry', 'worker'].map(kind => [`types-${kind}`, ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', `tsconfig.${kind}.json`]]),
  ['types-values-loose-optional', ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.typed-values.json', '--exactOptionalPropertyTypes', 'false']],
  ['unit-standard', ['bun', 'run', 'test']],
  ...['worker-tasks', 'list-query', 'list-query-regression', 'memory-startup'].map(name => [name, ['node', '--test', `proofs/${name}.mjs`]]),
  ...['node-worker', 'redux-node', 'typed-json-worker'].map(name => [name, ['node', `proofs/${name}.mjs`]]),
  ['package', ['node', 'scripts/check-package.mjs']],
];
async function run(arm, stage, command, cwd) {
  const record = { arm, stage, command, status: 'planned', commandReceipt: `${arm}-${stage}.command.json` };
  report.records.push(record); save();
  const env = { ...process.env, npm_config_cache: join(process.env.HEAP_PRIVATE_DIR, 'caches', arm, 'npm'), BUN_INSTALL_CACHE_DIR: join(process.env.HEAP_PRIVATE_DIR, 'caches', arm, 'bun') };
  const child = await runOwnedCommand({ command: command[0], args: command.slice(1), cwd, env,
    prefix: join(out, `${arm}-${stage}`), totalMs: 300000,
    identity: { engine: command[0] === 'bun' ? 'bun142' : command[0] === 'node' ? 'node22' : 'python3-supervisor', case: null, build: arm, mode: 'gate', protocol: null, block: null, pair: null, label: stage, frozenCounts: null } });
  Object.assign(record, child); save();
  assert(child.complete, `${arm}/${stage} failed; retain ${record.commandReceipt}`);
  assertOwnedClean();
}
save();
try {
  report.discovery = await inspectArms(baseline, root, { initializeCaches: true }); save();
  report.privateCaches = [];
  for (const arm of ['baseline', 'candidate', 'proof']) for (const kind of ['npm', 'bun']) {
    const path = join(process.env.HEAP_PRIVATE_DIR, 'caches', arm, kind);
    mkdirSync(path, { recursive: true }); assert(!lstatSync(path).isSymbolicLink()); assert.equal(readdirSync(path).length, 0);
    report.privateCaches.push({ arm, kind, physical: realpathSync(path), initiallyEmpty: true });
  }
  assert.equal(new Set(report.privateCaches.map(c => c.physical)).size, report.privateCaches.length); save();
  const dependencyRows = [];
  for (const [arm, dir] of [['baseline', baseline], ['candidate', root]]) {
    assert(!lstatSync(join(dir, 'node_modules')).isSymbolicLink(), `${arm}: independent dependency directory required`);
    assert.equal(readdirSync(join(dir, 'node_modules/.vite')).length, 0);
    assert.equal(readdirSync(join(dir, 'node_modules/.cache')).length, 0);
    const rows = [];
    function visit(path, prefix = '') {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + entry.name, absolute = join(path, entry.name);
        if (entry.isSymbolicLink()) rows.push([name, 'link', readlinkSync(absolute)]);
        else if (entry.isDirectory()) visit(absolute, `${name}/`);
        else rows.push([name, 'file', createHash('sha256').update(readFileSync(absolute)).digest('hex')]);
      }
    }
    visit(join(dir, 'node_modules'));
    dependencyRows.push({ arm, realPath: realpathSync(join(dir, 'node_modules')), entries: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') });
  }
  assert.notEqual(dependencyRows[0].realPath, dependencyRows[1].realPath); assert.equal(dependencyRows[0].sha256, dependencyRows[1].sha256);
  report.freshDependencies = dependencyRows; save();
  for (const [stage, command] of [
    ['repair-node', ['node', '--test', 'proofs/heap-compaction-records-repairs.node.mjs']],
    ['repair-bun', ['bun', 'test', './proofs/heap-compaction-records-repairs.node.mjs']],
    ['supervisor-ownership', ['python3', 'proofs/heap-compaction-records-supervisor-guard.py', root, join(out, 'supervisor'), process.execPath, 'bun']],
  ]) await run('proof', stage, command, root);
  for (const [stage, command] of steps) for (const [arm, dir] of [['baseline', baseline], ['candidate', root]]) await run(arm, stage, command, dir);
  for (const [stage, command] of [
    ['prepare-focused', ['node', 'proofs/heap-compaction-records-prepare.mjs']],
    ['build-focused', ['bun', 'proofs/heap-compaction-records-build.ts']],
    ['focused-node', ['node', '.proof-tools/heap-compaction-records/node-check.mjs']],
    ['focused-bun', ['bun', 'proofs/heap-compaction-records-check.ts']],
    ['workers-matrix', ['node', 'proofs/heap-compaction-records-worker.mjs']],
    ['protocol-tests', ['node', '--test', 'proofs/heap-compaction-records-stats.node.mjs']],
  ]) {
    await run('proof', stage, command, root);
    if (stage === 'focused-node' || stage === 'focused-bun') {
      const engine = stage === 'focused-node' ? 'node22' : 'bun142';
      saveFocusedReceipt(join(root, '.proof-tools/heap-compaction-records/correctness.json'), out, engine);
    }
  }
  report.sources = sourceManifest(baseline, root);
  assert(!interruption(), 'Gate controller interrupted');
  report.complete = true; report.passed = true; save();
} catch (error) { report.error = String(error); save(); throw error; }
