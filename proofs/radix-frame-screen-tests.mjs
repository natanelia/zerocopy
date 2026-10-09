import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTEXT, LANES, MODES, CONFIG, planFor, commonPlan, summarize, gateStatus } from './radix-frame-screen-protocol.mjs';
import { executeStudy, validateRecord, validatePrerequisiteRecord, requireSuccess, verifyProspective } from './radix-frame-screen-runner.mjs';
import { sha256, manifest } from './radix-frame-screen-source.mjs';
import { adaptFixture, registrationShim } from './radix-frame-screen-semantics.mjs';
import { comparableEngine, installedBrowserManifest } from './radix-frame-screen-engine.mjs';

// Only invented receipts and fake subjects are used. These tests do not call
// run(), launch a runtime/browser, build a fixture, or execute any timed kernel.
const clone = value => structuredClone(value);
const success = () => ({ status: 0, signal: null, error: null, timedOut: false, interrupted: null,
  cleanup: { status: 'verified-no-live-processes', survivors: [] } });
const neutral = '/invented/neutral';
const files = { 'package.json': 'invented-package', 'proofs/trie-view-subject.mjs': 'invented-subject',
  'proofs/trie-view-workloads.mjs': 'invented-workloads', 'proofs/trie-view-protocol.mjs': 'invented-protocol' };
function rawFor(lane, request, build) {
  const result = { phase: request.phase, status: 'completed', expectedDigest: 'invented-output', actualDigest: 'invented-output', flags: [],
    runtime: { name: lane.runtime, arch: lane.arch, version: lane.version, execArgv: [] },
    physical: { physicalRoot: neutral, packageSha256: files['package.json'] },
    sourceSha256: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('proofs/')).map(([name, hash]) => [name.slice(7), hash])),
    guards: { before: { digest: 'invented-immutable-bytes', allocated: 0 },
      after: { digest: 'invented-immutable-bytes', allocated: 0 }, allocatedSharedBytes: 0, immutableBytes: true } };
  if (request.kind === 'semantics') result.results = Array.from({ length: 17 }, (_, index) => ({ name: `invented-semantic-${index}`, status: 'passed' }));
  else if (request.phase === 'pilot') {
    result.prewarm = { targetMs: 500, elapsedMs: 500, operations: 1024, capped: false, batches: [{ repeat: 1024, ms: 500 }] };
    result.probes = lane.browser ? [{ repeat: 1024, samples: [51.2, 52.2, 53.2] }]
      : [{ repeat: 1, samples: [0.05, 0.06, 0.07] }, { repeat: 1024, samples: [51.2, 52.2, 53.2] }];
    result.estimateMsPerOperation = 0.05;
  } else if (request.phase === 'measure') {
    result.repeat = request.repeat; result.prescribedWarmupOperations = request.warmupOperations;
    result.warmup = { operations: request.warmupOperations,
      elapsedMs: request.warmupOperations / request.repeat * 40,
      batches: Array.from({ length: request.warmupOperations / request.repeat }, () => ({ repeat: request.repeat, ms: 40 })) };
    result.samples = Array(CONFIG.samples).fill(build === 'helper' ? 38 : 40);
  }
  return result;
}
function harness(lane, { mutatePilot, mutateMeasured, throwMeasured, throwFreeze } = {}) {
  const plan = planFor(lane.name), chronology = [], snapshots = [];
  const record = { status: 'completed', plan, rows: [], correctness: [], attempts: [],
    commands: Array.from({ length: 9 }, success),
    controller: { arch: lane.arch, platform: 'linux', versions: { node: CONTEXT.controllerNode }, execArgv: [] } };
  function retain(build, request, raw) {
    const sequence = record.attempts.length, commandSequence = record.commands.length;
    record.commands.push(success());
    record.attempts.push({ sequence, commandSequence, build, request: clone(request), neutral,
      before: clone(files), after: clone(files), status: raw.status, raw: lane.browser ? { raw } : raw });
    return { ...raw, build, sequence };
  }
  for (const expected of plan.correctness) {
    const request = { ...expected, phase: 'correctness' };
    record.correctness.push({ ...expected, result: retain(expected.build, request, rawFor(lane, request, expected.build)) });
  }
  let frozen = false, freezeCount = 0, measured = 0, pilots = 0, frozenPlans;
  const persist = () => snapshots.push({ calls: chronology.length, rows: record.rows.length,
    pilots: record.rows.reduce((sum, row) => sum + Object.keys(row.pilots).length, 0),
    subjects: record.rows.reduce((sum, row) => sum + row.blocks.reduce((n, block) => n + block.subjects.length, 0), 0),
    plansFrozen: record.plansFrozenBeforeMeasurement === true });
  const subject = async (build, request) => {
    assert(Object.isFrozen(plan.study.rows));
    chronology.push({ build, ...clone(request) });
    const raw = rawFor(lane, request, build);
    if (request.phase === 'pilot') {
      assert.equal(frozen, false); pilots++;
      mutatePilot?.(raw, { build, request, pilots });
    } else {
      assert.equal(frozen, true); assert.equal(pilots, 12); assert.equal(record.plansFrozenBeforeMeasurement, true);
      measured++;
      if (throwMeasured === measured) {
        raw.status = 'failed'; raw.samples = [40, 39, 0]; raw.error = 'invented positive-duration failure';
        retain(build, request, raw); persist(); throw new Error(raw.error);
      }
      mutateMeasured?.(raw, { build, request, measured });
    }
    return retain(build, request, raw);
  };
  const freezePlans = plans => {
    freezeCount++; assert.equal(pilots, 12); assert.equal(measured, 0); assert.equal(chronology.length, 12);
    assert.equal(plans.length, 4); assert(record.rows.every(row => row.blocks.length === 0));
    if (throwFreeze) throw new Error('invented freeze failure');
    frozenPlans = clone(plans); frozen = true;
  };
  return { record, plan, chronology, snapshots, run: () => executeStudy(record, plan, subject, persist, freezePlans),
    counts: () => ({ pilots, measured, freezeCount, frozen }), frozenPlans: () => frozenPlans };
}

