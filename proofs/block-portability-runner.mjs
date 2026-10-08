import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { bundleManifest, sha256 } from './block-traversal-source.mjs';
import { fullManifest, writeJson } from './block-traversal-empty-controls.mjs';
import { prepareSubject } from './block-traversal-performance.mjs';
import { deriveModule, schedule as correctnessSchedule } from './block-traversal-chromium-adapter.mjs';
import { executeCase } from './block-traversal-chromium-isolation.mjs';
import { LANES, CONTEXT, CONFIG, prospectivePlan, deriveSubject, freezeCommonWork, summarizePortability, verifyReusedHelpers } from './block-portability-protocol.mjs';
import { validatePrerequisites, verifyExactPair } from './block-portability-prerequisites.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const snapshot = () => ({ at: new Date().toISOString(), loadavg: os.loadavg(), freemem: os.freemem(), totalmem: os.totalmem(),
  cpus: os.cpus().map(({ model, speed, times }) => ({ model, speed, times })), uptimeSeconds: os.uptime() });
export function engineIdentity(engine) {
  const identity = { path: null, sha256: null, bytes: null, status: 'unavailable', error: null };
  try {
    identity.path = engine.executablePath(); const bytes = readFileSync(identity.path);
    identity.sha256 = sha256(bytes); identity.bytes = bytes.length; identity.status = 'recorded';
  } catch (error) { identity.error = String(error); }
  return identity;
}
export function proofManifest() {
  const names = readdirSync(here).filter(name => /^block-(?:traversal|portability)[.-]/.test(name) && /\.(mjs|ts|md|json)$/.test(name) && name !== 'block-portability-manifest.json').sort();
  const files = Object.fromEntries(names.map(name => [`proofs/${name}`, sha256(readFileSync(join(here, name)))]));
  files['.github/workflows/block-portability.yml'] = sha256(readFileSync(join(root, '.github/workflows/block-portability.yml')));
  return files;
}
export function prospectiveManifest() {
  verifyReusedHelpers();
  const subject = deriveSubject();
  return { schema: 1, stage: 'prospective-only; no timings', proofBase: 'd016ba306375bb9e2146befa68efd112916f34b6',
    context: CONTEXT, lanes: LANES.map(lane => prospectivePlan(lane.name)),
    proofFiles: proofManifest(), kernel: { originalSha256: subject.originalSha256, derivedFunctionSha256: subject.derivedFunctionSha256,
      sourceSha256: subject.sourceSha256, transformations: subject.transformations },
    total: { rows: 44, pilots: 88, measuredSubjects: 1408, measuredBatches: 29568, quartets: 352 },
    authorization: 'This deliverable is prospective only. The parent owns publication of the reviewed proof and its authorized single scoped-push execution; this worker has performed no latency measurement.' };
}
export function verifyProspective() {
  const bytes = readFileSync(join(here, 'block-portability-manifest.json'));
  assert.deepEqual(JSON.parse(bytes), prospectiveManifest(), 'Reviewed prospective protocol or code changed');
  return sha256(bytes);
}
export function requireCI(lane) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Browser/timing execution is CI-only; no local launch');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'No execution retry');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/proof/block-traversal-portability-20261008');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  assert.equal(event.before, 'd016ba306375bb9e2146befa68efd112916f34b6');
  assert.equal(event.forced, false); assert.equal(event.created, false); assert.equal(event.deleted, false);
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/); assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.equal(event.after, process.env.GITHUB_SHA);
  assert.equal(process.versions.node, '22.23.3'); assert.equal(process.arch, lane.arch); assert.equal(process.platform, 'linux');
  assert.equal(process.env.NODE_OPTIONS ?? '', ''); assert.equal(process.env.BUN_OPTIONS ?? '', '');
}
function deadline(promise, timeout, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout); })]).finally(() => clearTimeout(timer));
}
async function serverFor({ baseline, candidate, study, neutral }) {
  const server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Block portability</title>'); return; }
    const special = {
      '/study/single-case.mjs': join(study, 'single-case.mjs'), '/study/page.mjs': join(here, 'block-traversal-chromium-page.mjs'),
      '/study/kernel.mjs': join(study, 'kernel.mjs'), '/study/workloads.mjs': join(here, 'block-traversal-workloads.mjs'),
      '/proofs/block-traversal-worker.mjs': join(here, 'block-traversal-worker.mjs'),
    };
    let path = special[pathname];
    if (!path) {
      const [, scope, ...parts] = pathname.split('/'), base = { baseline, candidate, subject: neutral }[scope];
      if (base) { const value = resolve(base, ...parts); if (value.startsWith(resolve(base) + sep)) path = value; }
    }
    try { assert(path); res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.json') ? 'application/json' : 'text/javascript'); res.end(readFileSync(path)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
export async function correctness(baseline, candidate, evidence, laneName) {
  const { lane } = prospectivePlan(laneName); requireCI(lane); assert.equal(lane.arch, 'x64'); verifyProspective();
  const directory = join(evidence, 'browser-correctness'); assert(!existsSync(directory), 'No correctness retry'); mkdirSync(directory);
  const record = { status: 'running', runtime: lane.runtime, context: CONTEXT, results: [], startedAt: new Date().toISOString(), hardwareBefore: snapshot() };
  const save = () => writeJson(join(directory, 'results.json'), record); save();
  let server;
  try {
    verifyExactPair(baseline, candidate);
    writeFileSync(join(directory, 'single-case.mjs'), deriveModule().source);
    server = await serverFor({ baseline: join(baseline, 'dist'), candidate: join(candidate, 'dist'), study: directory, neutral: join(directory, 'unused') });
    const playwright = await import('playwright');
    record.playwright = readJson(join(root, 'node_modules/playwright/package.json')).version; assert.equal(record.playwright, '1.63.0');
    record.engineExecutable = engineIdentity(playwright[lane.runtime]); save();
    for (const task of correctnessSchedule()) {
      const receipt = { ...task, runtime: lane.runtime, startedAt: new Date().toISOString() }; record.results.push(receipt); save();
      Object.assign(receipt, await executeCase(playwright[lane.runtime], server.origin, task, progress => { Object.assign(receipt, progress, { runtime: lane.runtime }); save(); }), { runtime: lane.runtime });
      receipt.finishedAt = new Date().toISOString(); save();
      // A failed closure means no safe next process; preserve the partial plan.
      assert(!receipt.cleanupError, 'Correctness cleanup failed; stop before another launch');
    }
    assert.equal(record.results.length, 92); assert(record.results.every(row => row.status === 'passed'), 'Correctness failed; timing is forbidden');
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); throw error; }
  finally {
    if (server) { try { await server.close(); record.serverClosed = true; } catch (error) { record.status = 'failed'; record.cleanupError = String(error); } }
    record.hardwareAfter = snapshot(); record.finishedAt = new Date().toISOString(); save();
  }
  assert.equal(record.status, 'passed'); return record;
}
export function prepare(baseline, candidate, evidence, laneName) {
  const directory = join(resolve(evidence), 'latency'); assert(!existsSync(directory), 'Prepared output must be new'); mkdirSync(directory);
  const receipt = { status: 'preparing', stage: 'prerequisites', startedAt: new Date().toISOString() };
  const save = () => writeJson(join(directory, 'preparation.json'), receipt); save();
  try {
    const { lane } = prospectivePlan(laneName); requireCI(lane);
    const protocolSha256 = verifyProspective(), prerequisites = validatePrerequisites(evidence, baseline, candidate, laneName);
    const comparison = verifyExactPair(baseline, candidate);
    receipt.stage = 'archive-inputs'; save();
    for (const [build, sourceRoot] of Object.entries({ baseline, candidate })) {
      cpSync(join(sourceRoot, 'dist'), join(directory, 'bundles', build, 'dist'), { recursive: true });
      cpSync(join(sourceRoot, 'package.json'), join(directory, 'bundles', build, 'package.json'));
      for (const file of [...Object.keys(comparison.sourceManifests[build].files), ...Object.keys(comparison.sourceManifests[build].wasm)]) {
        const target = join(directory, 'source', build, file); mkdirSync(dirname(target), { recursive: true }); cpSync(join(sourceRoot, file), target);
      }
    }
    for (const file of Object.keys(proofManifest())) { const target = join(directory, 'proof', file); mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, file), target); }
    cpSync(join(here, 'block-portability-manifest.json'), join(directory, 'prospective-manifest.json'));
    const derived = deriveSubject(); writeFileSync(join(directory, 'kernel.mjs'), derived.source);
    writeFileSync(join(directory, 'subject.mjs'), "import {measurePortability} from './kernel.mjs'; const raw = await measurePortability(JSON.parse(process.argv[2])); console.log(JSON.stringify({raw, runtime:process.versions, arch:process.arch, execArgv:process.execArgv}));\n");
    const frozen = { ...prospectivePlan(laneName), proofCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: 1,
      protocolSha256, prerequisitesSha256: prerequisites.sha256, prerequisiteRoots: { baseline: resolve(baseline), candidate: resolve(candidate) }, comparison,
      archives: Object.fromEntries(['bundles', 'source', 'proof'].map(name => [name, fullManifest(join(directory, name))])),
      kernelSha256: sha256(readFileSync(join(directory, 'kernel.mjs'))), launcherSha256: sha256(readFileSync(join(directory, 'subject.mjs'))),
      preparedAt: new Date().toISOString() };
    writeJson(join(directory, 'frozen-study.json'), frozen); writeFileSync(join(directory, 'frozen-study.sha256'), sha256(readFileSync(join(directory, 'frozen-study.json'))) + '\n');
    receipt.status = 'prepared'; receipt.stage = 'complete'; receipt.finishedAt = new Date().toISOString(); save(); return frozen;
  } catch (error) { receipt.status = 'failed'; receipt.error = String(error.stack ?? error); receipt.finishedAt = new Date().toISOString(); save(); throw error; }
}
export function verifyPrepared(directory) {
  const bytes = readFileSync(join(directory, 'frozen-study.json')), frozen = JSON.parse(bytes);
  assert.equal(sha256(bytes), readFileSync(join(directory, 'frozen-study.sha256'), 'utf8').trim());
  const plan = prospectivePlan(frozen.lane.name); for (const key of Object.keys(plan)) assert.deepEqual(frozen[key], plan[key]);
  assert.equal(frozen.protocolSha256, verifyProspective());
  assert.equal(sha256(readFileSync(join(directory, 'prospective-manifest.json'))), frozen.protocolSha256);
  for (const [name, expected] of Object.entries(frozen.archives)) assert.deepEqual(fullManifest(join(directory, name)), expected);
  assert.equal(sha256(readFileSync(join(directory, 'kernel.mjs'))), frozen.kernelSha256); assert.equal(frozen.kernelSha256, deriveSubject().sourceSha256);
  assert.equal(sha256(readFileSync(join(directory, 'subject.mjs'))), frozen.launcherSha256);
  const { baseline, candidate } = frozen.prerequisiteRoots;
  assert.equal(validatePrerequisites(dirname(directory), baseline, candidate, frozen.lane.name).sha256, frozen.prerequisitesSha256);
  assert.deepEqual(verifyExactPair(baseline, candidate), frozen.comparison);
  return frozen;
}

