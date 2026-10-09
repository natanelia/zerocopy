import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONFIG as ORIGINAL_CONFIG, commonPlan as originalCommonPlan,
  validateMeasured as originalValidateMeasured } from './trie-view-protocol.mjs';
import { LIMITS as RECOVERY_LIMITS } from './radix-browser-recovery-protocol.mjs';
import { CONTEXT, CONFIG, LIMITS, LANES, CASES, CASE_NAMES, BUILDS, MODES,
  planFor, requireCI, commonPlan, validatePilot, validateMeasured, summarize, gateStatus } from './radix-frame-screen-protocol.mjs';

// These fixtures contain invented durations only. No workload, pilot, browser,
// native timed subject or performance clock is invoked by this test file.
const clone = value => structuredClone(value);
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
function pilot(lane, rate = 0.05) {
  const probes = lane.browser ? [{ repeat: 1024, samples: [rate * 1024, rate * 1024 + 1, rate * 1024 + 2] }]
    : [{ repeat: 1, samples: [rate, rate + 0.01, rate + 0.02] },
      { repeat: 1024, samples: [rate * 1024, rate * 1024 + 1, rate * 1024 + 2] }];
  return { phase: 'pilot', status: 'completed', expectedDigest: 'invented-identical-digest', flags: [],
    prewarm: { targetMs: 500, elapsedMs: 500, wallElapsedMs: 501, operations: 1024,
      capped: false, batches: [{ repeat: 1024, ms: 500 }] }, probes,
    estimateMsPerOperation: Math.min(...probes.flatMap(probe => probe.samples.map(ms => ms / probe.repeat))) };
}
const pilotsFor = lane => Object.fromEntries(BUILDS.map(build => [build, pilot(lane)]));
const inventedPlan = () => ({ repeat: 10, warmupOperations: 130, expectedDigest: 'invented-identical-digest',
  fastestPilotMsPerOperation: 5, valid: true, validityReasons: [] });
function syntheticRow(planned, ratios = {}) {
  const plan = inventedPlan(); let sequence = 0;
  const row = { ...clone(planned), plan, blocks: [] };
  for (const block of planned.schedule) row.blocks.push({ ...clone(block),
    subjects: block.roles.map((role, index) => {
      const requested = ratios[block.mode] ?? 1;
      const ratio = typeof requested === 'function' ? requested(block.block, index >> 1) : requested;
      return { phase: 'measure', status: 'completed', role, build: block[role], sequence: sequence++,
        repeat: plan.repeat, prescribedWarmupOperations: plan.warmupOperations, expectedDigest: plan.expectedDigest,
        samples: Array(CONFIG.samples).fill(40 * (role === 'right' ? ratio : 1)), flags: [],
        warmup: { operations: plan.warmupOperations, elapsedMs: 260,
          batches: Array.from({ length: 13 }, () => ({ repeat: 10, ms: 20 })) } };
    }) });
  return row;
}
function syntheticRecord(lane = LANES[0], ratios = { 'helper-baseline': 0.95, 'helper-current': 0.95 }) {
  const plan = planFor(lane.name);
  const rows = plan.study.rows.map(planned => {
    const row = syntheticRow(planned, ratios); row.summary = summarize(row); return row;
  });
  return { status: 'completed', plan, rows };
}

test('audited dependencies and CONFIG remain byte-for-byte untouched', () => {
  const hashes = {
    'trie-view-workloads.mjs': '6efed2d1c345e33b73364054b53a46f621d1196bd43ceb5642277cfe77a9940b',
    'trie-view-protocol.mjs': 'b083040d4e8f76d880db4560cebe34af49105cab2a23e31eb54f7f6689a54f1b',
    'radix-browser-recovery-protocol.mjs': 'bef00c4d32470fc71147980804e14c3a8d6000d26074494a232246e9c5cf3cda',
    'radix-portability-protocol.mjs': '6cc23b6ddb6063117d7b50239ccd592a69a215d006f180815a9a7afd0d1c5567',
  };
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex'), hash);
  assert.equal(CONFIG, ORIGINAL_CONFIG); assert.equal(validateMeasured, originalValidateMeasured);
  assert.deepEqual(LIMITS, { ...RECOVERY_LIMITS, controllerMs: 4500000 });
  assert.equal(LIMITS.retries, 0);
});

