import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { BASELINE, CANDIDATE, CANDIDATE_TREE, CONFIG, randomSource, shuffle, makeSchedule, summarize, gate } from './heap-entry-protocol.mjs';
import { CASES, fixture, fixtureIdentity, consume } from './heap-entry-workloads.mjs';
import { prerequisites } from './heap-entry-prerequisites.mjs';
import { subject } from './heap-entry-subject.mjs';
import { runCommand, COMMAND_LIMITS } from './heap-entry-command.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
export const PROOF_FILES = ['heap-entry-command.mjs', 'heap-entry-workloads.mjs', 'heap-entry-protocol.mjs', 'heap-entry-subject.mjs', 'heap-entry-performance.mjs',
  'heap-entry-prerequisites.mjs', 'heap-entry-worker.mjs', 'heap-entry-protocol.node.mjs', 'heap-entry-performance.md'];
const atomic = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.tmp', path); };
export function inventory(root, prefix = '') {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const subpath = prefix ? prefix + '/' + name : name, path = join(root, subpath);
    return statSync(path).isDirectory() ? inventory(root, subpath) : [{ path: subpath, bytes: statSync(path).size, sha256: sha256(readFileSync(path)) }];
  });
}
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
export function guardSource(baselineRoot, candidateRoot) {
  assert.equal(git(baselineRoot, 'rev-parse', 'HEAD'), BASELINE);
  assert.equal(git(candidateRoot, 'rev-parse', 'HEAD^'), CANDIDATE, 'proof commit must directly follow frozen candidate');
  assert.equal(git(candidateRoot, 'rev-parse', CANDIDATE + '^{tree}'), CANDIDATE_TREE);
  assert.equal(git(candidateRoot, 'status', '--porcelain', '--untracked-files=no'), '', 'tracked source changed');
  assert.equal(git(baselineRoot, 'status', '--porcelain', '--untracked-files=no'), '', 'baseline source changed');
  const allow = new Set([...PROOF_FILES.map(f => 'proofs/' + f), '.github/workflows/heap-entry-performance.yml']);
  const changes = git(candidateRoot, 'diff', '--name-only', CANDIDATE, 'HEAD').split('\n').filter(Boolean);
  assert(changes.length > 0 && changes.every(file => allow.has(file)), 'runtime/tests or unrelated proof files changed');
  return { baseline: BASELINE, runtimeCandidate: CANDIDATE, candidateTree: CANDIDATE_TREE,
    proofCommit: git(candidateRoot, 'rev-parse', 'HEAD'), changedProofFiles: changes };
}
function environment() {
  const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  return { arch: process.arch, platform: process.platform, kernel: os.release(), cpu: os.cpus(), totalMemory: os.totalmem(), freeMemory: os.freemem(),
    loadAverage: os.loadavg(), node: process.version, governor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    scalingMinKHz: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq'), scalingMaxKHz: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq'),
    turboDisabled: read('/sys/devices/system/cpu/intel_pstate/no_turbo') };
}
export function freezePlan(pilots) {
  assert.equal(pilots.length, 2);
  assert(pilots.every(p => p.status === 'passed' && p.invalid.length === 0));
  assert.deepEqual(pilots[0].expected, pilots[1].expected, 'pilot oracle differs by arm');
  assert.deepEqual(pilots[0].identity, pilots[1].identity, 'fixture bytes or descriptors differ by arm');
  const repeat = Math.max(...pilots.map(p => p.repeat)), fastest = Math.min(...pilots.map(p => p.minMsPerIteration));
  assert(Number.isFinite(fastest) && fastest > 0);
  const warmupScans = Math.ceil((CONFIG.warmupTargetMs * 1.25 / fastest) / repeat) * repeat;
  assert(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= CONFIG.repeatLimit);
  assert(Number.isSafeInteger(warmupScans) && warmupScans > 0);
  return { repeat, warmupScans, fastestPilotMsPerIteration: fastest, expected: pilots[0].expected, identity: pilots[0].identity };
}
export function prepareSubject(source, neutral) {
  assert.deepEqual(inventory(join(source.root, 'dist')), source.dist);
  assert.equal(sha256(readFileSync(join(source.root, 'package.json'))), source.packageSha256);
  rmSync(neutral, { recursive: true, force: true }); mkdirSync(neutral, { recursive: true });
  cpSync(join(source.root, 'dist'), join(neutral, 'dist'), { recursive: true }); writeFileSync(join(neutral, 'package.json'), source.packageBytes);
  assert.deepEqual(inventory(join(neutral, 'dist')), source.dist);
  return pathToFileURL(join(neutral, 'dist/shared.js')).href;
}
export function assertPilotBarrier(rows) {
  assert.equal(rows.length, 32);
  assert(rows.every(row => row.plan && row.invalid.length === 0 && Object.keys(row.pilots).length === 2), 'Global pilot barrier failed; no measurement processes may start');
}
async function main() {
  if (process.argv[2] === '--fixture-check') {
    const api = await import(process.argv[3]), checks = [];
    for (const workload of CASES) {
      const { item, expected } = fixture(api, workload);
      assert.deepEqual(consume(item, workload), expected);
      assert.deepEqual(consume(item, workload), expected);
      checks.push({ name: workload.name, expected, identity: fixtureIdentity(api, item), cache: workload.cache });
    }
    console.log(JSON.stringify({ passed: true, checks })); return;
  }
  if (process.argv[2] === '--subject') {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'No local latency collection');
    assert.equal(process.env.HEAP_ENTRY_CI_SUBJECT, '1');
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
    console.log(JSON.stringify(await subject(JSON.parse(process.argv[3])))); return;
  }
  const [base, candidate, output] = process.argv.slice(2);
  assert(base && candidate && output, 'Usage: node proofs/heap-entry-performance.mjs BASELINE_ROOT CANDIDATE_ROOT EVIDENCE_ROOT');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Measurements are CI-only');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Only the predeclared first attempt is allowed');
  assert.equal(process.env.HEAP_ENTRY_ATTEMPT, '1');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/perf/heap-entry-views-20261008');
  assert.equal(process.arch, 'x64');
  const baselineRoot = resolve(base), candidateRoot = resolve(candidate), evidenceRoot = resolve(output);
  mkdirSync(evidenceRoot, { recursive: true });
  const random = randomSource(CONFIG.seed), caseOrder = shuffle(CASES, random), runtimeOrder = shuffle(['node', 'bun'], random);
  const rows = caseOrder.flatMap(workload => runtimeOrder.map(runtime => ({
    workload, runtime, pilots: {}, pilotOrder: shuffle(['baseline', 'candidate'], random), schedule: makeSchedule(random), blocks: [], invalid: [], status: 'awaiting-prerequisites',
  })));
  const record = { schema: 1, status: 'preparing', startedAt: new Date().toISOString(), config: CONFIG, environment: environment(), rows,
    processCounts: { fixtureProcesses: 4, pilots: 64, pilotBuilds: { baseline: 32, candidate: 32 },
      measurementProcesses: 1024, abProcesses: 512, aaBaselineProcesses: 512,
      measurementBuilds: { baseline: 768, candidate: 256 }, measurementRoles: { left: 512, right: 512 }, measuredBatches: 21504 },
    caseOrder: caseOrder.map(c => c.name), runtimeOrder, source: null, prerequisites: null,
    phases: [], harness: {}, invalidCells: [], method: 'See frozen proofs/heap-entry-performance.md; no timing-driven retries or exclusions.' };
  const checkpoint = () => {
    for (const row of rows) row.summary = summarize(row);
    record.invalidCells = rows.filter(r => !r.summary.usable).map(r => ({ runtime: r.runtime, case: r.workload.name, status: r.status, reasons: r.summary.invalid }));
    record.inconclusiveCells = rows.filter(r => r.summary.usable && r.summary.modes.ab.interval.upper > CONFIG.margin).map(r => ({ runtime: r.runtime, case: r.workload.name, interval: r.summary.modes.ab.interval }));
    record.establishedGains = rows.filter(r => r.summary.usable && r.workload.target && r.summary.modes.ab.interval.upper < CONFIG.gainThreshold).map(r => ({ runtime: r.runtime, case: r.workload.name, interval: r.summary.modes.ab.interval }));
    record.gate = gate(rows, record.status === 'completed'); atomic(join(evidenceRoot, 'result.json'), record);
  };
  checkpoint();
  const temporary = mkdtempSync(join(os.tmpdir(), 'heap-entry-neutral-')), neutral = join(temporary, 'package');
  let sequence = 0;
  try {
    record.source = guardSource(baselineRoot, candidateRoot);
    for (const file of PROOF_FILES) {
      const bytes = readFileSync(join(here, file)); record.harness[file] = { bytes: bytes.length, sha256: sha256(bytes) };
      mkdirSync(join(evidenceRoot, 'harness'), { recursive: true }); writeFileSync(join(evidenceRoot, 'harness', file), bytes);
    }
    checkpoint();
    record.prerequisites = await prerequisites({ baselineRoot, candidateRoot, evidenceRoot: join(evidenceRoot, 'prerequisites') });
    guardSource(baselineRoot, candidateRoot);
    const packages = Object.fromEntries(['baseline', 'candidate'].map(build => {
      const root = record.prerequisites[build].root, packageBytes = readFileSync(join(root, 'package.json'));
      return [build, { root, packageBytes, packageSha256: sha256(packageBytes), dist: inventory(join(root, 'dist')) }];
    }));
    assert.equal(packages.baseline.packageSha256, packages.candidate.packageSha256, 'package contexts differ');
    record.packageContext = { sha256: packages.baseline.packageSha256, canonicalEntry: join(neutral, 'dist/shared.js'), copiedVerbatim: true };
    const execute = async (runtime, build, request, fixtureOnly = false) => {
      const entryUrl = prepareSubject(packages[build], neutral), ordinal = sequence++, requestObject = { ...request, entryUrl };
      const prefix = join(evidenceRoot, 'processes', String(ordinal).padStart(4, '0'));
      mkdirSync(dirname(prefix), { recursive: true }); atomic(prefix + '.request.json', { runtime, build, ...requestObject });
      const startedAt = new Date().toISOString(), start = performance.now();
      const child = await runCommand({ name: 'subject-' + ordinal, command: record.prerequisites.runtimes[runtime].path,
        args: [fileURLToPath(import.meta.url), fixtureOnly ? '--fixture-check' : '--subject', fixtureOnly ? entryUrl : JSON.stringify(requestObject)],
        cwd: neutral, prefix, timeoutMs: COMMAND_LIMITS.subjectMs,
        env: { ...process.env, HEAP_ENTRY_CI_SUBJECT: '1', NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } });
      const execution = { sequence: ordinal, runtime, build, startedAt, finishedAt: new Date().toISOString(), wallMs: performance.now() - start,
        exitCode: child.status, signal: child.signal, timedOut: child.timedOut, cleanup: child.cleanup,
        error: child.error ?? null, logPrefix: relative(evidenceRoot, prefix) };
      atomic(prefix + '.execution.json', execution);
      if (child.interruptedSignal) throw new Error('Controller interrupted by ' + child.interruptedSignal);
      assert.equal(child.cleanup?.status, 'verified-no-live-processes', 'Owned process group cleanup unresolved; no later child may start');
      assert.deepEqual(inventory(join(neutral, 'dist')), packages[build].dist);
      assert.equal(sha256(readFileSync(join(neutral, 'package.json'))), packages[build].packageSha256);
      if (!child.complete) return { ...execution, status: 'failed', invalid: [child.timedOut ? 'child-process-timeout' : 'child-process-failed'] };
      try { return { ...execution, ...JSON.parse(readFileSync(child.stdout, 'utf8')), status: 'passed' }; }
      catch (error) { return { ...execution, status: 'failed', invalid: ['invalid-child-json'], error: String(error) }; }
    };
    record.fixtures = [];
    for (const runtime of runtimeOrder) for (const build of ['baseline', 'candidate']) {
      const result = await execute(runtime, build, {}, true); record.fixtures.push(result); checkpoint();
      assert.equal(result.status, 'passed', 'benchmark fixture proof failed before pilots');
      assert.deepEqual(result.checks, record.fixtures[0].checks, 'fixture inputs, bytes or outputs differ across arms/runtimes');
    }
    record.phases.push({ phase: 'all-pilots', startedAt: new Date().toISOString(), firstSequence: sequence }); record.status = 'pilots'; checkpoint();
    // Global barrier: every runtime/case pilot finishes before ANY measured process.
    for (const row of rows) {
      row.status = 'pilots';
      for (const build of row.pilotOrder) { row.pilots[build] = await execute(row.runtime, build, { workload: row.workload, phase: 'pilot' }); checkpoint(); }
      const pilots = Object.values(row.pilots);
      if (pilots.some(p => p.status !== 'passed' || p.invalid.length)) { row.invalid.push('invalid-pilot'); row.status = 'pilot-invalid'; checkpoint(); continue; }
      row.plan = freezePlan(pilots); row.status = 'plan-frozen'; checkpoint();
    }
    record.phases[record.phases.length - 1].finishedAt = new Date().toISOString();
    assertPilotBarrier(rows);
    record.phases.push({ phase: 'measurements', startedAt: new Date().toISOString(), firstSequence: sequence }); record.status = 'measuring'; checkpoint();
    for (const row of rows) {
      row.status = 'measuring';
      for (const scheduled of row.schedule) {
        const block = { ...scheduled, subjects: [] }; row.blocks.push(block);
        for (const role of scheduled.roles) {
          const build = scheduled.mode === 'ab' && role === 'right' ? 'candidate' : 'baseline';
          const result = await execute(row.runtime, build, { workload: row.workload, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans });
          block.subjects.push({ role, ...result }); checkpoint();
          if (result.status === 'passed') {
            assert.deepEqual(result.expected, row.plan.expected); assert.deepEqual(result.identity, row.plan.identity, 'measured fixture changed');
            assert.equal(result.repeat, row.plan.repeat); assert.equal(result.prescribedWarmupScans, row.plan.warmupScans);
          }
        }
        console.log(row.runtime + ' ' + row.workload.name + ' ' + scheduled.mode + ' quartet ' + (scheduled.block + 1));
      }
      row.status = 'completed'; checkpoint();
    }
    for (const build of ['baseline', 'candidate']) {
      assert.deepEqual(inventory(join(packages[build].root, 'dist')), packages[build].dist);
      assert.equal(sha256(readFileSync(join(packages[build].root, 'package.json'))), packages[build].packageSha256);
      for (const file of record.prerequisites[build].wasm.files) assert.equal(sha256(readFileSync(join(packages[build].root, file.path))), file.sha256);
    }
    guardSource(baselineRoot, candidateRoot); record.phases[record.phases.length - 1].finishedAt = new Date().toISOString();
    record.status = 'completed'; record.finishedAt = new Date().toISOString(); record.environmentAfter = environment(); checkpoint();
    if (record.gate !== 'strong-clear-requires-human-review') process.exitCode = 1;
  } catch (error) {
    record.status = 'failed'; record.error = String(error.stack ?? error); record.finishedAt = new Date().toISOString();
    for (const row of rows) if (row.status === 'awaiting-prerequisites') row.invalid.push('prerequisites-not-passed');
    checkpoint(); throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