export async function browserSubject(engine, origin, request, checkpoint) {
  const receipt = { status: 'running', stage: 'launch', browser: { launched: false, closeRequested: false, closeCompleted: false, disconnected: false }, console: [], pageErrors: [] };
  let browser;
  const stage = value => { receipt.stage = value; checkpoint(receipt); };
  try {
    browser = await engine.launch({ headless: true, timeout: 30000 }); receipt.browser.launched = true; receipt.version = browser.version();
    browser.on('disconnected', () => { receipt.browser.disconnected = true; });
    stage('create-page'); const page = await deadline(browser.newPage(), 30000, 'Page creation');
    page.on('console', item => receipt.console.push({ type: item.type(), text: item.text() })); page.on('pageerror', error => receipt.pageErrors.push(String(error)));
    stage('navigate'); await page.goto(origin, { timeout: 30000 });
    stage('subject');
    const output = await deadline(page.evaluate(async ({ origin, request }) => {
      if (!crossOriginIsolated) throw new Error('Cross-origin isolation required');
      const { measurePortability } = await import(`${origin}/study/kernel.mjs`);
      const raw = await measurePortability({ ...request, entryUrl: `${origin}/subject/dist/shared.js`, harnessUrl: `${origin}/study/workloads.mjs` });
      return { raw, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated };
    }, { origin, request }), CONFIG.subjectTimeoutMs, 'Subject');
    Object.assign(receipt, output); assert.equal(receipt.pageErrors.length, 0); receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.error = { stage: receipt.stage, message: String(error.stack ?? error) }; }
  finally {
    if (browser) {
      receipt.browser.closeRequested = true; stage('close');
      try { await deadline(browser.close(), 30000, 'Browser close'); receipt.browser.closeCompleted = true; }
      catch (error) { receipt.status = 'failed'; receipt.cleanupError = String(error); }
      if (!receipt.browser.disconnected) { receipt.status = 'failed'; receipt.cleanupError ??= 'Browser disconnection not observed'; }
    }
    stage('terminal');
  }
  return receipt;
}
export async function executeRows(rows, subject, persist) {
  // Freeze ALL pilot work before ANY measured subjects; this is the only adaptive phase.
  for (const row of rows) {
    row.pilots = {}; row.blocks = [];
    for (const build of row.pilotOrder) { row.pilots[build] = await subject(build, { workload: row.workload, phase: 'pilot' }); persist(); }
    row.plan = freezeCommonWork(row.workload, Object.values(row.pilots)); persist();
  }
  for (const row of rows) {
    for (const planned of row.schedule) {
      const block = { ...planned, subjects: [] }; row.blocks.push(block); persist();
      for (const role of planned.roles) {
        const result = await subject(planned[role], { workload: row.workload, phase: 'measure', repeat: row.plan.repeat, warmupScans: row.plan.warmupScans });
        assert.equal(result.digest, row.plan.expectedDigest); block.subjects.push({ role, ...result }); persist();
      }
    }
    row.summary = summarizePortability(row); persist();
  }
}
export async function run(evidence) {
  const directory = join(resolve(evidence), 'latency'), output = join(directory, 'results.json');
  assert(!existsSync(output), 'No timing retry or overwrite');
  const record = { status: 'verifying', startedAt: new Date().toISOString(), context: CONTEXT, rows: [], subjects: [], hardwareBefore: snapshot(), cleanup: {} };
  const save = () => writeJson(output, record); save(); let server;
  const neutral = join(directory, 'subject');
  try {
    const frozen = verifyPrepared(directory); requireCI(frozen.lane);
    assert.equal(frozen.proofCommit, process.env.GITHUB_SHA); assert.equal(frozen.runId, process.env.GITHUB_RUN_ID);
    Object.assign(record, { lane: frozen.lane, frozenStudySha256: sha256(readFileSync(join(directory, 'frozen-study.json'))), rows: structuredClone(frozen.rows), controller: { versions: process.versions, arch: process.arch, execArgv: process.execArgv } });
    const browser = frozen.lane.arch === 'x64'; let engine;
    if (browser) {
      const playwright = await import('playwright'); engine = playwright[frozen.lane.runtime];
      record.playwright = readJson(join(root, 'node_modules/playwright/package.json')).version; assert.equal(record.playwright, frozen.versions.playwright);
      record.engineExecutable = engineIdentity(engine);
      server = await serverFor({ study: directory, neutral }); record.origin = server.origin;
    }
    record.status = 'running'; save();
    const subject = async (build, request) => {
      const receipt = { sequence: record.subjects.length, build, phase: request.phase, workload: request.workload.name, startedAt: new Date().toISOString(), hardwareBefore: snapshot(), cleanup: {} };
      record.subjects.push(receipt); save();
      const source = join(directory, 'bundles', build, 'dist/shared.js'), packageHash = frozen.comparison.sourceManifests[build].files['package.json'];
      const entry = prepareSubject(source, neutral, frozen.comparison.manifests[build], packageHash);
      receipt.entry = browser ? `${server.origin}/subject/dist/shared.js` : entry; receipt.packageSha256 = packageHash; save();
      if (browser) Object.assign(receipt, await browserSubject(engine, server.origin, request, progress => { Object.assign(receipt, progress); save(); }));
      else {
        const runtime = frozen.lane.runtime;
        const args = [...(runtime === 'node' ? ['--expose-gc'] : []), join(directory, 'subject.mjs'), JSON.stringify({ ...request, entryUrl: pathToFileURL(entry).href, harnessUrl: pathToFileURL(join(here, 'block-traversal-workloads.mjs')).href })];
        receipt.command = [runtime, ...args.slice(0, -1)]; receipt.stage = 'spawn'; save();
        const child = spawnSync(runtime, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CONFIG.subjectTimeoutMs,
          env: { ...process.env, NODE_OPTIONS: '', BUN_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } });
        receipt.stdout = child.stdout; receipt.stderr = child.stderr; receipt.exitCode = child.status; receipt.signal = child.signal; receipt.error = child.error ? String(child.error) : null;
        receipt.cleanup.childExited = child.status !== null || child.signal !== null;
        receipt.status = child.status === 0 && !child.error && !child.signal ? 'passed' : 'failed';
        if (receipt.status === 'passed') Object.assign(receipt, JSON.parse(child.stdout));
      }
      receipt.finishedAt = new Date().toISOString(); receipt.hardwareAfter = snapshot(); save();
      assert.equal(receipt.status, 'passed', `Subject failed; no retry: ${request.workload.name}`);
      assert.deepEqual(bundleManifest(entry), frozen.comparison.manifests[build]); assert.equal(sha256(readFileSync(join(neutral, 'package.json'))), packageHash);
      const { expectedJson, ...data } = receipt.raw; const result = { sequence: receipt.sequence, build, ...data, digest: sha256(expectedJson) };
      if (request.phase === 'measure') { assert.equal(data.samples.length, 21); assert(data.samples.every(ms => Number.isFinite(ms) && ms > 0)); }
      return result;
    };
    await executeRows(record.rows, subject, save);
    verifyPrepared(directory);
    record.status = 'completed'; record.summary = record.rows.map(row => ({ name: row.workload.name, ...row.summary }));
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); }
  finally {
    if (server) { try { await server.close(); record.cleanup.serverClosed = true; } catch (error) { record.cleanup.serverError = String(error); record.status = 'failed'; } }
    try { rmSync(neutral, { recursive: true, force: true }); record.cleanup.neutralRemoved = !existsSync(neutral); } catch (error) { record.cleanup.neutralError = String(error); record.status = 'failed'; }
    record.hardwareAfter = snapshot(); record.finishedAt = new Date().toISOString(); save();
  }
  assert.equal(record.status, 'completed', 'Portability lane failed or is partial; preserve results'); return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'freeze') { const path = args[0] ?? join(here, 'block-portability-manifest.json'); assert(!existsSync(path), 'Do not overwrite a frozen prospective manifest'); writeJson(path, prospectiveManifest()); }
  else if (command === 'verify') console.log(verifyProspective());
  else if (command === 'correctness') await correctness(...args);
  else if (command === 'prepare') prepare(...args);
  else if (command === 'run') await run(...args);
  else throw new Error('Use freeze [FILE], verify, correctness BASE CANDIDATE EVIDENCE LANE, prepare BASE CANDIDATE EVIDENCE LANE, or run EVIDENCE');
}
