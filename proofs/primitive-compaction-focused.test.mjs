import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS, CASES, PROTOCOL, COMPARISONS, measurementSchedule, chooseWorkPlan, summarizeQuartet, guardedPath, assertOnlyCompactionDiff,
  buildManifest, buildDigest, materializeBundle, neutralRequest, subjectEnvironment } from './primitive-compaction-focused.mjs';

test('the study is fixed to the three commits and four requested cases', () => {
  assert.deepEqual(Object.values(PINS), ['3331f2f0e9e0c3c61832e5f04b12e18c1889d96c', 'c5a242cd641e4ee96005296fab485e332a1394b7', 'b1e3d9d27b55ce5c4a0267f99b72c6862a58bf59']);
  assert.deepEqual(CASES.map(row => row.name), ['list/number/0', 'linked/number/31', 'doubly/number/32', 'linked/boolean/32']);
  assert.equal(PROTOCOL.warmupCalls, 512); assert.ok(PROTOCOL.warmupCalls > 16);
  assert.equal(PROTOCOL.cycles, 6); assert.equal(PROTOCOL.pilotReplicates, 3);
  assert.ok(Object.isFrozen(PROTOCOL)); assert.ok(CASES.every(Object.isFrozen));
});

test('every case/comparison has three ABBA and three BAAB quartets with balanced comparison positions', () => {
  const schedule = measurementSchedule();
  assert.equal(schedule.length, 72); assert.equal(schedule.length * 4, 288);
  for (const workload of CASES) for (const comparison of COMPARISONS) {
    const matching = schedule.filter(row => row.case.name === workload.name && row.comparison.name === comparison.name);
    assert.equal(matching.length, 6);
    for (const order of ['ABBA', 'BAAB']) {
      const selected = matching.filter(row => row.order.join('') === order);
      assert.equal(selected.length, 3);
      const positions = selected.map(row => schedule.indexOf(row) % COMPARISONS.length).sort();
      assert.deepEqual(positions, [0, 1, 2]);
    }
    for (const row of matching) {
      assert.equal(row.order.filter(role => role === 'A').length, 2);
      assert.equal(row.order.filter(role => role === 'B').length, 2);
    }
  }
  assert.equal(COMPARISONS.find(row => row.name.endsWith('-aa')).a, 'main');
  assert.equal(COMPARISONS.find(row => row.name.endsWith('-aa')).b, 'main');
});

function syntheticPilots(rates = { main: 0.1, old: 0.08, narrow: 0.05 }) {
  return CASES.flatMap(workload => Object.entries(rates).flatMap(([variant, rate]) => Array.from({ length: 3 }, (_item, replicate) => ({
    variant, case: workload, replicate, result: { repeat: 64, samples: Array.from({ length: 5 }, () => ({ perOperationMs: rate })) },
  }))));
}

test('disposable pilots choose one global power-of-two work count from the fastest robust build rate', () => {
  const pilots = syntheticPilots(), plan = chooseWorkPlan(pilots);
  for (const workload of CASES) {
    assert.equal(plan[workload.name].repeat, 512);
    assert.equal(plan[workload.name].requestedRepeat, 400);
    assert.equal(plan[workload.name].fastestMedianMs, 0.05);
    assert.equal(plan[workload.name].predictedFastestBatchMs, 25.6);
    assert.equal(plan[workload.name].capped, false);
  }
  // One anomalous pilot process does not define a build's median rate.
  for (const sample of pilots.find(row => row.variant === 'narrow').result.samples) sample.perOperationMs = 0.00001;
  assert.equal(chooseWorkPlan(pilots)[CASES[0].name].repeat, 512);
  assert.equal(new Set(measurementSchedule().filter(row => row.case.name === CASES[0].name).map(row => plan[row.case.name].repeat)).size, 1);
});

test('work-plan caps and invalid/incomplete pilots remain visible rather than triggering adaptive remeasurement', () => {
  const capped = chooseWorkPlan(syntheticPilots({ main: 0.0001, old: 0.0002, narrow: 0.0003 }));
  assert.ok(Object.values(capped).every(row => row.repeat === 2048 && row.capped && row.predictedFastestBatchMs < 20));
  assert.throws(() => chooseWorkPlan(syntheticPilots().slice(1)), /Missing pilots/);
  const duplicate = syntheticPilots(); duplicate[1].replicate = 0;
  assert.throws(() => chooseWorkPlan(duplicate), /distinct/);
  const invalid = syntheticPilots(); invalid[0].result.samples[0].perOperationMs = 0;
  assert.throws(() => chooseWorkPlan(invalid));
});

