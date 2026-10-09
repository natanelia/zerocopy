import assert from 'node:assert/strict';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { CONTEXT, LANES, CONFIG, LIMITS, planFor, requireCI, validatePilot, commonPlan, validateMeasured, summarize, gateStatus } from './radix-frame-screen-protocol.mjs';
import { engineIdentity, comparableEngine } from './radix-frame-screen-engine.mjs';
import { compilerManifest } from './trie-view-source.mjs';
import { deriveBrowser } from './radix-browser-recovery-adapter.mjs';
import { runBoundedCommand } from './radix-portability-process.mjs';
import { json, sha256, manifest, writeJson, verifyTriple } from './radix-frame-screen-source.mjs';
import { replaceOnce } from './radix-portability-adapter.mjs';
import { PROOF_FILES as ORIGINAL_PROOF_FILES, verifyProspective as verifyOriginalProspective } from './radix-browser-recovery-runner.mjs';
import { validateBrowserLifecycle } from './radix-browser-recovery-lifecycle.mjs';
import { section } from './radix-browser-recovery-adapter.mjs';
const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
export const PROOF_FILES = Object.freeze([
  ...ORIGINAL_PROOF_FILES, 'proofs/radix-browser-recovery-manifest.json',
  '.github/workflows/radix-frame-screen.yml', 'proofs/radix-frame-screen.md',
  'proofs/radix-frame-screen-pins.json', 'proofs/radix-frame-screen-setup.sh', 'proofs/radix-frame-screen-proposal.test.txt',
  ...['protocol', 'protocol-tests', 'source', 'engine', 'semantics', 'browser', 'runner', 'tests'].map(name => `proofs/radix-frame-screen-${name}.mjs`),
]);
const CHECKS = Object.freeze(['build:wasm', 'build:browser', 'build:types', 'typecheck', 'typecheck:values', 'typecheck:redux', 'typecheck:geometry', 'test', 'check:package']);
const subjectFiles = ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs'];
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); };
const hardware = () => ({ at: new Date().toISOString(), cpus: os.cpus(), loadavg: os.loadavg(), freemem: os.freemem(), totalmem: os.totalmem(), uptimeSeconds: os.uptime() });
export function prospectiveManifest() {
  const originalManifestSha256 = verifyOriginalProspective();
  const derivation = deriveBrowser();
  const adapters = Object.fromEntries(Object.entries(derivation).map(([name, { source, ...receipt }]) => [name, receipt]));
  const originalBrowser = readFileSync(join(here, 'radix-browser-recovery-browser.mjs'), 'utf8');
  const browser = readFileSync(join(here, 'radix-frame-screen-browser.mjs'), 'utf8');
  const preservedBrowserSections = Object.fromEntries([
    ['workerCloseBarrier', "    checkpoint('worker-close');", '\n  } catch (error)'],
    ['cleanup', '\n  } catch (error)', '\n  return result;'],
  ].map(([name, start, end]) => {
    const bytes = section(originalBrowser, start, end); assert.equal(section(browser, start, end), bytes, `Changed corrected browser ${name}`);
    return [name, sha256(bytes)];
  }));
  return { schema: 1, stage: 'prospective selected-cell helper diagnostic; no timing claim', originalManifestSha256, context: CONTEXT, plans: LANES.map(lane => planFor(lane.name)),
    files: Object.fromEntries(PROOF_FILES.map(file => [file, sha256(readFileSync(join(root, file)))])), adapters, preservedBrowserSections,
    expectedTotal: { lanes: 2, cells: 8, pilots: 24, measuredSubjects: 512, measuredBatches: 10752, quartets: 128 },
    publication: 'Local preparation only. Publication and the single scoped-push execution require parent review of this exact tree.' };
}
export function verifyProspective() {
  const bytes = readFileSync(join(here, 'radix-frame-screen-manifest.json'));
  assert.deepEqual(JSON.parse(bytes), prospectiveManifest(), 'Prospective files, protocol or adapters changed');
  return sha256(bytes);
}
export function requireSuccess(receipt) {
  assert.equal(receipt.status, 0); assert.equal(receipt.signal, null); assert.equal(receipt.error, null);
  assert.equal(receipt.timedOut, false); assert.equal(receipt.interrupted, null);
  assert.equal(receipt.cleanup?.status, 'verified-no-live-processes'); assert.deepEqual(receipt.cleanup.survivors, []);
}
async function command(evidence, record, spec, persist, signal) {
  const sequence = record.commands.length, prefix = `commands/${String(sequence).padStart(4, '0')}`;
  const receipt = { sequence, ...spec, startedAt: new Date().toISOString(), stdout: prefix + '.stdout', stderr: prefix + '.stderr', status: null };
  record.commands.push(receipt); persist(); mkdirSync(join(evidence, 'commands'), { recursive: true });
  const out = openSync(join(evidence, receipt.stdout), 'wx'), err = openSync(join(evidence, receipt.stderr), 'wx');
  try { Object.assign(receipt, await runBoundedCommand(spec.command[0], spec.command.slice(1), spec.cwd, out, spec.timeoutMs, { stderrFd: err, signal, env: { ...process.env, TRIE_VIEW_GATE_TIMING: '1' } })); }
  finally {
    closeSync(out); closeSync(err); receipt.finishedAt = new Date().toISOString();
    receipt.stdoutSha256 = sha256(readFileSync(join(evidence, receipt.stdout))); receipt.stderrSha256 = sha256(readFileSync(join(evidence, receipt.stderr))); persist();
  }
  requireSuccess(receipt); return receipt;
}
export function neutralSubject(evidence, build, request) {
  const neutral = join(evidence, 'neutral'); rmSync(neutral, { recursive: true, force: true });
  copy(join(evidence, 'bundles', build), neutral);
  for (const name of subjectFiles) copy(join(here, name), join(neutral, 'proofs', name));
  if (request.kind === 'worker') {
    copy(join(here, 'trie-view-worker.mjs'), join(neutral, 'proofs/trie-view-worker.mjs'));
    const source = replaceOnce(readFileSync(join(here, 'trie-view-workers.mjs'), 'utf8'), 'for (const copy of [false, true]) {', `for (const copy of [${JSON.stringify(request.copy)}]) {`);
    writeFileSync(join(neutral, 'proofs/trie-view-workers.mjs'), source);
  }
  assert.equal(realpathSync(neutral), neutral);
  return { neutral, files: manifest(neutral) };
}
export function expectedNeutral(frozen, build, request) {
  const prefix = build + '/';
  const expected = Object.fromEntries(Object.entries(frozen.manifests.bundles).filter(([file]) => file.startsWith(prefix)).map(([file, hash]) => [file.slice(prefix.length), hash]));
  for (const name of subjectFiles) expected[`proofs/${name}`] = frozen.manifests.proof[`proofs/${name}`];
  if (request.kind === 'worker') {
    expected['proofs/trie-view-worker.mjs'] = frozen.manifests.proof['proofs/trie-view-worker.mjs'];
    expected['proofs/trie-view-workers.mjs'] = sha256(replaceOnce(readFileSync(join(here, 'trie-view-workers.mjs'), 'utf8'), 'for (const copy of [false, true]) {', `for (const copy of [${JSON.stringify(request.copy)}]) {`));
  }
  return Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)));
}
export async function executeStudy(record, plan, subject, persist, freezePlans) {
  for (const planned of plan.study.rows) {
    const row = { ...planned, pilots: {}, blocks: [] }; record.rows.push(row); persist();
    for (const build of row.pilotOrder) { row.pilots[build] = await subject(build, { name: row.workload.name, phase: 'pilot' }); persist(); validatePilot(row.pilots[build], plan.lane); }
    row.plan = commonPlan(row.pilots, plan.lane); persist();
    assert(row.plan.valid, 'Invalid common plan: stop before further pilots or measurement');
  }
  freezePlans(record.rows.map(({ workload, plan }) => ({ workload, plan })));
  record.plansFrozenBeforeMeasurement = true; persist();
  assert(record.rows.every(row => row.plan.valid), 'Invalid pilot: no measurements allowed');
  for (const row of record.rows) for (const planned of row.schedule) {
    const block = { ...planned, subjects: [] }; row.blocks.push(block); persist();
    for (const role of block.roles) {
      const measured = { ...await subject(block[role], { name: row.workload.name, phase: 'measure', repeat: row.plan.repeat, warmupOperations: row.plan.warmupOperations }), role };
      block.subjects.push(measured); persist();
      assert.deepEqual(validateMeasured(measured, row.plan), [], 'Measured floor or validity failure: stop and preserve partial records');
    }
  }
  for (const row of record.rows) row.summary = summarize(row);
}
export async function run(baseline, current, helper, evidence, laneName, prerequisiteInput) {
  const prerequisitesOnly = prerequisiteInput === 'prerequisites-only';
  if (prerequisitesOnly) assert.equal(laneName, 'webkit-x64');
  else assert(prerequisiteInput, 'Sealed global correctness prerequisites required before timing admission');
  evidence = resolve(evidence); baseline = realpathSync(baseline); current = realpathSync(current); helper = realpathSync(helper);
  const output = join(evidence, 'results.json'); assert(!existsSync(output), 'Never overwrite or retry a study'); mkdirSync(evidence, { recursive: true });
  const plan = planFor(laneName), invocation = requireCI(plan.lane, process.env, json(process.env.GITHUB_EVENT_PATH));
  const prospectiveSha256 = verifyProspective(), abort = new AbortController();
  const deadline = setTimeout(() => abort.abort('Frozen 75-minute controller deadline'), LIMITS.controllerMs);
  const record = { schema: 1, status: 'preparing', invocation, plan, prospectiveSha256,
    prerequisitesOnly, controller: { versions: process.versions, arch: process.arch, platform: process.platform, execArgv: process.execArgv, execPath: process.execPath },
    commands: [], correctness: [], rows: [], attempts: [], hardwareBefore: hardware() };
  const persist = () => writeJson(output, record); persist();
  try {
    assert.equal(execFileSync('git', ['show', '-s', '--format=%P', process.env.GITHUB_SHA], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim(), CONTEXT.candidate, 'Proof must be one direct commit on the reviewed PR head');
    assert.equal(execFileSync('bun', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), '1.4.2');
    copy(process.env.GITHUB_EVENT_PATH, join(evidence, 'push-event.json'));
    for (const file of [...PROOF_FILES, 'proofs/radix-frame-screen-manifest.json']) copy(join(root, file), join(evidence, 'proof', file));
    if (!prerequisitesOnly) {
      const input = realpathSync(prerequisiteInput);
      validatePrerequisiteRecord(json(join(input, 'results.json')), input, invocation);
      copy(input, join(evidence, 'global-prerequisites'));
      record.importedPrerequisites = { status: 'verified', inputManifest: manifest(join(evidence, 'global-prerequisites')), receiptSha256: sha256(readFileSync(join(input, 'results.json'))) }; persist();
    }
    record.sourcesBefore = verifyTriple(baseline, current, helper, false); persist();
    record.compilersBefore = Object.fromEntries(Object.entries({ baseline, current, helper }).map(([role, path]) => [role, compilerManifest(path)]));
    record.engineFrozen = await engineIdentity(plan.lane); persist();
    if (!prerequisitesOnly) assert.deepEqual(comparableEngine(record.engineFrozen, plan.lane.browser),
      comparableEngine(json(join(evidence, 'global-prerequisites/results.json')).engineFrozen, plan.lane.browser), 'Prerequisite engine or browser installation differs from this lane');
    copy(join(here, 'radix-frame-screen-proposal.test.txt'), join(helper, 'radix-empty-delegation.test.ts'));
    record.proposalOverlaySha256 = sha256(readFileSync(join(helper, 'radix-empty-delegation.test.ts')));
    assert.equal(record.proposalOverlaySha256, 'c08c262009fcb9448a3bcfa0093a833af2222d23c1065ea5f6db3491a4a72129');
    for (const [build, cwd] of Object.entries({ baseline, current, helper })) for (const script of (prerequisitesOnly ? CHECKS : CHECKS.slice(0, 3))) {
      await command(evidence, record, { id: `${build}/${script}`, cwd, command: ['bun', 'run', script], timeoutMs: LIMITS.prerequisiteMs }, persist, abort.signal);
    }
    if (prerequisitesOnly) {
    await command(evidence, record, { id: 'helper/focused-node-semantics', cwd: helper, command: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'trie-view-capture.test.ts', 'radix-empty-delegation.test.ts'], timeoutMs: LIMITS.prerequisiteMs }, persist, abort.signal);
    await command(evidence, record, { id: 'helper/build-semantic-browser-overlay', cwd: root, command: ['bun', join(here, 'radix-frame-screen-semantics.mjs'), helper, join(evidence, 'semantics')], timeoutMs: LIMITS.prerequisiteMs }, persist, abort.signal);
    }
    record.sources = verifyTriple(baseline, current, helper); persist();
    assert.deepEqual(record.compilersBefore, Object.fromEntries(Object.entries(record.sources).map(([role, value]) => [role, value.compilers])));
    if (!prerequisitesOnly) {
      const imported = json(join(evidence, 'global-prerequisites/results.json'));
      for (const role of ['baseline', 'current', 'helper']) for (const field of ['commit', 'files', 'production', 'wasm', 'bundle', 'compilers']) assert.deepEqual(record.sources[role][field], imported.sources[role][field], `Prerequisite input mismatch ${role}/${field}`);
    }
    for (const [build, cwd] of Object.entries({ baseline, current, helper })) {
      for (const file of Object.keys(record.sources[build].files)) copy(join(cwd, file), join(evidence, 'sources', build, file));
      for (const file of Object.keys(record.sources[build].wasm)) copy(join(cwd, file), join(evidence, 'sources', build, file));
      copy(join(cwd, 'dist'), join(evidence, 'bundles', build, 'dist')); copy(join(cwd, 'package.json'), join(evidence, 'bundles', build, 'package.json'));
    }
    const derived = deriveBrowser(); for (const [name, value] of Object.entries(derived)) { mkdirSync(join(evidence, 'derived'), { recursive: true }); writeFileSync(join(evidence, 'derived', `${name}.mjs`), value.source); }
    record.inputManifests = Object.fromEntries(['proof', 'sources', 'bundles', 'derived', ...(prerequisitesOnly ? ['semantics'] : ['global-prerequisites'])].map(name => [name, manifest(join(evidence, name))]));
    const frozen = { invocation, plan, prospectiveSha256, sourceReceipts: record.sources, engine: record.engineFrozen, manifests: record.inputManifests };
    writeJson(join(evidence, 'frozen-study.json'), frozen); writeFileSync(join(evidence, 'frozen-study.sha256'), sha256(readFileSync(join(evidence, 'frozen-study.json'))) + '\n', { flag: 'wx' });
    record.frozenStudySha256 = sha256(readFileSync(join(evidence, 'frozen-study.json'))); persist();
    async function subject(build, request) {
      assert(!abort.signal.aborted, 'Controller deadline'); verifyProspective();
      assert.deepEqual(await engineIdentity(plan.lane), frozen.engine, 'Runtime or installed browser bytes changed');
      const { neutral, files } = neutralSubject(evidence, build, request), sequence = record.attempts.length;
      assert.deepEqual(files, expectedNeutral(frozen, build, request), 'Neutral package differs from pinned input');
      const attempt = { sequence, build, request, neutral, before: files, startedAt: new Date().toISOString(), status: 'running' };
      record.attempts.push(attempt); persist();
      let spec;
      if (plan.lane.browser) spec = { command: [frozen.engine.controller.path, join(here, 'radix-frame-screen-browser.mjs'), JSON.stringify({ ...request, lane: laneName, neutral })], timeoutMs: LIMITS.browserSubjectMs };
      else if (request.kind === 'worker') spec = { command: [frozen.engine.bun.path, join(neutral, 'proofs/trie-view-workers.mjs'), join(neutral, 'dist/shared.js')], timeoutMs: LIMITS.prerequisiteMs };
      else spec = { command: [frozen.engine.bun.path, join(neutral, 'proofs/trie-view-subject.mjs'), pathToFileURL(join(neutral, 'dist/shared.js')).href, request.name,
        request.phase === 'correctness' ? 'verify' : request.phase, ...(request.phase === 'measure' ? [String(request.repeat), String(request.warmupOperations)] : [])], timeoutMs: CONFIG.subjectTimeoutMs };
      let receipt;
      try {
        attempt.commandSequence = record.commands.length;
        receipt = await command(evidence, record, { id: `${request.phase}/${build}/${request.name}`, cwd: neutral, ...spec }, persist, abort.signal);
        attempt.commandSequence = receipt.sequence;
        const raw = JSON.parse(readFileSync(join(evidence, receipt.stdout), 'utf8'));
        attempt.raw = raw;
        if (plan.lane.browser) {
          validateBrowserLifecycle(raw, request, LIMITS.workerCloseMs);
          assert.deepEqual(raw.provenance, frozen.engine, 'Browser installation changed');
          assert.equal(raw.engine.version, '26.6');
          const identity = { engine: raw.engine, playwright: raw.playwright, browserRevisions: raw.browserRevisions };
          record.engine ??= identity; assert.deepEqual(identity, record.engine, 'Browser executable or revision changed within the lane');
        }
        const result = plan.lane.browser ? raw.raw : raw;
        if (!plan.lane.browser && request.kind !== 'worker') {
          assert.equal(result.runtime.execPath, frozen.engine.bun.path); assert.equal(result.runtime.name, 'bun');
          assert.equal(result.runtime.version, plan.lane.version); assert.equal(result.runtime.arch, 'x64'); assert.equal(result.runtime.platform, 'linux'); assert.deepEqual(result.runtime.execArgv, []);
        }
        if (request.kind === 'semantics') { assert.equal(result.status, 'completed'); assert.equal(result.results.length, 17); assert(result.results.every(test => test.status === 'passed')); }
        else if (request.kind !== 'worker') { assert.equal(result.status, 'completed'); assert.equal(result.expectedDigest, result.actualDigest); assert.equal(result.guards.allocatedSharedBytes, 0); assert.equal(result.guards.immutableBytes, true); assert.deepEqual(result.guards.before, result.guards.after); }
        else { const reports = plan.lane.browser ? result.reports : [result]; assert.equal(reports.length, 1); assert.equal(reports[0].transport, request.copy ? 'copy' : 'shared'); assert.equal(reports[0].writerGrowthBeforeFirstRead, true); assert.equal(reports[0].writerGrowthWhilePaused, true); assert.equal(reports[0].sourceBytesUnchanged, true); }
        attempt.status = 'completed'; return { ...result, build, sequence };
      } catch (error) { attempt.status = 'failed'; attempt.error = String(error.stack ?? error); throw error; }
      finally { attempt.after = manifest(neutral); attempt.finishedAt = new Date().toISOString(); persist(); assert.deepEqual(attempt.after, files, 'Physical neutral package changed'); }
    }
    record.status = 'correctness'; persist();
    if (prerequisitesOnly) {
      const request = { kind: 'semantics', phase: 'correctness', name: 'exact-helper-semantics', semanticBundle: join(evidence, 'semantics/bundle/semantics.js'), semanticSha256: record.inputManifests.semantics['bundle/semantics.js'] };
      record.semanticCorrectness = await subject('helper', request);
      record.status = 'prerequisites-completed'; persist();
      validatePrerequisiteRecord(record, evidence, invocation);
      return record;
    }
    for (const request of plan.correctness) { record.correctness.push({ ...request, result: await subject(request.build, { ...request, phase: 'correctness' }) }); persist(); }
    assert.equal(record.correctness.length, 18);
    record.status = 'measuring'; record.correctnessSha256 = sha256(JSON.stringify(record.correctness)); persist();
    await executeStudy(record, plan, subject, persist, plans => {
      writeJson(join(evidence, 'plans.json'), plans); record.plansSha256 = sha256(readFileSync(join(evidence, 'plans.json')));
    });
    record.status = 'completed'; record.outcome = gateStatus(record, plan.study.rows.map(row => row.workload));
    for (const [name, expected] of Object.entries(record.inputManifests)) assert.deepEqual(manifest(join(evidence, name)), expected);
    persist(); validateRecord(record, evidence);
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); persist(); throw error; }
  finally {
    clearTimeout(deadline); record.hardwareAfter = hardware(); record.finishedAt = new Date().toISOString();
    record.cleanup = { status: record.commands.every(item => item.cleanup?.status === 'verified-no-live-processes') ? 'verified-no-live-processes' : 'incomplete', survivors: record.commands.flatMap(item => item.cleanup?.survivors ?? []) };
    persist();
  }
  return record;
}
export function validateRecord(record, evidence) {
  assert.equal(record.status, 'completed'); assert.equal(record.plansFrozenBeforeMeasurement, true);
  const plan = planFor(record.plan.lane.name); assert.deepEqual(record.plan, plan); assert.equal(record.correctness.length, 18);
  assert.equal(record.controller.arch, plan.lane.arch); assert.equal(record.controller.platform, 'linux');
  assert.equal(record.controller.versions.node, '22.23.3'); assert.deepEqual(record.controller.execArgv, []);
  assert.equal(record.attempts.length, 18 + plan.expected.pilots + plan.expected.measuredSubjects);
  assert.equal(record.commands.length, 9 + record.attempts.length);
  for (const receipt of record.commands) {
    requireSuccess(receipt);
    if (evidence) for (const field of ['stdout', 'stderr']) assert.equal(sha256(readFileSync(join(evidence, receipt[field]))), receipt[`${field}Sha256`]);
  }
  let sequence = 0;
  for (const [index, expected] of plan.correctness.entries()) {
    const attempt = record.attempts[sequence++]; assert.deepEqual(attempt.request, { ...expected, phase: 'correctness' }); assert.equal(attempt.build, expected.build);
    const saved = record.correctness[index]; const { result, ...task } = saved; assert.deepEqual(task, expected);
    const { build, sequence: ignored, ...raw } = result;
    assert.equal(build, expected.build); assert.equal(result.sequence, attempt.sequence);
    assert.deepEqual(raw, plan.lane.browser ? attempt.raw.raw : attempt.raw);
  }
  const bind = (subject, request, build) => {
    const attempt = record.attempts[sequence++]; assert.equal(attempt.sequence, subject.sequence); assert.equal(attempt.build, build); assert.deepEqual(attempt.request, request);
    assert.equal(attempt.status, 'completed'); assert.deepEqual(attempt.after, attempt.before);
    assert.equal(subject.expectedDigest, subject.actualDigest); assert.deepEqual(subject.guards.after, subject.guards.before);
    assert.equal(subject.guards.allocatedSharedBytes, 0); assert.equal(subject.guards.immutableBytes, true);
    const { role, build: ignoredBuild, sequence: ignoredSequence, ...raw } = subject;
    assert.deepEqual(raw, plan.lane.browser ? attempt.raw.raw : attempt.raw);
    if (!plan.lane.browser) {
      assert.equal(raw.runtime.arch, 'x64'); assert.equal(raw.runtime.name, plan.lane.runtime); assert.equal(raw.runtime.version, plan.lane.version); assert.deepEqual(raw.runtime.execArgv, []);
      assert.equal(raw.physical.physicalRoot, attempt.neutral); assert.equal(raw.physical.packageSha256, attempt.before['package.json']);
      for (const file of subjectFiles) assert.equal(raw.sourceSha256[file], attempt.before[`proofs/${file}`]);
    }
  };
  for (const [index, planned] of plan.study.rows.entries()) {
    const row = record.rows[index]; assert.deepEqual(row.workload, planned.workload); assert.deepEqual(row.pilotOrder, planned.pilotOrder); assert.deepEqual(row.schedule, planned.schedule);
    for (const build of row.pilotOrder) { validatePilot(row.pilots[build], plan.lane); bind(row.pilots[build], { name: row.workload.name, phase: 'pilot' }, build); }
    assert.deepEqual(row.plan, commonPlan(row.pilots, plan.lane));
  }
  for (const row of record.rows) {
    assert.equal(row.blocks.length, row.schedule.length);
    for (const [index, planned] of row.schedule.entries()) {
      const block = row.blocks[index]; const { subjects, ...schedule } = block; assert.deepEqual(schedule, planned); assert.equal(subjects.length, 4);
      for (const [slot, subject] of subjects.entries()) { const role = planned.roles[slot]; assert.equal(subject.role, role); validateMeasured(subject, row.plan); bind(subject, { name: row.workload.name, phase: 'measure', repeat: row.plan.repeat, warmupOperations: row.plan.warmupOperations }, block[role]); }
    }
    assert.deepEqual(row.summary, summarize(row));
  }
  assert.equal(sequence, record.attempts.length); assert.equal(record.outcome, gateStatus(record, plan.study.rows.map(row => row.workload)));
  if (evidence) {
    assert.equal(record.prospectiveSha256, verifyProspective());
    const frozen = json(join(evidence, 'frozen-study.json'));
    assert.deepEqual(frozen.plan, record.plan); assert.deepEqual(frozen.invocation, record.invocation);
    assert.equal(frozen.prospectiveSha256, record.prospectiveSha256);
    assert.equal(record.importedPrerequisites.status, 'verified');
    validatePrerequisiteRecord(json(join(evidence, 'global-prerequisites/results.json')), join(evidence, 'global-prerequisites'), record.invocation);
    assert.deepEqual(comparableEngine(record.engineFrozen, plan.lane.browser), comparableEngine(json(join(evidence, 'global-prerequisites/results.json')).engineFrozen, plan.lane.browser));
    assert.deepEqual(record.importedPrerequisites.inputManifest, manifest(join(evidence, 'global-prerequisites')));
    assert.deepEqual(frozen.engine, record.engineFrozen);
    assert.deepEqual(frozen.sourceReceipts, record.sources); assert.deepEqual(frozen.manifests, record.inputManifests);
    for (const [name, expected] of Object.entries(frozen.manifests)) assert.deepEqual(manifest(join(evidence, name)), expected);
    assert.equal(record.frozenStudySha256, sha256(readFileSync(join(evidence, 'frozen-study.json'))));
    assert.equal(readFileSync(join(evidence, 'frozen-study.sha256'), 'utf8').trim(), record.frozenStudySha256);
    assert.equal(record.plansSha256, sha256(readFileSync(join(evidence, 'plans.json'))));
    assert.deepEqual(json(join(evidence, 'plans.json')), record.rows.map(({ workload, plan }) => ({ workload, plan })));
    assert.equal(record.correctnessSha256, sha256(JSON.stringify(record.correctness)));
    const root = resolve(evidence, 'neutral');
    for (const attempt of record.attempts) {
      assert.equal(attempt.status, 'completed'); assert.equal(attempt.neutral, root);
      assert.deepEqual(attempt.before, expectedNeutral(frozen, attempt.build, attempt.request)); assert.deepEqual(attempt.before, attempt.after);
      assert.deepEqual(attempt.raw, JSON.parse(readFileSync(join(evidence, record.commands[attempt.commandSequence].stdout), 'utf8')));
      if (plan.lane.browser) {
        const raw = attempt.raw; assert.deepEqual(raw.provenance, frozen.engine); assert.equal(raw.engine.version, '26.6'); validateBrowserLifecycle(raw, attempt.request, LIMITS.workerCloseMs); assert.equal(raw.engine.name, plan.lane.runtime); assert.equal(raw.playwright, '1.63.0');
        assert.deepEqual(raw.request, { ...attempt.request, lane: plan.lane.name, neutral: attempt.neutral });
        assert.deepEqual({ engine: raw.engine, playwright: raw.playwright, browserRevisions: raw.browserRevisions }, record.engine);
        assert.equal(raw.browserRevisions.sha256, json(join(here, 'radix-portability-pins.json')).playwright.browsersJsonSha256);
        assert.equal(raw.status, 'completed'); assert.equal(raw.browser.closeCompleted, true); assert.equal(raw.browser.disconnected, true); assert.equal(raw.serverClosed, true);
        assert.equal(raw.workers.length, attempt.request.kind === 'worker' ? 1 : 0); assert(raw.workers.every(worker => worker.closed)); assert.equal(raw.pageErrors.length, 0);
        assert.deepEqual(raw.before, attempt.before); assert.deepEqual(raw.after, attempt.after);
        const derived = deriveBrowser(), helperHashes = { '/study/workloads.mjs': derived.workload.sourceSha256, '/study/subject.mjs': derived.subject.sourceSha256,
          '/study/shims.mjs': derived.shims.sourceSha256, '/study/workers.mjs': derived.parent.sourceSha256, '/proofs/trie-view-worker.mjs': derived.worker.sourceSha256, '/study/semantics.js': frozen.manifests.semantics?.['bundle/semantics.js'] };
        for (const fetch of raw.requests) {
          if (fetch.path === '/') continue;
          assert.equal(fetch.sha256, fetch.path.startsWith('/subject/') ? attempt.before[fetch.path.slice('/subject/'.length)] : helperHashes[fetch.path], 'Served source differs from the frozen bytes');
        }
      }
    }
  }
  return true;
}
export function validatePrerequisiteRecord(record, evidence, invocation) {
  assert.equal(record.status, 'prerequisites-completed'); assert.equal(record.prerequisitesOnly, true);
  assert.equal(record.plan.lane.name, 'webkit-x64'); assert.deepEqual(record.plan, planFor('webkit-x64'));
  assert.equal(record.invocation.proofCommit, invocation.proofCommit); assert.equal(record.invocation.runId, invocation.runId);
  assert.equal(record.invocation.runAttempt, 1); assert.equal(record.prospectiveSha256, verifyProspective());
  assert.deepEqual(record.rows, []); assert.deepEqual(record.correctness, []); assert.equal(record.attempts.length, 1);
  const expectedCommands = ['baseline', 'current', 'helper'].flatMap(build => CHECKS.map(script => `${build}/${script}`))
    .concat(['helper/focused-node-semantics', 'helper/build-semantic-browser-overlay', 'correctness/helper/exact-helper-semantics']);
  assert.deepEqual(record.commands.map(item => item.id), expectedCommands);
  for (const command of record.commands) {
    requireSuccess(command);
    for (const field of ['stdout', 'stderr']) assert.equal(sha256(readFileSync(join(evidence, command[field]))), command[`${field}Sha256`]);
  }
  const attempt = record.attempts[0]; assert.equal(attempt.build, 'helper'); assert.equal(attempt.status, 'completed');
  assert.equal(attempt.request.kind, 'semantics'); assert.equal(attempt.request.phase, 'correctness');
  assert.deepEqual(attempt.before, attempt.after); validateBrowserLifecycle(attempt.raw, attempt.request, LIMITS.workerCloseMs);
  assert.deepEqual(attempt.raw.before, attempt.before); assert.deepEqual(attempt.raw.after, attempt.after);
  assert.deepEqual(attempt.raw.request, { ...attempt.request, lane: 'webkit-x64', neutral: attempt.neutral });
  assert.equal(attempt.raw.engine.name, 'webkit'); assert.equal(attempt.raw.engine.version, '26.6');
  assert.equal(attempt.raw.playwright, '1.63.0'); assert.equal(attempt.raw.browserRevisions.sha256, json(join(here, 'radix-portability-pins.json')).playwright.browsersJsonSha256);
  assert.deepEqual(attempt.raw.pageErrors, []);
  assert.deepEqual({ engine: attempt.raw.engine, playwright: attempt.raw.playwright, browserRevisions: attempt.raw.browserRevisions }, record.engine);
  assert.deepEqual(attempt.raw.provenance, record.engineFrozen);
  assert.equal(attempt.raw.raw.status, 'completed'); assert.equal(attempt.raw.raw.results.length, 17); assert(attempt.raw.raw.results.every(test => test.status === 'passed'));
  assert.deepEqual(record.semanticCorrectness, { ...attempt.raw.raw, build: 'helper', sequence: 0 });
  assert.deepEqual(attempt.raw, JSON.parse(readFileSync(join(evidence, record.commands[attempt.commandSequence].stdout), 'utf8')));
  const frozen = json(join(evidence, 'frozen-study.json'));
  assert.deepEqual(frozen.plan, record.plan); assert.deepEqual(frozen.invocation, record.invocation);
  assert.equal(frozen.prospectiveSha256, record.prospectiveSha256);
  assert.deepEqual(frozen.sourceReceipts, record.sources); assert.deepEqual(frozen.engine, record.engineFrozen);
  assert.deepEqual(frozen.manifests, record.inputManifests);
  for (const [name, expected] of Object.entries(frozen.manifests)) assert.deepEqual(manifest(join(evidence, name)), expected);
  assert.deepEqual(attempt.before, expectedNeutral(frozen, 'helper', attempt.request));
  assert.equal(attempt.request.semanticSha256, frozen.manifests.semantics['bundle/semantics.js']);
  assert.equal(sha256(readFileSync(join(evidence, 'semantics/bundle/semantics.js'))), attempt.request.semanticSha256);
  assert(attempt.raw.requests.some(fetch => fetch.path === '/study/semantics.js'), 'Semantic bundle was not served');
  const derived = deriveBrowser(), helperHashes = { '/study/workloads.mjs': derived.workload.sourceSha256, '/study/subject.mjs': derived.subject.sourceSha256,
    '/study/shims.mjs': derived.shims.sourceSha256, '/study/workers.mjs': derived.parent.sourceSha256, '/proofs/trie-view-worker.mjs': derived.worker.sourceSha256,
    '/study/semantics.js': attempt.request.semanticSha256 };
  for (const fetch of attempt.raw.requests) {
    if (fetch.path === '/') continue;
    assert.equal(fetch.sha256, fetch.path.startsWith('/subject/') ? attempt.before[fetch.path.slice('/subject/'.length)] : helperHashes[fetch.path], 'Prerequisite served bytes differ from frozen inputs');
  }
  assert.equal(record.frozenStudySha256, sha256(readFileSync(join(evidence, 'frozen-study.json'))));
  assert.equal(readFileSync(join(evidence, 'frozen-study.sha256'), 'utf8').trim(), record.frozenStudySha256);
  return true;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'verify') console.log(verifyProspective());
  else if (mode === 'run') await run(...args);
  else if (mode === 'validate') console.log(validateRecord(json(join(args[0], 'results.json')), args[0]));
  else throw new Error('Expected verify, run BASELINE CURRENT HELPER EVIDENCE LANE PREREQUISITE_INPUT|prerequisites-only, or validate EVIDENCE');
}
