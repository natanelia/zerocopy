import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES, measureSingle, logInterval } from './block-traversal-performance.mjs';
import { sha256 } from './block-traversal-source.mjs';
import { CONFIG, SELECTION, LANES, CONTEXT, prospectivePlan, deriveSubject, freezeCommonWork, summarizePortability } from './block-portability-protocol.mjs';
import { commandPlan, validatePrerequisites } from './block-portability-prerequisites.mjs';
import { executeRows, browserSubject, requireCI, proofManifest, engineIdentity } from './block-portability-runner.mjs';

test('prospective identity and archive include the method document and deterministic test file', () => {
  const files = proofManifest();
  for (const name of ['block-portability.md', 'block-portability.node.mjs']) {
    assert.equal(files[`proofs/${name}`], sha256(readFileSync(new URL(name, import.meta.url))));
  }
});
test('browser executable identity records exact bytes or an explicit unavailable reason', () => {
  const path = new URL('./block-portability-protocol.mjs', import.meta.url).pathname;
  const identity = engineIdentity({ executablePath: () => path });
  assert.equal(identity.status, 'recorded'); assert.equal(identity.sha256, sha256(readFileSync(path)));
  const unavailable = engineIdentity({ executablePath() { throw new Error('unavailable sentinel'); } });
  assert.equal(unavailable.status, 'unavailable'); assert.match(unavailable.error, /unavailable sentinel/);
});

