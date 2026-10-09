import assert from 'node:assert/strict';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { CONTEXT, LANES, CONFIG, LIMITS, planFor, requireCI, diagnosticOutcome } from './heap-portability-protocol.mjs';
import { summarize } from './heap-entry-protocol.mjs';
import { freezePlan } from './heap-portability-plan.mjs';
import { deriveBrowser, deriveNode } from './heap-portability-adapter.mjs';
import { validateBrowserLifecycle } from './heap-portability-lifecycle.mjs';
import { runBoundedCommand } from './heap-portability-process.mjs';
import { json, sha256, manifest, writeJson, verifyPair } from './heap-portability-source.mjs';
const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
export const PROOF_FILES = Object.freeze([
  '.github/workflows/heap-portability.yml', 'proofs/heap-portability.md', 'proofs/heap-portability-pins.json',
  ...['protocol', 'plan', 'source', 'adapter', 'browser-shims', 'browser', 'lifecycle', 'process', 'runner', 'node', 'semantic', 'archive', 'tests'].map(name => `proofs/heap-portability-${name}.mjs`),
  ...['workloads', 'subject', 'protocol', 'worker'].map(name => `proofs/heap-entry-${name}.mjs`),
]);
const subjectFiles = ['heap-entry-workloads.mjs', 'heap-entry-protocol.mjs', 'heap-entry-worker.mjs', 'heap-portability-semantic.mjs', 'heap-portability-node.mjs'];
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); };
const hardware = () => ({ at: new Date().toISOString(), cpus: os.cpus(), loadavg: os.loadavg(), freemem: os.freemem(), totalmem: os.totalmem(), uptimeSeconds: os.uptime() });
export function prospectiveManifest() {
  const receipts = collection => Object.fromEntries(Object.entries(collection).map(([name, { source, ...receipt }]) => [name, receipt]));
  return { schema: 1, stage: 'prospective; no timing claim', context: CONTEXT, plans: LANES.map(lane => planFor(lane.name)),
    files: Object.fromEntries(PROOF_FILES.map(file => [file, sha256(readFileSync(join(root, file)))])),
    browserAdapters: receipts(deriveBrowser()), nodeAdapters: receipts(deriveNode()),
    expectedTotal: { lanes: 5, cells: 15, correctness: 50, actualWorkers: 20, workerRows: 100, pilots: 30, measuredSubjects: 480, measuredBatches: 10080, quartets: 120 },
    publication: 'Local preparation only. No timing, push, or dispatch before review of this exact tree.' };
}
export function verifyProspective() {
  const bytes = readFileSync(join(here, 'heap-portability-manifest.json'));
  assert.deepEqual(JSON.parse(bytes), prospectiveManifest(), 'Prospective files, protocol or adapters changed');
  const pins = json(join(here, 'heap-portability-pins.json'));
  for (const [file, hash] of Object.entries(pins.originalHelpers)) assert.equal(sha256(readFileSync(join(root, file))), hash);
  for (const [name, receipt] of Object.entries(pins.transport)) assert.equal(sha256(readFileSync(join(here, `heap-portability-${name}.mjs`))), receipt.sha256);
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
  try { Object.assign(receipt, await runBoundedCommand(spec.command[0], spec.command.slice(1), spec.cwd, out, spec.timeoutMs,
    { stderrFd: err, signal, env: { ...process.env, HEAP_PORTABILITY_SUBJECT: '1', NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } })); }
  finally {
    closeSync(out); closeSync(err); receipt.finishedAt = new Date().toISOString();
    receipt.stdoutSha256 = sha256(readFileSync(join(evidence, receipt.stdout))); receipt.stderrSha256 = sha256(readFileSync(join(evidence, receipt.stderr))); persist();
  }
  return receipt;
}
export function neutralSubject(evidence, build) {
  const neutral = join(evidence, 'neutral'); rmSync(neutral, { recursive: true, force: true });
  copy(join(evidence, 'bundles', build), neutral);
  for (const name of subjectFiles) copy(join(here, name), join(neutral, 'proofs', name));
  writeFileSync(join(neutral, 'proofs/subject.mjs'), deriveNode().subject.source);
  assert.equal(realpathSync(neutral), neutral);
  return { neutral, files: manifest(neutral) };
}
export function expectedNeutral(frozen, build) {
  const prefix = build + '/';
  const expected = Object.fromEntries(Object.entries(frozen.manifests.bundles).filter(([file]) => file.startsWith(prefix)).map(([file, hash]) => [file.slice(prefix.length), hash]));
  for (const name of subjectFiles) expected[`proofs/${name}`] = frozen.manifests.proof[`proofs/${name}`];
  expected['proofs/subject.mjs'] = deriveNode().subject.sourceSha256;
  return Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)));
}
export function validatePilot(subject) {
  assert.equal(subject.status, 'passed'); assert.equal(subject.phase, 'pilot'); assert.deepEqual(subject.invalid, []); assert.equal(subject.capped, false);
  assert(Number.isSafeInteger(subject.repeat) && subject.repeat > 0 && subject.repeat <= CONFIG.repeatLimit);
  assert(Number.isFinite(subject.minMsPerIteration) && subject.minMsPerIteration > 0);
  assert.equal(subject.warmup.capped, false); assert(subject.warmup.ms >= CONFIG.warmupFloorMs);
  assert(subject.calibration.length > 0 && subject.calibration.length <= 16);
  const last = subject.calibration.at(-1); assert.equal(last.repeat, subject.repeat);
  assert.equal(last.samples.length, 3); assert(last.samples.every(ms => Number.isFinite(ms) && ms > 0));
  assert.equal(Math.min(...last.samples) / last.repeat, subject.minMsPerIteration);
  assert(Math.min(...last.samples) >= CONFIG.batchTargetMs * 1.25);
  assert.deepEqual(subject.progress.calibration, subject.calibration); assert.deepEqual(subject.progress.warmup, subject.warmup);
}
export function validateMeasured(subject, plan) {
  assert.equal(subject.status, 'passed'); assert.equal(subject.phase, 'measure');
  assert.equal(subject.repeat, plan.repeat); assert.equal(subject.prescribedWarmupScans, plan.warmupScans);
  assert.deepEqual(subject.expected, plan.expected); assert.deepEqual(subject.identity, plan.identity);
  assert.equal(subject.samples.length, 21); assert(subject.samples.every(ms => Number.isFinite(ms) && ms > 0));
  assert.deepEqual(subject.progress.samples, subject.samples); assert.deepEqual(subject.progress.warmup, subject.warmup);
  const invalid = [...(subject.warmup.capped ? ['warmup-capped'] : []), ...(subject.warmup.scans !== plan.warmupScans ? ['warmup-work-short'] : []),
    ...(subject.warmup.ms < CONFIG.warmupFloorMs ? ['warmup-below-floor'] : []), ...(subject.samples.some(ms => ms < CONFIG.batchFloorMs) ? ['sample-below-floor'] : [])];
  assert.deepEqual(subject.invalid, invalid);
  assert.deepEqual(subject.targetMisses, { batches: subject.samples.filter(ms => ms < CONFIG.batchTargetMs).length, warmup: subject.warmup.ms < CONFIG.warmupTargetMs });
}
export async function executeStudy(record, plan, subject, persist, freezePlans) {
  for (const planned of plan.rows) {
    const row = { ...planned, pilots: {}, blocks: [], invalid: [] }; record.rows.push(row); persist();
    for (const build of row.pilotOrder) {
      row.pilots[build] = await subject(build, { name: row.workload.name, phase: 'pilot' }); persist(); validatePilot(row.pilots[build]);
    }
    row.plan = freezePlan(Object.values(row.pilots)); persist();
  }
  assert.equal(record.rows.length, 3); assert(record.rows.every(row => row.plan && Object.keys(row.pilots).length === 2));
  freezePlans(record.rows.map(({ workload, plan }) => ({ workload, plan })));
  record.plansFrozenBeforeMeasurement = true; persist();
  for (const row of record.rows) for (const planned of row.schedule) {
    const block = { ...planned, subjects: [] }; row.blocks.push(block); persist();
    for (const role of block.roles) {
      const build = block.mode === 'ab' && role === 'right' ? 'candidate' : 'baseline';
      const result = await subject(build, { name: row.workload.name, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans });
      block.subjects.push({ ...result, role }); persist(); validateMeasured(result, row.plan);
    }
  }
  for (const row of record.rows) row.summary = summarize(row);
}
function semanticEquality(left, right) {
  assert.deepEqual(left.generator, right.generator); assert.equal(left.copy, right.copy); assert.equal(left.rows.length, right.rows.length);
  for (const [index, row] of left.rows.entries()) {
    const other = right.rows[index];
    for (const key of ['size', 'type', 'maxHeap']) assert.equal(row[key], other[key]);
    for (const key of ['expected', 'result']) {
      const { count: before, ...a } = row[key], { count: after, ...b } = other[key];
      assert.deepEqual(a, b); const visits = row.size * (key === 'result' ? 2 : 1);
      assert.equal(before.getters - after.getters, 3 * visits); assert.equal(before.refreshes - after.refreshes, 3 * visits); assert.equal(before.decodes, after.decodes);
    }
  }
}
export function validateCorrectness(record) {
  assert.equal(record.correctness.length, 10);
  for (const request of record.plan.correctness) {
    const row = record.correctness.find(row => row.build === request.build && row.name === request.name); assert(row);
    assert.equal(row.result.status, 'passed');
    if (request.kind === 'worker') {
      assert.equal(row.result.rows.length, 5); assert.equal(row.result.actualWorkers, 1);
      for (const field of ['generatorLazyAccess', 'customDecoderOrderReceiverReentrantGrowthExceptions', 'sharedCopyMarkers', 'growthBeforeFirstNextAndWhilePaused', 'bytesStateDescriptorsUnchanged']) assert.equal(row.result[field], true);
    }
  }
  for (const request of record.plan.correctness.filter(row => row.build === 'baseline')) {
    const a = record.correctness.find(row => row.build === 'baseline' && row.name === request.name).result;
    const b = record.correctness.find(row => row.build === 'candidate' && row.name === request.name).result;
    if (request.kind === 'worker') semanticEquality(a, b);
    else { assert.deepEqual(a.workload, b.workload); assert.deepEqual(a.expected, b.expected); assert.deepEqual(a.identity, b.identity); }
  }
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
  const persist = () => {
    for (const row of record.rows) row.summary = summarize(row);
    record.outcome = diagnosticOutcome(record.rows, record.status === 'completed'); writeJson(output, record);
  }; persist();
  try {
    assert.equal(execFileSync('git', ['show', '-s', '--format=%P', process.env.GITHUB_SHA], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim(), CONTEXT.candidate);
    assert.equal(execFileSync('bun', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), '1.4.2');
    const paths = { node: process.execPath, bun: execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 10000 }).trim() };
    record.executables = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, { path: realpathSync(path), sha256: sha256(readFileSync(path)) }]));
    persist();
    copy(process.env.GITHUB_EVENT_PATH, join(evidence, 'push-event.json'));
    for (const file of [...PROOF_FILES, 'proofs/heap-portability-manifest.json']) copy(join(root, file), join(evidence, 'proof', file));
    record.sourcesBefore = verifyPair(baseline, candidate, false); persist();
    // Retain source bytes before any build can fail.
    for (const [build, cwd] of Object.entries({ baseline, candidate })) for (const file of Object.keys(record.sourcesBefore[build].files)) copy(join(cwd, file), join(evidence, 'sources', build, file));
    for (const [build, cwd] of Object.entries({ baseline, candidate })) for (const script of ['build:wasm', 'build:browser'])
      requireSuccess(await command(evidence, record, { id: `${build}/${script}`, cwd, command: ['bun', 'run', script], timeoutMs: LIMITS.prerequisiteMs }, persist, abort.signal));
    record.sources = verifyPair(baseline, candidate); persist();
    for (const [build, cwd] of Object.entries({ baseline, candidate })) {
      for (const file of Object.keys(record.sources[build].wasm)) copy(join(cwd, file), join(evidence, 'sources', build, file));
      copy(join(cwd, 'dist'), join(evidence, 'bundles', build, 'dist')); copy(join(cwd, 'package.json'), join(evidence, 'bundles', build, 'package.json'));
    }
    for (const [platform, derived] of Object.entries({ browser: deriveBrowser(), node: deriveNode() })) for (const [name, value] of Object.entries(derived)) {
      mkdirSync(join(evidence, 'derived', platform), { recursive: true }); writeFileSync(join(evidence, 'derived', platform, `${name}.mjs`), value.source);
    }
    record.inputManifests = Object.fromEntries(['proof', 'sources', 'bundles', 'derived'].map(name => [name, manifest(join(evidence, name))]));
    const frozen = { invocation, plan, prospectiveSha256, sourceReceipts: record.sources, manifests: record.inputManifests };
    writeJson(join(evidence, 'frozen-study.json'), frozen); record.frozenStudySha256 = sha256(readFileSync(join(evidence, 'frozen-study.json')));
    writeFileSync(join(evidence, 'frozen-study.sha256'), record.frozenStudySha256 + '\n', { flag: 'wx' }); persist();
    async function subject(build, request) {
      assert(!abort.signal.aborted, 'Controller deadline'); verifyProspective();
      const { neutral, files } = neutralSubject(evidence, build), sequence = record.attempts.length;
      assert.deepEqual(files, expectedNeutral(frozen, build));
      const attempt = { sequence, build, request, neutral, before: files, startedAt: new Date().toISOString(), status: 'running' };
      record.attempts.push(attempt); persist();
      const spec = plan.lane.browser
        ? { command: [record.executables.node.path, join(here, 'heap-portability-browser.mjs'), JSON.stringify({ ...request, lane: laneName, neutral })], timeoutMs: LIMITS.browserSubjectMs }
        : { command: [record.executables[plan.lane.runtime].path, join(neutral, 'proofs/heap-portability-node.mjs'), JSON.stringify({ ...request, entryUrl: pathToFileURL(join(neutral, 'dist/shared.js')).href })], timeoutMs: request.phase === 'correctness' ? LIMITS.prerequisiteMs : CONFIG.subjectTimeoutMs };
      try {
        attempt.commandSequence = record.commands.length;
        const receipt = await command(evidence, record, { id: `${request.phase}/${build}/${request.name}`, cwd: neutral, ...spec }, persist, abort.signal);
        const text = readFileSync(join(evidence, receipt.stdout), 'utf8');
        try { attempt.raw = JSON.parse(text); } catch (error) { attempt.parseError = String(error); }
        persist(); requireSuccess(receipt); const raw = attempt.raw; assert(raw);
        if (plan.lane.browser) {
          validateBrowserLifecycle(raw, request, LIMITS.workerCloseMs);
          const identity = { engine: raw.engine, playwright: raw.playwright, browserRevisions: raw.browserRevisions };
          record.engine ??= identity; assert.deepEqual(identity, record.engine);
        }
        const result = plan.lane.browser ? raw.raw : raw; assert.equal(result.status, 'completed');
        attempt.status = 'completed'; return { ...result, status: 'passed', build, sequence };
      } catch (error) { attempt.status = 'failed'; attempt.error = String(error.stack ?? error); throw error; }
      finally { attempt.after = manifest(neutral); attempt.finishedAt = new Date().toISOString(); persist(); assert.deepEqual(attempt.after, files); }
    }
    record.status = 'correctness'; persist();
    for (const request of plan.correctness) { record.correctness.push({ ...request, result: await subject(request.build, { ...request, phase: 'correctness' }) }); persist(); }
    validateCorrectness(record); record.correctnessSha256 = sha256(JSON.stringify(record.correctness)); record.status = 'measuring'; persist();
    await executeStudy(record, plan, subject, persist, plans => { writeJson(join(evidence, 'plans.json'), plans); record.plansSha256 = sha256(readFileSync(join(evidence, 'plans.json'))); });
    record.status = 'completed'; persist();
    for (const executable of Object.values(record.executables)) assert.equal(sha256(readFileSync(executable.path)), executable.sha256);
    for (const [name, expected] of Object.entries(record.inputManifests)) assert.deepEqual(manifest(join(evidence, name)), expected);
    validateRecord(record, evidence);
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); persist(); throw error; }
  finally {
    clearTimeout(deadline); record.hardwareAfter = hardware(); record.finishedAt = new Date().toISOString();
    record.cleanup = { status: record.commands.every(item => item.cleanup?.status === 'verified-no-live-processes') ? 'verified-no-live-processes' : 'incomplete', survivors: record.commands.flatMap(item => item.cleanup?.survivors ?? []) }; persist();
  }
  return record;
}
export function validateRecord(record, evidence) {
  assert.equal(record.status, 'completed'); assert.equal(record.plansFrozenBeforeMeasurement, true);
  const plan = planFor(record.plan.lane.name); assert.deepEqual(record.plan, plan); validateCorrectness(record);
  assert.equal(record.controller.arch, plan.lane.arch); assert.equal(record.controller.platform, 'linux');
  assert.equal(record.controller.versions.node, '22.23.3'); assert.deepEqual(record.controller.execArgv, []);
  assert.equal(record.attempts.length, 112); assert.equal(record.commands.length, 116);
  for (const receipt of record.commands) {
    requireSuccess(receipt);
    if (evidence) for (const field of ['stdout', 'stderr']) assert.equal(sha256(readFileSync(join(evidence, receipt[field]))), receipt[`${field}Sha256`]);
  }
  let sequence = 0;
  const bind = (subject, request, build) => {
    const attempt = record.attempts[sequence++]; assert.equal(attempt.sequence, subject.sequence); assert.equal(attempt.build, build); assert.deepEqual(attempt.request, request);
    assert.equal(attempt.status, 'completed'); assert.deepEqual(attempt.after, attempt.before);
    const { role, build: ignoredBuild, sequence: ignoredSequence, ...raw } = subject;
    raw.status = 'completed'; assert.deepEqual(raw, plan.lane.browser ? attempt.raw.raw : attempt.raw);
    if (!plan.lane.browser) assert.deepEqual(raw.host, { runtime: plan.lane.runtime, version: plan.lane.version, arch: 'arm64', execArgv: [] });
  };
  for (const [index, expected] of plan.correctness.entries()) {
    const saved = record.correctness[index], { result, ...task } = saved; assert.deepEqual(task, expected);
    bind(result, { ...expected, phase: 'correctness' }, expected.build);
  }
  assert.equal(record.rows.length, 3);
  for (const [index, planned] of plan.rows.entries()) {
    const row = record.rows[index]; assert.deepEqual(row.workload, planned.workload); assert.deepEqual(row.pilotOrder, planned.pilotOrder); assert.deepEqual(row.schedule, planned.schedule);
    for (const build of row.pilotOrder) { validatePilot(row.pilots[build]); bind(row.pilots[build], { name: row.workload.name, phase: 'pilot' }, build); }
    assert.deepEqual(row.plan, freezePlan(Object.values(row.pilots)));
  }
  for (const row of record.rows) {
    assert.equal(row.blocks.length, 8);
    for (const [index, planned] of row.schedule.entries()) {
      const block = row.blocks[index], { subjects, ...schedule } = block; assert.deepEqual(schedule, planned); assert.equal(subjects.length, 4);
      for (const [slot, subject] of subjects.entries()) {
        const role = planned.roles[slot], build = planned.mode === 'ab' && role === 'right' ? 'candidate' : 'baseline';
        assert.equal(subject.role, role); validateMeasured(subject, row.plan);
        bind(subject, { name: row.workload.name, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans }, build);
      }
    }
    assert.deepEqual(row.summary, summarize(row));
  }
  assert.equal(sequence, record.attempts.length); assert.equal(record.outcome, diagnosticOutcome(record.rows, true));
  if (evidence) {
    assert.equal(record.prospectiveSha256, verifyProspective()); const frozen = json(join(evidence, 'frozen-study.json'));
    assert.deepEqual(frozen, { invocation: record.invocation, plan: record.plan, prospectiveSha256: record.prospectiveSha256, sourceReceipts: record.sources, manifests: record.inputManifests });
    for (const [name, expected] of Object.entries(frozen.manifests)) assert.deepEqual(manifest(join(evidence, name)), expected);
    assert.equal(record.frozenStudySha256, sha256(readFileSync(join(evidence, 'frozen-study.json'))));
    assert.equal(readFileSync(join(evidence, 'frozen-study.sha256'), 'utf8').trim(), record.frozenStudySha256);
    assert.equal(record.plansSha256, sha256(readFileSync(join(evidence, 'plans.json'))));
    assert.deepEqual(json(join(evidence, 'plans.json')), record.rows.map(({ workload, plan }) => ({ workload, plan })));
    assert.equal(record.correctnessSha256, sha256(JSON.stringify(record.correctness)));
    for (const attempt of record.attempts) {
      assert.equal(attempt.neutral, resolve(evidence, 'neutral')); assert.deepEqual(attempt.before, expectedNeutral(frozen, attempt.build)); assert.deepEqual(attempt.before, attempt.after);
      assert.deepEqual(attempt.raw, JSON.parse(readFileSync(join(evidence, record.commands[attempt.commandSequence].stdout), 'utf8')));
      if (plan.lane.browser) {
        const raw = attempt.raw; validateBrowserLifecycle(raw, attempt.request, LIMITS.workerCloseMs);
        assert.equal(raw.engine.name, plan.lane.runtime); assert.equal(raw.playwright, '1.63.0');
        assert.deepEqual({ engine: raw.engine, playwright: raw.playwright, browserRevisions: raw.browserRevisions }, record.engine);
        assert.equal(raw.browserRevisions.sha256, json(join(here, 'heap-portability-pins.json')).playwright.browsersJsonSha256);
        assert.equal(raw.pageErrors.length, 0); assert.deepEqual(raw.before, attempt.before); assert.deepEqual(raw.after, attempt.after);
        const derived = deriveBrowser(), helpers = { '/study/workloads.mjs': derived.workload.sourceSha256, '/study/subject.mjs': derived.subject.sourceSha256,
          '/study/protocol.mjs': derived.protocol.sourceSha256, '/study/fixture.mjs': derived.fixture.sourceSha256,
          '/study/shims.mjs': derived.shims.sourceSha256, '/study/workers.mjs': derived.parent.sourceSha256, '/proofs/heap-entry-worker.mjs': derived.worker.sourceSha256 };
        for (const fetch of raw.requests) if (fetch.path !== '/') assert.equal(fetch.sha256, fetch.path.startsWith('/subject/') ? attempt.before[fetch.path.slice('/subject/'.length)] : helpers[fetch.path]);
      }
    }
  }
  return true;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'verify') console.log(verifyProspective());
  else if (mode === 'run') { const result = await run(...args); if (result.outcome !== 'selected-cells-within-margin-only') process.exitCode = 1; }
  else if (mode === 'validate') console.log(validateRecord(json(join(args[0], 'results.json')), args[0]));
  else throw new Error('Expected verify, run BASELINE CANDIDATE EVIDENCE LANE, or validate EVIDENCE');
}
