import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PIN, fullManifest, verifyForBrowser, writeJson, verifyHelpers } from './block-traversal-empty-controls.mjs';
import { prepareComparison, sha256 } from './block-traversal-source.mjs';
import { SUPPLEMENT, CONTEXT, deriveModule, schedule, coverage } from './block-traversal-chromium-adapter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const proofFiles = ['block-traversal-chromium-adapter.mjs', 'block-traversal-chromium-page.mjs', 'block-traversal-chromium-isolation.mjs', 'block-traversal-chromium-isolation.node.mjs', 'block-traversal-chromium-isolation.md'];
function git(args) {
  const child = spawnSync('git', args, { cwd: join(here, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
}
function extract(zip, output) {
  const script = `import pathlib,sys,zipfile,stat\np=pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(sys.argv[1]) as z:\n names=z.namelist()\n assert len(names)==len(set(names)), 'Duplicate ZIP entry'\n for entry in z.infolist():\n  name=pathlib.PurePosixPath(entry.filename)\n  assert not name.is_absolute() and '..' not in name.parts and '\\\\' not in entry.filename, 'Unsafe ZIP path'\n  assert not stat.S_ISLNK(entry.external_attr >> 16), 'ZIP symlink'\n  target=p.joinpath(*name.parts)\n  if entry.is_dir(): target.mkdir(parents=True,exist_ok=True)\n  else:\n   target.parent.mkdir(parents=True,exist_ok=True)\n   target.write_bytes(z.read(entry))\n`;
  const child = spawnSync('python3', ['-c', script, zip, output], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
}
export function prepare(zip, baseline, candidate, output) {
  output = resolve(output); assert(!existsSync(output), 'Evidence output must be new; do not overwrite');
  mkdirSync(output, { recursive: true });
  const receipt = { status: 'preparing', stage: 'supplement-zip-identity', startedAt: new Date().toISOString(), supplement: SUPPLEMENT };
  const checkpoint = stage => { receipt.stage = stage; writeJson(join(output, 'preparation.json'), receipt); };
  checkpoint(receipt.stage);
  try {
    assert.equal(sha256(readFileSync(zip)), SUPPLEMENT.zipSha256, 'Wrong successful supplement ZIP');
    cpSync(zip, join(output, 'supplement.zip')); extract(zip, join(output, 'supplement'));
    checkpoint('supplement-eligibility');
    const eligibility = verifyForBrowser(join(output, 'supplement'), SUPPLEMENT.proofCommit);
    const frozenSupplement = readJson(join(output, 'supplement', 'frozen-study.json'));
    assert.equal(String(frozenSupplement.runId), SUPPLEMENT.run);
    assert.equal(String(frozenSupplement.runAttempt), '1');
    checkpoint('exact-rebuilt-source-and-bundle-identity');
    assert.equal(process.env.CANDIDATE_COMMIT, PIN.candidate);
    const comparison = prepareComparison(baseline, candidate);
    assert.deepEqual(comparison.manifests, frozenSupplement.sourceComparison.manifests, 'Rebuilt executable bytes differ from successful supplement');
    for (const role of ['baseline', 'candidate']) {
      const source = comparison.sourceManifests[role], original = frozenSupplement.sourceComparison.sourceManifests[role];
      assert.deepEqual(source.files, original.files, `Rebuilt ${role} source bytes differ`);
      assert.deepEqual(source.wasm, original.wasm, `Rebuilt ${role} kernel bytes differ`);
      for (const file of [...Object.keys(source.files), ...Object.keys(source.wasm)]) {
        const target = join(output, 'source', role, file); mkdirSync(dirname(target), { recursive: true }); cpSync(join(source.root, file), target);
      }
    }
    checkpoint('archive-original-and-derived-helpers');
    verifyHelpers();
    for (const file of Object.keys(PIN.helpers)) {
      mkdirSync(join(output, 'original-helpers'), { recursive: true }); cpSync(join(here, file), join(output, 'original-helpers', file));
    }
    const derived = deriveModule(); writeFileSync(join(output, 'single-case.mjs'), derived.source);
    mkdirSync(join(output, 'proof-source'));
    for (const file of proofFiles) cpSync(join(here, file), join(output, 'proof-source', file));
    cpSync(join(here, '../.github/workflows/block-traversal-chromium-isolation.yml'), join(output, 'proof-source', 'workflow.yml'));
    const frozen = { schemaVersion: 1, kind: 'correctness-only-chromium-process-isolation', context: CONTEXT,
      proofCommit: process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']), runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, preparedAt: new Date().toISOString(),
      supplement: SUPPLEMENT, eligibility, sourceComparison: comparison,
      hashes: { supplement: fullManifest(join(output, 'supplement')), sources: fullManifest(join(output, 'source')),
        originalHelpers: fullManifest(join(output, 'original-helpers')), proof: fullManifest(join(output, 'proof-source')),
        derivedModule: sha256(derived.source) },
      derivation: derived.transformations, coverage: coverage(), schedule: schedule(),
      execution: { runtime: 'chromium', browserPer: 'individual-scenario-and-source', retryCount: 0, headless: true, launchOptions: { headless: true, timeout: 30000 }, pageCreationTimeoutMs: 30000, navigationTimeoutMs: 30000, caseTimeoutMs: 90000, closeTimeoutMs: 30000,
        sourceOrder: 'AB/BA alternates by scenario index; each source is first for 23 cases', timing: false } };
    writeJson(join(output, 'frozen-study.json'), frozen);
    writeFileSync(join(output, 'frozen-study.sha256'), sha256(readFileSync(join(output, 'frozen-study.json'))) + '\n');
    receipt.status = 'prepared'; receipt.finishedAt = new Date().toISOString(); checkpoint('complete'); return frozen;
  } catch (error) {
    receipt.status = 'failed'; receipt.error = String(error.stack ?? error); receipt.finishedAt = new Date().toISOString(); checkpoint(receipt.stage); throw error;
  }
}
export function verifyPrepared(output) {
  const bytes = readFileSync(join(output, 'frozen-study.json')), frozen = JSON.parse(bytes);
  assert.equal(sha256(bytes), readFileSync(join(output, 'frozen-study.sha256'), 'utf8').trim(), 'Frozen diagnostic changed');
  assert.deepEqual(frozen.supplement, SUPPLEMENT); assert.deepEqual(frozen.context, CONTEXT);
  if (process.env.GITHUB_SHA) assert.equal(frozen.proofCommit, process.env.GITHUB_SHA, 'Diagnostic proof commit changed');
  assert.deepEqual(frozen.schedule, schedule()); assert.deepEqual(frozen.coverage, coverage());
  assert.equal(sha256(readFileSync(join(output, 'supplement.zip'))), SUPPLEMENT.zipSha256);
  for (const [field, path] of [['supplement', 'supplement'], ['sources', 'source'], ['originalHelpers', 'original-helpers'], ['proof', 'proof-source']]) {
    assert.deepEqual(fullManifest(join(output, path)), frozen.hashes[field], `Archived ${field} bytes changed`);
  }
  verifyHelpers(join(output, 'original-helpers')); verifyHelpers();
  for (const file of proofFiles) assert.equal(sha256(readFileSync(join(here, file))), frozen.hashes.proof[file], `Diagnostic helper changed: ${file}`);
  assert.equal(sha256(readFileSync(join(here, '../.github/workflows/block-traversal-chromium-isolation.yml'))), frozen.hashes.proof['workflow.yml']);
  assert.equal(sha256(readFileSync(join(output, 'single-case.mjs'))), frozen.hashes.derivedModule);
  assert.equal(sha256(deriveModule().source), frozen.hashes.derivedModule);
  verifyForBrowser(join(output, 'supplement'), SUPPLEMENT.proofCommit);
  const originalComparison = readJson(join(output, 'supplement', 'frozen-study.json')).sourceComparison;
  assert.equal(frozen.sourceComparison.candidateCommit, PIN.candidate);
  assert.deepEqual(frozen.sourceComparison.sourceDiff, ['arena.ts']);
  assert.deepEqual(frozen.sourceComparison.manifests, originalComparison.manifests, 'Diagnostic bundle identities differ from original evidence');
  const expectedSourceFiles = {};
  for (const role of ['baseline', 'candidate']) {
    for (const field of ['files', 'wasm']) {
      assert.deepEqual(frozen.sourceComparison.sourceManifests[role][field], originalComparison.sourceManifests[role][field]);
      for (const [file, digest] of Object.entries(originalComparison.sourceManifests[role][field])) expectedSourceFiles[`${role}/${file}`] = digest;
    }
  }
  assert.deepEqual(fullManifest(join(output, 'source')), expectedSourceFiles, 'Archived production source differs from pinned original evidence');
  return frozen;
}
function withDeadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
export async function executeCase(engine, origin, task, checkpoint = () => {}) {
  const receipt = { runtime: 'chromium', version: null, stage: 'browser-launch', status: 'running',
    browser: { launched: false, closeRequested: false, closeCompleted: false, disconnected: false },
    actualWorkers: [], console: [], pageErrors: [] };
  let browser;
  const stage = value => { receipt.stage = value; checkpoint(receipt); };
  try {
    browser = await engine.launch({ headless: true, timeout: 30000 });
    receipt.browser.launched = true; receipt.version = browser.version();
    browser.on('disconnected', () => { receipt.browser.disconnected = true; });
    stage('page-create'); const page = await withDeadline(browser.newPage(), 30000, 'Page creation');
    page.on('console', message => receipt.console.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => receipt.pageErrors.push(String(error.stack ?? error)));
    page.on('worker', worker => {
      const entry = { url: worker.url(), observed: true, closed: false, closedAtStage: null }; receipt.actualWorkers.push(entry);
      worker.on('close', () => { entry.closed = true; entry.closedAtStage = receipt.stage; });
    });
    stage('page-navigation'); await page.goto(origin, { timeout: 30000 });
    stage('scenario-evaluation');
    const result = await withDeadline(page.evaluate(async args => {
      const { runCase } = await import(`${args.origin}/study/page.mjs`); return runCase(args);
    }, { origin, role: task.role, scenario: task }), 90000, 'Single scenario');
    Object.assign(receipt, result); stage(result.error?.stage ?? 'scenario-complete');
    if (receipt.status === 'passed' && receipt.actualWorkers.length !== (task.type === 'worker' ? 1 : 0)) throw new Error('Unexpected number of actual browser workers');
    if (receipt.status === 'passed' && receipt.pageErrors.length) throw new Error('Unexpected browser page errors');
  } catch (error) {
    receipt.status = 'failed'; receipt.error = { stage: receipt.stage, name: error.name, message: error.message, stack: String(error.stack ?? error) };
  } finally {
    if (browser) {
      receipt.browser.closeRequested = true; stage('browser-close');
      try { await withDeadline(browser.close(), 30000, 'Browser cleanup'); receipt.browser.closeCompleted = true; }
      catch (error) { receipt.cleanupError = String(error.stack ?? error); receipt.status = 'failed'; }
      if (!receipt.browser.disconnected || receipt.actualWorkers.some(worker => !worker.closed)) {
        receipt.cleanupError ??= 'Browser/worker closure not observed'; receipt.status = 'failed';
      }
    }
    stage('terminal');
  }
  return receipt;
}
export async function executeSchedule(plan, execute, persist, record) {
  for (const task of plan) {
    const row = { ...task, startedAt: new Date().toISOString(), status: 'running', stage: 'scheduled' };
    record.results.push(row); persist();
    try { Object.assign(row, await execute(task, progress => { Object.assign(row, progress); persist(); })); }
    catch (error) { row.status = 'failed'; row.error = { stage: row.stage, name: error.name, message: error.message, stack: String(error.stack ?? error) }; }
    if (!['passed', 'failed'].includes(row.status)) { row.status = 'failed'; row.error = { stage: row.stage, message: 'Scenario did not return a terminal status' }; }
    row.finishedAt = new Date().toISOString(); persist();
  }
  record.status = record.results.length === plan.length && record.results.every(row => row.status === 'passed') ? 'passed' : 'failed';
  record.finishedAt = new Date().toISOString(); persist(); return record;
}
export function assertExecutionContext(frozen, env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Chromium execution is CI-only; no local browser launch');
  assert.equal(env.GITHUB_REF, 'refs/heads/proof/block-chromium-isolation', 'Wrong diagnostic branch');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'No retry of the same diagnostic run');
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/); assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.equal(frozen.proofCommit, env.GITHUB_SHA, 'Wrong current proof commit');
  assert.equal(String(frozen.runId), env.GITHUB_RUN_ID, 'Prepared archive belongs to another run');
  assert.equal(String(frozen.runAttempt), env.GITHUB_RUN_ATTEMPT, 'Prepared archive belongs to another attempt');
}
export async function run(output) {
  output = resolve(output); const resultPath = join(output, 'chromium-results.json');
  assert(!existsSync(resultPath), 'No rerun or replacement of diagnostic results');
  const record = { status: 'verifying', startedAt: new Date().toISOString(), context: CONTEXT, supplement: SUPPLEMENT,
    controller: { node: process.version, platform: process.platform, arch: process.arch, versions: process.versions }, results: [] };
  const persist = () => writeJson(resultPath, record); persist();
  let server;
  try {
    const frozen = verifyPrepared(output);
    assertExecutionContext(frozen);
    record.frozenStudySha256 = sha256(readFileSync(join(output, 'frozen-study.json')));
    record.proofCommit = frozen.proofCommit; record.runId = frozen.runId; record.runAttempt = frozen.runAttempt;
    record.sourceComparison = frozen.sourceComparison; record.hashes = frozen.hashes; record.expectedCoverage = frozen.coverage;
    const { chromium } = await import('playwright');
    record.controller.playwright = readJson(join(here, '../node_modules/playwright/package.json')).version;
    const roots = { baseline: join(output, 'supplement', 'bundles', 'baseline', 'dist'), candidate: join(output, 'supplement', 'bundles', 'candidate', 'dist'), proofs: join(output, 'original-helpers') };
    server = createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cache-Control', 'no-store');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated block correctness</title>'); return; }
      let path;
      if (url.pathname === '/study/single-case.mjs') path = join(output, 'single-case.mjs');
      else if (url.pathname === '/study/page.mjs') path = join(output, 'proof-source', 'block-traversal-chromium-page.mjs');
      else { const [, scope, ...parts] = url.pathname.split('/'), root = roots[scope]; path = root && resolve(root, ...parts); if (!path || !path.startsWith(root + sep)) path = null; }
      if (!path) { res.writeHead(404); res.end(); return; }
      try { res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(readFileSync(path)); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    record.status = 'running'; persist();
    await executeSchedule(frozen.schedule, async (task, checkpoint) => {
      const result = await executeCase(chromium, origin, task, checkpoint);
      console.log(JSON.stringify({ sequence: task.sequence, role: task.role, type: task.type, name: task.name, status: result.status, version: result.version, errorStage: result.error?.stage ?? null, cleanupError: result.cleanupError ?? null }));
      return result;
    }, persist, record);
    record.summary = Object.fromEntries(['baseline', 'candidate'].map(role => [role, Object.fromEntries(['fixture', 'worker'].map(type => {
      const rows = record.results.filter(row => row.role === role && row.type === type);
      return [type, { expected: type === 'fixture' ? 40 : 6, attempted: rows.length, passed: rows.filter(row => row.status === 'passed').length, failed: rows.filter(row => row.status === 'failed').length }];
    }))]));
    record.finalVerification = 'running'; persist(); verifyPrepared(output); record.finalVerification = 'passed'; persist();
  } catch (error) { record.status = 'failed'; record.controllerError = String(error.stack ?? error); record.finishedAt = new Date().toISOString(); persist(); }
  finally { if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); } }
  console.log(JSON.stringify({ status: record.status, attempted: record.results.length, summary: record.summary, output: resultPath }));
  if (record.status !== 'passed') throw new Error('Chromium isolation diagnostic failed or is incomplete; see archived results');
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--prepare') console.log(JSON.stringify(prepare(...args), null, 2));
  else if (command === '--run') await run(...args);
  else if (command === '--verify') console.log(JSON.stringify(verifyPrepared(...args), null, 2));
  else throw new Error('Use --prepare SUPPLEMENT_ZIP BASE/dist/shared.js CANDIDATE/dist/shared.js OUTPUT, --verify OUTPUT, or --run OUTPUT');
}
