import assert from 'node:assert/strict';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { CONTEXT, LANES, CONFIG, LIMITS, planFor, requireCI, validateRecoveryPilot as validatePilot } from './radix-browser-recovery-protocol.mjs';
import { commonPlan, validateMeasured, summarize, gateStatus } from './trie-view-protocol.mjs';
import { deriveBrowser } from './radix-browser-recovery-adapter.mjs';
import { runBoundedCommand } from './radix-portability-process.mjs';
import { json, sha256, manifest, writeJson, verifyPair } from './radix-portability-source.mjs';
import { replaceOnce } from './radix-portability-adapter.mjs';
import { PROOF_FILES as ORIGINAL_PROOF_FILES, verifyProspective as verifyOriginalProspective } from './radix-portability-runner.mjs';
import { validateBrowserLifecycle } from './radix-browser-recovery-lifecycle.mjs';
const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
export const PROOF_FILES = Object.freeze([
  ...ORIGINAL_PROOF_FILES, 'proofs/radix-portability-manifest.json',
  '.github/workflows/radix-browser-recovery.yml', 'proofs/radix-browser-recovery.md',
  ...['protocol', 'adapter', 'lifecycle', 'browser', 'runner', 'tests'].map(name => `proofs/radix-browser-recovery-${name}.mjs`),
]);
const subjectFiles = ['trie-view-subject.mjs', 'trie-view-workloads.mjs', 'trie-view-protocol.mjs'];
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); };
const hardware = () => ({ at: new Date().toISOString(), cpus: os.cpus(), loadavg: os.loadavg(), freemem: os.freemem(), totalmem: os.totalmem(), uptimeSeconds: os.uptime() });
export function prospectiveManifest() {
  const originalManifestSha256 = verifyOriginalProspective();
  const derivation = deriveBrowser();
  const adapters = Object.fromEntries(Object.entries(derivation).map(([name, { source, ...receipt }]) => [name, receipt]));
  return { schema: 1, stage: 'prospective browser-only recovery; no timing claim', originalManifestSha256, context: CONTEXT, plans: LANES.map(lane => planFor(lane.name)),
    files: Object.fromEntries(PROOF_FILES.map(file => [file, sha256(readFileSync(join(root, file)))])), adapters,
    expectedTotal: { lanes: 3, cells: 9, pilots: 18, measuredSubjects: 288, measuredBatches: 6048, quartets: 72 },
    publication: 'Local preparation only. Publication and the single scoped-push execution require parent review of this exact tree.' };
}
export function verifyProspective() {
  const bytes = readFileSync(join(here, 'radix-browser-recovery-manifest.json'));
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
    for (const build of row.pilotOrder) { row.pilots[build] = await subject(build, { name: row.workload.name, phase: 'pilot' }); persist(); validatePilot(row.pilots[build]); }
    row.plan = commonPlan(row.pilots); persist();
  }
  freezePlans(record.rows.map(({ workload, plan }) => ({ workload, plan })));
  record.plansFrozenBeforeMeasurement = true; persist();
  assert(record.rows.every(row => row.plan.valid), 'Invalid pilot: no measurements allowed');
  for (const row of record.rows) for (const planned of row.schedule) {
    const block = { ...planned, subjects: [] }; row.blocks.push(block); persist();
    for (const role of block.roles) { block.subjects.push({ ...await subject(block[role], { name: row.workload.name, phase: 'measure', repeat: row.plan.repeat, warmupOperations: row.plan.warmupOperations }), role }); persist(); }
  }
  for (const row of record.rows) row.summary = summarize(row);
}
export async function run(baseline, candidate, evidence, laneName) {
  evidence = resolve(evidence); baseline = realpathSync(baseline); candidate = realpathSync(candidate);
  const output = join(evidence, 'results.json'); assert(!existsSync(output), 'Never overwrite or retry a study'); mkdirSync(evidence, { recursive: true });
  const plan = planFor(laneName), invocation = requireCI(plan.lane, process.env, json(process.env.GITHUB_EVENT_PATH));
  const prospectiveSha256 = verifyProspective(), abort = new AbortController();
  const deadline = setTimeout(() => abort.abort('Frozen 25-minute controller deadline'), LIMITS.controllerMs);
  const record = { schema: 1, status: 'preparing', invocation, plan, prospectiveSha256,
    controller: { versions: process.versions, arch: process.arch, platform: process.platform, execArgv: process.execArgv, execPath: process.execPath },
    commands: [], correctness: [], rows: [], attempts: [], hardwareBefore: hardware() };
  const persist = () => writeJson(output, record); persist();
  try {
    assert.equal(execFileSync('git', ['show', '-s', '--format=%P', process.env.GITHUB_SHA], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim(), CONTEXT.candidate, 'Proof must be one direct commit on the reviewed PR head');
    assert.equal(execFileSync('bun', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), '1.4.2');
    copy(process.env.GITHUB_EVENT_PATH, join(evidence, 'push-event.json'));
    for (const file of [...PROOF_FILES, 'proofs/radix-browser-recovery-manifest.json']) copy(join(root, file), join(evidence, 'proof', file));
    record.sourcesBefore = verifyPair(baseline, candidate, false); persist();
    for (const [build, cwd] of Object.entries({ baseline, candidate })) for (const script of ['build:wasm', 'build:browser']) {
      await command(evidence, record, { id: `${build}/${script}`, cwd, command: ['bun', 'run', script], timeoutMs: LIMITS.prerequisiteMs }, persist, abort.signal);
    }
    record.sources = verifyPair(baseline, candidate); persist();
    for (const [build, cwd] of Object.entries({ baseline, candidate })) {
      for (const file of Object.keys(record.sources[build].files)) copy(join(cwd, file), join(evidence, 'sources', build, file));
      for (const file of Object.keys(record.sources[build].wasm)) copy(join(cwd, file), join(evidence, 'sources', build, file));
      copy(join(cwd, 'dist'), join(evidence, 'bundles', build, 'dist')); copy(join(cwd, 'package.json'), join(evidence, 'bundles', build, 'package.json'));
    }
    const derived = deriveBrowser(); for (const [name, value] of Object.entries(derived)) { mkdirSync(join(evidence, 'derived'), { recursive: true }); writeFileSync(join(evidence, 'derived', `${name}.mjs`), value.source); }
    record.inputManifests = Object.fromEntries(['proof', 'sources', 'bundles', 'derived'].map(name => [name, manifest(join(evidence, name))]));
    const frozen = { invocation, plan, prospectiveSha256, sourceReceipts: record.sources, manifests: record.inputManifests };
    writeJson(join(evidence, 'frozen-study.json'), frozen); writeFileSync(join(evidence, 'frozen-study.sha256'), sha256(readFileSync(join(evidence, 'frozen-study.json'))) + '\n', { flag: 'wx' });
    record.frozenStudySha256 = sha256(readFileSync(join(evidence, 'frozen-study.json'))); persist();
    async function subject(build, request) {
      assert(!abort.signal.aborted, 'Controller deadline'); verifyProspective();
      const { neutral, files } = neutralSubject(evidence, build, request), sequence = record.attempts.length;
      assert.deepEqual(files, expectedNeutral(frozen, build, request), 'Neutral package differs from pinned input');
      const attempt = { sequence, build, request, neutral, before: files, startedAt: new Date().toISOString(), status: 'running' };
      record.attempts.push(attempt); persist();
      let spec;
      if (plan.lane.browser) spec = { command: ['node', join(here, 'radix-browser-recovery-browser.mjs'), JSON.stringify({ ...request, lane: laneName, neutral })], timeoutMs: LIMITS.browserSubjectMs };
      else if (request.kind === 'worker') spec = { command: [plan.lane.runtime, join(neutral, 'proofs/trie-view-workers.mjs'), join(neutral, 'dist/shared.js')], timeoutMs: LIMITS.prerequisiteMs };
      else spec = { command: [plan.lane.runtime, join(neutral, 'proofs/trie-view-subject.mjs'), pathToFileURL(join(neutral, 'dist/shared.js')).href, request.name,
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
          const identity = { engine: raw.engine, playwright: raw.playwright, browserRevisions: raw.browserRevisions };
          record.engine ??= identity; assert.deepEqual(identity, record.engine, 'Browser executable or revision changed within the lane');
        }
        const result = plan.lane.browser ? raw.raw : raw;
        if (request.kind !== 'worker') { assert.equal(result.status, 'completed'); assert.equal(result.expectedDigest, result.actualDigest); assert.equal(result.guards.allocatedSharedBytes, 0); assert.equal(result.guards.immutableBytes, true); assert.deepEqual(result.guards.before, result.guards.after); }
        else { const reports = plan.lane.browser ? result.reports : [result]; assert.equal(reports.length, 1); assert.equal(reports[0].transport, request.copy ? 'copy' : 'shared'); assert.equal(reports[0].writerGrowthBeforeFirstRead, true); assert.equal(reports[0].writerGrowthWhilePaused, true); assert.equal(reports[0].sourceBytesUnchanged, true); }
        attempt.status = 'completed'; return { ...result, build, sequence };
      } catch (error) { attempt.status = 'failed'; attempt.error = String(error.stack ?? error); throw error; }
      finally { attempt.after = manifest(neutral); attempt.finishedAt = new Date().toISOString(); persist(); assert.deepEqual(attempt.after, files, 'Physical neutral package changed'); }
    }
    record.status = 'correctness'; persist();
    for (const request of plan.correctness) { record.correctness.push({ ...request, result: await subject(request.build, { ...request, phase: 'correctness' }) }); persist(); }
    assert.equal(record.correctness.length, 10);
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
  const plan = planFor(record.plan.lane.name); assert.deepEqual(record.plan, plan); assert.equal(record.correctness.length, 10);
  assert.equal(record.controller.arch, plan.lane.arch); assert.equal(record.controller.platform, 'linux');
  assert.equal(record.controller.versions.node, '22.23.3'); assert.deepEqual(record.controller.execArgv, []);
  assert.equal(record.attempts.length, 10 + plan.expected.pilots + plan.expected.measuredSubjects);
  assert.equal(record.commands.length, 4 + record.attempts.length);
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
      assert.equal(raw.runtime.arch, 'arm64'); assert.equal(raw.runtime.name, plan.lane.runtime); assert.equal(raw.runtime.version, plan.lane.version); assert.deepEqual(raw.runtime.execArgv, []);
      assert.equal(raw.physical.physicalRoot, attempt.neutral); assert.equal(raw.physical.packageSha256, attempt.before['package.json']);
      for (const file of subjectFiles) assert.equal(raw.sourceSha256[file], attempt.before[`proofs/${file}`]);
    }
  };
  for (const [index, planned] of plan.study.rows.entries()) {
    const row = record.rows[index]; assert.deepEqual(row.workload, planned.workload); assert.deepEqual(row.pilotOrder, planned.pilotOrder); assert.deepEqual(row.schedule, planned.schedule);
    for (const build of row.pilotOrder) { validatePilot(row.pilots[build]); bind(row.pilots[build], { name: row.workload.name, phase: 'pilot' }, build); }
    assert.deepEqual(row.plan, commonPlan(row.pilots));
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
        const raw = attempt.raw; validateBrowserLifecycle(raw, attempt.request, LIMITS.workerCloseMs); assert.equal(raw.engine.name, plan.lane.runtime); assert.equal(raw.playwright, '1.63.0');
        assert.deepEqual({ engine: raw.engine, playwright: raw.playwright, browserRevisions: raw.browserRevisions }, record.engine);
        assert.equal(raw.browserRevisions.sha256, json(join(here, 'radix-portability-pins.json')).playwright.browsersJsonSha256);
        assert.equal(raw.status, 'completed'); assert.equal(raw.browser.closeCompleted, true); assert.equal(raw.browser.disconnected, true); assert.equal(raw.serverClosed, true);
        assert.equal(raw.workers.length, attempt.request.kind === 'worker' ? 1 : 0); assert(raw.workers.every(worker => worker.closed)); assert.equal(raw.pageErrors.length, 0);
        assert.deepEqual(raw.before, attempt.before); assert.deepEqual(raw.after, attempt.after);
        const derived = deriveBrowser(), helperHashes = { '/study/workloads.mjs': derived.workload.sourceSha256, '/study/subject.mjs': derived.subject.sourceSha256,
          '/study/shims.mjs': derived.shims.sourceSha256, '/study/workers.mjs': derived.parent.sourceSha256, '/proofs/trie-view-worker.mjs': derived.worker.sourceSha256 };
        for (const fetch of raw.requests) {
          if (fetch.path === '/') continue;
          assert.equal(fetch.sha256, fetch.path.startsWith('/subject/') ? attempt.before[fetch.path.slice('/subject/'.length)] : helperHashes[fetch.path], 'Served source differs from the frozen bytes');
        }
      }
    }
  }
  return true;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'verify') console.log(verifyProspective());
  else if (mode === 'run') await run(...args);
  else if (mode === 'validate') console.log(validateRecord(json(join(args[0], 'results.json')), args[0]));
  else throw new Error('Expected verify, run BASELINE CANDIDATE EVIDENCE LANE, or validate EVIDENCE');
}
