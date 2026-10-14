// Source-only until a separately approved exact-hash release authorizes smoke/screen.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { cpus, totalmem, release as kernelRelease, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { CASES } from './draft-workload.mjs';

const START = performance.now(), HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '..');
const PROTOCOL = 'set-insert-screen-v1', COMMIT = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e';
const PATCH = '44d29c932a4a14b420d382c062dcaa057f2f67813556b158dc57934dba77d0ac';
const HASH = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sum = xs => xs.reduce((a, b) => a + b, 0), mean = xs => sum(xs) / xs.length;
const median = xs => { const a = [...xs].sort((a, b) => a - b); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2; };
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const elapsed = () => performance.now() - START;
const mode = process.argv[2], releaseFile = resolve(process.argv[3] ?? ''), out = resolve(process.argv[4] ?? '');
const capMs = mode === 'smoke' ? 60000 : 300000;
let study, summary, created = false;
function write(name, value, exclusive = true) {
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
}
function save() { write('study.json', study, false); }
function local(root, name) {
  assert.ok(!isAbsolute(name) && name !== '' && !name.split('/').includes('..'), `Unsafe relative path: ${name}`);
  const file = join(root, name);
  assert.equal(realpathSync(file), file, `Symlink/alias rejected: ${name}`);
  assert.ok(lstatSync(file).isFile(), `Not a regular file: ${name}`);
  return file;
}
function checkFile(root, name, expected) {
  const bytes = readFileSync(local(root, name));
  assert.equal(HASH(bytes), typeof expected === 'string' ? expected : expected.sha256, `Digest mismatch: ${name}`);
  if (expected.bytes !== undefined) assert.equal(bytes.length, expected.bytes);
}
function walk(root, prefix = '') {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(join(root, rel));
    assert.ok(!stat.isSymbolicLink(), `Symlink rejected: ${rel}`);
    return stat.isDirectory() ? walk(root, rel) : (assert.ok(stat.isFile()), [rel]);
  });
}
function bindings(release, pins) {
  assert.equal(release.protocol, PROTOCOL); assert.equal(release.authorize, mode);
  assert.equal(release.baselineCommit, COMMIT); assert.equal(release.sourcePatchSha256, PATCH);
  assert.equal(HASH(readFileSync(join(HERE, 'PROVENANCE.json'))), release.provenanceSha256);
  assert.deepEqual(Object.keys(release.harness).sort(), ['SCREEN-PLAN.md', 'draft-workload.mjs', 'screen-child.mjs', 'screen-controller.mjs'].sort());
  for (const [name, hash] of Object.entries(release.harness)) checkFile(HERE, name, hash);
  for (const [name, hash] of Object.entries(pins.receipts)) checkFile(ROOT, name, hash);
  checkFile(ROOT, 'SOURCE.patch', PATCH);
  const candidate = json(join(ROOT, 'correctness-v1/plan.json'));
  const baseline = json(join(ROOT, 'baseline-build-v1/plan.json'));
  assert.equal(candidate.sourcePatchSha256, PATCH); assert.equal(baseline.baselineCommit, COMMIT);
  assert.equal(json(join(ROOT, 'correctness-v1/result.json')).status, 'passed');
  assert.equal(json(join(ROOT, 'baseline-build-v1/result.json')).status, 'passed');
  for (const [name, hash] of Object.entries(candidate.sourceFiles)) checkFile(ROOT, name, hash);
  for (const [name, hash] of Object.entries(baseline.sourceFiles)) checkFile(join(ROOT, 'baseline'), name, hash);
  const generated = {
    baseline: json(join(ROOT, 'baseline-build-v1/generated.json')),
    candidate: Object.assign({}, ...Object.values(json(join(ROOT, 'correctness-v1/final-generated.json')))),
  };
  for (const [arm, files] of Object.entries(generated)) {
    for (const [name, expected] of Object.entries(files)) checkFile(join(ROOT, arm), name, expected);
    assert.deepEqual(walk(join(ROOT, arm, 'dist')).map(name => `dist/${name}`).sort(), Object.keys(files).filter(name => name.startsWith('dist/')).sort());
  }
  for (const [name, hash] of Object.entries(pins.toolchainFiles)) checkFile(pins.toolchainRoot, name, hash);
  for (const [name, engine] of Object.entries(pins.engines)) {
    assert.equal(realpathSync(engine.path), engine.path);
    assert.equal(HASH(readFileSync(engine.path)), engine.sha256, `Executable mismatch: ${name}`);
  }
  return generated;
}