test('quartet estimates compare symmetric slot means and retain short-batch counts', () => {
  for (const order of [['A', 'B', 'B', 'A'], ['B', 'A', 'A', 'B']]) {
    const row = { subjects: order.map((role, position) => ({ role, result: { medianMs: 10 + position, shortBatches: position } })) };
    assert.deepEqual(summarizeQuartet(row), { aMedianMs: 11.5, bMedianMs: 11.5, ratio: 1, shortBatches: 6 });
  }
  assert.throws(() => summarizeQuartet({ subjects: [] }));
});

test('source guards reject added/deleted runtime inputs and package/build changes', () => {
  for (const name of ['arena.ts', 'extra.ts', 'new.wasm', 'package.json', 'scripts/build-extra.mjs']) assert.equal(guardedPath(name), true);
  for (const name of ['unit.test.ts', 'proofs/diagnostic.mjs', 'node_modules/extra.ts']) assert.equal(guardedPath(name), false);
  const main = { 'arena.ts': 'a', 'compaction.ts': 'main', 'package.json': 'p', 'scripts/build-wasm.mjs': 'b' };
  const old = { ...main, 'compaction.ts': 'old' };
  assertOnlyCompactionDiff(main, old);
  assert.throws(() => assertOnlyCompactionDiff(main, { ...old, 'new.ts': 'x' }));
  assert.throws(() => assertOnlyCompactionDiff(main, { ...old, 'package.json': 'changed' }));
  assert.throws(() => assertOnlyCompactionDiff(main, { ...old, 'scripts/build-wasm.mjs': 'changed' }));
  const missing = { ...old }; delete missing['arena.ts']; assert.throws(() => assertOnlyCompactionDiff(main, missing));
});

test('different verified bundles reuse one canonical entry path without leftover files or symlinks', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compaction-neutral-test-')));
  try {
    const first = join(root, 'first'), second = join(root, 'second'), neutral = join(root, 'neutral');
    for (const directory of [first, second, neutral]) mkdirSync(directory);
    writeFileSync(join(first, 'shared.js'), 'export const value = 1;'); writeFileSync(join(first, 'old-chunk.js'), 'export {};');
    writeFileSync(join(second, 'shared.js'), 'export const value = 2;'); mkdirSync(join(second, 'nested'));
    writeFileSync(join(second, 'nested/data.json'), '{}');
    const firstDigest = buildDigest(first), secondDigest = buildDigest(second);
    const firstURL = materializeBundle(first, neutral, firstDigest);
    assert.equal(buildDigest(neutral), firstDigest); assert.deepEqual(buildManifest(neutral), buildManifest(first));
    const secondURL = materializeBundle(second, neutral, secondDigest);
    assert.equal(secondURL, firstURL); assert.equal(realpathSync(fileURLToPath(secondURL)), join(neutral, 'shared.js'));
    assert.equal(buildDigest(neutral), secondDigest); assert.deepEqual(readdirSync(neutral).sort(), ['nested', 'shared.js']);
    assert.equal(readFileSync(join(neutral, 'shared.js'), 'utf8'), 'export const value = 2;');
    writeFileSync(join(neutral, 'shared.js'), 'changed'); assert.notEqual(buildDigest(neutral), secondDigest);
    assert.throws(() => materializeBundle(first, neutral, secondDigest), /Source bundle changed/);
    symlinkSync(join(first, 'shared.js'), join(second, 'linked.js'));
    assert.throws(() => buildManifest(second), /symlink/);
    const alias = join(root, 'alias'); symlinkSync(neutral, alias, 'dir');
    assert.throws(() => materializeBundle(first, alias, firstDigest), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('child requests and environments do not carry selected variant labels or source checkout paths', () => {
  const request = neutralRequest({ phase: 'measure', caseName: 'linked/number/31', repeat: 256,
    variant: 'old', pin: PINS.old, source: '/source/old/dist', role: 'B', workPlanSHA256: 'plan' }, '/neutral/dist', 'digest');
  assert.deepEqual(request, { phase: 'measure', caseName: 'linked/number/31', repeat: 256,
    workPlanSHA256: 'plan', neutralDirectory: '/neutral/dist', buildDigest: 'digest' });
  assert.equal(neutralRequest({ phase: 'pilot', repeat: 999, caseName: 'list/number/0' }, '/neutral/dist', 'digest').repeat, 64);
  const env = { FOCUSED_MAIN_DIR: '/source/main', FOCUSED_OLD_DIR: '/source/old', FOCUSED_NARROW_DIR: '/source/narrow', PATH: '/bin' };
  assert.deepEqual(subjectEnvironment(env), { PATH: '/bin' }); assert.equal(env.FOCUSED_MAIN_DIR, '/source/main');
});
