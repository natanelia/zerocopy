import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { sha256, prepareComparison } from './block-traversal-source.mjs';
import { writeJson } from './block-traversal-empty-controls.mjs';
import { CONTEXT, IDENTITIES, prospectivePlan, verifyReusedHelpers } from './block-portability-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function commandPlan(baseline, candidate, lane, evidence) {
  const specs = [];
  const add = (id, cwd, command, ...args) => specs.push({ id, cwd: resolve(cwd), command: [command, ...args] });
  for (const [build, directory] of Object.entries({ baseline, candidate })) {
    for (const script of ['build:wasm', 'build:browser', 'build:types', 'typecheck', 'typecheck:values', 'typecheck:redux', 'typecheck:geometry', 'test', 'check:package']) {
      add(`${build}/${script}`, directory, 'bun', 'run', script);
    }
    add(`${build}/public-worker-types`, directory, 'node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json');
    add(`${build}/built-worker-tasks`, directory, 'node', '--test', 'proofs/worker-tasks.mjs');
    for (const name of ['node-worker', 'redux-node', 'typed-json-worker']) add(`${build}/${name}`, directory, 'node', `proofs/${name}.mjs`);
    for (const runtime of ['node', 'bun']) add(`${build}/block-workers-${runtime}`, root, runtime, join(here, 'block-traversal-worker-check.mjs'), join(directory, 'dist/shared.js'));
    add(`${build}/mechanism`, root, 'bun', join(here, 'block-traversal-counts.ts'), directory, build);
    add(`${build}/all-fixtures`, root, 'node', '--input-type=module', '-e', `import {runChecks} from ${JSON.stringify(new URL('./block-traversal-workloads.mjs', import.meta.url).href)}; const S=await import(${JSON.stringify(pathToFileURL(resolve(directory, 'dist/shared.js')).href)}); console.log(JSON.stringify(await runChecks(S)));`);
  }
  add('proof/protocol-tests', root, 'node', '--test', 'proofs/block-traversal-performance.node.mjs', 'proofs/block-traversal-empty-controls.node.mjs', 'proofs/block-traversal-chromium-isolation.node.mjs', 'proofs/block-portability.node.mjs');
  if (lane.arch === 'x64') add('proof/browser-correctness', root, 'node', join(here, 'block-portability-runner.mjs'), 'correctness', baseline, candidate, evidence, lane.name);
  return specs;
}
export function validatePrerequisites(directory, baseline, candidate, laneName) {
  const receipt = readJson(join(directory, 'prerequisites.json')), { lane } = prospectivePlan(laneName);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.lane, laneName);
  assert.deepEqual(receipt.commits, { baseline: CONTEXT.baseline, candidate: CONTEXT.candidate });
  const expected = commandPlan(baseline, candidate, lane, directory);
  assert.deepEqual(receipt.checks.map(({ id, cwd, command }) => ({ id, cwd, command })), expected, 'Missing, duplicate, substituted or reordered prerequisite');
  for (const check of receipt.checks) {
    assert.equal(check.status, 0, `Failed prerequisite ${check.id}`); assert.equal(check.signal, null); assert.equal(check.error, null);
    assert.match(check.log, /^logs\/[a-z0-9-]+\.log$/); assert.equal(sha256(readFileSync(join(directory, check.log))), check.sha256);
  }
  assert.equal(receipt.runtime.node, '22.23.3'); assert.equal(receipt.runtime.bun, '1.4.2'); assert.equal(receipt.runtime.arch, lane.arch);
  assert.equal(receipt.comparison.candidateCommit, CONTEXT.candidate);
  assert.deepEqual(receipt.comparison.manifests, IDENTITIES.bundles);
  return { receipt, sha256: sha256(readFileSync(join(directory, 'prerequisites.json'))) };
}
export function verifyExactPair(baseline, candidate) {
  assert.equal(process.env.CANDIDATE_COMMIT, CONTEXT.candidate);
  for (const [role, directory] of Object.entries({ baseline, candidate })) {
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(), CONTEXT[role]);
    assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(), '', `Tracked source/test/configuration files changed in ${role}`);
  }
  const { cleanup, ...comparison } = prepareComparison(join(baseline, 'dist/shared.js'), join(candidate, 'dist/shared.js'));
  assert.deepEqual(comparison.manifests, IDENTITIES.bundles, 'Emitted builds differ from the reviewed immutable builds');
  for (const role of ['baseline', 'candidate']) {
    assert.deepEqual(comparison.sourceManifests[role].wasm, IDENTITIES.wasm);
    assert.deepEqual(comparison.sourceManifests[role].files, Object.fromEntries(Object.entries(IDENTITIES.source[role]).map(([file, identity]) => [file, identity.sha256])));
  }
  return comparison;
}
export function runPrerequisites(baseline, candidate, evidence, laneName) {
  baseline = realpathSync(baseline); candidate = realpathSync(candidate); evidence = resolve(evidence);
  const { lane } = prospectivePlan(laneName);
  assert(!existsSync(evidence), 'Prerequisite output must be new; no retry or overwrite');
  mkdirSync(join(evidence, 'logs'), { recursive: true });
  const record = { status: 'partial', lane: laneName, startedAt: new Date().toISOString(),
    commits: { baseline: CONTEXT.baseline, candidate: CONTEXT.candidate }, checks: [] };
  const save = () => writeJson(join(evidence, 'prerequisites.json'), record); save();
  try {
    verifyReusedHelpers();
    for (const directory of [root, candidate]) assert(relative(directory, baseline).startsWith('..'), 'Baseline must be outside both proof and candidate checkouts');
    for (const [role, directory] of Object.entries({ baseline, candidate })) {
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(), CONTEXT[role]);
      assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(), '', `Tracked source/test/configuration files changed in ${role}`);
    }
    record.runtime = { node: process.versions.node, bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), arch: process.arch, platform: process.platform };
    assert.equal(record.runtime.node, '22.23.3'); assert.equal(record.runtime.bun, '1.4.2'); assert.equal(process.arch, lane.arch); assert.equal(process.platform, 'linux');
    for (const spec of commandPlan(baseline, candidate, lane, evidence)) {
      const log = `logs/${spec.id.replaceAll(/[^a-z0-9]/g, '-')}.log`, path = join(evidence, log);
      const check = { ...spec, log, status: null, signal: null, error: null, startedAt: new Date().toISOString(), sha256: null }; record.checks.push(check); save();
      const fd = openSync(path, 'wx'); let child;
      try { child = spawnSync(spec.command[0], spec.command.slice(1), { cwd: spec.cwd, stdio: ['ignore', fd, fd], timeout: 1800000 }); }
      finally { closeSync(fd); }
      Object.assign(check, { status: child.status, signal: child.signal, error: child.error ? String(child.error) : null, finishedAt: new Date().toISOString(), sha256: sha256(readFileSync(path)) }); save();
      assert.equal(child.status, 0, `Prerequisite failed: ${spec.id}; retained ${path}`);
      assert.equal(child.signal, null); assert.equal(check.error, null);
    }
    record.comparison = verifyExactPair(baseline, candidate);
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); save();
    validatePrerequisites(evidence, baseline, candidate, laneName); return record;
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); record.finishedAt = new Date().toISOString(); save(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runPrerequisites(...process.argv.slice(2));