test('exact two lanes, four audited workloads and four modes exclude C/B', () => {
  assert.deepEqual(LANES.map(lane => lane.name), ['webkit-x64', 'bun-x64']);
  assert.deepEqual(LANES[0], { name: 'webkit-x64', runtime: 'webkit', platform: 'linux', arch: 'x64', browser: true,
    playwright: '1.63.0', browserRevision: '2359', version: '26.6', defaultJitFlags: true });
  assert.equal(LANES[1].version, '1.4.2'); assert.equal(LANES[1].revision, '744846f844374847c902b5e7fd59b4342a51ef99');
  assert.equal(CONTEXT.branch, 'proof/radix-frame-screen-20261009');
  assert.equal(CONTEXT.baseline, '3773c6e519c7c0958da13727ed1082f449f3ee25');
  assert.equal(CONTEXT.current, 'cda6f639faab0ef627fb97ed199864fc4cc2468a');
  assert.equal(CONTEXT.helperCommit, 'e15597748144bf92439a88a2d0405f038e1cc833');
  assert.equal(CONTEXT.helperSourceTree, '871dc245dcb420254f99b5d77a6b99785eb89a40');
  assert.equal(CONTEXT.helperRuntimeTree, 'fa9fbea9011ae8e6109db874493e720fd6b6278b');
  assert.deepEqual(CASE_NAMES, ['map/radix/number/0/canonical/entries', 'map/radix/number/1/canonical/entries',
    'map/radix/number/4096/canonical/entries', 'map/hamt/number/0/canonical/entries']);
  assert.deepEqual(CASES.map(row => row.name), CASE_NAMES);
  assert.deepEqual(MODES.map(({ mode, left, right }) => [mode, left, right]), [
    ['helper-baseline', 'baseline', 'helper'], ['aa-baseline', 'baseline', 'baseline'],
    ['helper-current', 'current', 'helper'], ['aa-current', 'current', 'current'],
  ]);
  assert.throws(() => planFor('node-x64')); assert.throws(() => planFor('chromium-x64'));
  assert.throws(() => planFor({ ...LANES[0], browserRevision: '2358' }));
});

test('deterministic frozen schedules have 12 pilots, 64 quartets and 256 independent subjects per lane', () => {
  for (const lane of LANES) {
    const plan = planFor(lane.name); assert.deepEqual(planFor(lane.name), plan);
    assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.study.rows));
    let pilots = 0, quartets = 0, subjects = 0;
    for (const row of plan.study.rows) {
      assert.deepEqual([...row.pilotOrder].sort(), BUILDS); pilots += row.pilotOrder.length;
      assert(Object.isFrozen(row.pilotOrder)); assert(Object.isFrozen(row.schedule));
      for (let block = 0; block < CONFIG.quartets; block++)
        assert.deepEqual(row.schedule.filter(item => item.block === block).map(item => item.mode).sort(), MODES.map(item => item.mode).sort());
      for (const mode of MODES) {
        const blocks = row.schedule.filter(block => block.mode === mode.mode);
        assert.equal(blocks.length, 4);
        assert.equal(blocks.filter(block => block.roles.join(',') === 'left,right,right,left').length, 2);
        assert.equal(blocks.filter(block => block.roles.join(',') === 'right,left,left,right').length, 2);
      }
      for (const block of row.schedule) {
        assert(Object.isFrozen(block)); assert(Object.isFrozen(block.roles));
        assert.throws(() => { block.roles[0] = 'right'; }, TypeError);
        quartets++; subjects += block.roles.length;
      }
    }
    assert.equal(pilots, 12); assert.equal(quartets, 64); assert.equal(subjects, 256);
    assert.equal(subjects * CONFIG.samples, 5376); assert.equal(CONFIG.samples, 21);
    assert.equal(plan.study.pilots, pilots); assert.equal(plan.study.quartets, quartets);
    assert.equal(plan.study.measuredSubjects, subjects); assert.equal(plan.study.measuredBatches, 5376);
    assert.equal(plan.expected.commonPlans, 4);
    assert.equal(plan.correctness.filter(item => item.kind === 'fixture').length, 12);
    assert.equal(plan.correctness.filter(item => item.kind === 'worker').length, 6);
    assert.equal(plan.correctness.length, 18);
    for (const build of BUILDS) for (const copy of [false, true])
      assert.equal(plan.correctness.filter(item => item.build === build && item.kind === 'worker' && item.copy === copy).length, 1);
    assert.equal(plan.scheduling.freezeBeforePilot, true); assert.equal(plan.scheduling.allPilotsBeforeMeasurement, true);
  }
  assert.deepEqual(planFor('webkit-x64').study, planFor('bun-x64').study);
  const schedule = planFor('webkit-x64').study.rows.map(({ workload, pilotOrder, schedule }) =>
    ({ name: workload.name, pilotOrder, schedule }));
  assert.equal(createHash('sha256').update(JSON.stringify(schedule)).digest('hex'),
    'ab4eac2ec5aadbfa1e5eb26fa4bb1439c8b2bfa51b8fe911d7da999ea34e8d79', 'Frozen case/pilot/mode/quartet schedule changed');
});

