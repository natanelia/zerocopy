// Explicit Node discovery only. These tests do not run the performance workload.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protocol, scheduleCase, variantFor, interval, summarizeCase, applyRunIntegrity } from './latest-stream-screen-protocol.mjs';
import { treeManifest, sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment, sha256, verifyPinnedSnapshot, verifyGate, requiredGateChecks, createEvidenceDirectory } from './latest-stream-screen-guard.mjs';
import { readSubjectLog } from './run-latest-stream-screen.mjs';
import { archiveEvidence } from './archive-latest-stream-screen-evidence.mjs';

test('scope, toolchain, caps and margin are frozen', () => {
  assert.deepEqual(protocol.cases.map(x => [x.copy, x.consumer, x.streams, x.updates]), [[false, 'paused', 1, 32], [true, 'paused', 1, 32], [false, 'paused', 4, 4096], [true, 'paused', 4, 4096], [false, 'waiting', 4, 4096], [true, 'waiting', 4, 4096]]);
  assert.equal(protocol.toolchain.node, '22.23.3'); assert.equal(protocol.toolchain.arch, 'x64'); assert.equal(protocol.minimumBatchMs, 20);
  assert.equal(protocol.quartetsPerMode, 4); assert.equal(protocol.degreesOfFreedom, 3); assert.equal(protocol.latencyMargin, 1.02);
  assert.equal(protocol.warmupBatches, 2); assert.equal(protocol.samples, 7); assert.equal(protocol.pilotMaxSteps, 8); assert.equal(protocol.maxRepeats, 256);
});
test('all six deterministic schedules balance orientations, adjacent-pair order and mode-first positions', () => {
  for (let index = 0; index < 6; index++) {
    const schedule = scheduleCase(protocol.seed + index); assert.deepEqual(schedule, scheduleCase(protocol.seed + index)); assert.equal(schedule.length, 8);
    for (const mode of protocol.modes) {
      const blocks = schedule.filter(b => b.mode === mode); assert.equal(blocks.length, 4);
      assert.equal(blocks.filter(b => b.order === 'ABBA').length, 2); assert.equal(blocks.filter(b => b.order === 'BAAB').length, 2);
      assert.equal(schedule.filter((b, n) => n % 2 === 0 && b.mode === mode).length, 2);
      assert.equal(blocks.flatMap(b => [b.roles[0], b.roles[2]]).filter(r => r === 'A').length, 4);
    }
  }
  assert.deepEqual(['A', 'B'].map(r => variantFor('ab', r)), ['baseline', 'candidate']);
  assert.deepEqual(['A', 'B'].map(r => variantFor('aa-baseline', r)), ['baseline', 'baseline']);
  assert.throws(() => variantFor('bad', 'A'));
});
test('df3 interval uses quartet logs with two-sided t and exact control drift condition', () => {
  const known = interval([-.02, -.01, .01, .02]); assert.equal(known.ratio, 1);
  assert(Math.abs(known.standardError - Math.sqrt(.001 / 3 / 4)) < 1e-14);
  assert(Math.abs(known.ci95[1] - Math.exp(3.182446305284263 * known.standardError)) < 1e-14);
  assert.equal(interval(Array(4).fill(Math.log(1.04))).materialRoleDrift, true);
  assert.equal(interval(Array(4).fill(Math.log(.96))).materialRoleDrift, true);
  assert.equal(interval(Array(4).fill(Math.log(1.015))).materialRoleDrift, false);
  assert.equal(interval([.8, 1.2, 1.3, .9].map(Math.log)).materialRoleDrift, false);
  assert.equal(interval(Array(4).fill(Math.log(.96))).classification, 'material-improvement-signal');
  assert.equal(interval(Array(4).fill(Math.log(1.04))).classification, 'material-slowdown-signal'); assert.throws(() => interval(Array(8).fill(0)));
});
const synthetic = ({ aa = 1, short = false } = {}) => scheduleCase(protocol.seed).map(planned => ({ ...planned, subjects: planned.roles.map(role => {
  const ms = 40 * (role === 'A' ? 1 : planned.mode === 'ab' ? .97 : aa);
  const batch = n => ({ repeat: 1, elapsedMs: short && n === 0 ? 19 : ms, msPerBurst: ms });
  return { role, result: { warmup: [batch(0), batch(1)], measured: Array.from({ length: 7 }, (_, i) => batch(i + 2)) } };
}) }));
test('A/A drift, short batches and caps invalidate without adjusting raw A/B', () => {
  assert.equal(summarizeCase(synthetic()).inferenceValid, true);
  for (const aa of [.96, 1.04]) {
    const s = summarizeCase(synthetic({ aa })); assert.equal(s.inferenceValid, false); assert(s.invalidationReasons.includes('aa-baseline-material-role-drift'));
    assert(Math.abs(s.arms.ab.inference.ratio - .97) < 1e-14); assert.equal(s.arms.ab.pairs.length, 8);
  }
  assert.equal(summarizeCase(synthetic({ short: true })).inferenceValid, false);
  assert.equal(summarizeCase(synthetic(), { baseline: { result: { capped: true } } }).inferenceValid, false);
  assert.equal(summarizeCase(synthetic().slice(0, -1)).inferenceValid, false);
});
test('incomplete final integrity cannot report a valid result', () => {
  const summary = summarizeCase(synthetic());
  for (const state of [{ status: 'running' }, { status: 'failed', integrityComplete: true }, { status: 'completed', integrityComplete: false }]) {
    const result = applyRunIntegrity(summary, state); assert.equal(result.inferenceValid, false); assert.deepEqual(result.arms, summary.arms);
  }
  assert.equal(applyRunIntegrity(summary, { status: 'completed', integrityComplete: true }).inferenceValid, true);
});
test('frozen production worker, tests and mechanism proof remain unchanged', () => {
  assert.equal(sha256(readFileSync(new URL('../worker.ts', import.meta.url))), protocol.pins.workerSource.candidate);
  assert.equal(sha256(readFileSync(new URL('../worker.test.ts', import.meta.url))), protocol.pins.candidateTests);
  const baseline = execFileSync('git', ['show', `${protocol.pins.baseline}:worker.ts`]); assert.equal(sha256(baseline), protocol.pins.workerSource.baseline);
  const diff = execFileSync('git', ['diff', protocol.pins.baseline, protocol.pins.candidate, '--', 'worker.ts'], { encoding: 'utf8' });
  assert.equal(diff.split('\n').filter(line => /^\+[^+]/.test(line)).length, 3); assert.equal(diff.split('\n').filter(line => /^-[^-]/.test(line)).length, 3);
});
test('public one-build kernel uses lossless normal transport and disables clocks in verify mode', () => {
  const source = readFileSync(new URL('./latest-stream-screen-subject.mjs', import.meta.url), 'utf8');
  assert(source.includes("await import('zerocopy')")); assert(source.includes("await import('zerocopy/worker')"));
  assert(source.includes("delivery: 'all', maxPending: workload.updates")); assert(source.includes('reader.snapshots()'));
  assert(source.includes("const timed = phase !== 'verify'")); assert(source.includes('const endNs = timed ? clock().toString() : null'));
  assert(source.includes('await arrived;')); assert(source.includes('await readers;'));
  assert(!source.includes('__streamProof')); assert(!source.includes('instrument')); assert(!source.includes('candidate')); assert(!source.includes('baseline'));
});
test('neutral package preserves original metadata, replaces stale chunks and rejects mutations and symlinks', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stream-source-test-')));
  try {
    const packageBytes = '{"name":"zerocopy","type":"module","custom":"preserved","exports":{".":"./dist/shared.js"}}\n';
    const fixture = (name, chunk) => {
      const path = join(root, name); mkdirSync(join(path, 'dist'), { recursive: true });
      writeFileSync(join(path, 'package.json'), packageBytes); writeFileSync(join(path, 'dist/shared.js'), `export{v}from'./${chunk}.js'`);
      writeFileSync(join(path, `dist/${chunk}.js`), 'export const v=1;'); return sourceContext(path);
    };
    const a = fixture('a', 'chunk-a'), b = fixture('b', 'chunk-b'), target = join(root, 'subject');
    const first = stageCanonical(a, target, '// synthetic'); checkAfterSubject(a, target, first);
    const second = stageCanonical(b, target, '// synthetic'); checkAfterSubject(b, target, second);
    assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), packageBytes); assert(!existsSync(join(target, 'dist/chunk-a.js')));
    writeFileSync(join(target, 'dist/chunk-b.js'), 'changed'); assert.throws(() => checkAfterSubject(b, target, second), /changed during subject/);
    symlinkSync(join(b.dist, 'shared.js'), join(b.dist, 'link.js')); assert.throws(() => treeManifest(b.dist), /Symlink forbidden/);
    writeFileSync(join(a.root, 'package.json'), '{}'); assert.throws(() => stageCanonical(a, target, '// synthetic'), /Source package changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('source receipts detect runtime mutations and extra untracked production input', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stream-receipt-test-')));
  try {
    mkdirSync(join(root, 'scripts')); writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'worker.ts'), 'original');
    const runtime = { 'package.json': sha256('{}'), 'worker.ts': sha256('original') };
    const snapshot = { root, files: runtime, runtime }; verifyPinnedSnapshot(snapshot);
    writeFileSync(join(root, 'extra.ts'), 'export{}'); assert.throws(() => verifyPinnedSnapshot(snapshot), /Runtime inputs changed/);
    rmSync(join(root, 'extra.ts')); writeFileSync(join(root, 'worker.ts'), 'changed'); assert.throws(() => verifyPinnedSnapshot(snapshot), /Pinned source changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('incomplete or mismatched full-unit gates cannot authorize timing', () => {
  assert.throws(() => verifyGate({ status: 'failed' }, {}), /Full unit CI gate/);
  const comparison = { baseline: { hash: 'a' }, candidate: { hash: 'b' } };
  const proofs = { subject: 'hash' };
  const receipt = { status: 'passed', node: protocol.toolchain.node, bun: protocol.toolchain.bun, bunRevision: protocol.toolchain.bunRevision, compilers: protocol.pins.compilers, sources: comparison, proofs, checks: [] };
  assert.throws(() => verifyGate(receipt, comparison, proofs), /Missing successful/);
  for (const variant of ['baseline', 'candidate']) for (const name of requiredGateChecks) receipt.checks.push({ variant, name, status: 0, signal: null, logSha256: 'digest' });
  receipt.strictWorkerTypecheck = { disposition: 'built-public-consumers-passed', diagnosticCount: 0, passed: true }; verifyGate(receipt, comparison, proofs);
  assert.throws(() => verifyGate(receipt, comparison, { subject: 'changed' }), /Protocol\/kernel changed/);
  const publicTypes = receipt.checks.find(c => c.name === 'public-worker-types');
  publicTypes.status = 2;
  receipt.preDeclarationWorkerTypecheck = { supplementaryOnly: true, matchingDiagnostics: true, matchesHistoricalDiagnostics: true };
  assert.throws(() => verifyGate(receipt, comparison, proofs), /public-worker-types/);
  publicTypes.status = 0;
  receipt.strictWorkerTypecheck = { disposition: 'identical-known-baseline-diagnostics', diagnosticCount: 12, passed: false };
  assert.throws(() => verifyGate(receipt, comparison, proofs));
  receipt.strictWorkerTypecheck = { disposition: 'built-public-consumers-passed', diagnosticCount: 0, passed: true };
  assert.throws(() => verifyGate({ ...receipt, compilers: {} }, comparison, proofs), /compiler pins/);
  receipt.checks.push({ ...publicTypes }); assert.throws(() => verifyGate(receipt, comparison, proofs), /public-worker-types/); receipt.checks.pop();
  receipt.checks.find(c => c.name === 'full-unit').status = 1; assert.throws(() => verifyGate(receipt, comparison, proofs), /full-unit/);
});
test('subject environment strips labels, credentials and optimizer overrides', () => {
  assert.deepEqual(cleanEnvironment({ PATH: '/bin', HOME: '/tmp', NODE_OPTIONS: '--jitless', GITHUB_SHA: 'label', VARIANT: 'B', SECRET_TOKEN: 'secret' }), { PATH: '/bin', HOME: '/tmp', NODE_DISABLE_COMPILE_CACHE: '1' });
});
test('independent trace verifier rejects coalesced transport masquerading as full work', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-trace-test-')), path = join(root, 'trace.ndjson');
  try {
    const trace = index => ({ id: index, startVersion: index * 2, retainedInitialValid: true, delivered: [index * 2 + 1, index * 2 + 2], deliveredValues: [1, 0], consumed: [[index * 2 + 2]], consumedValues: [[0]], initialConsumed: [], overwritten: { initialVersion: index * 2, updateVersions: [index * 2 + 1], perStreamCount: 2 }, elapsedMs: null, startNs: null, endNs: null, completionNs: null });
    const request = { phase: 'verify', config: {}, workload: { updates: 2, streams: 1, consumer: 'paused' } };
    const events = [{ event: 'start', metadata: {}, request }, { event: 'setup', metadata: {} }, ...[0, 1].map(n => ({ event: 'round', kind: 'verify', index: 0, repetition: n, trace: trace(n) })), { event: 'batch', kind: 'verify', index: 0, row: { repeat: 2, elapsedMs: null, msPerBurst: null } }, { event: 'result', result: { phase: 'verify', verified: true, rounds: 2 } }];
    const save = () => writeFileSync(path, events.map(x => JSON.stringify(x)).join('\n'));
    save(); assert.equal(readSubjectLog(path, request).traceRounds, 2);
    assert.throws(() => readSubjectLog(path, { ...request, phase: 'measure' }), /differs from controller plan/);
    events[0].request.workload.updates = 4096; save(); assert.throws(() => readSubjectLog(path));
    events[0].request.workload.updates = 2; events[2].trace.overwritten.updateVersions = []; save(); assert.throws(() => readSubjectLog(path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('terminal self-reported partial samples do not satisfy the controller plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-partial-test-')), path = join(root, 'trace.ndjson');
  try {
    const request = { phase: 'measure', repeat: 1, config: { warmupBatches: 2, samples: 7 }, workload: { updates: 2, streams: 1, consumer: 'paused' } };
    const row = { repeat: 1, elapsedMs: .001, msPerBurst: .001 };
    const events = [{ event: 'start', metadata: {}, request }, { event: 'setup', metadata: {} }, { event: 'result', result: { phase: 'measure', repeat: 1, warmup: [row, row], measured: Array(6).fill(row), rounds: 0 } }];
    writeFileSync(path, events.map(x => JSON.stringify(x)).join('\n')); assert.throws(() => readSubjectLog(path, request));
    events.at(-1).result.measured.push(row); writeFileSync(path, events.map(x => JSON.stringify(x)).join('\n')); assert.throws(() => readSubjectLog(path, request), /round/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('complete synthetic timed batches are recomputed and inconsistent summaries are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-totals-test-')), path = join(root, 'trace.ndjson');
  try {
    const request = { phase: 'measure', repeat: 1, config: { warmupBatches: 2, samples: 7 }, workload: { updates: 2, streams: 1, consumer: 'paused' } };
    const row = { repeat: 1, elapsedMs: 40, msPerBurst: 40 };
    const events = [{ event: 'start', metadata: {}, request }, { event: 'setup', metadata: {} }];
    for (let id = 0; id < 9; id++) {
      const kind = id < 2 ? 'warmup' : 'measured', index = id < 2 ? id : id - 2, startVersion = id * 2;
      const trace = { id, startVersion, retainedInitialValid: true, delivered: [startVersion + 1, startVersion + 2], deliveredValues: [1, 0], consumed: [[startVersion + 2]], consumedValues: [[0]], initialConsumed: [], overwritten: { initialVersion: startVersion, updateVersions: [startVersion + 1], perStreamCount: 2 }, elapsedMs: 40, startNs: '100000000', endNs: '140000000', completionNs: '150000000' };
      events.push({ event: 'round', kind, index, repetition: 0, trace }, { event: 'batch', kind, index, row });
    }
    events.push({ event: 'result', result: { phase: 'measure', repeat: 1, warmup: [row, row], measured: Array(7).fill(row), rounds: 9 } });
    const save = () => writeFileSync(path, events.map(x => JSON.stringify(x)).join('\n'));
    save(); assert.equal(readSubjectLog(path, request).traceRounds, 9);
    events[3].row = { ...row, elapsedMs: 39 }; save(); assert.throws(() => readSubjectLog(path, request));
    events[3].row = row; events[2].trace.endNs = '160000000'; save(); assert.throws(() => readSubjectLog(path, request));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a capped pilot retains its last sampled repeat rather than an untested next count', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-cap-test-')), path = join(root, 'trace.ndjson');
  try {
    const request = { phase: 'pilot', config: { pilotMaxSteps: 1, pilotSamples: 3, pilotTargetMs: 30, maxRepeats: 256 }, workload: { updates: 2, streams: 1, consumer: 'paused' } };
    const row = { repeat: 1, elapsedMs: 1, msPerBurst: 1 };
    const events = [{ event: 'start', metadata: {}, request }, { event: 'setup', metadata: {} }];
    for (let id = 0; id < 5; id++) {
      const kind = id < 2 ? 'pilot-warmup' : 'pilot', index = id < 2 ? id : id - 2, startVersion = id * 2;
      const trace = { id, startVersion, retainedInitialValid: true, delivered: [startVersion + 1, startVersion + 2], deliveredValues: [1, 0], consumed: [[startVersion + 2]], consumedValues: [[0]], initialConsumed: [], overwritten: { initialVersion: startVersion, updateVersions: [startVersion + 1], perStreamCount: 2 }, elapsedMs: 1, startNs: '100000000', endNs: '101000000', completionNs: '110000000' };
      events.push({ event: 'round', kind, index, repetition: 0, trace }, { event: 'batch', kind, index, row });
    }
    const result = { phase: 'pilot', repeat: 1, capped: true, warmup: [row, row], calibration: [{ repeat: 1, samples: [row, row, row] }], rounds: 5 };
    events.push({ event: 'result', result });
    const save = () => writeFileSync(path, events.map(x => JSON.stringify(x)).join('\n'));
    save(); assert.equal(readSubjectLog(path, request).result.capped, true);
    result.repeat = 30; save(); assert.throws(() => readSubjectLog(path, request));
    assert(readFileSync(new URL('./latest-stream-screen-subject.mjs', import.meta.url), 'utf8').includes('repeat = calibration.at(-1).repeat;'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('evidence output creation rejects both partial and completed existing directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-evidence-test-')), output = join(root, 'results');
  try {
    createEvidenceDirectory(output); writeFileSync(join(output, 'results.json'), 'retained');
    assert.throws(() => createEvidenceDirectory(output), /EEXIST/);
    assert.equal(readFileSync(join(output, 'results.json'), 'utf8'), 'retained');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('evidence archive lists and round-trips colon paths, hidden files and nested raw bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-archive-test-'));
  try {
    const source = join(root, 'evidence'), output = join(root, 'upload'), extracted = join(root, 'extracted');
    const files = {
      'gate/baseline-build:types.log': Buffer.from('declaration output\r\n\0unmodified\n'),
      '.hidden-receipt': Buffer.from('include hidden evidence\n'),
      'measurements/case-0/raw/subject:0.ndjson': Buffer.from('{"event":"round"}\n{"event":"partial"'),
      'measurements/case-0/raw/trace.bin': Buffer.from([0, 1, 13, 10, 127, 128, 254, 255]),
    };
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), bytes);
    }
    mkdirSync(join(source, 'empty')); mkdirSync(extracted);
    const before = treeManifest(source), packaged = archiveEvidence(source, output);
    const listed = execFileSync('tar', ['-tzf', packaged.archive], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(listed, ['.', ...before.entries.map(row => row.path)].map(path => path === '.' ? './' : `./${path}`).sort());
    assert.equal(readFileSync(packaged.checksum, 'utf8'), `${sha256(readFileSync(packaged.archive))}  stream-screen.tar.gz\n`);
    execFileSync('sha256sum', ['--check', 'stream-screen.tar.gz.sha256'], { cwd: output });
    execFileSync('tar', ['-xzf', packaged.archive, '-C', extracted]);
    assert.deepEqual(treeManifest(extracted), before);
    for (const [path, bytes] of Object.entries(files)) assert.deepEqual(readFileSync(join(extracted, path)), bytes);
    assert.deepEqual(treeManifest(source), before, 'Packaging must not mutate evidence');
    const archivedBytes = readFileSync(packaged.archive);
    assert.throws(() => archiveEvidence(source, output), /EEXIST/);
    assert.deepEqual(readFileSync(packaged.archive), archivedBytes, 'Repeated packaging must not replace evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('packaging CLI can retain an empty directory after early setup failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-empty-archive-test-'));
  try {
    const source = join(root, 'not-yet-created'), output = join(root, 'upload');
    execFileSync(process.execPath, [new URL('./archive-latest-stream-screen-evidence.mjs', import.meta.url).pathname, source, output]);
    assert.equal(execFileSync('tar', ['-tzf', join(output, 'stream-screen.tar.gz')], { encoding: 'utf8' }), './\n');
    execFileSync('sha256sum', ['--check', 'stream-screen.tar.gz.sha256'], { cwd: output });
    assert.throws(() => archiveEvidence(source, join(source, 'upload')), /outside evidence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('original failed-attempt audit remains exact and timed inputs have not changed', () => {
  const bytes = readFileSync(new URL('./latest-stream-screen-first-attempt.json', import.meta.url));
  assert.equal(sha256(bytes), '53ed85f8a425cd9ad1bf1516417a135776d16a801eec638adcf090b3081b9631');
  const original = JSON.parse(bytes);
  assert.equal(original.runId, 37849591258); assert.equal(original.jobId, 113558904846); assert.equal(original.artifactCount, 0);
  assert.equal(original.cells.length, 6); assert(original.cells.every(cell => !cell.inferenceValid && Object.values(cell.statistics).every(value => value === null)));
  for (const path of ['gate-latest-stream-screen.mjs', 'latest-stream-screen-protocol.mjs', 'latest-stream-screen-subject.mjs', 'latest-stream-screen.manifest.json', 'run-latest-stream-screen.mjs']) {
    assert.equal(sha256(readFileSync(new URL(path, import.meta.url))), original.independentlyVerified.allNineReviewedProofFileHashes[`proofs/${path}`], `${path} changed`);
  }
});
test('workflow gates full tests before one replacement collection from the failed proof head', () => {
  const yaml = readFileSync(new URL('../.github/workflows/latest-stream-screen.yml', import.meta.url), 'utf8');
  assert(yaml.includes('\n  push:')); assert(!yaml.includes('workflow_dispatch:')); assert(!yaml.includes('\n  pull_request:'));
  assert(yaml.includes('branches: [perf/latest-stream-slot-20261008]')); assert(yaml.includes('github.run_attempt == 1'));
  assert(yaml.includes("github.event_name == 'push'")); assert(yaml.includes("github.ref == 'refs/heads/perf/latest-stream-slot-20261008'"));
  assert(yaml.includes("github.event.before == 'f7ba5a423bdf515a03c0e308893c658c2d8f19a9'")); assert(yaml.includes('!github.event.forced')); assert(yaml.includes('!github.event.deleted'));
  assert(yaml.includes(protocol.pins.candidate)); assert.equal(protocol.pins.candidate, '19da19f03237c28eaa8a115a5ff54c77b0ddb77d');
  assert(yaml.includes('node --test proofs/latest-stream-screen-tests.node.mjs')); assert(yaml.includes('if: always()'));
  assert(yaml.indexOf('gate-latest-stream-screen.mjs') < yaml.indexOf('--measure'));
  assert(yaml.indexOf('compilerContext(process.cwd())') < yaml.indexOf('bun run build:wasm'));
  const gate = readFileSync(new URL('./gate-latest-stream-screen.mjs', import.meta.url), 'utf8'); assert(gate.includes("'full-unit', bun, ['run', 'test']"));
  assert(gate.indexOf("required(variant, 'build:types'") < gate.indexOf("required(variant, 'public-worker-types'"));
  assert(gate.includes("required(variant, 'public-worker-types'"));
  assert(yaml.includes('git archive f7ba5a423bdf515a03c0e308893c658c2d8f19a9'));
  assert(yaml.includes('f7ba5a423bdf515a03c0e308893c658c2d8f19a9:.github/workflows/latest-stream-screen.yml'));
  assert(yaml.includes('cp proofs/latest-stream-screen-first-attempt.json'));
  const archive = yaml.indexOf('      - name: Archive complete or partial evidence');
  const upload = yaml.indexOf('      - name: Retain complete or partial evidence');
  assert(archive > yaml.indexOf('--measure') && upload > archive);
  assert(yaml.slice(archive, upload).includes('if: always()')); assert(yaml.slice(upload).includes('if: always()'));
  assert(yaml.slice(archive, upload).includes('node proofs/archive-latest-stream-screen-evidence.mjs'));
  assert(yaml.slice(upload).includes('stream-screen-upload/stream-screen.tar.gz\n'));
  assert(yaml.slice(upload).includes('stream-screen-upload/stream-screen.tar.gz.sha256\n'));
  assert(!yaml.slice(upload).includes('path: ${{ runner.temp }}/stream-screen/'));
});
