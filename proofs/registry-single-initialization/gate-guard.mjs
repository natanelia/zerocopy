import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, manifest } from '../worker-arena-source-guard.mjs';
import { captureBuilds, verifyPrimaryBytes } from './preflight-guard.mjs';
import { treeManifest } from './package-tools.mjs';
import { protocol, stageDecision } from './protocol.mjs';
export const frozen = JSON.parse(readFileSync(new URL('./frozen-pins.json', import.meta.url)));
export const workflowPath = '.github/workflows/registry-single-initialization-gate.yml';
export const protocolHash = () => sha256(readFileSync(new URL('./gate.json', import.meta.url)));
export const pinsHash = () => sha256(readFileSync(new URL('./frozen-pins.json', import.meta.url)));
export function verifyFrozenDeclaration() {
  assert.equal(frozen.passed, true);
  assert.equal(frozen.sourceBuildWasmCompilerProofBytesVerified, true, 'Preflight artifact bytes must be independently verified before use');
  assert.equal(frozen.proofCommit, protocol.preflight.commit);
  assert.equal(frozen.proofTree, protocol.preflight.tree);
  assert.equal(frozen.runId, protocol.preflight.run);
  for (const role of protocol.variants) assert.equal(frozen.pins[role], protocol.pins[role]);
}
export function verifyTools(actual, arch) {
  verifyFrozenDeclaration();
  assert.deepEqual(actual, frozen.toolsByArchitecture[arch], 'Exact Node/Bun/compiler identities must match reviewed Node22 preflight');
}
export function captureTools(proofRoot, nodeExecutable, bunExecutable) {
  const node = realpathSync(nodeExecutable), bun = realpathSync(bunExecutable);
  const asc = join(proofRoot, 'node_modules/assemblyscript');
  const ts = join(proofRoot, 'node_modules/typescript');
  return {
    node: { version: process.versions.node, sha256: sha256(readFileSync(node)), versions: process.versions },
    bun: { version: execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(), sha256: sha256(readFileSync(bun)), revision: execFileSync(bun, ['--revision'], { encoding: 'utf8' }).trim() },
    assemblyscript: { version: JSON.parse(readFileSync(join(asc, 'package.json'))).version, packageSha256: sha256(readFileSync(join(asc, 'package.json'))), compilerSha256: sha256(readFileSync(join(asc, 'dist/asc.js'))) },
    typescript: { version: JSON.parse(readFileSync(join(ts, 'package.json'))).version, packageSha256: sha256(readFileSync(join(ts, 'package.json'))), compilerSha256: sha256(readFileSync(join(ts, 'lib/typescript.js'))) },
  };
}
export function verifyBuildStates(states) {
  verifyFrozenDeclaration();
  for (const role of protocol.variants) {
    const s = states[role];
    assert.equal(s.commit, protocol.pins[role]);
    assert.equal(s.sourceDirty, false);
    assert.deepEqual({ source: s.source.sha256, emittedJs: s.build.sha256, wasm: s.wasm.sha256, completeDist: s.completeDist.sha256 }, frozen.builds[role], role + ' exact source/WASM/JS/complete distribution changed');
  }
  return states;
}
export function proofSnapshot(proofRoot) {
  return { files: treeManifest(join(proofRoot, 'proofs/registry-single-initialization')),
    workflow: manifest(proofRoot, [workflowPath]),
    dependencies: manifest(proofRoot, ['proofs/worker-arena-source-guard.mjs', 'proofs/worker-arenas.mjs', 'proofs/node-worker.mjs', 'proofs/typed-json-worker.mjs', 'proofs/worker-sessions.mjs']) };
}
export function verifyProofRoot(proofRoot, env = process.env) {
  verifyFrozenDeclaration();
  const git = args => execFileSync('git', args, { cwd: proofRoot, encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GITHUB_REF, 'refs/heads/' + protocol.branch);
  assert.equal(env.GITHUB_SHA, commit);
  assert.deepEqual(git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).slice(1), [protocol.runtimeParent]);
  assert.equal(git(['rev-parse', protocol.runtimeParent + '^{tree}']), protocol.runtimeTree);
  const changed = git(['diff', '--name-only', protocol.runtimeParent, 'HEAD']).split('\n').filter(Boolean);
  assert(changed.length && changed.every(p => p.startsWith('proofs/registry-single-initialization/') || [workflowPath, '.github/workflows/registry-single-initialization-preflight.yml'].includes(p)));
  assert.equal(git(['diff', 'HEAD', '--name-only']), '', 'Tracked proof checkout is dirty');
  assert.equal(git(['ls-files', '--others', '--exclude-standard', '--', 'proofs/registry-single-initialization', workflowPath]), '', 'Untracked proof input');
  assert.deepEqual(verifyPrimaryBytes(proofRoot), frozen.originalSubject);
  assert.equal(sha256(readFileSync(join(proofRoot, 'proofs/registry-single-initialization/owned-subject.mjs'))), frozen.ownedSubject.sha256, 'Owned control differs from successful preflight bytes');
  return { commit, snapshot: proofSnapshot(proofRoot), protocolSha256: protocolHash(), pinsSha256: pinsHash() };
}
export function verifyCurrentInputs(roots, proofRoot, arch, node, bun) {
  const proof = verifyProofRoot(proofRoot), tools = captureTools(proofRoot, node, bun);
  verifyTools(tools, arch);
  const states = verifyBuildStates(captureBuilds(roots));
  return { proof, tools, states };
}
export function verifyPreparation(summary, guard, arch) {
  assert.equal(summary.status, 'passed-gate-prerequisites-no-timings');
  assert.equal(summary.mode, 'gate-prerequisites-only');
  assert.equal(summary.integrityComplete, true);
  assert.equal(summary.host.arch, arch);
  assert.equal(summary.proofCommit, guard.proof.commit);
  assert.equal(summary.gateProtocolSha256, protocolHash());
  assert.equal(summary.frozenPinsSha256, pinsHash());
  assert.deepEqual(summary.tools, guard.tools);
  assert.deepEqual(summary.buildsAfter, guard.states);
  assert.equal(summary.pilotSubjects, 0); assert.equal(summary.measuredSubjects, 0);
  assert(summary.invocations.length > 0 && summary.invocations.every(i => i.status === 'completed' && i.exitStatus === 0));
  assert.equal(summary.fixtureResults.length, 9);
  assert(summary.fixtureResults.every(f => f.result.phase === 'correctness' && !f.result.calibration.length && !f.result.warmup.length && !f.result.measured.length));
  assert(summary.inputRetention.length === 3 && summary.inputRetention.every(i => i.errors.length === 0));
  assert.equal(summary.mapProbes.passed, true, 'Separate untimed Map/topology/lifetime probes are prerequisites');
}
export function verifyStageOne(report, proofCommit, runId) {
  assert.equal(report.stage, 1); assert.equal(report.arch, 'arm64');
  assert.equal(report.status, 'completed'); assert.equal(report.integrityComplete, true);
  assert.equal(report.proofCommit, proofCommit); assert.equal(report.runner.GITHUB_RUN_ID, runId);
  assert.equal(report.protocolSha256, protocolHash()); assert.equal(report.frozenPinsSha256, pinsHash());
  assert.equal(report.measuredSubjects, protocol.stageBudgets[1]);
  const decision = stageDecision(report.rows, 1, { runComplete: true, integrityComplete: true });
  assert.deepEqual(decision, report.decision, 'Stage1 gate decision must recompute exactly');
  assert.equal(decision.stage2Permitted, true, 'ARM gate did not permit x64');
  return decision;
}
