// Deterministic tests only: fake durations, no latency loops or browser launches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CASES, CASE_NAMES, LANES, CONTEXT, CONFIG, planFor, requireCI } from './radix-portability-protocol.mjs';
import { commonPlan, logInterval, hasControlDrift, summarize, gateStatus, validateMeasured } from './trie-view-protocol.mjs';
import { runFixedMeasure, runPilot, requireTimingAuthorization } from './trie-view-subject.mjs';
import { deriveBrowser, replaceOnce, transform } from './radix-portability-adapter.mjs';
import { prospectiveManifest, executeStudy, requireSuccess } from './radix-portability-runner.mjs';
import { assert as browserAssert, sha256 as browserHash } from './radix-portability-browser-shims.mjs';
const hash = data => createHash('sha256').update(data).digest('hex');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
function pilot() {
  return { phase: 'pilot', status: 'completed', expectedDigest: 'same', flags: [],
    prewarm: { targetMs: 500, elapsedMs: 500, operations: 1024, capped: false },
    probes: [{ repeat: 40, samples: [40, 41, 42] }], estimateMsPerOperation: 1 };
}
function measured(request, scale = 1) {
  const warmup = { operations: request.warmupOperations, elapsedMs: request.warmupOperations * scale,
    batches: Array.from({ length: request.warmupOperations / request.repeat }, () => ({ repeat: request.repeat, ms: request.repeat * scale })) };
  return { phase: 'measure', status: 'completed', expectedDigest: 'same', flags: [], repeat: request.repeat,
    prescribedWarmupOperations: request.warmupOperations, warmup, samples: Array(21).fill(request.repeat * scale) };
}
test('exact three mechanisms and five lanes are fixed before pilots', () => {
  assert.equal(CASES.length, 3); assert.deepEqual(CASES.map(row => row.name), CASE_NAMES);
  assert.equal(CASES.filter(row => row.target).length, 1); assert.equal(LANES.length, 5);
  for (const lane of LANES) {
    const plan = planFor(lane.name); assert.equal(plan.study.rows.length, 3); assert.equal(plan.correctness.length, 10);
    assert.equal(plan.study.measuredSubjects, 96); assert.equal(plan.study.measuredBatches, 2016);
    for (const row of plan.study.rows) for (const mode of ['ab', 'aa-baseline']) {
      const blocks = row.schedule.filter(block => block.mode === mode); assert.equal(blocks.length, 4);
      assert.equal(blocks.filter(block => block.roles.join('') === 'leftrightrightleft').length, 2);
      assert.equal(blocks.filter(block => block.roles.join('') === 'rightleftleftright').length, 2);
    }
  }
});
test('work cushion and measured floors are declared, never adapted after pilots', () => {
  assert.equal(CONFIG.rateSafetyFactor, 1.25); assert.equal(CONFIG.batchTargetMs, 40); assert.equal(CONFIG.warmupTargetMs, 500);
  assert.equal(CONFIG.minBatchMs, 10); assert.equal(CONFIG.minWarmupMs, 150);
  const plan = commonPlan({ baseline: pilot(), candidate: pilot() }); assert.equal(plan.repeat, 50); assert.equal(plan.warmupOperations, 650);
  assert.equal(plan.valid, true); assert.deepEqual(validateMeasured(measured(plan), plan), []);
  const short = measured(plan); short.samples[3] = 9; assert(validateMeasured(short, plan).includes('batch below floor'));
  const faster = pilot(); faster.probes[0] = { repeat: 40000000, samples: [40,41,42] }; faster.estimateMsPerOperation = 0.000001;
  assert.throws(() => commonPlan({ baseline: faster, candidate: faster }));
});
test('published pure statistics retain df=3, pointwise intervals and explicit AA drift', () => {
  assert.equal(logInterval([0,0,0,0]).degreesOfFreedom, 3); assert.equal(logInterval([0,0,0]).classification, 'inconclusive');
  assert.equal(logInterval(Array(4).fill(Math.log(1.021))).classification, 'detected material loss');
  assert.equal(hasControlDrift(logInterval(Array(4).fill(Math.log(1.025)))), true);
  assert.equal(hasControlDrift(logInterval(Array(4).fill(Math.log(1.015)))), false);
});
test('all six pilots precede 96 fixed subjects; all plans persist first', async () => {
  const record = { status: 'completed', rows: [] }, chronology = []; let frozen = false;
  await executeStudy(record, planFor('node-arm64'), async (build, request) => {
    chronology.push({ build, ...request });
    if (request.phase === 'pilot') { assert.equal(frozen, false); return pilot(); }
    assert.equal(frozen, true); return measured(request, build === 'candidate' ? 0.9 : 1);
  }, () => {}, plans => { assert.equal(plans.length, 3); assert.equal(chronology.length, 6); frozen = true; });
  assert.equal(chronology.length, 102); assert(chronology.slice(0,6).every(item => item.phase === 'pilot'));
  assert(chronology.slice(6).every(item => item.phase === 'measure'));
  assert.equal(gateStatus(record, CASES), 'selected-cells-within-margin-with-target-gain');
  const row = record.rows[0]; row.blocks[0].subjects[0].samples[0] = 9;
  assert.equal(summarize(row).ab.inferenceUsable, false);
});
test('fake-clock pilot and fixed sample loops preserve every sample', () => {
  let now = 0; const result = { flags: [] };
  runPilot(result, repeat => { now += repeat; return repeat; }, () => now);
  assert(result.probes.length > 0); assert(result.prewarm.operations >= 1024);
  const fixed = { flags: [] }; runFixedMeasure({ repeat: 20, warmupOperations: 160 }, fixed, repeat => repeat);
  assert.equal(fixed.samples.length, 21); assert.equal(fixed.warmup.operations, 160);
});
test('local timing, browser launches, reruns and wrong parent events are rejected', () => {
  assert.throws(() => requireTimingAuthorization('pilot', {})); assert.doesNotThrow(() => requireTimingAuthorization('verify', {}));
  assert.throws(() => requireCI(LANES[0], {}, {}));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '2', GITHUB_REF: `refs/heads/${CONTEXT.branch}` };
  assert.throws(() => requireCI(LANES[0], env, {}));
});
test('published workload and subject remain byte-identical; protocol changes are exactly declared', () => {
  const pins = JSON.parse(read('radix-portability-pins.json'));
  for (const name of ['trie-view-workloads.mjs', 'trie-view-subject.mjs', 'trie-view-source.mjs']) assert.equal(hash(read(name)), pins.publishedHelpers[`proofs/${name}`]);
  let original = read('trie-view-protocol.mjs');
  for (const [before, after] of [...pins.protocolChanges].reverse()) original = replaceOnce(original, after, before);
  assert.equal(hash(original), pins.publishedHelpers['proofs/trie-view-protocol.mjs']);
  const supervisor = read('radix-portability-process.mjs');
  assert.equal(hash(supervisor.slice(supervisor.indexOf('export const PREREQUISITE_TIMEOUT_MS'))), pins.supervisorFragmentSha256);
});
test('browser adapter preserves the exact timed core and only substitutes declared environment checks', () => {
  const derived = deriveBrowser(), original = read('trie-view-subject.mjs');
  const core = original.slice(original.indexOf('function positiveDuration'), original.indexOf('export async function subject'));
  assert(derived.subject.source.includes(core)); assert.equal(derived.subject.timedCoreSha256, hash(core));
  assert.equal(derived.workload.originalSha256, hash(read('trie-view-workloads.mjs')));
  assert.equal(derived.parent.edits.length, 3); assert.equal(derived.worker.edits.length, 2);
  assert.throws(() => replaceOnce('twice twice', 'twice', 'once'));
  assert.throws(() => transform('missing', [['x','y']]));
  for (const value of Object.values(derived)) assert.equal(hash(value.source), value.sourceSha256);
});
test('browser SHA-256 matches node crypto for UTF-8, shared slices and block boundaries', () => {
  for (const value of ['', 'abc', '界🙂\0\ud800', ...[1,55,56,63,64,65,127,128,1024,65536].map(size => Uint8Array.from({ length: size }, (_, i) => i & 255))]) assert.equal(browserHash(value), hash(value));
  const memory = new SharedArrayBuffer(140), view = new Uint8Array(memory, 7, 128); view.fill(31); assert.equal(browserHash(view), hash(view));
});
test('browser assertion adapter rejects output and type corruption', () => {
  browserAssert.deepEqual([NaN, undefined, { n: -0 }], [NaN, undefined, { n: -0 }]);
  for (const [a,b] of [[[1],[2]], [0,-0], [[undefined],[]], [new Uint8Array([1]),new Uint16Array([1])], [{ a: 1 }, { a: 1, b: 2 }]]) assert.throws(() => browserAssert.deepEqual(a,b));
  const e = new Error('stop'); browserAssert.throws(() => { throw e; }, value => value === e);
  assert.throws(() => browserAssert.throws(() => {}));
});
test('workflow contexts and matrix use only the frozen platforms', () => {
  const workflow = read('../.github/workflows/radix-portability.yml');
  assert.equal((workflow.match(/runner\.temp/g) ?? []).length, 2);
  assert(!workflow.slice(workflow.indexOf('\nenv:'), workflow.indexOf('\njobs:')).includes('runner.'));
  assert(workflow.includes('timeout-minutes: 55')); assert(workflow.includes('if: always()')); assert(workflow.includes('persist-credentials: false'));
  for (const lane of LANES) assert(workflow.includes(`lane: ${lane.name}`));
});
test('cleanup and failed commands cannot be called successful', () => {
  const ok = { status: 0, signal: null, error: null, timedOut: false, interrupted: null, cleanup: { status: 'verified-no-live-processes', survivors: [] } };
  requireSuccess(ok);
  for (const patch of [{ timedOut: true }, { status: 1 }, { interrupted: 'SIGTERM' }, { cleanup: { status: 'failed', survivors: [{pid:1}] } }]) assert.throws(() => requireSuccess({ ...ok, ...patch }));
});
test('prospective manifest includes every browser source and all three mechanism cases', () => {
  const value = prospectiveManifest(); assert.equal(value.expectedTotal.cells, 15); assert.equal(value.expectedTotal.measuredBatches, 10080);
  assert.equal(value.plans.length, 5); assert.equal(Object.keys(value.adapters).length, 5);
});
// Opt-in, untimed fixture parity. The preparation worker supplies previously
// sealed builds. CI already validates all fixtures under each target engine.
if (process.env.RADIX_FIXTURE_ROOTS) test('untimed baseline/candidate browser-adapter fixture parity', async () => {
  const roots = JSON.parse(process.env.RADIX_FIXTURE_ROOTS), directory = mkdtempSync(join(tmpdir(), 'radix-adapter-fixtures-'));
  try {
    const derived = deriveBrowser(); writeFileSync(join(directory, 'workloads.mjs'), derived.workload.source); writeFileSync(join(directory, 'shims.mjs'), derived.shims.source);
    const original = await import('./trie-view-workloads.mjs'), adapted = await import(pathToFileURL(join(directory, 'workloads.mjs')));
    for (const source of roots) {
      const S = await import(pathToFileURL(join(source, 'dist/shared.js')));
      for (const name of CASE_NAMES) {
        const a = original.verifyFixture(original.fixture(S, name)); const b = adapted.verifyFixture(adapted.fixture(S, name));
        assert.deepEqual(a, b);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
