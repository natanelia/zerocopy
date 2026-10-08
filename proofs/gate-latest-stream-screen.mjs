// Run once before any pilot. Failed full unit CI prevents all measurements.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, realpathSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocol } from './latest-stream-screen-protocol.mjs';
import { pinnedGuard, sha256, proofFingerprint, compilerContext, createEvidenceDirectory } from './latest-stream-screen-guard.mjs';
const [baseline, candidate, directory] = process.argv.slice(2);
assert(baseline && candidate && directory, 'Usage: node proofs/gate-latest-stream-screen.mjs BASE_ROOT CANDIDATE_ROOT OUTPUT');
assert.equal(process.versions.node, protocol.toolchain.node); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
const proofRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), roots = { baseline: resolve(baseline), candidate: resolve(candidate) };
const out = resolve(directory); createEvidenceDirectory(out);
assert(process.env.BUN_EXECUTABLE, 'BUN_EXECUTABLE is required');
const bun = realpathSync(process.env.BUN_EXECUTABLE);
const version = spawnSync(bun, ['--version'], { encoding: 'utf8' }); assert.equal(version.status, 0); assert.equal(version.stdout.trim(), protocol.toolchain.bun);
const revision = spawnSync(bun, ['--revision'], { encoding: 'utf8' }); assert.equal(revision.status, 0); assert.equal(revision.stdout.trim(), protocol.toolchain.bunRevision);
const compilers = compilerContext(roots.baseline); assert.deepEqual(compilerContext(roots.candidate), compilers);
const receipt = { status: 'running', node: process.versions.node, bun: version.stdout.trim(), bunRevision: revision.stdout.trim(), compilers, checks: [], sources: pinnedGuard(proofRoot, roots.baseline, roots.candidate), proofs: proofFingerprint(proofRoot), strictWorkerTypecheck: null };
const save = () => writeFileSync(join(out, 'gate.json'), JSON.stringify(receipt, null, 2) + '\n');
function check(variant, name, executable, args, cwd, timeout = 900000) {
  const log = join(out, `${variant}-${name}.log`), fd = openSync(log, 'wx');
  let child;
  try { child = spawnSync(executable, args, { cwd, stdio: ['ignore', fd, fd], timeout }); } finally { closeSync(fd); }
  const row = { variant, name, executable, args, cwd, status: child.status, signal: child.signal, error: child.error?.message ?? null, log, logSha256: sha256(readFileSync(log)) };
  receipt.checks.push(row); save(); return row;
}
function required(...args) { const row = check(...args); assert.equal(row.status, 0, `Required check failed: ${row.variant}/${row.name}; ${row.log}`); assert.equal(row.signal, null); return row; }
try {
  for (const [variant, root] of Object.entries(roots)) {
    required(variant, 'typecheck', bun, ['run', 'typecheck'], root);
    // Supplementary only: missing declarations select source files with different strictness.
    check(variant, 'pre-declaration-worker-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json'], root);
    required(variant, 'build:types', bun, ['run', 'build:types'], root);
    for (const name of ['typecheck:redux', 'typecheck:values', 'typecheck:geometry']) required(variant, name, bun, ['run', name], root);
    required(variant, 'public-worker-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json'], root);
    required(variant, 'full-unit', bun, ['run', 'test'], root);
    required(variant, 'node-worker', process.execPath, ['proofs/node-worker.mjs'], root);
    required(variant, 'worker-tasks', process.execPath, ['--test', 'proofs/worker-tasks.mjs'], root);
    required(variant, 'worker-sessions', process.execPath, ['proofs/worker-sessions.mjs'], root);
    required(variant, 'typed-json-worker', process.execPath, ['proofs/typed-json-worker.mjs'], root);
  }
  const preDeclaration = receipt.checks.filter(c => c.name === 'pre-declaration-worker-types');
  receipt.preDeclarationWorkerTypecheck = { supplementaryOnly: true, matchingDiagnostics: preDeclaration[0].logSha256 === preDeclaration[1].logSha256,
    matchesHistoricalDiagnostics: preDeclaration.every(c => c.status === 2 && c.signal === null && c.logSha256 === protocol.pins.preDeclarationWorkerDiagnostics) };
  receipt.strictWorkerTypecheck = { disposition: 'built-public-consumers-passed', diagnosticCount: 0, passed: true };
  const verification = required('both', 'stream-correctness', process.execPath, ['proofs/run-latest-stream-screen.mjs', roots.baseline, roots.candidate, join(out, 'stream-correctness'), '--verify'], proofRoot);
  for (const variant of ['baseline', 'candidate']) receipt.checks.push({ ...verification, variant });
  assert.deepEqual(pinnedGuard(proofRoot, roots.baseline, roots.candidate), receipt.sources);
  assert.deepEqual(proofFingerprint(proofRoot), receipt.proofs, 'Protocol changed during correctness gate');
  for (const root of Object.values(roots)) assert.deepEqual(compilerContext(root), compilers);
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error.stack; throw error; }
finally { save(); }