test('selection is a fixed structural subset, with compaction excluded only from browser lanes', () => {
  assert.equal(SELECTION.length, 10); assert.equal(new Set(SELECTION.map(row => row.workload.name)).size, 10);
  assert(SELECTION.every(row => CASES.includes(row.workload)));
  for (const lane of LANES) {
    const plan = prospectivePlan(lane.name); assert.equal(plan.rows.length, lane.cases);
    assert.deepEqual(plan.rows.map(row => row.workload), SELECTION.slice(0, lane.cases).map(row => row.workload));
    assert.equal(plan.rows.filter(row => row.workload.operation === 'compact').length, lane.arch === 'arm64' ? 2 : 0);
    assert.equal(plan.counts.measuredBatches, lane.cases * 32 * 21);
  }
});
test('every case has four balanced AB and baseline AA quartets before pilot information exists', () => {
  for (const lane of LANES) for (const row of prospectivePlan(lane.name).rows) for (const mode of ['ab', 'aa-baseline']) {
    const blocks = row.schedule.filter(row => row.mode === mode); assert.equal(blocks.length, 4);
    assert.equal(blocks.filter(row => row.roles.join() === 'left,right,right,left').length, 2);
    assert.equal(blocks.filter(row => row.roles.join() === 'right,left,left,right').length, 2);
  }
});
test('subject derivation reverses exactly and preserves the entire original timed kernel', () => {
  const derived = deriveSubject(); let body = derived.source.slice(derived.source.indexOf('async function'));
  body = body.trimEnd(); for (const [before, after] of [...derived.transformations].reverse()) body = body.replace(after, before);
  assert.equal(body, measureSingle.toString());
  const original = measureSingle.toString();
  const timedRegion = original.slice(original.indexOf('  const scan ='), original.indexOf('  const warm ='));
  assert(derived.source.includes(timedRegion));
  assert.equal(CONFIG.targetBatchMs, 40); assert.equal(CONFIG.warmupMs, 500);
  assert.equal(CONFIG.measuredBatchFloorMs, 10); assert.equal(CONFIG.measuredWarmupFloorMs, 150);
  assert(derived.source.includes('warmupTimeShort: !allocating'));
  assert(derived.source.includes('assert.equal(commonWarmupScans, CONFIG.compactWarmupCalls)'));
});
const pilot = (repeat = 100, fastest = 0.1) => ({ repeat, minMsPerScan: fastest, digest: 'same', repeatCapped: false, warmup: { capped: false } });
test('both builds prescribe common work, including the faster pilot and fixed compaction warmup', () => {
  const plan = freezeCommonWork(SELECTION[4].workload, [pilot(100), pilot(200, 0.01)]);
  assert.equal(plan.repeat, 200); assert(plan.warmupScans >= 625 / 0.01); assert.equal(plan.warmupScans % 200, 0);
  assert.equal(freezeCommonWork(SELECTION[8].workload, [pilot(), pilot()]).warmupScans, 512);
  assert.throws(() => freezeCommonWork(SELECTION[0].workload, [pilot(), { ...pilot(), digest: 'other' }]), /differ/);
});
test('all disposable pilots finish before any measured subjects and failure does not retry', async () => {
  const rows = structuredClone(prospectivePlan('node-arm64').rows.slice(0, 2)), calls = [];
  await assert.rejects(executeRows(rows, async (build, request) => {
    calls.push({ build, ...request }); if (request.phase === 'measure') throw new Error('sentinel failure'); return pilot();
  }, () => {}), /sentinel failure/);
  assert.equal(calls.length, 5); assert(calls.slice(0, 4).every(row => row.phase === 'pilot')); assert.equal(calls[4].phase, 'measure');
  assert(rows.every(row => row.plan)); assert.equal(rows[0].blocks[0].subjects.length, 0);
});
function synthetic(ratio = 0.8, aa = 1) {
  const row = { plan: {}, blocks: [] };
  for (const mode of ['ab', 'aa-baseline']) for (let block = 0; block < 4; block++) row.blocks.push({ mode, block,
    subjects: ['left', 'right', 'right', 'left'].map(role => ({ role, repeat: 1, samples: Array(21).fill(role === 'left' ? 20 : 20 * (mode === 'ab' ? ratio : aa)), belowTargetBatches: 0, warmup: { capped: false }, warmupTimeShort: false, warmupWorkShort: false })) });
  return row;
}
test('pointwise df3 t intervals and matched AA drift remain direct and never normalize AB', () => {
  const result = summarizePortability(synthetic(0.8, 1.05));
  assert.equal(result.ab.interval.quartets, 4); assert(Math.abs(result.ab.interval.geometricMean - 0.8) < 1e-12);
  assert.equal(result.ab.inferenceUsable, false); assert.equal(result.ab.controlDrift, true);
  assert.equal(logInterval([0, 0, 0, 0]).classification, 'evidence within margin');
});
test('a matched AA timing flag invalidates AB without changing its estimate', () => {
  const row = synthetic(); row.blocks.find(block => block.mode === 'aa-baseline').subjects[0].warmupTimeShort = true;
  const result = summarizePortability(row); assert.equal(result.ab.inferenceUsable, false); assert.equal(result.ab.conclusion, 'inconclusive (invalid matched A/A)');
  assert(Math.abs(result.ab.interval.geometricMean - 0.8) < 1e-12);
});
function fakeEngine({ failEvaluation = false, failClose = false } = {}) {
  let disconnect;
  return { launches: 0, closes: 0, async launch(options) {
    this.launches++; assert.deepEqual(options, { headless: true, timeout: 30000 });
    return { version: () => 'fake-no-browser-launched', on: (name, fn) => { if (name === 'disconnected') disconnect = fn; },
      newPage: async () => ({ on() {}, goto: async () => {}, evaluate: async () => { if (failEvaluation) throw new Error('allocation sentinel'); return { raw: { expectedJson: '[]' } }; } }),
      close: async () => { this.closes++; if (failClose) throw new Error('close sentinel'); disconnect(); } };
  } };
}
test('browser subject failure retains error and complete closure with no retry', async () => {
  const engine = fakeEngine({ failEvaluation: true }), records = [];
  const result = await browserSubject(engine, 'http://neutral.invalid', {}, value => records.push(structuredClone(value)));
  assert.equal(result.status, 'failed'); assert.match(result.error.message, /allocation sentinel/);
  assert.deepEqual(result.browser, { launched: true, closeRequested: true, closeCompleted: true, disconnected: true });
  assert.equal(engine.launches, 1); assert.equal(engine.closes, 1); assert.equal(records.at(-1).stage, 'terminal');
});
test('browser cleanup failure remains fatal even after successful subject evaluation', async () => {
  const result = await browserSubject(fakeEngine({ failClose: true }), 'http://neutral.invalid', {}, () => {});
  assert.equal(result.status, 'failed'); assert.match(result.cleanupError, /close sentinel/); assert.equal(result.browser.closeCompleted, false);
});
test('all relevant prerequisites use the standard full Bun suite and actual built Node workers', () => {
  const checks = commandPlan('/tmp/base', '/tmp/candidate', LANES[0], '/tmp/evidence');
  assert.equal(checks.length, 37);
  for (const build of ['baseline', 'candidate']) {
    assert.deepEqual(checks.find(row => row.id === `${build}/test`).command, ['bun', 'run', 'test']);
    assert.deepEqual(checks.find(row => row.id === `${build}/built-worker-tasks`).command, ['node', '--test', 'proofs/worker-tasks.mjs']);
  }
  assert(!checks.some(row => row.command.join(' ').includes('node_modules/vitest/vitest.mjs')));
  assert.equal(commandPlan('/tmp/base', '/tmp/candidate', LANES[2], '/tmp/evidence').length, 38);
});
test('missing or substituted prerequisite receipts fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'portability-prereq-test-'));
  try {
    writeFileSync(join(directory, 'prerequisites.json'), JSON.stringify({ status: 'completed', lane: 'node-arm64', commits: { baseline: CONTEXT.baseline, candidate: CONTEXT.candidate }, checks: [] }));
    assert.throws(() => validatePrerequisites(directory, '/tmp/base', '/tmp/candidate', 'node-arm64'), /Missing, duplicate, substituted or reordered/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('local process context cannot authorize browser or latency execution', () => {
  if (!process.env.GITHUB_ACTIONS) assert.throws(() => requireCI(LANES[2]), /CI-only/);
});
