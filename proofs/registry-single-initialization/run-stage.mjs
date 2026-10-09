/** One prospectively bounded stage. No dispatch, local timing mode, resume or retry. */
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../worker-arena-source-guard.mjs';
import { protocol, randomSource, shuffle, scheduleCase, variantFor, settingsFor, freezeWork, validateResult, stageDecision } from './protocol.mjs';
import { frozen, protocolHash, pinsHash, proofSnapshot, verifyCurrentInputs, verifyPreparation, verifyStageOne } from './gate-guard.mjs';
import { sourceContext, stageCanonical, checkAfterSubject, cleanEnvironment, treeManifest } from './package-tools.mjs';
import { runToFiles } from './run-to-files.mjs';

const [stageArg, prepareArg, outputArg, stageOneArg] = process.argv.slice(2), stage = Number(stageArg);
assert([1, 2].includes(stage) && prepareArg && outputArg && process.argv.length === (stage === 1 ? 5 : 6));
const arch = stage === 1 ? 'arm64' : 'x64';
const proofRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const preparation = realpathSync(prepareArg), output = resolve(outputArg);
assert(!existsSync(output), 'A stage output must be new; no overwrite, resume or retry');
mkdirSync(output, { recursive: true });
for (const d of ['raw', 'inputs', 'staging', 'temporary']) mkdirSync(join(output, d));
const node = realpathSync(process.execPath), bun = realpathSync(process.env.BUN_EXECUTABLE);
const roots = Object.fromEntries(protocol.variants.map(role => [role, join(preparation, 'worktrees', role)]));
const canonical = join(output, 'staging', 'subject');
const subjectBytes = Object.fromEntries(['original', 'owned'].map(name => [name, readFileSync(new URL('./' + name + '-subject.mjs', import.meta.url))]));
const selected = protocol.cases.filter(row => row.stage === stage);
const record = {
  schemaVersion: 1, stage, arch, status: 'preparing', startedAt: new Date().toISOString(), protocol,
  protocolSha256: protocolHash(), frozenPinsSha256: pinsHash(),
  runner: Object.fromEntries(['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'RUNNER_ARCH', 'RUNNER_OS', 'ImageOS', 'ImageVersion'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
  host: { platform: process.platform, arch: process.arch, osRelease: release(), cpus: cpus(), loadavgBefore: loadavg() },
  schedule: selected.map(row => {
    const index = protocol.cases.indexOf(row);
    return { id: row.id, blocks: scheduleCase(row, protocol.seed + index), pilotOrder: shuffle(protocol.variants, randomSource(protocol.seed + 100 + index)) };
  }),
  rows: selected.map(row => ({ ...row, pilots: {}, plan: null, blocks: [] })),
  invocations: [], pilotSubjects: 0, measuredSubjects: 0,
  runtimeSettings: { childFlags: ['--expose-gc'], compileCache: 'disabled', jit: 'default', roleMetadataInSubject: false, normalization: 'none' },
  canonicalPackagePath: canonical,
};
function checkpoint() {
  try { record.decision = stageDecision(record.rows, stage, { runComplete: record.status === 'completed', integrityComplete: record.integrityComplete === true }); }
  catch (error) {
    record.decision = { passed: false, stage2Permitted: false, summaryError: error.stack ?? String(error) };
    if (record.status === 'completed') { record.status = 'failed'; process.exitCode = 1; }
  }
  writeFileSync(join(output, 'summary.json'), JSON.stringify(record, null, 2) + '\n');
}
checkpoint();
let ordinal = 0;
try {
  assert.equal(process.platform, protocol.toolchain.platform); assert.equal(process.arch, arch);
  assert.equal(process.versions.node, protocol.toolchain.node); assert.equal(process.versions.bun, undefined); assert.deepEqual(process.execArgv, []);
  const guard = verifyCurrentInputs(roots, proofRoot, arch, node, bun); record.guardBefore = guard; record.proofCommit = guard.proof.commit;
  const preparedBytes = readFileSync(join(preparation, 'summary.json'));
  const prepared = JSON.parse(preparedBytes); verifyPreparation(prepared, guard, arch);
  record.preparationSummarySha256 = sha256(preparedBytes);
  record.preparationFinishedAt = prepared.finishedAt;
  assert(Date.parse(prepared.finishedAt) <= Date.parse(record.startedAt), 'Prerequisites must finish before this stage');
  cpSync(join(preparation, 'summary.json'), join(output, 'inputs', 'preparation-summary.json'));
  cpSync(join(proofRoot, 'proofs/registry-single-initialization'), join(output, 'inputs', 'proof'), { recursive: true });
  if (stage === 2) {
    const stageOneBytes = readFileSync(stageOneArg), checksum = readFileSync(stageOneArg + '.sha256', 'utf8').trim();
    assert.match(checksum, /^[a-f0-9]{64}$/); assert.equal(sha256(stageOneBytes), checksum, 'Stage1 transfer checksum mismatch');
    const prior = JSON.parse(stageOneBytes);
    record.stageOneDecision = verifyStageOne(prior, record.proofCommit, process.env.GITHUB_RUN_ID);
    record.stageOneSha256 = checksum;
    cpSync(stageOneArg, join(output, 'inputs', 'stage1-summary.json'));
    cpSync(stageOneArg + '.sha256', join(output, 'inputs', 'stage1-summary.json.sha256'));
  }
  const contexts = Object.fromEntries(protocol.variants.map(role => [role, sourceContext(roots[role])]));
  for (const role of protocol.variants) assert.deepEqual(contexts[role].packageBytes, contexts.main.packageBytes);
  const environment = cleanEnvironment({ ...process.env, TMPDIR: join(output, 'temporary') });
  record.runtimeSettings.childEnvironment = environment;
  record.sourceContexts = Object.fromEntries(protocol.variants.map(role => [role, { packageSha256: sha256(contexts[role].packageBytes), completeDist: contexts[role].distManifest }]));
  const scheduleBytes = JSON.stringify({ protocolSha256: record.protocolSha256, frozenPinsSha256: record.frozenPinsSha256, schedule: record.schedule }, null, 2) + '\n';
  writeFileSync(join(output, 'schedule-before-pilots.json'), scheduleBytes); record.scheduleSha256 = sha256(scheduleBytes);
  function invoke(variant, request, row, position) {
    const bytes = subjectBytes[row.subject], before = stageCanonical(contexts[variant], canonical, bytes);
    const id = String(++ordinal).padStart(4, '0');
    const args = ['--expose-gc', join(canonical, 'subject.mjs'), JSON.stringify(request)];
    const call = { ordinal, variant, caseId: row.id, phase: request.phase, position, startedAt: new Date().toISOString(), command: [node, ...args], stageBefore: before, status: 'running', stdout: 'raw/' + id + '.stdout', stderr: 'raw/' + id + '.stderr' };
    record.invocations.push(call); checkpoint();
    const result = runToFiles(node, args, { cwd: canonical, env: environment, timeout: protocol.subjectTimeoutMs, stdoutPath: join(output, call.stdout), stderrPath: join(output, call.stderr) });
    Object.assign(call, { status: result.status === 0 ? 'completed' : 'failed', exitStatus: result.status, signal: result.signal, error: result.error?.message,
      finishedAt: new Date().toISOString(), stdout: 'raw/' + id + '.stdout', stderr: 'raw/' + id + '.stderr', stdoutSha256: sha256(result.stdout ?? ''), stderrSha256: sha256(result.stderr ?? '') });
    checkpoint();
    call.stageAfter = checkAfterSubject(contexts[variant], canonical, before);
    assert.equal(result.status, 0, 'Subject failed; partial JSONL retained; no retry: ' + (result.error?.message ?? result.stderr));
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[0].event, 'start'); assert.equal(events[1].event, 'setup'); assert.equal(events.at(-1).event, 'result');
    assert(events.slice(2, -1).every(e => e.event === 'batch'));
    const parsed = events.at(-1).result;
    writeFileSync(join(output, 'raw', id + '.json'), JSON.stringify(parsed, null, 2) + '\n');
    assert.deepEqual(events[0].request, request);
    assert.deepEqual(events.filter(e => e.event === 'batch').map(e => e.row), [...parsed.calibration, ...parsed.warmup, ...parsed.measured]);
    validateResult(parsed, request, row, variant);
    assert.equal(parsed.metadata.versions.node, protocol.toolchain.node); assert.equal(parsed.metadata.arch, arch);
    assert.equal(parsed.metadata.executableSha256, frozen.toolsByArchitecture[arch].node.sha256);
    assert.deepEqual(parsed.metadata.execArgv, ['--expose-gc']);
    assert.equal(parsed.metadata.cwd, canonical); assert.equal(parsed.metadata.entryPath, join(canonical, 'dist/shared.js'));
    assert.equal(parsed.metadata.harnessSha256, sha256(bytes));
    assert.equal(parsed.metadata.entrySha256, before.entries.find(e => e.path === 'dist/shared.js').sha256);
    assert.equal(parsed.metadata.packageSha256, sha256(contexts[variant].packageBytes));
    if (request.phase === 'pilot') record.pilotSubjects++; else record.measuredSubjects++;
    checkpoint();
    return { ordinal, result: parsed };
  }
  record.status = 'pilots'; checkpoint();
  for (const row of record.rows) {
    const schedule = record.schedule.find(s => s.id === row.id);
    for (const variant of schedule.pilotOrder) {
      row.pilots[variant] = invoke(variant, { operation: row.operation, arenas: row.arenas, phase: 'pilot', settings: settingsFor(row) }, row, { phase: 'pilot' }); checkpoint();
    }
    row.plan = { ...freezeWork(row, row.pilots), frozenAt: new Date().toISOString() }; checkpoint();
  }
  assert.equal(record.pilotSubjects, record.rows.length * 3);
  record.plansFrozenAt = new Date().toISOString();
  const plans = { protocolSha256: record.protocolSha256, frozenPinsSha256: record.frozenPinsSha256, scheduleSha256: record.scheduleSha256, rows: record.rows.map(row => ({ id: row.id, pilots: row.pilots, plan: row.plan })) };
  writeFileSync(join(output, 'frozen-plans.json'), JSON.stringify(plans, null, 2) + '\n'); record.frozenPlansSha256 = sha256(readFileSync(join(output, 'frozen-plans.json')));
  record.status = 'measuring'; checkpoint();
  for (const row of record.rows) for (const planned of record.schedule.find(s => s.id === row.id).blocks) {
    const block = { ...planned, subjects: [] }; row.blocks.push(block); checkpoint();
    for (const role of planned.roles) {
      const variant = variantFor(planned.arm, role);
      block.subjects.push({ role, variant, ...invoke(variant, { operation: row.operation, arenas: row.arenas, phase: 'measure', iterations: row.plan.iterations, settings: settingsFor(row) }, row, { ...planned, role }) }); checkpoint();
    }
    console.log(row.id + ' ' + planned.arm + ' quartet ' + planned.quartet + '/' + row.quartets + ' retained');
  }
  assert.equal(record.measuredSubjects, protocol.stageBudgets[stage]);
  assert.equal(record.invocations.length, record.pilotSubjects + record.measuredSubjects);
  for (const [index, call] of record.invocations.entries()) {
    assert.equal(call.ordinal, index + 1); assert.equal(call.status, 'completed'); assert.equal(call.exitStatus, 0);
    const start = Date.parse(call.startedAt), end = Date.parse(call.finishedAt);
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'Invocation timestamps inconsistent');
    if (index) assert(start >= Date.parse(record.invocations[index - 1].finishedAt), 'Fresh processes overlap or clock chronology failed');
    if (call.phase === 'pilot') assert(end <= Date.parse(record.plansFrozenAt));
    else assert(start >= Date.parse(record.plansFrozenAt), 'Measurement started before all common work was frozen');
  }
  assert.equal(record.scheduleSha256, sha256(readFileSync(join(output, 'schedule-before-pilots.json'))));
  assert.equal(record.frozenPlansSha256, sha256(readFileSync(join(output, 'frozen-plans.json'))));
  assert.equal(record.preparationSummarySha256, sha256(readFileSync(join(preparation, 'summary.json'))));
  record.guardAfter = verifyCurrentInputs(roots, proofRoot, arch, node, bun);
  assert.deepEqual(record.guardAfter, record.guardBefore, 'Frozen source/toolchain/proof inputs changed');
  assert.deepEqual(treeManifest(join(output, 'inputs', 'proof')), proofSnapshot(proofRoot).files);
  for (const row of record.rows) assert.deepEqual(row.blocks.map(({ subjects, ...b }) => b), record.schedule.find(s => s.id === row.id).blocks);
  record.integrityComplete = true; record.status = 'completed';
} catch (error) {
  record.status = 'failed'; record.error = error.stack ?? String(error); process.exitCode = 1;
  console.error(record.error);
} finally {
  record.finishedAt = new Date().toISOString(); record.host.loadavgAfter = loadavg(); checkpoint();
  writeFileSync(join(output, 'summary.json.sha256'), sha256(readFileSync(join(output, 'summary.json'))) + '\n');
  if (stage === 1 && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'advance=' + (record.status === 'completed' && record.decision.stage2Permitted === true ? 'true' : 'false') + '\n');
  console.log(JSON.stringify({ stage, status: record.status, measuredSubjects: record.measuredSubjects, decision: record.decision }));
}
