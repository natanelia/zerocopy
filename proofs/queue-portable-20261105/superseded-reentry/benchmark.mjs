import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { CASES, makeFixture } from './fixtures.mjs';

export const CONFIG = Object.freeze({
  pilot: { pairs: 2, samples: 7, warmupMs: 150 },
  formal: { pairs: 6, samples: 11, warmupMs: 500 },
  targetBatchMs: 20, minWarmupBatches: 8, minWarmupElements: 32768,
  maxWarmupBatches: 512, maxCalibrationSteps: 12, maxRetainedBytes: 32 * 1024 * 1024, childTimeoutMs: 90000,
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const oracleText = expected => JSON.stringify(expected, (_key, value) => value === undefined ? { projection: 'undefined' }
  : typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)) ? { projectionNumber: Object.is(value, -0) ? '-0' : String(value) } : value);
export const median = values => {
  const a = [...values].sort((x, y) => x - y), middle = a.length >>> 1;
  return a.length % 2 ? a[middle] : (a[middle - 1] + a[middle]) / 2;
};
export function summarizePairs(pairs, inferential = false) {
  const logs = pairs.map(pair => Math.log(pair.after.medianMs / pair.before.medianMs));
  const mean = logs.reduce((sum, x) => sum + x, 0) / logs.length;
  const result = { pairs: pairs.length, beforeMedianMs: median(pairs.map(pair => pair.before.medianMs)),
    afterMedianMs: median(pairs.map(pair => pair.after.medianMs)), ratio: Math.exp(mean),
    pairRatios: logs.map(Math.exp), minRatio: Math.exp(Math.min(...logs)), maxRatio: Math.exp(Math.max(...logs)) };
  if (inferential) {
    const critical = pairs.length === 6 ? 2.570581835636314 : undefined;
    assert.ok(critical, 'Unsupported independent-pair count');
    const variance = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (logs.length - 1);
    const half = critical * Math.sqrt(variance / logs.length);
    Object.assign(result, { lower95: Math.exp(mean - half), upper95: Math.exp(mean + half), degreesOfFreedom: logs.length - 1 });
  }
  return result;
}
function storageEstimate(value) {
  if (Array.isArray(value)) return 24 + value.length * 8 + value.reduce((sum, item) => sum + storageEstimate(item), 0);
  if (value !== null && typeof value === 'object') return 24 + Object.keys(value).length * 16 + Object.values(value).reduce((sum, child) => sum + storageEstimate(child), 0);
  return typeof value === 'string' ? 24 + value.length * 2 : 0;
}

export async function subject(request) {
  const record = { status: 'running', runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions,
    phase: request.phase, name: request.workload.name, initialVerified: false, warmup: [], calibration: [], samples: [] };
  try {
    const api = await import(request.entry), redux = await import(request.reduxEntry), fixture = makeFixture(api, redux, request.workload);
    const state = fixture.state, memoryDigest = data => data ? sha(data.memory) : null;
    const before = state(), digest = memoryDigest(before), bufferBytes = before?.bytes ?? null;
    const expectedDigest = sha(oracleText(fixture.expected)), estimatedOutputBytes = storageEstimate(fixture.expected);
    const maxRepeat = Math.min(fixture.maxRepeat, Math.max(1, Math.floor(CONFIG.maxRetainedBytes / Math.max(1, estimatedOutputBytes))));
    Object.assign(record, { expectedDigest, expectedLength: fixture.outputElements, outputElements: fixture.outputElements,
      estimatedOutputBytes, materializedSlots: fixture.materializedSlots, maxRepeat, arenaUsed: before?.used ?? null, arenaBytes: bufferBytes, arenaSha256: digest });
    let checkedCalls = 0, checkedElements = 0;
    fixture.verify(fixture.materialize()); record.initialVerified = true;
    const batch = repeat => {
      const start = performance.now(), outputs = new Array(repeat);
      for (let i = 0; i < repeat; i++) outputs[i] = fixture.materialize();
      const ms = performance.now() - start;
      // Escape and retain every complete result. Every element is checked after
      // timing against the independent input oracle, including every nested field and encoded special number.
      globalThis.__portableQueueBlackbox = outputs;
      for (const output of outputs) fixture.verify(output);
      checkedCalls += repeat; checkedElements += repeat * fixture.outputElements;
      return { repeat, ms, verifiedCalls: repeat, verifiedElements: repeat * fixture.outputElements };
    };
    const warm = (repeat, minimumMs) => {
      let elapsed = 0, calls = 0;
      while (elapsed < minimumMs || record.warmup.length < CONFIG.minWarmupBatches || calls * Math.max(1, fixture.outputElements) < CONFIG.minWarmupElements) {
        assert.ok(record.warmup.length < CONFIG.maxWarmupBatches, 'Warm-up cap reached');
        const row = batch(repeat); record.warmup.push(row); elapsed += row.ms; calls += repeat;
      }
      record.warmupMs = elapsed; record.warmupCalls = calls;
    };
    if (request.phase === 'calibrate') {
      let repeat = Math.min(maxRepeat, Math.max(1, Math.ceil(65536 / Math.max(1, fixture.outputElements))));
      warm(repeat, CONFIG.pilot.warmupMs);
      for (let step = 0; step < CONFIG.maxCalibrationSteps; step++) {
        const trials = Array.from({ length: 3 }, () => batch(repeat)); record.calibration.push({ repeat, trials });
        const elapsed = median(trials.map(row => row.ms));
        if (elapsed >= CONFIG.targetBatchMs * 1.25 || repeat === maxRepeat) break;
        repeat = Math.min(maxRepeat, Math.ceil(repeat * Math.max(1.1, Math.min(8, CONFIG.targetBatchMs * 1.5 / Math.max(elapsed, .001)))));
      }
      assert.equal(record.calibration.at(-1).repeat, repeat, 'Calibration exhausted');
      record.repeat = repeat; record.minMsPerCall = Math.min(...record.calibration.at(-1).trials.map(row => row.ms / repeat));
    } else {
      assert.ok(Number.isInteger(request.repeat) && request.repeat >= 1 && request.repeat <= maxRepeat);
      record.repeat = request.repeat;
      warm(request.repeat, request.measurement.warmupMs);
      for (let i = 0; i < request.measurement.samples; i++) record.samples.push(batch(request.repeat));
      record.medianMs = median(record.samples.map(row => row.ms / request.repeat));
      record.minBatchMs = Math.min(...record.samples.map(row => row.ms));
      record.belowTargetBatches = record.samples.filter(row => row.ms < CONFIG.targetBatchMs).length;
    }
    record.capped = record.repeat === maxRepeat;
    const after = state();
    assert.equal(after?.used, before?.used); assert.equal(after?.bytes ?? null, bufferBytes);
    assert.equal(memoryDigest(after), digest, 'Reading changed shared bytes');
    Object.assign(record, { checkedCalls, checkedElements, immutableBytesVerified: true, status: 'complete' });
  } catch (error) { record.status = 'failed'; record.error = String(error?.stack ?? error); }
  return record;
}

