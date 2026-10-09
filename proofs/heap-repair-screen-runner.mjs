import assert from 'node:assert/strict';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { CONTEXT, BUILDS, CONFIG, LIMITS, planFor, requireCI, diagnosticOutcome, freezePlan, summarize, validatePilot, validateMeasured } from './heap-repair-screen-protocol.mjs';
import { deriveBrowser, deriveNode, section } from './heap-portability-adapter.mjs';
import { validateBrowserLifecycle } from './heap-portability-lifecycle.mjs';
import { runBoundedCommand, validateNativeLifetime } from './heap-repair-screen-process.mjs';
import { json, sha256, manifest, writeJson, verifyTriple, compilerManifest } from './heap-repair-screen-source.mjs';
import { verifyBudget } from './heap-repair-screen-budget.mjs';
import { engineIdentity, validateProcessReceipt } from './heap-repair-screen-engine.mjs';
import { prepareCache, verifyCacheStart, archiveCacheEnd } from './heap-repair-screen-cache.mjs';
const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
const TRANSPORT_FILES = Object.freeze(JSON.parse(readFileSync(join(here, 'heap-repair-screen-transport.json'))));
export const PROOF_FILES = Object.freeze([
 ...Object.keys(TRANSPORT_FILES), '.github/workflows/heap-repair-screen.yml',
 'proofs/heap-repair-screen.md', 'proofs/heap-repair-screen-pins.json', 'proofs/heap-repair-screen-transport.json', 'proofs/heap-repair-screen-setup.sh',
 'proofs/heap-repair-screen-supervisor.py',
 ...['protocol', 'source', 'engine', 'browser', 'cache', 'cache-tests', 'runner', 'tests', 'engine-tests', 'process', 'lifetime', 'process-tests', 'budget'].map(name => `proofs/heap-repair-screen-${name}.mjs`),
 ...Object.keys(manifest(join(here, 'heap-repair-screen-history'))).map(name => `proofs/heap-repair-screen-history/${name}`),
]);
const subjectFiles = ['heap-entry-workloads.mjs', 'heap-entry-protocol.mjs', 'heap-entry-worker.mjs', 'heap-portability-semantic.mjs', 'heap-portability-node.mjs'];
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); };
const hardware = () => ({ at: new Date().toISOString(), cpus: os.cpus(), loadavg: os.loadavg(), freemem: os.freemem(), totalmem: os.totalmem(), uptimeSeconds: os.uptime() });
export const CHECKS = Object.freeze([
 ...['build:wasm', 'build:browser', 'build:types', 'typecheck', 'typecheck:redux', 'typecheck:values', 'typecheck:geometry'].map(id => ({ id, command: ['bun', 'run', id] })),
 { id: 'typecheck:worker', command: ['bun', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json'] },
 { id: 'test', command: ['bun', 'run', 'test'] },
 ...['worker-tasks', 'list-query', 'list-query-regression', 'memory-startup'].map(id => ({ id, command: ['node', '--test', `proofs/${id}.mjs`] })),
 ...['node-worker', 'redux-node', 'typed-json-worker'].map(id => ({ id, command: ['node', `proofs/${id}.mjs`] })),
 { id: 'check:package', command: ['bun', 'run', 'check:package'] },
]);
export function prospectiveManifest() {
 const receipts = Object.fromEntries(Object.entries(deriveBrowser()).map(([name, { source, ...receipt }]) => [name, receipt]));
 for (const [file, hash] of Object.entries(TRANSPORT_FILES)) assert.equal(sha256(readFileSync(join(root, file))), hash, `Audited transport changed ${file}`);
 const original = readFileSync(join(here, 'heap-portability-browser.mjs'), 'utf8'), changed = readFileSync(join(here, 'heap-repair-screen-browser.mjs'), 'utf8');
 const preserved = Object.fromEntries([
  ['workerCloseBarrier', "    checkpoint('worker-close');", "    result.status = 'completed';"],
 ].map(([name, start, end]) => {
  const expected = section(original, start, end);
  const actual = section(changed, start, '    result.processIdentity.push'); assert.equal(actual, expected); return [name, sha256(expected)];
 }));
 return { schema: 1, stage: 'prospective implementation; no timing or correctness claim', context: CONTEXT, plan: planFor(),
  checks: CHECKS, infrastructureBudget: verifyBudget(), browserAdapters: receipts, preservedBrowserSections: preserved,
  files: Object.fromEntries(PROOF_FILES.map(file => [file, sha256(readFileSync(join(root, file)))])),
  publication: 'Local exact-tree independent review only. No browser launch, timing, publication or main/PR integration authorized by this receipt.' };
}
export function verifyProspective() {
 const bytes = readFileSync(join(here, 'heap-repair-screen-manifest.json')); assert.deepEqual(JSON.parse(bytes), prospectiveManifest(), 'Prospective protocol/files changed'); return sha256(bytes);
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
    { stderrFd: err, signal, nativeScope: spec.nativeScope, receiptPath: join(evidence, prefix + '.native.json'), env: { ...process.env, HEAP_PORTABILITY_SUBJECT: '1', NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } })); }
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
export async function runPrerequisites(roots, execute, beforeTest, afterTest, persist) {
 const receipts = [];
 for (const build of BUILDS) {
  for (const check of CHECKS) {
   if (check.id === 'test') beforeTest(build);
   let receipt;
   try { receipt = await execute(build, check, roots[build]); receipts.push({ build, ...check, receipt }); persist(); requireSuccess(receipt); }
   finally { if (check.id === 'test') afterTest(build); }
  }
 }
 assert.equal(receipts.length, BUILDS.length * CHECKS.length);
 return { status: 'passed', receipts, standardTestCommand: ['bun', 'run', 'test'], cacheStateIdentical: true };
}
export function validateCorrectness(record) {
 const plan = planFor(); assert.deepEqual(record.plan, plan); assert.equal(record.correctness.length, 15);
 for (const [index, task] of plan.correctness.entries()) {
  const saved = record.correctness[index], { result, ...actual } = saved; assert.deepEqual(actual, task); assert.equal(result.status, 'passed');
  if (task.kind === 'worker') {
   assert.equal(result.rows.length, 5); assert.equal(result.actualWorkers, 1);
   for (const field of ['generatorLazyAccess', 'customDecoderOrderReceiverReentrantGrowthExceptions', 'sharedCopyMarkers', 'growthBeforeFirstNextAndWhilePaused', 'bytesStateDescriptorsUnchanged']) assert.equal(result[field], true);
  }
 }
 const strip = result => { const { build, sequence, ...plain } = result; return plain; };
 for (const task of plan.correctness.filter(row => row.build === 'baseline')) {
  const get = build => strip(record.correctness.find(row => row.build === build && row.kind === task.kind && row.workload === task.workload && row.copy === task.copy).result);
  const baseline = get('baseline'), current = get('current'), repair = get('repair');
  assert.deepEqual(current, repair, 'Current/repair actual semantics differ');
  if (task.kind === 'worker') semanticEquality(baseline, repair);
  else for (const key of ['workload', 'expected', 'identity']) assert.deepEqual(baseline[key], repair[key]);
 }
}
export function requireGlobalBarrier(record) {
 assert.equal(record.prerequisites?.status, 'passed', 'All three standard prerequisite suites must pass before pilots');
 assert.equal(record.prerequisites.receipts.length, 3 * CHECKS.length);
 for (const [index, receipt] of record.prerequisites.receipts.entries()) {
  const build = BUILDS[Math.floor(index / CHECKS.length)], check = CHECKS[index % CHECKS.length];
  assert.equal(receipt.build, build); assert.equal(receipt.id, check.id); assert.deepEqual(receipt.command, check.command); requireSuccess(receipt.receipt);
 }
 validateCorrectness(record); assert.equal(record.correctnessSha256, sha256(JSON.stringify(record.correctness)));
}
export async function executeStudy(record, plan, subject, persist, freezePlans) {
 requireGlobalBarrier(record); assert.equal(record.pilots.length, 0); assert.equal(record.rows.length, 0);
 record.rows = plan.cells.map(cell => ({ ...cell, blocks: [], invalid: [] })); persist();
 for (const planned of plan.pilots) {
  const entry = { ...planned, result: await subject(planned.build, { name: planned.workload, phase: 'pilot' }) };
  record.pilots.push(entry); persist(); validatePilot(entry.result);
 }
 const plans = plan.cases.map(workload => ({ workload, plan: freezePlan(record.pilots.filter(row => row.workload === workload.name).map(row => row.result)) }));
 for (const row of record.rows) row.plan = plans.find(entry => entry.workload.name === row.workload.name).plan;
 freezePlans(plans); record.plansFrozenBeforeMeasurement = true; persist();
 for (const planned of plan.measured) {
  const row = record.rows.find(row => row.name === planned.cell); let block = row.blocks.find(block => block.mode === planned.mode && block.block === planned.block);
  if (!block) { const fixed = row.schedule.find(block => block.mode === planned.mode && block.block === planned.block); block = { ...fixed, subjects: [] }; row.blocks.push(block); persist(); }
  assert.equal(block.subjects.length, planned.sequence);
  const result = await subject(planned.build, { name: planned.workload, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans });
  block.subjects.push({ ...result, role: planned.role }); persist(); validateMeasured(result, row.plan);
  assert.deepEqual(result.invalid, [], 'Measured duration floor missed; stop and retain partial subjects without replacement');
 }
 for (const row of record.rows) row.summary = summarize(row);
}
function correctnessRequest(task) { return { kind: task.kind, phase: 'correctness', name: task.workload ?? (task.copy ? 'copied-heap-semantics' : 'shared-heap-semantics'), ...(task.kind === 'worker' ? { copy: task.copy } : {}) }; }
export async function run(baseline, current, repair, evidence, sharedNodeModules) {
 const roots = Object.fromEntries(Object.entries({ baseline, current, repair }).map(([role, path]) => [role, realpathSync(path)]));
 evidence = resolve(evidence); const output = join(evidence, 'results.json'); assert(!existsSync(output), 'Never overwrite or retry a study'); mkdirSync(evidence, { recursive: true });
 const plan = planFor(), invocation = requireCI(plan.lane, process.env, json(process.env.GITHUB_EVENT_PATH));
 const prospectiveSha256 = verifyProspective(), abort = new AbortController(); let deadline;
 const setDeadline = (ms, reason) => { clearTimeout(deadline); deadline = setTimeout(() => abort.abort(reason), ms); };
 setDeadline(LIMITS.prerequisiteTotalMs, 'Frozen 60-minute full prerequisites deadline');
 const record = { schema: 1, status: 'preparing', invocation, plan, prospectiveSha256, controller: { versions: process.versions, arch: process.arch, platform: process.platform, execArgv: process.execArgv, execPath: process.execPath }, commands: [], correctness: [], pilots: [], rows: [], attempts: [], hardwareBefore: hardware() };
 const persist = () => { for (const row of record.rows) row.summary = summarize(row); record.outcome = diagnosticOutcome(record.rows, record.status === 'completed'); writeJson(output, record); }; persist();
 try {
  assert.equal(execFileSync('git', ['show', '-s', '--format=%P', process.env.GITHUB_SHA], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim(), CONTEXT.repair);
  copy(process.env.GITHUB_EVENT_PATH, join(evidence, 'push-event.json'));
  for (const file of [...PROOF_FILES, 'proofs/heap-repair-screen-manifest.json']) copy(join(root, file), join(evidence, 'proof', file));
  record.caches = {};
  for (const [build, cwd] of Object.entries(roots)) { mkdirSync(join(cwd, 'node_modules')); record.caches[build] = prepareCache(cwd, sharedNodeModules, join(evidence, 'caches', build)); persist(); }
  record.sourcesBefore = verifyTriple(roots, false); persist();
  for (const [build, cwd] of Object.entries(roots)) for (const file of Object.keys(record.sourcesBefore[build].files)) copy(join(cwd, file), join(evidence, 'sources', build, file));
  record.engineFrozen = await engineIdentity(); persist();
  record.prerequisites = await runPrerequisites(roots,
   (build, check, cwd) => command(evidence, record, { id: `${build}/${check.id}`, cwd, command: check.command, timeoutMs: LIMITS.prerequisiteMs }, persist, abort.signal),
   build => verifyCacheStart(roots[build], record.caches[build]),
   build => { record.caches[build].end = archiveCacheEnd(roots[build], join(evidence, 'caches', build)); persist(); }, persist);
  record.sources = verifyTriple(roots); persist();
  for (const build of BUILDS) assert.deepEqual(record.sourcesBefore[build].compilers, record.sources[build].compilers, 'Toolchain changed during prerequisites');
  for (const [build, cwd] of Object.entries(roots)) { for (const file of Object.keys(record.sources[build].wasm)) copy(join(cwd, file), join(evidence, 'sources', build, file)); copy(join(cwd, 'dist'), join(evidence, 'bundles', build, 'dist')); copy(join(cwd, 'package.json'), join(evidence, 'bundles', build, 'package.json')); }
  for (const [platform, derived] of Object.entries({ browser: deriveBrowser(), node: deriveNode() })) for (const [name, value] of Object.entries(derived)) { mkdirSync(join(evidence, 'derived', platform), { recursive: true }); writeFileSync(join(evidence, 'derived', platform, `${name}.mjs`), value.source); }
  record.inputManifests = Object.fromEntries(['proof', 'sources', 'bundles', 'derived', 'caches'].map(name => [name, manifest(join(evidence, name))]));
  const frozen = { invocation, plan, prospectiveSha256, sourceReceipts: record.sources, engine: record.engineFrozen, manifests: record.inputManifests };
  writeJson(join(evidence, 'frozen-study.json'), frozen); record.frozenStudySha256 = sha256(readFileSync(join(evidence, 'frozen-study.json'))); writeFileSync(join(evidence, 'frozen-study.sha256'), record.frozenStudySha256 + '\n', { flag: 'wx' }); persist();
  async function subject(build, request) {
   assert(!abort.signal.aborted, 'Controller deadline'); verifyProspective();
   assert.deepEqual(await engineIdentity(), frozen.engine, 'Runtime or installed browser bytes changed');
   const { neutral, files } = neutralSubject(evidence, build), sequence = record.attempts.length; assert.deepEqual(files, expectedNeutral(frozen, build));
   const attempt = { sequence, build, request, neutral, before: files, startedAt: new Date().toISOString(), status: 'running' }; record.attempts.push(attempt); persist();
   try {
    attempt.commandSequence = record.commands.length;
    const receipt = await command(evidence, record, { id: `${request.phase}/${build}/${request.name}`, cwd: neutral, command: [frozen.engine.controller.path, join(here, 'heap-repair-screen-browser.mjs'), JSON.stringify({ ...request, lane: plan.lane.name, neutral })], timeoutMs: LIMITS.browserSubjectMs, nativeScope: { root: frozen.engine.installed.root, manifestSha256: frozen.engine.installed.manifestSha256, supervisor: frozen.engine.supervisor } }, persist, abort.signal);
    try { attempt.raw = JSON.parse(readFileSync(join(evidence, receipt.stdout), 'utf8')); } catch (error) { attempt.parseError = String(error); }
    persist(); requireSuccess(receipt); validateBrowserLifecycle(attempt.raw, request, LIMITS.workerCloseMs);
    const raw = attempt.raw; validateNativeLifetime(receipt, raw.processIdentity); assert.deepEqual(raw.provenance, frozen.engine); assert.deepEqual(raw.provenanceAfter, frozen.engine); assert.equal(raw.engine.version, '155.0');
    assert.deepEqual(raw.processIdentity.map(row => row.checkpoint), ['after-launch', 'before-work', 'after-work']);
    for (const identity of raw.processIdentity) validateProcessReceipt(identity, frozen.engine, receipt.cleanup.group);
    assert.equal(new Set(raw.processIdentity.map(row => row.browserPid)).size, 1);
    assert.equal(raw.raw.status, 'completed'); attempt.status = 'completed'; return { ...raw.raw, status: 'passed', build, sequence };
   } catch (error) { attempt.status = 'failed'; attempt.error = String(error.stack ?? error); throw error; }
   finally { attempt.after = manifest(neutral); attempt.finishedAt = new Date().toISOString(); persist(); assert.deepEqual(attempt.after, files); }
  }
  record.status = 'correctness'; persist();
  for (const task of plan.correctness) { record.correctness.push({ ...task, result: await subject(task.build, correctnessRequest(task)) }); persist(); }
  validateCorrectness(record); record.correctnessSha256 = sha256(JSON.stringify(record.correctness)); requireGlobalBarrier(record);
  record.status = 'measuring'; record.prerequisitesFinishedAt = new Date().toISOString(); persist();
  setDeadline(LIMITS.controllerMs, 'Frozen 60-minute pilot and measured lane deadline');
  await executeStudy(record, plan, subject, persist, plans => { writeJson(join(evidence, 'plans.json'), plans); record.plansSha256 = sha256(readFileSync(join(evidence, 'plans.json'))); });
  record.status = 'completed'; persist(); assert.deepEqual(await engineIdentity(), frozen.engine);
  assert.deepEqual(verifyTriple(roots), record.sources);
  for (const [name, expected] of Object.entries(record.inputManifests)) assert.deepEqual(manifest(join(evidence, name)), expected);
  validateRecord(record, evidence);
 } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); persist(); throw error; }
 finally { clearTimeout(deadline); record.hardwareAfter = hardware(); record.finishedAt = new Date().toISOString(); record.cleanup = { status: record.commands.every(item => item.cleanup?.status === 'verified-no-live-processes') ? 'verified-no-live-processes' : 'incomplete', survivors: record.commands.flatMap(item => item.cleanup?.survivors ?? []) }; persist(); }
 return record;
}
export function validateRecord(record, evidence) {
 assert.equal(record.status, 'completed'); assert.equal(record.plansFrozenBeforeMeasurement, true); requireGlobalBarrier(record);
 const plan = planFor(); assert.deepEqual(record.plan, plan); assert.equal(record.attempts.length, 216); assert.equal(record.commands.length, 3 * CHECKS.length + 216);
 assert.equal(record.controller.versions.node, '22.23.3'); assert.equal(record.controller.arch, 'x64'); assert.equal(record.controller.platform, 'linux'); assert.deepEqual(record.controller.execArgv, []);
 for (const receipt of record.commands) { requireSuccess(receipt); if (evidence) for (const field of ['stdout', 'stderr']) assert.equal(sha256(readFileSync(join(evidence, receipt[field]))), receipt[`${field}Sha256`]); }
 let sequence = 0;
 const bind = (result, request, build) => {
  const attempt = record.attempts[sequence++]; assert.equal(attempt.sequence, result.sequence); assert.equal(attempt.build, build); assert.deepEqual(attempt.request, request); assert.equal(attempt.status, 'completed'); assert.deepEqual(attempt.before, attempt.after);
  const { role, build: ignored, sequence: ignoredSequence, ...raw } = result; raw.status = 'completed'; assert.deepEqual(raw, attempt.raw.raw);
  validateBrowserLifecycle(attempt.raw, request, LIMITS.workerCloseMs); assert.deepEqual(attempt.raw.provenance, record.engineFrozen); assert.deepEqual(attempt.raw.provenanceAfter, record.engineFrozen);
 };
 for (const [index, task] of plan.correctness.entries()) bind(record.correctness[index].result, correctnessRequest(task), task.build);
 assert.equal(record.pilots.length, 9); assert.equal(record.rows.length, 6);
 for (const [index, task] of plan.pilots.entries()) { const { result, ...saved } = record.pilots[index]; assert.deepEqual(saved, task); validatePilot(result); bind(result, { name: task.workload, phase: 'pilot' }, task.build); }
 for (const [index, cell] of plan.cells.entries()) { const row = record.rows[index]; for (const key of ['name', 'workload', 'pair', 'schedule']) assert.deepEqual(row[key], cell[key]); assert.deepEqual(row.plan, freezePlan(record.pilots.filter(p => p.workload === row.workload.name).map(p => p.result))); assert.equal(row.blocks.length, 8); }
 for (const task of plan.measured) { const row = record.rows.find(row => row.name === task.cell), block = row.blocks.find(block => block.block === task.block && block.mode === task.mode), result = block.subjects[task.sequence]; assert.equal(block.subjects.length, 4); assert.equal(result.role, task.role); validateMeasured(result, row.plan); assert.deepEqual(result.invalid, []); bind(result, { name: task.workload, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans }, task.build); }
 assert.equal(sequence, 216); for (const row of record.rows) assert.deepEqual(row.summary, summarize(row)); assert.equal(record.outcome, diagnosticOutcome(record.rows, true));
 if (evidence) {
  assert.equal(record.prospectiveSha256, verifyProspective()); const frozen = json(join(evidence, 'frozen-study.json'));
  assert.deepEqual(frozen, { invocation: record.invocation, plan: record.plan, prospectiveSha256: record.prospectiveSha256, sourceReceipts: record.sources, engine: record.engineFrozen, manifests: record.inputManifests });
  assert.equal(sha256(readFileSync(join(evidence, 'frozen-study.json'))), record.frozenStudySha256); assert.equal(readFileSync(join(evidence, 'frozen-study.sha256'), 'utf8').trim(), record.frozenStudySha256);
  for (const [name, expected] of Object.entries(frozen.manifests)) assert.deepEqual(manifest(join(evidence, name)), expected);
  assert.equal(sha256(readFileSync(join(evidence, 'plans.json'))), record.plansSha256);
  assert.deepEqual(json(join(evidence, 'plans.json')), plan.cases.map(workload => ({ workload, plan: record.rows.find(row => row.workload.name === workload.name).plan })));
  const derived = deriveBrowser(), helpers = { '/study/workloads.mjs': derived.workload.sourceSha256, '/study/subject.mjs': derived.subject.sourceSha256, '/study/protocol.mjs': derived.protocol.sourceSha256, '/study/fixture.mjs': derived.fixture.sourceSha256, '/study/shims.mjs': derived.shims.sourceSha256, '/study/workers.mjs': derived.parent.sourceSha256, '/proofs/heap-entry-worker.mjs': derived.worker.sourceSha256 };
  for (const attempt of record.attempts) {
   assert.equal(attempt.neutral, resolve(evidence, 'neutral')); assert.deepEqual(attempt.before, expectedNeutral(frozen, attempt.build)); assert.deepEqual(attempt.raw, JSON.parse(readFileSync(join(evidence, record.commands[attempt.commandSequence].stdout), 'utf8')));
   validateNativeLifetime(record.commands[attempt.commandSequence], attempt.raw.processIdentity);
   assert.equal(attempt.raw.engine.version, '155.0'); assert.equal(attempt.raw.engine.name, 'firefox'); assert.equal(attempt.raw.playwright, '1.63.0'); assert.deepEqual(attempt.raw.before, attempt.before); assert.deepEqual(attempt.raw.after, attempt.after);
   assert.deepEqual(attempt.raw.processIdentity.map(row => row.checkpoint), ['after-launch', 'before-work', 'after-work']);
   for (const identity of attempt.raw.processIdentity) validateProcessReceipt(identity, record.engineFrozen, record.commands[attempt.commandSequence].cleanup.group);
   assert.equal(new Set(attempt.raw.processIdentity.map(row => row.browserPid)).size, 1);
   for (const fetch of attempt.raw.requests) if (fetch.path !== '/') assert.equal(fetch.sha256, fetch.path.startsWith('/subject/') ? attempt.before[fetch.path.slice('/subject/'.length)] : helpers[fetch.path]);
  }
 }
 return true;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 const [mode, ...args] = process.argv.slice(2);
 if (mode === 'verify') console.log(verifyProspective());
 else if (mode === 'run') { const result = await run(...args); if (result.outcome !== 'positive-selected-case-effect-only') process.exitCode = 1; }
 else if (mode === 'validate') console.log(validateRecord(json(join(args[0], 'results.json')), args[0]));
 else throw new Error('Expected verify, run BASELINE CURRENT REPAIR EVIDENCE SHARED_NODE_MODULES, or validate EVIDENCE');
}