test('both lane controllers finish all 12 pilots and four frozen plans before 256 fixed measured subjects', async () => {
  for (const lane of LANES) {
    const h = harness(lane), before = JSON.stringify(h.plan); await h.run();
    assert.deepEqual(h.counts(), { pilots: 12, measured: 256, freezeCount: 1, frozen: true });
    assert.equal(JSON.stringify(h.plan), before); assert.equal(h.chronology.length, 268);
    assert(h.chronology.slice(0, 12).every(item => item.phase === 'pilot'));
    assert(h.chronology.slice(12).every(item => item.phase === 'measure'));
    assert.equal(h.record.rows.length, 4);
    assert.deepEqual(h.frozenPlans(), h.record.rows.map(({ workload, plan }) => ({ workload, plan })));
    for (const row of h.record.rows) {
      assert.deepEqual(Object.keys(row.pilots), row.pilotOrder);
      assert.deepEqual(row.plan, commonPlan(row.pilots, lane)); assert.equal(row.plan.valid, true);
      assert.equal(row.blocks.length, 16); assert.equal(row.blocks.reduce((sum, block) => sum + block.subjects.length, 0), 64);
      assert.deepEqual(row.summary, summarize(row));
      assert.deepEqual(Object.keys(row.summary), MODES.map(mode => mode.mode));
    }
    const subjects = h.record.rows.flatMap(row => row.blocks.flatMap(block => block.subjects));
    assert.equal(new Set(subjects.map(subject => subject.sequence)).size, 256);
    assert.equal(subjects.reduce((sum, subject) => sum + subject.samples.length, 0), 5376);
    assert(h.snapshots.some(snapshot => snapshot.pilots === 12 && snapshot.subjects === 0 && snapshot.plansFrozen));
    h.record.outcome = gateStatus(h.record);
    assert.equal(h.record.outcome, 'selected-cells-within-margin-with-required-improvements');
    assert.equal(validateRecord(h.record), true);
  }
});

