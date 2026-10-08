/** Fail closed: the fixed latency screen requires one complete clean correctness run. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareComparison, verifyProofSources, sha256, bundleManifest, CORE_HASHES } from './vector-reservation-source.mjs';
export function prerequisitePlan(compared, build, directory) {
  const root = compared.sourceManifests.candidate.root, rows = [];
  const add = (name, executable, args, cwd = root) => rows.push({ name, executable, args, cwd });
  for (const [role, source] of Object.entries(compared.sourceManifests)) {
    // Keep repository defaults, including the unchanged 5000ms test timeout.
    // Full source suites use the repository's supported Bun runner. Node is
    // checked through built portable modules and actual worker/task probes below.
    add(`${role}-full-bun`, 'bun', ['--bun', 'node_modules/vitest/vitest.mjs', 'run'], source.root);
  }
  for (const target of ['typecheck', 'typecheck:redux', 'typecheck:values', 'typecheck:geometry']) add(target, 'bun', ['run', target]);
  for (const config of ['numeric', 'text-search', 'worker']) add(`typecheck-${config}`, 'node', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', `tsconfig.${config}.json`]);
  add('protocol-tests', 'node', ['--test', 'proofs/vector-reservation-tests.node.mjs']);
  add('raw-correctness', 'node', ['proofs/vector-path-reservation.mjs', join(directory, 'raw')]);
  for (const runtime of ['node', 'bun']) {
    add(`portable-public-${runtime}`, runtime, ['proofs/vector-path-reservation-public.mjs', join(directory, 'raw')]);
    add(`packed-public-${runtime}`, runtime, ['proofs/vector-path-reservation-public.mjs', join(directory, 'raw'), build.packages.candidate.root]);
    add(`boundary-${runtime}`, runtime, ['proofs/vector-path-reservation-boundaries.mjs', join(directory, 'raw')]);
    for (const role of ['baseline', 'candidate']) {
      const mode = role === 'candidate' ? 'vector-only' : 'baseline';
      add(`${role}-invariants-${runtime}`, runtime, ['proofs/noop-sequence-invariants.mjs', compared.paths[role], mode]);
      add(`${role}-workers-${runtime}`, runtime, ['proofs/noop-sequence-worker.mjs', compared.paths[role], mode]);
    }
  }
  for (const file of ['worker-tasks.mjs', 'list-query.mjs', 'list-query-regression.mjs', 'memory-startup.mjs']) add(file, 'node', ['--test', `proofs/${file}`]);
  for (const file of ['node-worker.mjs', 'redux-node.mjs', 'typed-json-worker.mjs']) add(file, 'node', [`proofs/${file}`]);
  add('installed-package', 'bun', ['run', 'check:package']);
  add('full-chromium', 'node', ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.browser.config.ts']);
  add('documented-browser-workers', 'node', ['scripts/check-doc-browser.mjs']);
  return rows;
}
export function verifyPackages(build, compared) {
  for (const role of ['baseline', 'candidate']) {
    const item = build.packages[role];
    assert.equal(sha256(readFileSync(item.tarball)), item.tarballSha256, 'Packed archive changed');
    assert.deepEqual(bundleManifest(join(item.root, 'dist/shared.js')), compared.manifests[role]);
    assert.deepEqual(item.manifests, compared.manifests[role]);
    assert.equal(sha256(readFileSync(join(item.root, 'persistent-core.wasm'))), CORE_HASHES[role]);
    for (const runtime of ['node', 'bun']) {
      assert.deepEqual(item.actualImports[runtime].actualCompiledWasm, [CORE_HASHES[role]]);
      assert.equal(item.actualImports[runtime].rows.length, 16);
    }
  }
}
export function verifyPrerequisites(path, buildPath, compared, proofs) {
  const receipt = JSON.parse(readFileSync(path)), build = JSON.parse(readFileSync(buildPath));
  assert.equal(receipt.schema, 'vector-reservation-prerequisites/v1');
  assert.equal(receipt.complete, true, 'All prerequisites must pass in one clean run');
  assert.equal(receipt.buildReceiptSha256, sha256(readFileSync(buildPath)));
  assert.equal(receipt.candidateCommit, compared.candidateCommit);
  assert.deepEqual(receipt.proofs, proofs);
  assert.deepEqual(receipt.commands.map(({ name, executable, args, cwd }) => ({ name, executable, args, cwd })), prerequisitePlan(compared, build, dirname(resolve(path))));
  assert(receipt.commands.every(row => row.status === 0), 'Failed correctness check blocks timing');
  for (const row of receipt.commands) assert.equal(sha256(readFileSync(row.log)), row.logSha256, `Correctness log changed: ${row.name}`);
  verifyPackages(build, compared);
  return receipt;
}
export function runPrerequisites(baseline, candidate, buildPath, output) {
  assert.equal(process.versions.node, '22.23.3', 'Correctness gate requires Node 22.23.3');
  assert.equal(process.arch, 'x64');
  const build = JSON.parse(readFileSync(buildPath));
  assert.equal(build.schema, 'vector-reservation-build/v1');
  assert.deepEqual(build.commands.map(row => [row.role, row.args, row.status]), ['baseline', 'candidate'].flatMap(role => ['build:wasm', 'build:browser', 'build:types'].map(target => [role, ['run', target], 0])));
  const compared = prepareComparison(baseline, candidate), proofs = verifyProofSources(compared.sourceManifests.candidate.root, compared.candidateCommit);
  assert.deepEqual(build.manifests, compared.manifests); assert.deepEqual(build.proofs, proofs);
  verifyPackages(build, compared);
  const directory = dirname(resolve(output)); mkdirSync(join(directory, 'logs'), { recursive: true });
  const receipt = { schema: 'vector-reservation-prerequisites/v1', date: new Date().toISOString(), complete: false,
    candidateCommit: compared.candidateCommit, buildReceiptSha256: sha256(readFileSync(buildPath)), proofs, commands: [] };
  const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n'); save();
  for (const [index, command] of prerequisitePlan(compared, build, directory).entries()) {
    const result = spawnSync(command.executable, command.args, { cwd: command.cwd, encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
    const log = join(directory, 'logs', `${String(index).padStart(2, '0')}-${command.name}.log`);
    writeFileSync(log, `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`);
    receipt.commands.push({ ...command, status: result.status, log, logSha256: sha256(readFileSync(log)) }); save();
    assert.equal(result.status, 0, `Correctness prerequisite failed: ${command.name}; see ${log}`);
  }
  assert.deepEqual(prepareComparison(baseline, candidate), compared);
  assert.deepEqual(verifyProofSources(compared.sourceManifests.candidate.root, compared.candidateCommit), proofs);
  receipt.complete = true; receipt.completed = new Date().toISOString(); save();
  return verifyPrerequisites(output, buildPath, compared, proofs);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, build, output] = process.argv.slice(2); assert(baseline && candidate && build && output);
  runPrerequisites(resolve(baseline), resolve(candidate), resolve(build), resolve(output));
}
