// Launch only after the coordinator supplies the reviewed release manifest.
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpus, totalmem, release as osRelease, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { CASES, PILOT, TARGET_MS, assertKeyHashes } from './cases.mjs';
import { summarize } from './summarize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const START = performance.now(), STUDY_MS = 12 * 60 * 1000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = object => JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
function files(root, relativeDir = '') {
  const result = [];
  for (const name of readdirSync(join(root, relativeDir)).sort()) {
    const path = join(relativeDir, name), stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Symlink in immutable inventory: ${join(root, path)}`);
    if (stat.isDirectory()) result.push(...files(root, path));
    else if (stat.isFile()) result.push(path);
  }
  return result;
}
function inventory(root, list) {
  const entries = Object.fromEntries(list.sort().map(path => [path, hash(readFileSync(join(root, path)))]));
  return { files: entries, sha256: hash(canonical(entries)) };
}
function sourceInventory(root) {
  const list = readdirSync(root).filter(name => {
    if (!/\.(ts|json|wasm)$/.test(name)) return false;
    const stat = lstatSync(join(root, name));
    if (stat.isSymbolicLink()) throw new Error(`Symlink in source inventory: ${join(root, name)}`);
    return stat.isFile();
  });
  list.push(...files(join(root, 'scripts')).map(name => join('scripts', name)));
  return inventory(root, list);
}
function check(condition, text) { if (!condition) throw new Error(text); }
function within(root, file) {
  const path = relative(root, file);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}
function bind(manifest) {
  check(manifest.release === 'session-cache-screen-v1', 'An explicit reviewed release manifest is required');
  check(manifest.baselineCommit === 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e', 'Wrong current-main pin');
  check(manifest.candidatePatchSha256 === '5241396e6a8a67b80937c7cf8b9cf3450a8f86d0f0c56985fe8c6d85e1bd77c6', 'Wrong final reviewed candidate patch pin');
  check(isAbsolute(manifest.candidatePatchFile), 'Candidate patch path must be absolute');
  check(hash(readFileSync(manifest.candidatePatchFile)) === manifest.candidatePatchSha256, 'Candidate patch file differs from release');
  check(manifest.engines.length === 2 && manifest.engines[0].name === 'node' && manifest.engines[1].name === 'bun', 'Engine order must be node, bun');
  const harness = inventory(HERE, ['cases.mjs', 'subject.mjs', 'run.mjs', 'summarize.mjs', 'method.md']);
  check(harness.sha256 === manifest.harnessSha256, 'Harness changed after release');
  const engines = manifest.engines.map(engine => {
    check(isAbsolute(engine.executable), 'Runtime path must be absolute');
    const executable = realpathSync(engine.executable), sha256 = hash(readFileSync(executable));
    check(sha256 === engine.sha256, `Runtime digest differs: ${engine.name}`);
    check(engine.version === (engine.name === 'node' ? '22.16.0' : '1.4.2'), `Unexpected runtime version: ${engine.name}`);
    return { ...engine, executable, sha256 };
  });
  const variants = {};
  for (const name of ['baseline', 'candidate']) {
    const supplied = manifest.variants[name];
    check(isAbsolute(supplied.sourceRoot) && isAbsolute(supplied.buildRoot), 'Source/build paths must be absolute');
    const sourceRoot = realpathSync(supplied.sourceRoot), buildRoot = realpathSync(supplied.buildRoot);
    const source = sourceInventory(sourceRoot), build = inventory(buildRoot, files(buildRoot));
    check(source.sha256 === supplied.sourceSha256, `Source inventory differs: ${name}`);
    check(build.sha256 === supplied.buildSha256, `Build inventory differs: ${name}`);
    const shared = realpathSync(join(buildRoot, 'shared.js')), worker = realpathSync(join(buildRoot, 'worker.js'));
    check(within(buildRoot, shared) && within(buildRoot, worker), 'Entry point escapes retained build');
    variants[name] = { sourceRoot, buildRoot, source, build, shared, worker };
  }
  check(variants.baseline.buildRoot !== variants.candidate.buildRoot, 'Variants must use distinct retained build directories');
  check(variants.baseline.sourceRoot !== variants.candidate.sourceRoot, 'Variants must use distinct source roots');
  return { manifest, harness, engines, variants, fixtureFullKeyHashes: assertKeyHashes(),
    hardware: { cpu: cpus().map(cpu => cpu.model), cpuCount: cpus().length, totalMemoryBytes: totalmem(),
      platform: platform(), architecture: arch(), osRelease: osRelease() } };
}
function assertBindings(binding) {
  for (const variant of Object.values(binding.variants)) {
    check(sourceInventory(variant.sourceRoot).sha256 === variant.source.sha256, 'Source changed during study');
    check(inventory(variant.buildRoot, files(variant.buildRoot)).sha256 === variant.build.sha256, 'Build changed during study');
  }
  for (const engine of binding.engines) check(hash(readFileSync(engine.executable)) === engine.sha256, 'Runtime changed during study');
  check(inventory(HERE, Object.keys(binding.harness.files)).sha256 === binding.harness.sha256, 'Harness changed during study');
}

async function child(out, label, engine, config, capMs) {
  const remainingMs = STUDY_MS - (performance.now() - START);
  check(remainingMs > 0, 'Whole-study cap exhausted');
  const configFile = join(out, `${label}.config.json`);
  writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: 'wx' });
  const stdoutPath = join(out, `${label}.ndjson`), stderrPath = join(out, `${label}.stderr`);
  writeFileSync(stdoutPath, '', { flag: 'wx' }); writeFileSync(stderrPath, '', { flag: 'wx' });
  const t = performance.now(), events = [];
  let buffer = '', parseFailure, timedOut = false, spawnFailure, exitCode, signal, timer, rawRevisionCount = 0;
  const processChild = spawn(engine.executable, [join(HERE, 'subject.mjs'), configFile], {
    cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', BUN_OPTIONS: '' },
  });
  const consume = line => {
    if (!line) return;
    try {
      const event = JSON.parse(line);
      if (event.event === 'revision') rawRevisionCount++;
      else events.push(event);
    } catch { parseFailure ??= `Invalid JSON line: ${line.slice(0, 200)}`; }
  };
  processChild.stdout.on('data', bytes => {
    appendFileSync(stdoutPath, bytes);
    buffer += bytes.toString();
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
  });
  processChild.stderr.on('data', bytes => appendFileSync(stderrPath, bytes));
  await new Promise(resolveChild => {
    timer = setTimeout(() => { timedOut = true; processChild.kill('SIGKILL'); }, Math.min(capMs, remainingMs));
    processChild.once('error', error => { spawnFailure = error.stack ?? String(error); });
    processChild.once('close', (code, reason) => { exitCode = code; signal = reason; clearTimeout(timer); resolveChild(); });
  });
  if (buffer) consume(buffer);
  const expectedEvents = config.mode === 'transport-smoke'
    ? events.some(event => event.event === 'transport-smoke-success') && rawRevisionCount === 0
    : events.filter(event => event.event === 'case').length === CASES.length
      && rawRevisionCount === CASES.length * 32 + Object.values(config.counts).reduce((sum, n) => sum + n, 0);
  const valid = exitCode === 0 && !timedOut && !spawnFailure && !parseFailure && events.at(-1)?.event === 'done' && expectedEvents;
  const result = { label, engine: engine.name, variant: config.variant, mode: config.mode, pair: config.pair,
    valid, timedOut, spawnFailure, parseFailure, exitCode, signal, wallMs: performance.now() - t,
    configFile, stdoutPath, stderrPath, rawRevisionCount, events };
  writeFileSync(join(out, `${label}.receipt.json`), JSON.stringify({ ...result, events: undefined }, null, 2), { flag: 'wx' });
  return result;
}

let out, study, createdOutput = false;
try {
  const manifestPath = resolve(process.argv[2]); out = resolve(process.argv[3]);
  mkdirSync(out); // Must be a fresh directory. Never overwrite any earlier attempt.
  createdOutput = true;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const binding = bind(manifest), bindingDigest = hash(JSON.stringify(binding));
  writeFileSync(join(out, 'binding.json'), JSON.stringify({ bindingDigest, ...binding }, null, 2), { flag: 'wx' });
  study = { startedAt: new Date().toISOString(), bindingDigest, complete: false, transportSmokes: [], calibrations: [], attempts: [], counts: {}, feasibility: {} };
  const persist = () => writeFileSync(join(out, 'study.json'), JSON.stringify(study, null, 2));
  const configFor = (engine, variant, mode, pair, counts, order) => ({ engine, variant, mode, pair, counts, order, bindingDigest,
    shared: binding.variants[variant].shared, worker: binding.variants[variant].worker });
  // Capability is a correctness gate, not a timed sample. Never substitute copy
  // mode or in-process ports when the actual worker cannot clone shared memory.
  for (const engine of binding.engines) for (const variant of ['baseline', 'candidate']) {
    const result = await child(out, `${engine.name}-transport-smoke-${variant}`, engine,
      configFor(engine, variant, 'transport-smoke', null, {}, []), 15000);
    study.transportSmokes.push(result); persist();
    check(result.valid, `Real-worker copy:false transport is not established for ${engine.name}/${variant}; no calibration or measurement has started`);
  }
  // Complete both baseline calibrations before releasing any measurement child.
  for (const engine of binding.engines) {
    const counts = Object.fromEntries(CASES.map(c => [c.id, PILOT]));
    const result = await child(out, `${engine.name}-calibration-baseline`, engine,
      configFor(engine, 'baseline', 'calibration', null, counts, CASES.map(c => c.id)), 60000);
    study.calibrations.push(result); persist();
    check(result.valid, `Calibration invalid for ${engine.name}; measurements have not started`);
    const selected = {}, estimates = [];
    for (const c of CASES) {
      const row = result.events.find(event => event.event === 'case' && event.case === c.id);
      const meanMs = row.aggregateMs / PILOT;
      check(Number.isFinite(meanMs) && meanMs > 0, 'Invalid calibration duration');
      const desired = Math.ceil((TARGET_MS / meanMs) / 8) * 8;
      selected[c.id] = Math.max(8, Math.min(c.max, desired));
      estimates.push({ case: c.id, desired, count: selected[c.id], atCap: desired > c.max,
        predictedAggregateMs: meanMs * selected[c.id],
        predictedWholeCaseMs: row.wallMs - row.measuredWallMs + row.measuredWallMs / PILOT * selected[c.id] });
    }
    const observedCasesMs = result.events.filter(event => event.event === 'case').reduce((n, row) => n + row.wallMs, 0);
    const predictedSubjectMs = Math.max(0, result.wallMs - observedCasesMs) + estimates.reduce((n, row) => n + row.predictedWholeCaseMs, 0);
    study.counts[engine.name] = selected;
    study.feasibility[engine.name] = { estimates, predictedSubjectMs, limitWithReserveMs: 36000 };
    persist();
    check(predictedSubjectMs <= 36000, `Baseline projects >36 seconds/subject for ${engine.name}; stop before measurements`);
  }
  const projectedTotalMs = performance.now() - START + binding.engines.reduce((n, e) => n + 14 * study.feasibility[e.name].predictedSubjectMs, 0);
  study.feasibility.projectedTotalMs = projectedTotalMs; persist();
  check(projectedTotalMs <= STUDY_MS * 0.8, 'Full schedule exceeds80% of12-minute budget; stop before measurements');
  assertBindings(binding);
  for (const engine of binding.engines) {
    for (let pair = 0; pair < 7; pair++) {
      const offset = (pair * 3) % CASES.length;
      const order = [...CASES.slice(offset), ...CASES.slice(0, offset)].map(c => c.id);
      const variants = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const variant of variants) {
        const result = await child(out, `${engine.name}-pair${pair}-${variant}`, engine,
          configFor(engine, variant, 'measurement', pair, study.counts[engine.name], order), 45000);
        study.attempts.push(result); persist();
        // A failure consumes its declared slot. No replacement, retry or tuning.
      }
    }
  }
  assertBindings(binding);
  check(performance.now() - START <= STUDY_MS, 'Whole-study cap exhausted before final analysis');
  study.complete = true; study.elapsedMs = performance.now() - START; persist();
  const summary = summarize(study);
  check(performance.now() - START <= STUDY_MS, 'Whole-study cap exhausted during final analysis');
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
} catch (error) {
  const failure = { event: 'study-failure', error: error.stack ?? String(error), elapsedMs: performance.now() - START };
  if (createdOutput) {
    try {
      writeFileSync(join(out, 'failure.json'), JSON.stringify(failure, null, 2), { flag: 'wx' });
      if (study) {
        study.complete = false;
        study.failure = failure; study.elapsedMs = failure.elapsedMs;
        writeFileSync(join(out, 'study.json'), JSON.stringify(study, null, 2));
        writeFileSync(join(out, 'summary.json'), JSON.stringify(summarize(study), null, 2), { flag: 'wx' });
      }
    } catch {}
  }
  process.stderr.write(`${failure.error}\n`); process.exitCode = 1;
}
