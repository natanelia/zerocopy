import assert from 'node:assert/strict';
import { CASES as CATALOGUE } from './trie-view-workloads.mjs';
import { CONFIG, randomSource, shuffle, median, logInterval, hasControlDrift,
  validatePilot as validateNativePilot, validateMeasured } from './trie-view-protocol.mjs';
import { LIMITS as RECOVERY_LIMITS, validateRecoveryPilot } from './radix-browser-recovery-protocol.mjs';
export { CONFIG, validateMeasured } from './trie-view-protocol.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
export const CONTEXT = freeze({
  protocol: 'radix-frame-screen-v1', branch: 'proof/radix-frame-screen-20261009',
  baseline: '3773c6e519c7c0958da13727ed1082f449f3ee25',
  current: 'cda6f639faab0ef627fb97ed199864fc4cc2468a',
  candidate: 'cda6f639faab0ef627fb97ed199864fc4cc2468a',
  helperCommit: 'e15597748144bf92439a88a2d0405f038e1cc833',
  helperBase: 'cda6f639faab0ef627fb97ed199864fc4cc2468a',
  helperSourceTree: '871dc245dcb420254f99b5d77a6b99785eb89a40',
  // This reviewed runtime-only projection excludes the proposal's two tests;
  // the committed helper source tree above includes those original tests.
  helperRuntimeTree: 'fa9fbea9011ae8e6109db874493e720fd6b6278b',
  helperProposalTree: '871dc245dcb420254f99b5d77a6b99785eb89a40',
  helperArenaSha256: '06d115fe05a30b065483bc416de242b5078f98f413e58406575204c2fa4ac81e',
  transportCommit: '8b8e6d78ee444ce07b1ee59a652106e0221c7a69',
  transportTree: 'b3fa6631efbec2f926b153ca69ff837262622285',
  transportRun: '37882888216', controllerNode: '22.23.3',
  excludedIntegrationMain: 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad',
  scope: 'One prospective selected-cell helper screen on WebKit and Bun; no current/baseline rerun, historical pooling, full-catalogue acceptance, integration or PR metadata changes.',
  historicalWebkitEmptyRadixLoss: 'Current/baseline +3.204%, 95% CI [+2.490%, +3.923%]; preserved independently and never reclassified by this screen.',
});
export const BUILDS = freeze(['baseline', 'current', 'helper']);
export const MODES = freeze([
  { mode: 'helper-baseline', left: 'baseline', right: 'helper', matchedAA: 'aa-baseline' },
  { mode: 'aa-baseline', left: 'baseline', right: 'baseline' },
  { mode: 'helper-current', left: 'current', right: 'helper', matchedAA: 'aa-current' },
  { mode: 'aa-current', left: 'current', right: 'current' },
]);
export const CASE_NAMES = freeze([
  'map/radix/number/0/canonical/entries',
  'map/radix/number/1/canonical/entries',
  'map/radix/number/4096/canonical/entries',
  'map/hamt/number/0/canonical/entries',
]);
export const CASES = freeze(CASE_NAMES.map(name => {
  const workload = CATALOGUE.find(row => row.name === name); assert(workload); return workload;
}));
export const LANES = freeze([
  { name: 'webkit-x64', runtime: 'webkit', platform: 'linux', arch: 'x64', browser: true,
    playwright: '1.63.0', browserRevision: '2359', version: '26.6', defaultJitFlags: true },
  { name: 'bun-x64', runtime: 'bun', platform: 'linux', arch: 'x64', browser: false,
    version: '1.4.2', revision: '744846f844374847c902b5e7fd59b4342a51ef99', defaultJitFlags: true },
]);
export const LIMITS = freeze({ ...RECOVERY_LIMITS, controllerMs: 75 * 60 * 1000 });
function resolveLane(lane) {
  const expected = LANES.find(row => row.name === (typeof lane === 'string' ? lane : lane?.name));
  assert(expected, 'Unknown frame-screen lane');
  if (typeof lane !== 'string') assert.deepEqual(lane, expected, 'Frozen lane changed');
  return expected;
}
function makeSchedule(random) {
  const all = Array.from({ length: CONFIG.quartets }, (_, block) =>
    shuffle(MODES, random).map(mode => ({ ...mode, block, key: random() }))).flat();
  for (const { mode } of MODES) {
    const group = all.filter(row => row.mode === mode).sort((a, b) => a.key - b.key || a.block - b.block);
    group.forEach((row, index) => {
      row.roles = index < 2 ? ['left', 'right', 'right', 'left'] : ['right', 'left', 'left', 'right'];
    });
  }
  return all.map(({ key, ...row }) => row);
}
export function planFor(laneName) {
  const lane = resolveLane(laneName), random = randomSource(CONFIG.seed);
  const rows = shuffle(CASES, random).map(workload => ({ workload,
    pilotOrder: shuffle(BUILDS, random), schedule: makeSchedule(random) }));
  return freeze({ schema: 1, context: CONTEXT, lane, limits: LIMITS,
    study: { schemaVersion: 1, config: CONFIG, rows, modes: MODES,
      pilots: 12, commonPlans: 4, quartets: 64, measuredSubjects: 256, measuredBatches: 5376 },
    correctness: CASES.flatMap((workload, index) => (index % 2 ? [...BUILDS].reverse() : BUILDS)
      .map(build => ({ build, kind: 'fixture', name: workload.name })))
      .concat([false, true].flatMap((copy, index) => (index % 2 ? [...BUILDS].reverse() : BUILDS)
        .map(build => ({ build, kind: 'worker', copy, name: copy ? 'copy-growth-paused' : 'shared-growth-paused' })))),
    expected: { cells: 4, pilots: 12, commonPlans: 4, quartets: 64,
      measuredSubjects: 256, measuredBatches: 5376, untimedFixtureChecks: 12,
      untimedWorkerChecks: 6, untimedRuntimePrerequisites: 18 },
    scheduling: { freezeBeforePilot: true, allPilotsBeforeMeasurement: true,
      freshProcessPerSubject: true, freshBrowserPerWebkitSubject: true,
      noSharedMeasuredSubjectsAcrossContrasts: true, retries: 0 },
    browserRecovery: { calibrationStart: 'last retained positive prewarm batch repeat',
      workerClosure: 'observe exact worker close before requesting browser close',
      nativeBunCalibrationStart: 'repeat=1, unchanged audited native pilot' },
    resultRule: 'Report all four cells and both direct contrasts with their independently executed matched AA. Any integrity, duration, floor, lifecycle, cleanup or completeness failure invalidates affected inference. Pointwise df=3 intervals; 2% loss margin. A promising selected-cell repair requires every contrast usable and within margin on both lanes, WebKit empty-radix H/C upper < 1, and radix-4096 H/B upper < 1 on each lane. No AA adjustment, C/B rerun, retries, extra samples or timing-informed source edits.',
  });
}
export function requireCI(lane, env = process.env, event) {
  lane = resolveLane(lane);
  assert.equal(env.GITHUB_ACTIONS, 'true', 'No local timing or browser launch');
  assert.equal(env.GITHUB_EVENT_NAME, 'push'); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GITHUB_REF, `refs/heads/${CONTEXT.branch}`);
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/); assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.equal(event.before, CONTEXT.current); assert.equal(event.after, env.GITHUB_SHA);
  assert.equal(event.created, false); assert.equal(event.deleted, false); assert.equal(event.forced, false);
  assert.equal(env.NODE_OPTIONS ?? '', ''); assert.equal(env.BUN_OPTIONS ?? '', '');
  assert.match(CONTEXT.helperCommit, /^[0-9a-f]{40}$/, 'Helper commit must be frozen before execution');
  assert.equal(process.platform, lane.platform); assert.equal(process.arch, lane.arch);
  assert.equal(process.versions.node, CONTEXT.controllerNode); assert.deepEqual(process.execArgv, []);
  return { proofCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    lane: lane.name, protocol: CONTEXT.protocol };
}
export function validatePilot(pilot, lane) {
  lane = resolveLane(lane);
  const rate = lane.browser ? validateRecoveryPilot(pilot) : validateNativePilot(pilot);
  if (!lane.browser) {
    assert.equal(pilot.probes[0].repeat, 1, 'Native Bun calibration must retain repeat=1');
    const prewarm = pilot.prewarm;
    assert(prewarm.batches.length > 0, 'Missing retained native prewarm batches');
    for (const batch of prewarm.batches) {
      assert(Number.isSafeInteger(batch.repeat) && batch.repeat > 0 && batch.repeat <= CONFIG.maxRepeat);
      assert(Number.isFinite(batch.ms) && batch.ms > 0, 'Nonpositive native prewarm duration');
    }
    assert.equal(prewarm.operations, prewarm.batches.reduce((sum, batch) => sum + batch.repeat, 0));
    assert.equal(prewarm.elapsedMs, prewarm.batches.reduce((sum, batch) => sum + batch.ms, 0));
  }
  return rate;
}
// Explicit three-build extension. The audited two-key validator remains intact.
export function commonPlan(pilots, lane) {
  lane = resolveLane(lane);
  assert.deepEqual(Object.keys(pilots).sort(), BUILDS, 'Exactly baseline, current and helper pilots are required');
  const values = BUILDS.map(build => pilots[build]);
  const fastest = Math.min(...values.map(pilot => validatePilot(pilot, lane)));
  assert.equal(typeof values[0].expectedDigest, 'string'); assert(values[0].expectedDigest.length > 0);
  values.forEach(pilot => assert.equal(pilot.expectedDigest, values[0].expectedDigest, 'Build workload outputs differ'));
  const repeat = Math.ceil(CONFIG.batchTargetMs * CONFIG.rateSafetyFactor / fastest);
  const warmupOperations = Math.ceil((CONFIG.warmupTargetMs * CONFIG.rateSafetyFactor / fastest) / repeat) * repeat;
  const reasons = [];
  if (!Number.isSafeInteger(repeat) || repeat > CONFIG.maxRepeat) reasons.push('repeat cap');
  if (!Number.isSafeInteger(warmupOperations) || warmupOperations > CONFIG.maxWarmupCalls) reasons.push('warmup work cap');
  for (const build of BUILDS) {
    const pilot = pilots[build], last = pilot.probes.at(-1);
    if (pilot.prewarm.capped || pilot.prewarm.elapsedMs < CONFIG.pilotWarmupMs || pilot.prewarm.operations < CONFIG.pilotWarmupMinCalls) reasons.push(`${build} pilot warmup`);
    if (Math.min(...last.samples) < CONFIG.pilotCalibrationTargetMs) reasons.push(`${build} pilot calibration cap`);
    if (pilot.flags?.length) reasons.push(...pilot.flags.map(flag => `${build}: ${flag}`));
  }
  return { repeat, warmupOperations, fastestPilotMsPerOperation: fastest,
    expectedDigest: values[0].expectedDigest, validityReasons: reasons, valid: reasons.length === 0 };
}
export function summarize(row) {
  assert(Array.isArray(row.blocks));
  const summary = {}, seenSubjects = new Set(), seenSequences = new Set();
  for (const block of row.blocks) {
    const mode = MODES.find(mode => mode.mode === block.mode); assert(mode, 'Unknown mode; C/B is excluded');
    assert.equal(block.left, mode.left); assert.equal(block.right, mode.right);
    assert(Number.isSafeInteger(block.block) && block.block >= 0 && block.block < CONFIG.quartets);
    assert(Array.isArray(block.subjects) && block.subjects.length <= 4, 'Invalid quartet subject count');
    for (const subject of block.subjects) {
      assert(!seenSubjects.has(subject), 'Measured subjects must not be shared'); seenSubjects.add(subject);
      if (subject.sequence !== undefined) {
        assert(Number.isSafeInteger(subject.sequence) && subject.sequence >= 0);
        assert(!seenSequences.has(subject.sequence), 'Measured subject sequence reused'); seenSequences.add(subject.sequence);
      }
    }
  }
  for (const mode of MODES) {
    const blocks = row.blocks.filter(block => block.mode === mode.mode);
    assert.equal(new Set(blocks.map(block => block.block)).size, blocks.length, 'Duplicate quartet');
    const logs = [], pairs = [], orientations = [], flags = [...(row.plan?.validityReasons ?? [])];
    if (row.plan?.valid !== true) flags.push('invalid common plan');
    if (blocks.length !== CONFIG.quartets) flags.push('incomplete mode');
    for (const block of blocks) {
      if (block.subjects.length !== 4) { flags.push('incomplete quartet'); continue; }
      const roles = block.subjects.map(subject => subject.role);
      assert(['left,right,right,left', 'right,left,left,right'].includes(roles.join(',')), 'Quartet lost ABBA/BAAB balance');
      assert.deepEqual(roles, block.roles, 'Subject roles differ from frozen quartet'); orientations.push(roles[0]);
      const local = [];
      for (const subject of block.subjects) {
        if (subject.build !== undefined) assert.equal(subject.build, mode[subject.role], 'Subject build differs from mode');
        flags.push(...validateMeasured(subject, row.plan));
      }
      for (let index = 0; index < 4; index += 2) {
        const pair = block.subjects.slice(index, index + 2);
        const left = pair.find(subject => subject.role === 'left'), right = pair.find(subject => subject.role === 'right');
        const leftMs = median(left.samples) / left.repeat, rightMs = median(right.samples) / right.repeat;
        pairs.push({ block: block.block, pair: index / 2, leftMs, rightMs, latencyRatio: rightMs / leftMs });
        local.push(Math.log(rightMs / leftMs));
      }
      logs.push((local[0] + local[1]) / 2);
    }
    if (logs.length === CONFIG.quartets) assert.equal(orientations.filter(role => role === 'left').length, 2, 'Mode lost balanced quartet orientations');
    summary[mode.mode] = { leftBuild: mode.left, rightBuild: mode.right,
      matchedAA: mode.matchedAA ?? mode.mode, pairs, quartetLogLatencyRatios: logs, interval: logInterval(logs),
      leftMedianMs: pairs.length ? median(pairs.map(pair => pair.leftMs)) : null,
      rightMedianMs: pairs.length ? median(pairs.map(pair => pair.rightMs)) : null,
      validityReasons: [...new Set(flags)] };
  }
  // A B/B failure or drift affects H/B; a C/C failure or drift affects H/C.
  // Neither control is used to adjust a ratio or veto the other matched pair.
  for (const mode of MODES) {
    const value = summary[mode.mode], control = summary[mode.matchedAA ?? mode.mode];
    const invalid = [value, control].some(result => result.validityReasons.length || result.interval.quartets !== CONFIG.quartets);
    value.controlDrift = hasControlDrift(control.interval);
    value.inferenceUsable = !invalid && !value.controlDrift;
    value.conclusion = invalid ? 'invalid-or-incomplete' : value.controlDrift ? 'control-drift-inconclusive' : value.interval.classification;
  }
  return summary;
}
export function gateStatus(record, cases = CASES) {
  if (record.status !== 'completed' || !Array.isArray(record.rows) || record.rows.length !== CASES.length) return 'incomplete';
  assert.deepEqual(cases.map(row => row.name).sort(), [...CASE_NAMES].sort(), 'Selected cases changed');
  const lane = resolveLane(record.plan?.lane);
  if (new Set(record.rows.map(row => row.workload.name)).size !== CASES.length
      || record.rows.some(row => !CASE_NAMES.includes(row.workload.name))) return 'invalid-or-incomplete';
  const contrasts = record.rows.flatMap(row => MODES.filter(mode => mode.matchedAA).map(mode => row.summary?.[mode.mode]));
  const controls = record.rows.flatMap(row => ['aa-baseline', 'aa-current'].map(mode => row.summary?.[mode]));
  if ([...contrasts, ...controls].some(value => !value || value.conclusion === 'invalid-or-incomplete')) return 'invalid-or-incomplete';
  if ([...contrasts, ...controls].some(value => value.controlDrift)) return 'control-drift-inconclusive';
  if ([...contrasts, ...controls].some(value => !value.inferenceUsable)) return 'invalid-or-incomplete';
  if (contrasts.some(value => value.interval.classification === 'detected material loss')) return 'detected-material-loss';
  if (contrasts.some(value => value.interval.classification !== 'evidence within margin')) return 'statistical-inconclusive';
  const target = record.rows.find(row => row.workload.name === CASE_NAMES[2]);
  if (!(target.summary['helper-baseline'].interval.upper < 1)) return 'within-margin-without-established-target-gain';
  const empty = record.rows.find(row => row.workload.name === CASE_NAMES[0]);
  if (lane.browser && !(empty.summary['helper-current'].interval.upper < 1)) return 'within-margin-without-established-empty-repair';
  return 'selected-cells-within-margin-with-required-improvements';
}
