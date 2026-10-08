// Untimed prerequisite receipts and supplementary source-diagnostic inspection.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_COMMIT, CANDIDATE_RUNTIME_COMMIT, sha256 } from './trie-view-source.mjs';

export const WORKER_COMMAND = Object.freeze(['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json']);
export const KNOWN_WORKER_DIAGNOSTICS = JSON.parse(readFileSync(new URL('./trie-view-worker-types.expected.json', import.meta.url)));
export const COMMON_CHECKS = Object.freeze(['build-wasm', 'build-browser', 'build-types', 'typecheck', 'worker-types', 'type-values', 'type-redux', 'type-geometry', 'unit', 'unit-node', 'package', 'node-worker', 'redux-node', 'typed-json-worker', 'actual-workers-node', 'actual-workers-bun']);
export const REQUIRED_CHECKS = Object.freeze([
  ...['baseline', 'candidate'].flatMap(build => COMMON_CHECKS.map(name => `${build}/${name}`)),
  'candidate/mechanism', 'candidate/protocol-tests',
  ...['runtime', 'install', 'baseline-worktree', 'sources', 'compilers', 'exact-builds'].map(name => `gate/${name}`),
]);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const saveJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

export function parseWorkerDiagnostics(output, source) {
  const diagnostics = [];
  for (const line of output.replaceAll('\r\n', '\n').split('\n')) {
    if (!line) continue;
    const match = /^([^()]+)\(([1-9][0-9]*),([1-9][0-9]*)\): error (TS[0-9]+): (.+)$/.exec(line);
    if (match) {
      const [, file, row, column, code, message] = match;
      assert(['arena.ts', 'redux-jsan.ts'].includes(file), `Unexpected diagnostic file: ${file}`);
      const lines = source(file).split(/\r?\n/), sourceLine = lines[Number(row) - 1];
      assert.equal(typeof sourceLine, 'string', 'Diagnostic source line missing');
      diagnostics.push({ file, line: Number(row), column: Number(column), code, message, sourceLine });
    } else {
      assert(diagnostics.length && /^  \S/.test(line), `Unparsed compiler output: ${line}`);
      diagnostics.at(-1).message += '\n' + line;
    }
  }
  return diagnostics;
}
export function diagnosticIdentity(diagnostics) {
  // Preserve multiplicity, column and exact source text; only numeric row is
  // omitted because the reviewed capture inserts lines above existing errors.
  return diagnostics.map(({ line, ...identity }) => identity)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function workerSourceOutcome(status, output, source) {
  assert.equal(status, 2, 'Known worker source diagnostics require compiler exit 2');
  const diagnostics = parseWorkerDiagnostics(output, source);
  assert.deepEqual(diagnosticIdentity(diagnostics), diagnosticIdentity(KNOWN_WORKER_DIAGNOSTICS), 'Worker source diagnostics differ from the exact baseline');
  return { outcome: 'known-diagnostic-parity', compilerPass: false, diagnostics };
}
export function validatePrerequisites(directory, requireCompleted = true) {
  const path = join(directory, 'prerequisites.json'), data = readJson(path);
  assert.equal(data.status, requireCompleted ? 'completed' : 'partial');
  assert.equal(data.baseline, BASELINE_COMMIT); assert.equal(data.candidate, CANDIDATE_RUNTIME_COMMIT);
  assert.deepEqual(data.checks.map(c => `${c.build}/${c.name}`).sort(), [...REQUIRED_CHECKS].sort(), 'Missing, extra or duplicated prerequisites');
  for (const check of data.checks) {
    const key = `${check.build}/${check.name}`;
    assert.equal(typeof check.log, 'string'); assert(!check.log.startsWith('/') && !check.log.split('/').includes('..'));
    const bytes = readFileSync(join(directory, check.log)); assert.equal(sha256(bytes), check.sha256, `Prerequisite log changed ${key}`);
    assert.equal(check.signal, null); assert.equal(check.error, null);
    assert.equal(typeof check.finished, 'string');
    assert.equal(check.status, 0, `Failed prerequisite ${key}`);
    assert.equal(check.outcome, 'pass');
  }
  return { ...data, manifestSha256: sha256(readFileSync(path)) };
}
export function runCheck(evidence, build, name, cwd, command, args) {
  assert.match(build, /^(baseline|candidate|gate)$/); assert.match(name, /^[a-z0-9-]+$/);
  assert(REQUIRED_CHECKS.includes(`${build}/${name}`), 'Unregistered prerequisite');
  const manifestPath = join(evidence, 'prerequisites.json'), manifest = readJson(manifestPath);
  Object.assign(manifest, { schema: 2, status: 'partial', baseline: BASELINE_COMMIT, candidate: CANDIDATE_RUNTIME_COMMIT,
    gateCommit: process.env.GITHUB_SHA ?? null, runtime: process.env.PROOF_RUNTIME ?? null });
  assert(!manifest.checks.some(check => check.build === build && check.name === name), 'Prerequisite checks cannot be retried or overwritten');
  const log = `logs/${build}-${name}.log`, path = join(evidence, log), started = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const check = { build, name, cwd: resolve(cwd), command: [command, ...args], status: null, outcome: 'pending', log, sha256: null, started, finished: null, signal: null, error: null };
  manifest.checks.push(check); saveJson(manifestPath, manifest);
  writeFileSync(path, JSON.stringify({ build, name, cwd: check.cwd, command: check.command, started }) + '\n');
  let accepted = false;
  try {
    const fd = openSync(path, 'a');
    let result;
    try { result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    Object.assign(check, { status: result.status, signal: result.signal ?? null, error: result.error ? String(result.error) : null });
    assert.equal(check.signal, null); assert.equal(check.error, null);
    assert.equal(check.status, 0, `Failed prerequisite ${build}/${name}`); check.outcome = 'pass';
    accepted = true;
  } catch (error) {
    check.outcome = 'failed'; check.validationError = String(error.stack ?? error);
  } finally {
    check.sha256 = sha256(readFileSync(path)); check.finished = new Date().toISOString(); saveJson(manifestPath, manifest);
    process.stdout.write(readFileSync(path));
    if (check.validationError) process.stderr.write(check.validationError + '\n');
  }
  return accepted;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, evidence, build, name, cwd, command, ...args] = process.argv.slice(2);
  if (mode === 'check') process.exitCode = runCheck(evidence, build, name, cwd, command, args) ? 0 : 1;
  else if (mode === 'seal') {
    validatePrerequisites(evidence, false);
    const path = join(evidence, 'prerequisites.json'), receipt = readJson(path);
    receipt.status = 'completed'; receipt.finished = new Date().toISOString(); saveJson(path, receipt);
    validatePrerequisites(evidence); console.log('All required prerequisites passed, including post-declaration public worker consumers.');
  } else throw new Error('Usage: trie-view-prerequisites.mjs check EVIDENCE BUILD NAME CWD COMMAND ...ARGS | seal EVIDENCE');
}