test('three-way common plan uses the fastest retained post-prewarm rate from any build', () => {
  for (const lane of LANES) for (const fastestBuild of BUILDS) {
    const pilots = pilotsFor(lane); pilots[fastestBuild] = pilot(lane, 0.04);
    const plan = commonPlan(pilots, lane); assert.equal(plan.valid, true);
    assert.equal(plan.fastestPilotMsPerOperation, 0.04);
    assert.equal(plan.repeat, 1250); assert.equal(plan.warmupOperations, 16250);
    assert.equal(plan.warmupOperations % plan.repeat, 0);
    const snapshot = JSON.stringify(pilots); commonPlan(pilots, lane.name); assert.equal(JSON.stringify(pilots), snapshot);
  }
});

test('three-way input is explicit; the original two-build validator is never bypassed or changed', () => {
  const lane = LANES[0], pilots = pilotsFor(lane);
  assert.throws(() => originalCommonPlan(pilots));
  assert.doesNotThrow(() => originalCommonPlan({ baseline: pilots.baseline, candidate: pilots.helper }));
  for (const build of BUILDS) {
    const missing = clone(pilots); delete missing[build]; assert.throws(() => commonPlan(missing, lane));
  }
  assert.throws(() => commonPlan({ ...pilots, candidate: pilots.helper }, lane));
  assert.throws(() => commonPlan({ baseline: pilots.baseline, candidate: pilots.current, helper: pilots.helper }, lane));
  for (const build of BUILDS) {
    const wrong = clone(pilots); wrong[build].expectedDigest = 'different';
    assert.throws(() => commonPlan(wrong, lane), /outputs differ/);
  }
  assert.throws(() => commonPlan(pilots));
});

test('browser starts calibration at last retained prewarm repeat; native Bun retains repeat=1', () => {
  for (const lane of LANES) {
    const value = pilot(lane); assert.equal(validatePilot(value, lane), 0.05);
    const changed = clone(value); changed.probes[0].repeat = lane.browser ? 1 : 1024;
    changed.estimateMsPerOperation = Math.min(...changed.probes.flatMap(probe => probe.samples.map(ms => ms / probe.repeat)));
    assert.throws(() => validatePilot(changed, lane), /Calibration must start|Native Bun calibration/);
    for (const mutate of [p => { p.prewarm.batches = []; }, p => { p.prewarm.operations++; },
      p => { p.prewarm.elapsedMs++; }, p => { p.prewarm.batches[0].ms = 0; }]) {
      const bad = clone(value); mutate(bad); assert.throws(() => validatePilot(bad, lane));
    }
  }
});

test('all retained calibration samples matter and no nonpositive duration is tolerated', () => {
  for (const lane of LANES) {
    const value = pilot(lane, 0.05);
    value.probes.unshift({ repeat: lane.browser ? 1024 : 1, samples: [0.03 * (lane.browser ? 1024 : 1), 35, 36] });
    value.estimateMsPerOperation = 0.03;
    assert.equal(validatePilot(value, lane), 0.03);
    const pilots = pilotsFor(lane); pilots.current = value;
    assert.equal(commonPlan(pilots, lane).fastestPilotMsPerOperation, 0.03);
    for (const invalid of [0, -1, NaN, Infinity]) {
      const bad = pilot(lane); bad.probes[0].samples[0] = invalid;
      assert.throws(() => validatePilot(bad, lane));
    }
    const wrongRate = pilot(lane); wrongRate.estimateMsPerOperation++;
    assert.throws(() => validatePilot(wrongRate, lane), /fastest/);
    const failed = pilot(lane); failed.status = 'failed'; assert.throws(() => validatePilot(failed, lane));
    const tooMany = pilot(lane); tooMany.probes = Array.from({ length: 17 }, () => clone(tooMany.probes[0]));
    assert.throws(() => validatePilot(tooMany, lane));
  }
});