function manifest(root) {
  const files = names => Object.fromEntries(names.sort().map(name => [name, existsSync(join(root, name)) ? sha(readFileSync(join(root, name))) : null]));
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    production: files(readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))),
    tests: files(readdirSync(root).filter(name => name.endsWith('.test.ts'))),
    support: files(['package.json', 'bun.lock', 'bun.lockb', 'scripts/build-browser.ts', 'scripts/build-wasm.mjs', 'tsconfig.json']),
    wasm: files(readdirSync(root).filter(name => name.endsWith('.wasm'))),
    bundles: files(readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js')).map(name => `dist/${name}`)),
    ci: files(['.github/workflows/ci.yml']) };
}
function driverManifest() {
  return Object.fromEntries(['benchmark.mjs', 'fixtures.mjs', 'worker.mjs', 'compatibility.mjs', 'PLAN.md'].map(name => [name, sha(readFileSync(join(import.meta.dirname, name)))]));
}
function comparableSource(source) {
  return Object.fromEntries(['baseline', 'candidate'].map(label => [label,
    Object.fromEntries(['production', 'support', 'wasm', 'bundles'].map(key => [key, source[label][key]]))]));
}
async function main() {
  const [phase, baselineArg, candidateArg, bunArg, outputArg, planArg] = process.argv.slice(2);
  assert.ok(['pilot', 'formal'].includes(phase) && baselineArg && candidateArg && bunArg && outputArg,
    'Usage: node benchmark.mjs pilot|formal BASELINE CANDIDATE BUN NEW_OUTPUT.json [PILOT.json]');
  const baseline = resolve(baselineArg), candidate = resolve(candidateArg), output = resolve(outputArg);
  assert.ok(!existsSync(output), 'Choose a new output path'); mkdirSync(dirname(output), { recursive: true });
  const source = { baseline: manifest(baseline), candidate: manifest(candidate), driver: driverManifest() };
  assert.equal(source.baseline.commit, '77599337867dbf785a5f0311d34637d0b36678fc', 'The predeclared baseline must remain fixed');
  assert.deepEqual(Object.keys(source.baseline.production), Object.keys(source.candidate.production));
  assert.deepEqual(Object.keys(source.baseline.production).filter(name => source.baseline.production[name] !== source.candidate.production[name]), ['redux-codec.ts', 'shared-queue.ts']);
  assert.deepEqual(source.baseline.support, source.candidate.support); assert.deepEqual(source.baseline.wasm, source.candidate.wasm);
  const pilot = phase === 'formal' ? JSON.parse(readFileSync(resolve(planArg), 'utf8')) : undefined;
  if (pilot) {
    assert.equal(pilot.status, 'complete'); assert.equal(pilot.phase, 'pilot'); assert.deepEqual(pilot.cases, CASES); assert.deepEqual(pilot.config, CONFIG);
    assert.deepEqual(pilot.source.driver, source.driver); assert.deepEqual(comparableSource(pilot.source), comparableSource(source));
  }
  const record = { schema: 1, phase, status: 'running', createdAt: new Date().toISOString(), config: CONFIG, cases: CASES, source,
    pilotFile: pilot ? { path: resolve(planArg), sha256: sha(readFileSync(resolve(planArg))) } : null,
    hardware: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, availableParallelism: os.availableParallelism(),
      affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] },
    plans: [], pairs: [], summary: [] };
  const save = () => {
    record.summary = ['node', 'bun'].flatMap(runtime => CASES.flatMap(workload => {
      const pairs = record.pairs.filter(row => row.runtime === runtime && row.name === workload.name && row.before?.status === 'complete' && row.after?.status === 'complete');
      return pairs.length === CONFIG[phase].pairs ? [{ runtime, name: workload.name, mode: 'ab', ...summarizePairs(pairs, phase === 'formal') }] : [];
    }));
    writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  };
  const temporary = mkdtempSync(join(os.tmpdir(), 'portable-queue-')), neutral = join(temporary, 'subject');
  const originals = { baseline, candidate };
  let sequence = 0;
  const execute = (executable, build, request) => {
    // Reuse one neutral pathname, with a complete build installed before each
    // fresh process. There is exactly one imported build in every subject.
    rmSync(neutral, { recursive: true, force: true }); mkdirSync(neutral);
    cpSync(join(originals[build], 'dist'), join(neutral, 'dist'), { recursive: true });
    cpSync(join(originals[build], 'package.json'), join(neutral, 'package.json'));
    const startedAt = new Date().toISOString(), started = performance.now();
    const child = spawnSync(executable, [import.meta.filename, '--subject', JSON.stringify({ ...request, entry: pathToFileURL(join(neutral, 'dist/shared.js')).href, reduxEntry: pathToFileURL(join(neutral, 'dist/redux.js')).href })],
      { encoding: 'utf8', timeout: CONFIG.childTimeoutMs, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '' } });
    assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error));
    return { sequence: sequence++, startedAt, wallMs: performance.now() - started, ...JSON.parse(child.stdout) };
  };
  try {
    save();
    for (const [runtime, executable] of [['node', process.execPath], ['bun', resolve(bunArg)]]) {
      for (const [index, workload] of CASES.entries()) {
        if (pilot) { record.plans.push(pilot.plans.find(row => row.runtime === runtime && row.name === workload.name)); continue; }
        const plan = { runtime, name: workload.name, order: index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'], calibration: {} };
        record.plans.push(plan);
        for (const build of plan.order) { plan.calibration[build] = execute(executable, build, { workload, phase: 'calibrate' }); save(); assert.equal(plan.calibration[build].status, 'complete'); }
        const values = Object.values(plan.calibration);
        assert.equal(values[0].expectedDigest, values[1].expectedDigest); assert.equal(values[0].arenaSha256, values[1].arenaSha256);
        assert.equal(values[0].maxRepeat, values[1].maxRepeat);
        plan.repeat = Math.max(...values.map(value => value.repeat)); plan.expectedDigest = values[0].expectedDigest; plan.arenaSha256 = values[0].arenaSha256;
        save();
      }
      const scheduled = [];
      for (let pair = 0; pair < CONFIG[phase].pairs; pair++) {
        const ordered = [...CASES.slice(pair % CASES.length), ...CASES.slice(0, pair % CASES.length)];
        for (const workload of ordered) {
          scheduled.push({ workload, pair, mode: 'ab' });
        }
      }
      for (const { workload, pair, mode } of scheduled) {
        const plan = record.plans.find(row => row.runtime === runtime && row.name === workload.name);
        const row = { runtime, name: workload.name, pair, mode, order: pair % 2 ? ['after', 'before'] : ['before', 'after'] };
        record.pairs.push(row);
        for (const side of row.order) {
          const build = side === 'before' ? 'baseline' : 'candidate';
          row[side] = execute(executable, build, { workload, phase: 'measure', repeat: plan.repeat, measurement: CONFIG[phase] });
          save();
          assert.equal(row[side].status, 'complete', row[side].error); assert.equal(row[side].runtime, runtime);
          assert.equal(row[side].expectedDigest, plan.expectedDigest); assert.equal(row[side].arenaSha256, plan.arenaSha256);
        }
        console.log(`${runtime} ${workload.name} ${mode} pair ${pair + 1}: ${(row.after.medianMs / row.before.medianMs).toFixed(3)} candidate/baseline`);
      }
    }
    assert.deepEqual(manifest(baseline), source.baseline); assert.deepEqual(manifest(candidate), source.candidate);
    assert.deepEqual(driverManifest(), source.driver);
    record.status = 'complete'; record.completedAt = new Date().toISOString(); save();
    for (const row of record.summary) console.log(JSON.stringify(row));
  } catch (error) { record.status = 'failed'; record.error = String(error?.stack ?? error); save(); throw error; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--subject') process.stdout.write(JSON.stringify(await subject(JSON.parse(process.argv[3]))));
  else await main();
}
