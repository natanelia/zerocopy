/** Deterministic protocol tests only; never execute latency subjects. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { protocol, median, randomSource, shuffle, scheduleCase, variantFor, interval, settingsFor, freezeWork, validateResult, summarizeCase, stageDecision } from './protocol.mjs';
import { frozen, verifyFrozenDeclaration, verifyTools, verifyBuildStates, verifyPreparation, verifyStageOne, protocolHash, pinsHash } from './gate-guard.mjs';

const clone = value => structuredClone(value);
const primary = protocol.cases[0];
function batch(phase, index, iterations, ms) { return { phase, index, iterations, elapsedMs: iterations * ms, msPerOperation: ms, shortBatch: iterations * ms < 20 }; }
function result(row, variant, phase = 'measure', ms = 0.1, iterations = 400) {
  const request = { operation: row.operation, arenas: row.arenas, phase, settings: settingsFor(row), ...(phase === 'measure' ? { iterations } : {}) };
  const owned = row.subject === 'owned', count = variant === 'main' ? row.arenas ** 2 : row.arenas;
  const r = { request, operation: row.operation, arenas: row.arenas, phase, iterations,
    correctness: { checkedAllLeaves: Math.max(1, row.arenas - 1), sharedReexportArenas: row.arenas, nestedReadOnly: !owned, ...(owned ? { retainedOwnedSnapshot: true } : {}) },
    sink: 7, dependencySets: owned ? null : count, traversedArenaValues: owned ? null : count,
    calibration: [], warmup: Array.from({ length: 3 }, (_, i) => batch('warmup', i, iterations, ms)), measured: Array.from({ length: 7 }, (_, i) => batch('sample', i, iterations, ms)),
    fastestPilotMsPerOperation: null, prescribedIterations: null };
  return r;
}
function rowWithRatios(definition, overrides = {}) {
  const ratios = { bridge: 1.04, repair: 0.98, acceptance: 1.01, 'aa-main': 1, 'aa-old': 1, 'aa-cleanup': 1, ...overrides };
  let ordinal = 0;
  return { ...definition, blocks: scheduleCase(definition, protocol.seed + protocol.cases.indexOf(definition)).map(block => ({ ...block, subjects: block.roles.map(role => {
    const variant = variantFor(block.arm, role), ratio = Array.isArray(ratios[block.arm]) ? ratios[block.arm][block.quartet - 1] : ratios[block.arm];
    return { role, variant, ordinal: ++ordinal, result: result(definition, variant, 'measure', role === 'A' ? 0.1 : 0.1 * ratio) };
  }) })) };
}
const complete = { runComplete: true, integrityComplete: true };
test('source references and architecture/build receipts are exact and independently reconciled', () => {
  verifyFrozenDeclaration();
  assert.equal(frozen.runtimeExecutableBytesVerified, false);
  assert.equal(frozen.runId, 37867223456);
  for (const arch of ['arm64', 'x64']) {
    verifyTools(frozen.toolsByArchitecture[arch], arch);
    const bad = clone(frozen.toolsByArchitecture[arch]); bad.node.sha256 = '0'.repeat(64);
    assert.throws(() => verifyTools(bad, arch));
    const compiler = clone(frozen.toolsByArchitecture[arch]); compiler.assemblyscript.compilerSha256 = '0'.repeat(64);
    assert.throws(() => verifyTools(compiler, arch));
  }
});
test('entire original and separate owned subjects match successful Node22 preflight bytes', () => {
  for (const [name, pin] of [['original', frozen.originalSubject], ['owned', frozen.ownedSubject]]) {
    const bytes = readFileSync(new URL('./' + name + '-subject.mjs', import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
    assert.equal(bytes.length, pin.bytes);
  }
});
test('bounded staged matrix and arm mappings are exactly declared', () => {
  assert.deepEqual(protocol.cases.map(c => [c.stage, c.arch, c.subject, c.operation, c.arenas, c.quartets, c.arms.length]), [
    [1, 'arm64', 'original', 'warmNestedRead', 512, 8, 6], [1, 'arm64', 'original', 'warmNestedRead', 1, 4, 5],
    [1, 'arm64', 'owned', 'warmNestedRead', 512, 4, 5], [2, 'x64', 'original', 'warmNestedRead', 512, 4, 5],
    [2, 'x64', 'original', 'attach', 1, 4, 5], [2, 'x64', 'original', 'reexport', 512, 4, 5],
  ]);
  for (const stage of [1, 2]) assert.equal(protocol.cases.filter(c => c.stage === stage).reduce((n, c) => n + c.quartets * c.arms.length * 4, 0), stage === 1 ? 352 : 240);
  assert.deepEqual(protocol.arms, { bridge: ['main', 'old'], repair: ['old', 'cleanup'], acceptance: ['main', 'cleanup'], 'aa-main': ['main', 'main'], 'aa-old': ['old', 'old'], 'aa-cleanup': ['cleanup', 'cleanup'] });
  assert.throws(() => variantFor('unknown', 'A')); assert.throws(() => variantFor('repair', 'C'));
});
test('deterministic schedules are balanced and interleave dedicated arms in every quartet', () => {
  for (const [index, row] of protocol.cases.entries()) {
    const schedule = scheduleCase(row, protocol.seed + index);
    assert.deepEqual(schedule, scheduleCase(row, protocol.seed + index));
    assert.equal(schedule.length, row.quartets * row.arms.length);
    for (const arm of row.arms) {
      const blocks = schedule.filter(b => b.arm === arm);
      assert.equal(new Set(blocks.map(b => b.quartet)).size, row.quartets);
      assert.equal(blocks.filter(b => b.order === 'ABBA').length, row.quartets / 2);
      assert.equal(blocks.filter(b => b.order === 'BAAB').length, row.quartets / 2);
      assert(blocks.every(b => b.roles.join('') === b.order));
    }
    for (let q = 1; q <= row.quartets; q++) assert.deepEqual(schedule.filter(b => b.quartet === q).map(b => b.arm).sort(), [...row.arms].sort());
    assert.deepEqual(shuffle(protocol.variants, randomSource(protocol.seed + 100 + index)).sort(), [...protocol.variants].sort());
  }
});
test('quartet intervals use correct df7 and df3 sample variance without batch pseudoreplication', () => {
  for (const n of [4, 8]) {
    const logs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) / 100);
    const observed = interval(logs), variance = logs.reduce((s, x) => s + x * x, 0) / (n - 1);
    assert.equal(observed.df, n - 1); assert(Math.abs(observed.ratio - 1) < 1e-14);
    assert(Math.abs(observed.standardError - Math.sqrt(variance / n)) < 1e-14);
    assert(Math.abs(observed.ci95[1] - Math.exp(protocol.tCriticalByDf[n - 1] * Math.sqrt(variance / n))) < 1e-14);
  }
  assert.equal(interval(Array(8).fill(Math.log(1.04))).classification, 'material-slowdown-signal');
  assert.equal(interval(Array(4).fill(Math.log(0.96))).materialRoleDrift, true);
  assert.throws(() => interval([0, 0, 0])); assert.throws(() => median([0]));
});
test('all three direct primary decisions are necessary; historical bridge cannot be dropped', () => {
  assert.equal(summarizeCase(rowWithRatios(primary), complete).passed, true);
  for (const ratios of [{ bridge: 1.01 }, { repair: 1.001 }, { acceptance: 1.03 }]) {
    const s = summarizeCase(rowWithRatios(primary, ratios), complete);
    assert.equal(s.inferenceValid, true); assert.equal(s.passed, false);
    assert.equal(s.arms.bridge.pairs.length, 16);
  }
});
test('either-direction A/A drift, short warmups/samples and incomplete work invalidate without normalization', () => {
  for (const arm of ['aa-main', 'aa-old', 'aa-cleanup']) for (const ratio of [1.04, 0.96]) {
    const s = summarizeCase(rowWithRatios(primary, { [arm]: ratio }), complete);
    assert.equal(s.inferenceValid, false); assert.equal(s.passed, false);
    assert(Math.abs(s.arms.acceptance.inference.ratio - 1.01) < 1e-14);
    assert(s.invalidationReasons.includes(arm + '-material-role-drift'));
  }
  for (const category of ['warmup', 'measured']) {
    const row = rowWithRatios(primary); row.blocks[0].subjects[0].result[category][0].elapsedMs = 19;
    const s = summarizeCase(row, complete); assert.equal(s.passed, false); assert(s.invalidationReasons.some(r => r.includes('short')));
  }
  const row = rowWithRatios(primary); row.blocks.at(-1).subjects.pop();
  assert.equal(summarizeCase(row, complete).passed, false);
  for (const state of [{}, { runComplete: true }, { integrityComplete: true }]) {
    const s = summarizeCase(rowWithRatios(primary), state); assert.equal(s.passed, false); assert(s.arms.repair.inference);
  }
});
test('inconclusive ARM control blocks stage2; x64 reexport additionally requires benefit over main', () => {
  const rows = protocol.cases.filter(c => c.stage === 1).map(c => rowWithRatios(c));
  assert.equal(stageDecision(rows, 1, complete).stage2Permitted, true);
  rows[1] = rowWithRatios(protocol.cases[1], { acceptance: [0.98, 1.04, 1.01, 1.05] });
  const d = stageDecision(rows, 1, complete); assert.equal(d.stage2Permitted, false); assert.equal(d.stage2Disposition, 'not-run-gate-not-met');
  const reexport = protocol.cases.at(-1);
  assert.equal(summarizeCase(rowWithRatios(reexport), complete).passed, false);
  assert.equal(summarizeCase(rowWithRatios(reexport, { acceptance: 0.8 }), complete).passed, true);
});
test('pilot freezing uses max across all3 sources and rejects caps before measurements', () => {
  const pilots = Object.fromEntries(protocol.variants.map((v, i) => [v, { result: { prescribedIterations: 100000 + i * 100000 } }]));
  assert.deepEqual(freezeWork(primary, pilots), { iterations: 300000, warmupOperationsPerProcess: 900000, measuredOperationsPerProcess: 2100000 });
  const bad = clone(pilots); bad.cleanup.result.prescribedIterations = 10000001;
  assert.throws(() => freezeWork(primary, bad)); delete bad.cleanup; assert.throws(() => freezeWork(primary, bad));
});
test('equal-work measured results reject changed counts, batch schemas and correctness counters', () => {
  for (const row of protocol.cases) for (const variant of protocol.variants) {
    const r = result(row, variant); validateResult(r, r.request, row, variant);
    for (const mutate of [x => x.measured[0].iterations++, x => x.measured.pop(), x => x.warmup[0].index++, x => x.correctness.sharedReexportArenas++, x => x.calibration.push({}), x => x.measured[0].shortBatch = true]) {
      const bad = clone(r); mutate(bad); assert.throws(() => validateResult(bad, r.request, row, variant));
    }
  }
});
test('pilot result validation enforces exact stopping and prescription rather than trusting a count', () => {
  const settings = settingsFor(primary), count = settings.initialIterations, ms = 40 / count;
  const r = result(primary, 'cleanup', 'pilot', ms, count);
  r.calibration = [batch('pilot-calibration', 0, count, ms)];
  r.warmup = Array.from({ length: 3 }, (_, i) => batch('pilot-warmup', i, count, ms)); r.measured = [];
  r.fastestPilotMsPerOperation = ms; r.prescribedIterations = count;
  validateResult(r, r.request, primary, 'cleanup');
  const changed = clone(r); changed.prescribedIterations++; assert.throws(() => validateResult(changed, r.request, primary, 'cleanup'));
  const premature = clone(r); premature.calibration[0] = batch('pilot-calibration', 0, count, ms / 2); assert.throws(() => validateResult(premature, r.request, primary, 'cleanup'));
});
test('exhausted8-batch pilot preserves the original final increment before warmups', () => {
  const counts = [100000, 100251, 100503, 100755, 101008, 101262, 101516, 101771];
  const count = 102027, r = result(primary, 'cleanup', 'pilot', 40 / count, count);
  r.calibration = counts.map((iterations, index) => ({ phase: 'pilot-calibration', index, iterations, elapsedMs: 39.9, msPerOperation: 39.9 / iterations, shortBatch: false }));
  r.warmup = Array.from({ length: 3 }, (_, index) => ({ phase: 'pilot-warmup', index, iterations: count, elapsedMs: 40, msPerOperation: 40 / count, shortBatch: false }));
  r.measured = []; r.fastestPilotMsPerOperation = 40 / count; r.prescribedIterations = Math.max(count, Math.ceil(40 / r.fastestPilotMsPerOperation));
  validateResult(r, r.request, primary, 'cleanup');
  const stale = clone(r); stale.iterations = counts.at(-1); assert.throws(() => validateResult(stale, r.request, primary, 'cleanup'));
});
test('source/build/WASM/full-dist guards fail closed for every source', () => {
  const states = Object.fromEntries(protocol.variants.map(v => [v, { commit: protocol.pins[v], sourceDirty: false, source: { sha256: frozen.builds[v].source }, build: { sha256: frozen.builds[v].emittedJs }, wasm: { sha256: frozen.builds[v].wasm }, completeDist: { sha256: frozen.builds[v].completeDist } }]));
  verifyBuildStates(states);
  for (const v of protocol.variants) for (const key of ['source', 'build', 'wasm', 'completeDist']) { const bad = clone(states); bad[v][key].sha256 = '0'.repeat(64); assert.throws(() => verifyBuildStates(bad)); }
});
test('stage2 admission binds proof/run/protocol and recomputes all ARM decisions', () => {
  const rows = protocol.cases.filter(c => c.stage === 1).map(c => rowWithRatios(c));
  const report = { stage: 1, arch: 'arm64', status: 'completed', integrityComplete: true, proofCommit: 'proof', runner: { GITHUB_RUN_ID: 'run' }, protocolSha256: protocolHash(), frozenPinsSha256: pinsHash(), measuredSubjects: 352, rows, decision: stageDecision(rows, 1, complete) };
  verifyStageOne(report, 'proof', 'run');
  for (const mutate of [x => x.status = 'failed', x => x.integrityComplete = false, x => x.measuredSubjects--, x => x.protocolSha256 = 'bad', x => x.rows[1].primary = true, x => x.decision.stage2Permitted = false, x => x.rows[0].blocks[1] = x.rows[0].blocks[0], x => x.rows[0].blocks[0].subjects[0].variant = 'wrong-source']) {
    const bad = clone(report); mutate(bad); assert.throws(() => verifyStageOne(bad, 'proof', 'run'));
  }
  assert.throws(() => verifyStageOne(report, 'other-proof', 'run'));
  assert.throws(() => verifyStageOne(report, 'proof', 'other-run'));
});
test('workflow and controller preserve push-only attempt1 and ARM-dependent x64 admission', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/registry-single-initialization-gate.yml', import.meta.url), 'utf8');
  assert(!workflow.includes('workflow_dispatch:')); assert(!workflow.includes('pull_request:'));
  assert(workflow.includes('branches: [perf/registry-single-initialization-20261008]'));
  assert(workflow.includes('github.run_attempt == 1'));
  assert(workflow.includes('needs: arm64')); assert(workflow.includes("needs.arm64.outputs.advance == 'true'"));
  assert(workflow.includes('always()')); assert(workflow.includes('sha256sum'));
  const runner = readFileSync(new URL('./run-stage.mjs', import.meta.url), 'utf8');
  assert(runner.indexOf("record.status = 'pilots'") > runner.indexOf('verifyPreparation(prepared, guard, arch)'));
  assert(runner.indexOf("record.status = 'measuring'") > runner.indexOf("'frozen-plans.json'"));
  assert(!runner.includes('--correctness-only')); assert(!runner.includes('rmSync'));
});