test('pilot caps, failed warmup, calibration floors and retained flags make a common plan invalid', () => {
  for (const lane of LANES) {
    for (const mutate of [p => { p.prewarm.capped = true; },
      p => { p.prewarm.elapsedMs = p.prewarm.batches[0].ms = 499; },
      p => { p.flags.push('fixture integrity failed'); },
      p => { p.probes.at(-1).samples = [30, 31, 32];
        p.estimateMsPerOperation = Math.min(...p.probes.flatMap(probe => probe.samples.map(ms => ms / probe.repeat))); }]) {
      const pilots = pilotsFor(lane); mutate(pilots.helper);
      const plan = commonPlan(pilots, lane); assert.equal(plan.valid, false); assert(plan.validityReasons.length > 0);
    }
    const pilots = pilotsFor(lane), value = pilots.current;
    value.probes[0].samples = [1e-12, 1e-12, 1e-12];
    value.probes.push({ repeat: 1024, samples: [40, 41, 42] });
    value.estimateMsPerOperation = 1e-12 / value.probes[0].repeat;
    const plan = commonPlan(pilots, lane);
    assert.equal(plan.valid, false); assert(plan.validityReasons.includes('repeat cap'));
    assert(plan.validityReasons.includes('warmup work cap'));
  }
});

test('quartet inference uses medians, two adjacent log ratios, four units and df=3 intervals', () => {
  const ratios = [0.96, 0.98, 1.01, 1.02];
  const row = syntheticRow(planFor('webkit-x64').study.rows[0], { 'helper-baseline': block => ratios[block] });
  for (const block of row.blocks) for (const subject of block.subjects) {
    subject.samples[0] = 10; subject.samples[20] = 10000;
  }
  const summary = summarize(row)['helper-baseline'], logs = ratios.map(Math.log);
  const mean = logs.reduce((a, b) => a + b, 0) / 4;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 3;
  const half = 3.182446305284263 * Math.sqrt(variance / 4);
  assert.equal(summary.pairs.length, 8); assert.equal(summary.quartetLogLatencyRatios.length, 4);
  assert.equal(summary.interval.degreesOfFreedom, 3); assert.equal(summary.interval.confidenceLevel, 0.95);
  near(summary.interval.geometricMean, Math.exp(mean));
  near(summary.interval.lower, Math.exp(mean - half)); near(summary.interval.upper, Math.exp(mean + half));
  const paired = syntheticRow(planFor('webkit-x64').study.rows[0], { 'helper-baseline': (_, pair) => pair ? 1.25 : 0.8 });
  near(summarize(paired)['helper-baseline'].interval.geometricMean, 1);
});

test('each contrast has independently matched AA; AA never adjusts effect size or the other contrast', () => {
  for (const [control, affected, unaffected] of [
    ['aa-baseline', 'helper-baseline', 'helper-current'], ['aa-current', 'helper-current', 'helper-baseline'],
  ]) {
    const row = syntheticRow(planFor('webkit-x64').study.rows[0],
      { 'helper-baseline': 0.97, 'helper-current': 0.96, [control]: 1.08 });
    const summary = summarize(row);
    assert.equal(summary[affected].inferenceUsable, false);
    assert.equal(summary[affected].conclusion, 'control-drift-inconclusive');
    assert.equal(summary[unaffected].inferenceUsable, true);
    assert.equal(summary[unaffected].controlDrift, false);
    near(summary['helper-baseline'].interval.geometricMean, 0.97);
    near(summary['helper-current'].interval.geometricMean, 0.96);
    assert.equal(summary[affected].matchedAA, control);
    row.blocks.find(block => block.mode === control).subjects.pop();
    const incomplete = summarize(row);
    assert.equal(incomplete[affected].conclusion, 'invalid-or-incomplete');
    assert.equal(incomplete[unaffected].inferenceUsable, true);
  }
});