test('runner follows every frozen pilot and quartet role mapping with four independently executed modes', async () => {
  for (const lane of LANES) {
    const h = harness(lane); await h.run();
    assert.deepEqual(h.chronology.slice(0, 12), h.plan.study.rows.flatMap(row => row.pilotOrder.map(build =>
      ({ build, name: row.workload.name, phase: 'pilot' }))));
    const expected = h.record.rows.flatMap(row => row.schedule.flatMap(block => block.roles.map(role =>
      ({ build: block[role], name: row.workload.name, phase: 'measure', repeat: row.plan.repeat, warmupOperations: row.plan.warmupOperations }))));
    assert.deepEqual(h.chronology.slice(12), expected);
    const modeSequences = Object.fromEntries(MODES.map(mode => [mode.mode, new Set()]));
    for (const row of h.record.rows) for (const [index, block] of row.blocks.entries()) {
      const planned = row.schedule[index]; assert.equal(block.mode, planned.mode);
      assert.deepEqual(block.subjects.map(subject => subject.role), planned.roles);
      assert.deepEqual(block.subjects.map(subject => subject.build), planned.roles.map(role => planned[role]));
      block.subjects.forEach(subject => modeSequences[block.mode].add(subject.sequence));
    }
    for (const mode of MODES) assert.equal(modeSequences[mode.mode].size, 64);
    assert.equal(new Set(Object.values(modeSequences).flatMap(value => [...value])).size, 256);
    assert(!Object.keys(modeSequences).some(mode => mode === 'ab' || mode === 'current-baseline'));
  }
});

test('invalid pilot receipt is retained and stops immediately without a replacement or measurements', async () => {
  for (const lane of LANES) for (const mutation of [
    raw => { raw.status = 'failed'; }, raw => { raw.probes[0].samples[0] = 0; },
    raw => { raw.probes[0].repeat = lane.browser ? 1 : 1024;
      raw.estimateMsPerOperation = Math.min(...raw.probes.flatMap(probe => probe.samples.map(ms => ms / probe.repeat))); },
  ]) {
    const h = harness(lane, { mutatePilot: (raw, { pilots }) => { if (pilots === 2) mutation(raw); } });
    await assert.rejects(h.run());
    assert.deepEqual(h.counts(), { pilots: 2, measured: 0, freezeCount: 0, frozen: false });
    assert.equal(h.chronology.length, 2); assert.equal(h.record.rows.length, 1);
    assert.equal(Object.keys(h.record.rows[0].pilots).length, 2);
    assert.equal(h.record.rows[0].blocks.length, 0);
    assert.equal(h.snapshots.at(-1).pilots, 2);
    assert.equal(h.record.plansFrozenBeforeMeasurement, undefined);
  }
});

test('invalid common plan or cross-build digest stops after the first three pilots and retains the evidence', async () => {
  for (const lane of LANES) for (const mutation of [
    raw => { raw.prewarm.capped = true; }, raw => { raw.flags.push('invented integrity failure'); },
    raw => { raw.expectedDigest = 'invented-mismatch'; },
  ]) {
    const h = harness(lane, { mutatePilot: (raw, { pilots }) => { if (pilots === 1) mutation(raw); } });
    await assert.rejects(h.run());
    assert.deepEqual(h.counts(), { pilots: 3, measured: 0, freezeCount: 0, frozen: false });
    assert.equal(h.chronology.length, 3); assert.equal(h.record.rows.length, 1);
    assert.equal(Object.keys(h.record.rows[0].pilots).length, 3);
    assert.equal(h.snapshots.at(-1).pilots, 3); assert.equal(h.snapshots.at(-1).subjects, 0);
  }
});

test('failed plan persistence never admits measured subjects', async () => {
  const h = harness(LANES[0], { throwFreeze: true });
  await assert.rejects(h.run(), /invented freeze failure/);
  assert.deepEqual(h.counts(), { pilots: 12, measured: 0, freezeCount: 1, frozen: false });
  assert.equal(h.record.plansFrozenBeforeMeasurement, undefined);
  assert(h.record.rows.every(row => row.blocks.length === 0));
});

test('a subject exception retains preceding subjects and partial failed receipt, then stops without retry', async () => {
  for (const lane of LANES) {
    const h = harness(lane, { throwMeasured: 6 });
    await assert.rejects(h.run(), /invented positive-duration failure/);
    assert.deepEqual(h.counts(), { pilots: 12, measured: 6, freezeCount: 1, frozen: true });
    assert.equal(h.chronology.length, 18);
    assert.deepEqual(h.record.rows[0].blocks.map(block => block.subjects.length), [4, 1]);
    assert(h.record.rows.slice(1).every(row => row.blocks.length === 0));
    const attempt = h.record.attempts.at(-1), raw = lane.browser ? attempt.raw.raw : attempt.raw;
    assert.equal(attempt.status, 'failed'); assert.deepEqual(raw.samples, [40, 39, 0]);
    assert.equal(h.snapshots.at(-1).subjects, 5);
    assert(h.record.rows.every(row => row.summary === undefined));
  }
});