async function child(engineName, variant, config, label, pins) {
  const remaining = capMs - elapsed(); assert.ok(remaining > 0, 'Whole-study cap reached');
  const full = { protocol: PROTOCOL, engine: engineName, variant,
    sharedURL: pathToFileURL(join(ROOT, variant, 'dist/shared.js')).href, ...config };
  const configPath = join(out, `${label}.config.json`); write(`${label}.config.json`, full);
  const raw = join(out, `${label}.jsonl`), errors = join(out, `${label}.stderr`);
  writeFileSync(raw, '', { flag: 'wx' }); writeFileSync(errors, '', { flag: 'wx' });
  const started = performance.now(), deadline = started + Math.min(10000, remaining);
  let timedOut = false, spawnError, groupRemaining = false, groupCleanupRequired = false;
  const proc = spawn(pins.engines[engineName].path, [join(HERE, 'screen-child.mjs'), configPath], {
    cwd: HERE, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', BUN_OPTIONS: '' },
  });
  const killGroup = () => { if (proc.pid) try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') spawnError ??= String(e); } };
  proc.stdout.on('data', bytes => appendFileSync(raw, bytes));
  proc.stderr.on('data', bytes => appendFileSync(errors, bytes));
  const result = await new Promise(done => {
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, Math.min(10000, remaining));
    proc.once('error', error => { spawnError = String(error); });
    proc.once('close', (exitCode, signal) => { clearTimeout(timer); done({ exitCode, signal }); });
  });
  const alive = () => {
    if (!proc.pid) return false;
    try { process.kill(-proc.pid, 0); return true; }
    catch (e) { if (e.code !== 'ESRCH') spawnError ??= String(e); return false; }
  };
  if (alive()) {
    groupCleanupRequired = true; killGroup();
    while (alive() && performance.now() < deadline) await new Promise(done => setTimeout(done, Math.min(10, Math.max(0, deadline - performance.now()))));
  }
  groupRemaining = alive();
  const wallMs = performance.now() - started;
  let events = [], parseError;
  try { events = readFileSync(raw, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { parseError = String(error); }
  const expected = config.mode === 'smoke' ? 'smoke-result' : 'result';
  const data = events.find(event => event.event === expected);
  const valid = result.exitCode === 0 && !timedOut && !spawnError && !parseError && !groupCleanupRequired && !groupRemaining
    && events[0]?.event === 'started' && events.at(-1)?.event === 'done'
    && events.length === 3 && !!data;
  const receipt = { label, ...full, ...result, valid, timedOut, spawnError, parseError, groupCleanupRequired, groupRemaining,
    wallMs, rawSha256: HASH(readFileSync(raw)), stderrSha256: HASH(readFileSync(errors)) };
  write(`${label}.receipt.json`, receipt); study.attempts.push(receipt); save();
  assert.ok(valid, `Invalid child ${label}; no retry`);
  return { ...receipt, data: data.value ?? data };
}

function interval(values, geometric = true) {
  let seed = 0x5e7add14;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const source = geometric ? values.map(Math.log) : values;
  const samples = Array.from({ length: 10000 }, () => {
    const value = mean(source.map(() => source[Math.floor(next() * source.length)]));
    return geometric ? Math.exp(value) : value;
  }).sort((a, b) => a - b);
  return [samples[249], samples[9749]];
}
function readout(pairs, endpoint, counts) {
  const flags = [], armA = [], armB = [];
  let allocation;
  if (endpoint === 'operation') {
    allocation = { fields: {}, deterministic: true, adverseIncrease: false };
    for (const metric of ['usedBefore', 'usedAfter', 'backingBytes', 'allocatedBytes']) {
      const values = [0, 1].map(arm => pairs.flatMap(pair => pair[arm].data.measured.map(row =>
        metric === 'allocatedBytes' ? row.usedAfter - row.usedBefore : row[metric])));
      const [a, b] = values.map(xs => ({ min: Math.min(...xs), max: Math.max(...xs) }));
      const deterministic = a.min === a.max && b.min === b.max;
      const increase = deterministic && b.max > a.max;
      allocation.fields[metric] = { baseline: a, candidate: b, deterministic, candidateIncreaseBytes: increase ? b.max - a.max : 0 };
      allocation.deterministic &&= deterministic; allocation.adverseIncrease ||= increase;
    }
    if (!allocation.deterministic) flags.push('non-deterministic-arena-allocation');
    if (allocation.adverseIncrease) flags.push('arena-allocation-increase');
  }
  for (const [a, b] of pairs) for (const [arm, list] of [[a, armA], [b, armB]]) {
    const d = arm.data;
    if (endpoint === 'operation') {
      assert.equal(d.warm.length, counts.warmCount); assert.equal(d.measured.length, counts.measureCount);
      const total = sum(d.measured.map(row => row.elapsedMs)), warm = d.warm.map(row => row.elapsedMs / row.operations);
      if (total < 25) flags.push('short-aggregate');
      if (counts.measureCapped && total < 75 || counts.warmCapped && sum(d.warm.map(row => row.elapsedMs)) < 50) flags.push('capped-short');
      const half = Math.floor(warm.length / 2);
      if (Math.abs(median(warm.slice(-half)) / median(warm.slice(-2 * half, -half)) - 1) > 0.20) flags.push('warmup-instability');
      list.push(total / sum(d.measured.map(row => row.operations)));
    } else {
      const value = endpoint === 'processWallMs' ? arm.wallMs : d[endpoint];
      if (value < 1) flags.push('short-startup'); list.push(value);
    }
  }
  const ratios = armA.map((a, i) => armB[i] / a), logs = ratios.map(Math.log), estimate = Math.exp(mean(logs));
  assert.ok(ratios.every(value => Number.isFinite(value) && value > 0));
  const sd = Math.sqrt(sum(logs.map(x => (x - mean(logs)) ** 2)) / (logs.length - 1));
  if (sd > Math.log(1.10) || Math.max(...ratios) / Math.min(...ratios) > 1.25) flags.push('noisy-pairs');
  const ci = interval(ratios), absoluteDeltaInterval = interval(armA.map((a, i) => armB[i] - a), false);
  const status = ci[0] > 1.02 ? 'material-regression' : flags.length || estimate > 1 || ci[1] > 1.02 ? 'unresolved' : 'guard-clear';
  return { endpoint, status, flags: [...new Set(flags)], allocation, ratios, estimate, interval: ci, absoluteDeltaInterval,
    baseline: { median: median(armA), min: Math.min(...armA), max: Math.max(...armA) },
    candidate: { median: median(armB), min: Math.min(...armB), max: Math.max(...armB) } };
}

try {
  assert.ok(['smoke', 'screen'].includes(mode), 'Usage: node screen-controller.mjs smoke|screen RELEASE.json NEW_OUTPUT_DIR');
  assert.ok(process.argv[3] && process.argv[4]);
  assert.ok(isAbsolute(process.argv[3]) && isAbsolute(process.argv[4]), 'Use absolute release/output paths');
  assert.ok(relative(ROOT, out) && !relative(ROOT, out).startsWith('..'), 'Output must be a fresh directory inside this task');
  mkdirSync(out); created = true;
  study = { protocol: PROTOCOL, mode, startedAt: new Date().toISOString(), complete: false,
    noRegressionClaim: false, mergeClearance: false, attempts: [], counts: {}, projections: {} };
  save();
  const release = json(releaseFile), pins = json(join(HERE, 'PROVENANCE.json'));
  const generated = bindings(release, pins);
  const versions = {};
  for (const [name, engine] of Object.entries(pins.engines)) {
    versions[name] = execFileSync(engine.path, ['--version'], { timeout: Math.min(5000, Math.max(1, capMs - elapsed())), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', BUN_OPTIONS: '' } }).trim().replace(/^v/, '');
    assert.equal(versions[name], name === 'node' ? '22.16.0' : '1.4.2');
  }
  write('binding.json', { release, releaseSha256: HASH(readFileSync(releaseFile)), pins, versions,
    hardware: { cpuModels: [...new Set(cpus().map(cpu => cpu.model))], cpuCount: cpus().length,
      totalMemoryBytes: totalmem(), os: platform(), kernel: kernelRelease(), architecture: arch(), affinity: 'not set by harness' },
    runtimeFlags: [], generated });
  if (mode === 'smoke') {
    const checksums = [];
    for (const engine of ['node', 'bun']) for (const variant of ['baseline', 'candidate']) {
      const r = await child(engine, variant, { mode: 'smoke' }, `smoke-${engine}-${variant}`, pins);
      assert.equal(r.data.cells.length, CASES.length);
      checksums.push(r.data.cells.map(row => [row.case, row.checksum]));
    }
    for (const value of checksums) assert.deepEqual(value, checksums[0]);
    study.validationOnly = true;
  } else {
    // Finish all baseline pilots before any candidate timing.
    for (const engine of ['node', 'bun']) {
      study.counts[engine] = {}; study.projections[engine] = {};
      for (const c of CASES) {
        const startup = c.kind === 'startup';
        const r = await child(engine, 'baseline', { mode: 'calibration', case: c.id,
          warmCount: startup ? 0 : 8, measureCount: startup ? 1 : 8 }, `pilot-${engine}-${c.id}`, pins);
        if (startup) {
          study.counts[engine][c.id] = { warmCount: 0, measureCount: 1 };
          study.projections[engine][c.id] = r.wallMs;
        } else {
          const m = mean(r.data.measured.map(row => row.elapsedMs)); assert.ok(m > 0 && Number.isFinite(m));
          const limit = c.kind === 'map' || c.kind === 'insert' && c.n === 8192 ? 64 : c.cached ? 512 : 2048;
          const warmCount = clamp(Math.ceil(50 / m), 8, limit), measureCount = clamp(Math.ceil(75 / m), 4, limit);
          study.counts[engine][c.id] = { warmCount, measureCount, warmCapped: warmCount === limit, measureCapped: measureCount === limit, pilotMeanMs: m };
          const fixed = Math.max(0, r.wallMs - sum([...r.data.warm, ...r.data.measured].map(row => row.wallMs)));
          study.projections[engine][c.id] = fixed + mean(r.data.warm.map(row => row.wallMs)) * warmCount + mean(r.data.measured.map(row => row.wallMs)) * measureCount;
        }
        save();
      }
    }
    study.projectedTotalMs = elapsed() + 1.25 * 12 * sum(Object.values(study.projections).flatMap(Object.values));
    save(); assert.ok(study.projectedTotalMs <= 300000, 'Baseline-only projection exceeds the fixed 300-second screen cap');
    const measurements = [];
    for (let pair = 0; pair < 6; pair++) {
      const engines = pair % 2 ? ['bun', 'node'] : ['node', 'bun'];
      const offset = 5 * pair % CASES.length, cases = CASES.slice(offset).concat(CASES.slice(0, offset));
      for (const c of cases) for (const engine of engines) {
        for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          measurements.push(await child(engine, variant, { mode: 'measurement', case: c.id, pair,
            ...study.counts[engine][c.id] }, `p${pair}-${engine}-${c.id}-${variant}`, pins));
        }
      }
    }
    const rows = [];
    for (const engine of ['node', 'bun']) for (const c of CASES) {
      const pairs = Array.from({ length: 6 }, (_, pair) => ['baseline', 'candidate'].map(variant =>
        measurements.find(r => r.engine === engine && r.case === c.id && r.pair === pair && r.variant === variant)));
      for (const [a, b] of pairs) {
        assert.ok(a && b); assert.equal(a.data.case, c.id); assert.equal(b.data.case, c.id);
        if (c.kind !== 'startup') assert.deepEqual(a.data.fixture, b.data.fixture);
      }
      for (const endpoint of c.kind === 'startup' ? ['importMs', 'importThroughFirstUseMs', 'processWallMs'] : ['operation'])
        rows.push({ engine, case: c.id, ...readout(pairs, endpoint, study.counts[engine][c.id]) });
    }
    const leads = ['insert-ascii-8192', 'insert-unicode-8192'];
    const targetEvidence = leads.filter(id => ['node', 'bun'].every(engine => rows.some(r => r.case === id && r.engine === engine && !r.flags.length && r.interval[1] <= 0.90)));
    const ruledOut = leads.every(id => rows.some(r => r.case === id && !r.flags.length && r.interval[0] > 0.90));
    const blocked = rows.some(r => r.status === 'material-regression'), guardsClear = rows.every(r => r.status === 'guard-clear');
    const memoryTradeoffs = rows.filter(r => r.allocation?.adverseIncrease).map(r => ({ engine: r.engine, case: r.case, allocation: r.allocation }));
    summary = { rows, targetEvidence, guardsClear, memoryTradeoffs,
      verdict: blocked ? 'blocked-by-regression' : memoryTradeoffs.length ? 'blocked-by-arena-allocation-increase' : ruledOut ? 'stipulated-lead-ruled-out' : targetEvidence.length && guardsClear ? 'further-validation-evidence' : 'inconclusive',
      noRegressionClaim: false, mergeClearance: false };
  }
  bindings(release, pins); assert.ok(elapsed() <= capMs, 'Whole-study cap reached');
  if (summary) write('summary.json', { complete: true, ...summary });
  study.complete = true;
} catch (error) {
  if (study) study.error = error?.stack ?? String(error);
  process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1;
} finally {
  if (created) {
    study.wallMs = elapsed(); save();
    const hashes = Object.fromEntries(readdirSync(out).sort().filter(name => lstatSync(join(out, name)).isFile()).map(name => [name, HASH(readFileSync(join(out, name)))]));
    write('RAW-SHA256.json', hashes);
  }
}