test('AA drift requires both out-of-margin estimate and interval excluding one', () => {
  for (const [ratio, drift] of [[1.019, false], [1.021, true], [0.979, true], [1, false]]) {
    const row = syntheticRow(planFor('webkit-x64').study.rows[0], { 'aa-baseline': ratio });
    assert.equal(summarize(row)['helper-baseline'].controlDrift, drift);
  }
  const row = syntheticRow(planFor('webkit-x64').study.rows[0], { 'aa-baseline': block => [0.8, 1.1, 1.2, 1.3][block] });
  const summary = summarize(row)['helper-baseline'];
  assert.equal(summary.controlDrift, false);
});

test('material-loss, within-margin and inconclusive classification retain strict boundaries', () => {
  for (const [ratio, classification] of [[1.021, 'detected material loss'],
    [1.02, 'evidence within margin'], [0.9, 'evidence within margin']]) {
    const row = syntheticRow(planFor('webkit-x64').study.rows[0], { 'helper-current': ratio });
    assert.equal(summarize(row)['helper-current'].interval.classification, classification);
  }
  const row = syntheticRow(planFor('webkit-x64').study.rows[0], { 'helper-current': block => [1, 1.04, 1, 1.04][block] });
  assert.equal(summarize(row)['helper-current'].interval.classification, 'inconclusive');
});

test('floor flags and incomplete quartets invalidate matched inference without rejecting or clipping samples', () => {
  const row = syntheticRow(planFor('webkit-x64').study.rows[0]);
  const subject = row.blocks.find(block => block.mode === 'helper-baseline').subjects[0];
  subject.samples[0] = 9.9;
  subject.warmup.batches.forEach(batch => { batch.ms = 10; }); subject.warmup.elapsedMs = 130;
  const before = JSON.stringify(row), summary = summarize(row);
  assert.equal(JSON.stringify(row), before);
  assert(summary['helper-baseline'].validityReasons.includes('batch below floor'));
  assert(summary['helper-baseline'].validityReasons.includes('warmup below floor'));
  assert.equal(summary['helper-baseline'].inferenceUsable, false);
  assert.equal(summary['helper-current'].inferenceUsable, true);
  row.blocks = row.blocks.filter(block => !(block.mode === 'aa-current' && block.block === 0));
  const incomplete = summarize(row);
  assert.equal(incomplete['aa-current'].interval.quartets, 3); assert.equal(incomplete['aa-current'].interval.lower, null);
  assert.equal(incomplete['helper-current'].inferenceUsable, false);
});

test('positive durations, fixed work, mode identity, quartet identity and unique subjects are mandatory', () => {
  const base = syntheticRow(planFor('webkit-x64').study.rows[0]);
  for (const mutate of [row => { row.blocks[0].subjects[0].samples[0] = 0; },
    row => { row.blocks[0].subjects[0].repeat++; }, row => { row.blocks[0].subjects[0].warmup.operations++; },
    row => { row.blocks[0].subjects[0].warmup.elapsedMs++; }, row => { row.blocks[0].subjects[0].expectedDigest = 'wrong'; },
    row => { row.blocks[0].subjects[0].samples.pop(); }, row => { row.blocks[0].subjects[0].status = 'failed'; },
    row => { row.blocks[0].mode = 'current-baseline'; }, row => { row.blocks[0].right = 'current'; },
    row => { row.blocks.push(clone(row.blocks[0])); },
    row => { row.blocks[1].subjects[0] = row.blocks[0].subjects[0]; },
    row => { row.blocks[1].subjects[0].sequence = row.blocks[0].subjects[0].sequence; },
    row => { row.blocks[0].subjects[0].build = 'wrong'; },
    row => { row.blocks[0].subjects[0].role = row.blocks[0].subjects[1].role; }]) {
    const row = clone(base); mutate(row); assert.throws(() => summarize(row));
  }
  const unbalanced = clone(base);
  for (const block of unbalanced.blocks.filter(block => block.mode === 'helper-baseline')) {
    block.roles = ['left', 'right', 'right', 'left'];
    block.subjects.forEach((subject, index) => { subject.role = block.roles[index]; subject.build = block[subject.role]; });
  }
  assert.throws(() => summarize(unbalanced), /balanced quartet orientations/);
});

test('measured floor equality is valid and every declared batch remains present', () => {
  const row = syntheticRow(planFor('bun-x64').study.rows[0]);
  for (const block of row.blocks) for (const subject of block.subjects) {
    subject.samples.fill(10);
    subject.warmup.batches = [{ repeat: 10, ms: 30 }, ...Array.from({ length: 12 }, () => ({ repeat: 10, ms: 10 }))];
    subject.warmup.elapsedMs = 150;
  }
  const summary = summarize(row);
  assert(Object.values(summary).every(value => value.inferenceUsable && value.validityReasons.length === 0));
  assert(row.blocks.every(block => block.subjects.every(subject => subject.samples.length === 21)));
});