test('failed, malformed or below-floor measured receipt is persisted before immediate stop', async () => {
  for (const lane of LANES) for (const mutation of [
    raw => { raw.status = 'failed'; }, raw => { raw.samples[0] = 0; },
    raw => { raw.samples[0] = 9; }, raw => { raw.repeat++; },
    raw => { raw.flags.push('invented cleanup failure'); },
    raw => { raw.warmup.batches.forEach(batch => { batch.ms = 1; }); raw.warmup.elapsedMs = raw.warmup.batches.length; },
  ]) {
    const h = harness(lane, { mutateMeasured: (raw, { measured }) => { if (measured === 6) mutation(raw); } });
    await assert.rejects(h.run());
    assert.deepEqual(h.counts(), { pilots: 12, measured: 6, freezeCount: 1, frozen: true });
    assert.equal(h.chronology.length, 18);
    assert.deepEqual(h.record.rows[0].blocks.map(block => block.subjects.length), [4, 2]);
    assert.equal(h.snapshots.at(-1).subjects, 6);
    assert(h.record.rows.slice(1).every(row => row.blocks.length === 0));
  }
});

test('completed-record validator recomputes schedules, identities, common plans, summaries and gate', async () => {
  for (const lane of LANES) {
    const h = harness(lane); await h.run(); h.record.outcome = gateStatus(h.record);
    assert.equal(validateRecord(h.record), true);
    for (const mutate of [record => { record.outcome = 'invented-pass'; },
      record => { record.plansFrozenBeforeMeasurement = false; }, record => { record.attempts.pop(); },
      record => { record.commands.pop(); }, record => { record.correctness.pop(); },
      record => { record.rows[0].plan.repeat++; },
      record => { record.rows[0].summary['helper-baseline'].interval.upper = 0; },
      record => { record.rows[0].blocks[0].subjects[0].build = 'invented-build'; },
      record => { record.rows[0].blocks[0].subjects[0].sequence++; },
      record => { record.rows[0].blocks[0].subjects[0].guards.immutableBytes = false; },
      record => { record.rows[0].blocks[0].subjects[0].actualDigest = 'changed'; },
      record => { record.rows[0].blocks[0].mode = 'current-baseline'; },
      record => { record.rows[0].pilotOrder.reverse(); },
      record => { record.commands[0].cleanup.status = 'incomplete'; },
    ]) {
      const changed = clone(h.record); mutate(changed); assert.throws(() => validateRecord(changed));
    }
  }
});

test('outer process success requires every exit and independent cleanup receipt to succeed', () => {
  assert.doesNotThrow(() => requireSuccess(success()));
  for (const mutate of [receipt => { receipt.status = 1; }, receipt => { receipt.signal = 'SIGTERM'; },
    receipt => { receipt.error = 'invented error'; }, receipt => { receipt.timedOut = true; },
    receipt => { receipt.interrupted = 'invented interruption'; }, receipt => { delete receipt.cleanup; },
    receipt => { receipt.cleanup.status = 'incomplete'; }, receipt => { receipt.cleanup.survivors = [123]; }]) {
    const receipt = success(); mutate(receipt); assert.throws(() => requireSuccess(receipt));
  }
});