test('lane gate requires every selected contrast, target gain and WebKit direct empty improvement', () => {
  for (const lane of LANES) assert.equal(gateStatus(syntheticRecord(lane)), 'selected-cells-within-margin-with-required-improvements');
  assert.equal(gateStatus(syntheticRecord(LANES[0], { 'helper-current': 0.95 })), 'within-margin-without-established-target-gain');
  assert.equal(gateStatus(syntheticRecord(LANES[0], { 'helper-baseline': 0.95 })), 'within-margin-without-established-empty-repair');
  assert.equal(gateStatus(syntheticRecord(LANES[1], { 'helper-baseline': 0.95 })), 'selected-cells-within-margin-with-required-improvements');
  for (const mode of ['helper-baseline', 'helper-current']) for (const name of CASE_NAMES) {
    const record = syntheticRecord(), index = record.rows.findIndex(row => row.workload.name === name);
    const row = syntheticRow(record.plan.study.rows[index], { 'helper-baseline': 0.9, 'helper-current': 0.9, [mode]: 1.04 });
    row.summary = summarize(row); record.rows[index] = row;
    assert.equal(gateStatus(record), 'detected-material-loss', `${name} ${mode}`);
  }
});

test('gate preserves failures, AA drift and uncertainty and rejects missing or duplicate selected cells', () => {
  assert.equal(gateStatus(syntheticRecord(LANES[0], { 'aa-baseline': 1.1 })), 'control-drift-inconclusive');
  assert.equal(gateStatus(syntheticRecord(LANES[0], { 'aa-current': 1.1 })), 'control-drift-inconclusive');
  assert.equal(gateStatus(syntheticRecord(LANES[0], { 'helper-current': block => [1, 1.04, 1, 1.04][block] })), 'statistical-inconclusive');
  const record = syntheticRecord(); record.rows[0].plan.valid = false;
  record.rows[0].plan.validityReasons.push('cleanup failed'); record.rows[0].summary = summarize(record.rows[0]);
  assert.equal(gateStatus(record), 'invalid-or-incomplete');
  const failed = syntheticRecord(); failed.status = 'failed'; assert.equal(gateStatus(failed), 'incomplete');
  const missing = syntheticRecord(); missing.rows.pop(); assert.equal(gateStatus(missing), 'incomplete');
  const duplicate = syntheticRecord(); duplicate.rows[0] = duplicate.rows[1]; assert.equal(gateStatus(duplicate), 'invalid-or-incomplete');
  const noSummary = syntheticRecord(); delete noSummary.rows[0].summary; assert.equal(gateStatus(noSummary), 'invalid-or-incomplete');
  assert.throws(() => gateStatus(syntheticRecord(), CASES.slice(1)));
});

test('CI gate blocks local runs, wrong branch, retry, unexpected source transition or flags', () => {
  const proof = 'a'.repeat(40), env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: `refs/heads/${CONTEXT.branch}`, GITHUB_SHA: proof, GITHUB_RUN_ID: '123' };
  const event = { before: CONTEXT.current, after: proof, created: false, deleted: false, forced: false };
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: 'bad' },
    { GITHUB_RUN_ID: 'bad' }, { NODE_OPTIONS: '--jitless' }, { BUN_OPTIONS: '--smol' }])
    assert.throws(() => requireCI(LANES[0], { ...env, ...change }, event));
  for (const change of [{ before: CONTEXT.baseline }, { after: 'b'.repeat(40) },
    { created: true }, { deleted: true }, { forced: true }])
    assert.throws(() => requireCI(LANES[0], env, { ...event, ...change }));
  assert.throws(() => requireCI({ ...LANES[0], arch: 'arm64' }, env, event));
  // A pending helper identity or a non-pinned controller must always fail closed.
  if (!/^[0-9a-f]{40}$/.test(CONTEXT.helperCommit) || process.versions.node !== CONTEXT.controllerNode || process.execArgv.length)
    assert.throws(() => requireCI(LANES[0], env, event));
  else assert.equal(requireCI(LANES[0], env, event).proofCommit, proof);
});