function fakePrerequisiteEvidence() {
  const directory = mkdtempSync(join(tmpdir(), 'radix-frame-fake-prerequisite-'));
  const save = (name, value) => {
    const path = join(directory, name); mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return sha256(readFileSync(path));
  };
  const lane = LANES[0], plan = planFor(lane.name), prospectiveSha256 = verifyProspective();
  const invocation = { proofCommit: 'a'.repeat(40), runId: '123', runAttempt: 1, lane: lane.name, protocol: CONTEXT.protocol };
  const pins = JSON.parse(readFileSync(new URL('./radix-portability-pins.json', import.meta.url)));
  const engine = { bun: { path: '/invented/bin/bun', version: '1.4.2', revision: LANES[1].revision, sha256: 'b'.repeat(64) },
    controller: { path: '/invented/bin/node', version: '22.23.3', sha256: 'c'.repeat(64) },
    playwright: '1.63.0', packages: { playwright: { sha256: 'd'.repeat(64), files: { 'index.mjs': 'e'.repeat(64) } },
      'playwright-core': { sha256: 'f'.repeat(64), files: { 'index.mjs': '1'.repeat(64) } } },
    browsersJsonSha256: pins.playwright.browsersJsonSha256,
    revision: { name: 'webkit', revision: '2359', browserVersion: '26.6' },
    installed: { root: '/invented/webkit-2359', launcher: { path: '/invented/webkit-2359/pw_run.sh', sha256: '2'.repeat(64) },
      files: { 'pw_run.sh': '2'.repeat(64), 'MiniBrowser': '3'.repeat(64) }, symlinks: {}, nativeElfFiles: { 'MiniBrowser': '3'.repeat(64) } } };
  for (const name of ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs']) save(`proof/proofs/${name}`, `// invented ${name}`);
  save('bundles/helper/dist/shared.js', '// invented inert bundle'); save('bundles/helper/package.json', '{}');
  save('sources/helper/arena.ts', '// invented inert source'); save('derived/subject.mjs', '// invented inert adapter');
  const semanticSha256 = save('semantics/bundle/semantics.js', '// invented inert semantic bundle');
  const inputManifests = Object.fromEntries(['proof', 'bundles', 'sources', 'derived', 'semantics'].map(name => [name, manifest(join(directory, name))]));
  const before = Object.fromEntries([
    ...Object.entries(inputManifests.bundles).map(([name, hash]) => [name.slice('helper/'.length), hash]),
    ...Object.entries(inputManifests.proof),
  ].sort(([a], [b]) => a.localeCompare(b)));
  const request = { kind: 'semantics', phase: 'correctness', name: 'exact-helper-semantics',
    semanticBundle: join(directory, 'semantics/bundle/semantics.js'), semanticSha256 };
  const raw = { status: 'completed', request: { ...request, lane: lane.name, neutral: join(directory, 'neutral') },
    before: clone(before), after: clone(before), provenance: clone(engine),
    engine: { name: 'webkit', version: '26.6', launcher: clone(engine.installed.launcher) },
    playwright: '1.63.0', browserRevisions: { sha256: pins.playwright.browsersJsonSha256 },
    pageErrors: [], workers: [], browser: { launched: true, closeRequested: true, closeCompleted: true, disconnected: true },
    workerCloseBarrier: { expectedWorkers: 0, timeoutMs: 30000, completed: true }, serverClosed: true,
    requests: [{ path: '/study/semantics.js', sha256: semanticSha256 }],
    raw: { status: 'completed', results: Array.from({ length: 17 }, (_, index) => ({ name: `invented-semantic-${index}`, status: 'passed' })) } };
  const commandIds = ['baseline', 'current', 'helper'].flatMap(build => ['build:wasm', 'build:browser', 'build:types',
    'typecheck', 'typecheck:values', 'typecheck:redux', 'typecheck:geometry', 'test', 'check:package'].map(script => `${build}/${script}`))
    .concat(['helper/focused-node-semantics', 'helper/build-semantic-browser-overlay', 'correctness/helper/exact-helper-semantics']);
  const commands = commandIds.map((id, sequence) => {
    const stdout = `commands/${sequence}.stdout`, stderr = `commands/${sequence}.stderr`;
    return { ...success(), id, sequence, stdout, stderr,
      stdoutSha256: save(stdout, sequence === 29 ? raw : 'invented successful command output'), stderrSha256: save(stderr, '') };
  });
  const sources = Object.fromEntries(['baseline', 'current', 'helper'].map(role => [role,
    { commit: role === 'helper' ? CONTEXT.helperCommit : CONTEXT[role], files: {}, production: {}, bundle: {}, wasm: {}, compilers: {} }]));
  const frozen = { invocation: clone(invocation), plan: clone(plan), prospectiveSha256,
    sourceReceipts: sources, engine: clone(engine), manifests: clone(inputManifests) };
  const record = { status: 'prerequisites-completed', prerequisitesOnly: true, plan, invocation, prospectiveSha256,
    controller: { arch: lane.arch, platform: lane.platform, versions: { node: CONTEXT.controllerNode }, execArgv: [] },
    rows: [], correctness: [], commands, sources, inputManifests, engineFrozen: engine,
    engine: { engine: clone(raw.engine), playwright: raw.playwright, browserRevisions: clone(raw.browserRevisions) },
    semanticCorrectness: { ...clone(raw.raw), build: 'helper', sequence: 0 },
    attempts: [{ sequence: 0, commandSequence: 29, build: 'helper', status: 'completed', request,
      neutral: join(directory, 'neutral'), before: clone(before), after: clone(before), raw }] };
  const sealFrozen = () => {
    record.frozenStudySha256 = save('frozen-study.json', frozen);
    save('frozen-study.sha256', record.frozenStudySha256 + '\n');
  };
  const sealRaw = () => { commands[29].stdoutSha256 = save(commands[29].stdout, raw); };
  sealFrozen();
  return { directory, record, raw, frozen, invocation, save, sealRaw, sealFrozen,
    validate: () => validatePrerequisiteRecord(record, directory, invocation),
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('sealed shared prerequisite receipt admits no timing and binds all 30 successful commands', () => {
  const fixture = fakePrerequisiteEvidence();
  try {
    assert.equal(fixture.validate(), true);
    assert.equal(fixture.record.commands.length, 30); assert.equal(fixture.record.attempts.length, 1);
    assert.deepEqual(fixture.record.rows, []);
    for (const mutate of [record => { record.status = 'failed'; }, record => { record.prerequisitesOnly = false; },
      record => { record.invocation.runId = '124'; }, record => { record.commands[7].status = 1; },
      record => { record.commands[7].cleanup.survivors = [123]; }, record => { record.commands[7].id = 'helper/skipped-test'; },
      record => { record.semanticCorrectness.results[0].status = 'failed'; }, record => { record.rows.push({}); }]) {
      const record = clone(fixture.record); mutate(record);
      assert.throws(() => validatePrerequisiteRecord(record, fixture.directory, fixture.invocation));
    }
  } finally { fixture.cleanup(); }
});

test('semantic prerequisite revalidation rejects altered raw request, served bytes, provenance or immutable snapshots', () => {
  for (const mutate of [raw => { raw.request.name = 'different-suite'; },
    raw => { raw.before['package.json'] = 'different-package'; }, raw => { raw.after['package.json'] = 'different-package'; },
    raw => { raw.requests[0].sha256 = 'different-served-script'; }, raw => { raw.requests = []; },
    raw => { raw.engine.name = 'chromium'; }, raw => { raw.playwright = '1.62.0'; },
    raw => { raw.browserRevisions.sha256 = 'different-revisions'; }, raw => { raw.provenance.bun.sha256 = 'different-bun'; },
    raw => { raw.pageErrors.push('invented page error'); }, raw => { raw.serverClosed = false; }]) {
    const fixture = fakePrerequisiteEvidence();
    try { mutate(fixture.raw); fixture.sealRaw(); assert.throws(fixture.validate, undefined, mutate.toString()); }
    finally { fixture.cleanup(); }
  }
});

test('semantic prerequisite frozen metadata is bound to the current proof, invocation and complete plan', () => {
  for (const mutate of [frozen => { frozen.invocation.proofCommit = 'b'.repeat(40); },
    frozen => { frozen.plan.context.helperCommit = 'b'.repeat(40); }, frozen => { frozen.prospectiveSha256 = 'b'.repeat(64); }]) {
    const fixture = fakePrerequisiteEvidence();
    try { mutate(fixture.frozen); fixture.sealFrozen(); assert.throws(fixture.validate); }
    finally { fixture.cleanup(); }
  }
});

test('semantic adaptation preserves the exact remaining fixture helpers and rejects a changed fixture', () => {
  const original = readFileSync(new URL('./trie-view-fixtures.ts', import.meta.url), 'utf8');
  const adapted = adaptFixture(original), suffix = original.slice(original.indexOf('export function withMethods<'));
  assert(adapted.source.endsWith(suffix)); assert(adapted.source.includes('class BaselineTraversal'));
  assert.equal(adapted.originalSha256, sha256(original)); assert.equal(adapted.sourceSha256, sha256(adapted.source));
  assert.throws(() => adaptFixture(original + '\n'));
});

test('semantic registration executes exactly 17 frozen callbacks and preserves a first failure', async () => {
  const load = nonce => import(`data:text/javascript,${encodeURIComponent(registrationShim + `\n// ${nonce}`)}`);
  const successful = await load('all-pass'); let calls = 0;
  successful.describe('invented scope', () => {
    for (let index = 0; index < 17; index++) successful.it(`case ${index}`, () => { calls++; });
  });
  const passed = await successful.runSemantics(); assert.equal(calls, 17); assert.equal(passed.status, 'completed');
  assert.equal(new Set(passed.results.map(row => row.name)).size, 17);
  const failing = await load('first-failure'); calls = 0;
  for (let index = 0; index < 17; index++) failing.it(`case ${index}`, () => { calls++; if (index === 7) throw new Error('invented semantic failure'); });
  const failed = await failing.runSemantics(); assert.equal(calls, 8); assert.equal(failed.status, 'failed');
  assert.equal(failed.results.length, 8); assert.equal(failed.results.at(-1).status, 'failed');
  const missing = await load('missing-case'); missing.it('single', () => {});
  await assert.rejects(missing.runSemantics(), /exactly 17/);
});

test('shared correctness engine comparison ignores only host paths and retains every relevant binary/package digest', () => {
  const fixture = fakePrerequisiteEvidence();
  try {
    const original = fixture.record.engineFrozen, moved = clone(original);
    moved.bun.path = '/different/bun'; moved.controller.path = '/different/node';
    moved.installed.root = '/different/webkit-2359'; moved.installed.launcher.path = '/different/webkit-2359/pw_run.sh';
    for (const browser of [false, true]) {
      const before = JSON.stringify(original), expected = comparableEngine(original, browser);
      assert.deepEqual(comparableEngine(moved, browser), expected);
      assert.equal(JSON.stringify(original), before);
      for (const mutate of [engine => { engine.bun.sha256 = 'different'; },
        engine => { engine.bun.version = '1.4.3'; }, engine => { engine.bun.revision = 'different'; },
        engine => { engine.controller.sha256 = 'different'; }, engine => { engine.controller.version = '22.24.0'; }]) {
        const changed = clone(original); mutate(changed); assert.notDeepEqual(comparableEngine(changed, browser), expected);
      }
    }
    const webkit = comparableEngine(original, true);
    for (const mutate of [engine => { engine.playwright = '1.62.0'; },
      engine => { engine.packages.playwright.sha256 = 'different'; }, engine => { engine.packages['playwright-core'].files['index.mjs'] = 'different'; },
      engine => { engine.browsersJsonSha256 = 'different'; }, engine => { engine.revision.revision = '2358'; },
      engine => { engine.installed.launcher.sha256 = 'different'; }, engine => { engine.installed.files.MiniBrowser = 'different'; },
      engine => { engine.installed.nativeElfFiles.MiniBrowser = 'different'; }, engine => { engine.installed.symlinks.lib = 'different'; }]) {
      const changed = clone(original); mutate(changed); assert.notDeepEqual(comparableEngine(changed, true), webkit);
    }
    assert.deepEqual(comparableEngine({ bun: clone(original.bun), controller: clone(original.controller) }, false), comparableEngine(original, false));
  } finally { fixture.cleanup(); }
});

test('browser installation provenance hashes inert native ELF fixtures beyond the launcher and rejects external symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radix-frame-fake-installation-'));
  try {
    const launcher = join(directory, 'pw_run.sh'); writeFileSync(launcher, '# invented inert launcher');
    assert.throws(() => installedBrowserManifest(launcher), /Missing native WebKit ELF/);
    mkdirSync(join(directory, 'engine'));
    writeFileSync(join(directory, 'engine/MiniBrowser'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
    writeFileSync(join(directory, 'engine/libEngine.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 4, 5, 6]));
    symlinkSync('engine/MiniBrowser', join(directory, 'browser-link'));
    const original = installedBrowserManifest(launcher);
    assert.equal(Object.keys(original.nativeElfFiles).length, 2);
    assert.equal(original.files['engine/MiniBrowser'], sha256(readFileSync(join(directory, 'engine/MiniBrowser'))));
    assert.equal(original.symlinks['browser-link'], 'engine/MiniBrowser');
    writeFileSync(join(directory, 'engine/libEngine.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 4, 5, 7]));
    const changed = installedBrowserManifest(launcher);
    assert.equal(original.launcher.sha256, changed.launcher.sha256);
    assert.notDeepEqual(original.nativeElfFiles, changed.nativeElfFiles);
    symlinkSync(tmpdir(), join(directory, 'external-link'));
    assert.throws(() => installedBrowserManifest(launcher), /External browser symlink/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
