import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { CASES, makeWorkload, MAX_CHECKED_ELEMENTS, MAX_SHARED_BYTES, UPDATES } from './workloads.mjs';

export const CONFIG = Object.freeze({
  pilot: { pairs: 2, samples: 7, warmupMs: 150 },
  formal: { pairs: 6, samples: 11, warmupMs: 500 },
  targetBatchMs: 20, minWarmupBatches: 8, maxWarmupBatches: 2048,
  maxCalibrationSteps: 12, childTimeoutMs: 300000,
  maxCheckedElements: MAX_CHECKED_ELEMENTS, maxSharedBytes: MAX_SHARED_BYTES, updatesPerOperation: UPDATES,
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function summarizePairs(pairs, inferential = false) {
  const logs = pairs.map(pair => Math.log(pair.after.medianMs / pair.before.medianMs));
  const mean = logs.reduce((sum, x) => sum + x, 0) / logs.length;
  const result = { pairs: pairs.length, beforeMedianMs: median(pairs.map(pair => pair.before.medianMs)),
    afterMedianMs: median(pairs.map(pair => pair.after.medianMs)), ratio: Math.exp(mean),
    pairRatios: logs.map(Math.exp), minRatio: Math.exp(Math.min(...logs)), maxRatio: Math.exp(Math.max(...logs)) };
  if (inferential) {
    assert.equal(pairs.length, 6, 'Confirmation requires six independent pairs');
    const variance = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (logs.length - 1);
    const half = 2.570581835636314 * Math.sqrt(variance / logs.length);
    Object.assign(result, { lower95: Math.exp(mean - half), upper95: Math.exp(mean + half), degreesOfFreedom: 5 });
  }
  return result;
}

export async function subject(request) {
  const record = { status: 'running', runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions,
    phase: request.phase, name: request.workload.name, candidate: request.candidate, warmup: [], calibration: [], samples: [] };
  try {
    const api = await import(request.entry), workload = makeWorkload(api, request.workload);
    const { maxRepeat, outputElements, expectedDigest, updatesPerOperation, nodeBytes, blobBytes, worstSharedBytesPerOperation } = workload;
    Object.assign(record, { maxRepeat, outputElements, expectedDigest, updatesPerOperation, nodeBytes, blobBytes, worstSharedBytesPerOperation });
    let checkedCalls = 0, checkedElements = 0, checkedSourceElements = 0;
    const batch = repeat => {
      // Each batch owns a fresh source. Fixture construction and all verification
      // stay outside timing, symmetrically for both builds.
      const fixture = workload.prepare(request.candidate);
      const start = performance.now(), outputs = new Array(repeat);
      for (let i = 0; i < repeat; i++) outputs[i] = fixture.materialize();
      const ms = performance.now() - start;
      // Retain every operation's final snapshot (not intermediate set wrappers).
      globalThis.__listSetLookupBlackbox = outputs;
      for (const output of outputs) fixture.verify(output);
      const allocation = fixture.finish(repeat);
      if (record.sourceSha256 === undefined) record.sourceSha256 = allocation.sourceSha256;
      else assert.equal(allocation.sourceSha256, record.sourceSha256, 'Fresh batches must construct identical source bytes');
      checkedCalls += repeat; checkedElements += repeat * outputElements; checkedSourceElements += allocation.sourceVerifiedElements;
      return { repeat, ms, verifiedCalls: repeat, verifiedElements: repeat * outputElements,
        publicCalls: repeat * UPDATES, ...allocation };
    };
    // Initial check is recorded, including its time and full-output validation.
    // Its timing is excluded from warm-up floors and measured summaries.
    record.initial = batch(1);
    const warm = (repeat, minimumMs) => {
      let elapsed = 0, calls = 0;
      while (elapsed < minimumMs || record.warmup.length < CONFIG.minWarmupBatches) {
        assert.ok(record.warmup.length < CONFIG.maxWarmupBatches, 'Warm-up cap reached');
        const row = batch(repeat); record.warmup.push(row); elapsed += row.ms; calls += repeat;
      }
      record.warmupMs = elapsed; record.warmupCalls = calls;
    };
    if (request.phase === 'calibrate') {
      let repeat = Math.min(maxRepeat, Math.max(1, Math.ceil(65536 / UPDATES)));
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
    Object.assign(record, { checkedCalls, checkedElements, checkedSourceElements,
      allPublishedBytesVerified: true, allAllocationDeltasVerified: true, status: 'complete' });
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
  return Object.fromEntries(['benchmark.mjs', 'workloads.mjs', 'PLAN.md'].map(name => [name, sha(readFileSync(join(import.meta.dirname, name)))]));
}
function comparableSource(source) {
  return Object.fromEntries(['baseline', 'candidate'].map(label => [label,
    Object.fromEntries(['production', 'support', 'wasm', 'bundles'].map(key => [key, source[label][key]]))]));
}
function validateSource(source) {
  assert.equal(source.baseline.commit, '77599337867dbf785a5f0311d34637d0b36678fc', 'The predeclared baseline must remain fixed');
  assert.deepEqual(Object.keys(source.baseline.production), Object.keys(source.candidate.production));
  assert.deepEqual(Object.keys(source.baseline.production).filter(name => source.baseline.production[name] !== source.candidate.production[name]), ['persistent-core.as.ts']);
  assert.deepEqual(source.baseline.support, source.candidate.support);
  assert.deepEqual(Object.keys(source.baseline.wasm), Object.keys(source.candidate.wasm));
  const aliases = ['doubly-linked-list.wasm', 'linked-list.wasm', 'ordered-map.wasm', 'persistent-core.wasm', 'priority-queue.wasm',
    'shared-list.wasm', 'shared-map.wasm', 'singly-linked-list.wasm', 'sorted-tree.wasm'];
  assert.deepEqual(Object.keys(source.baseline.wasm).filter(name => source.baseline.wasm[name] !== source.candidate.wasm[name]), aliases);
  for (const label of ['baseline', 'candidate']) for (const name of aliases) assert.equal(source[label].wasm[name], source[label].wasm['persistent-core.wasm']);
}
function withoutVecSet(text) {
  const start = text.indexOf('export function vecSet('); assert.ok(start >= 0);
  const open = text.indexOf('{', start); let end = open + 1, depth = 1;
  for (; depth && end < text.length; end++) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}') depth--;
  }
  assert.equal(depth, 0);
  return text.slice(0, start) + 'EXPORTED_VEC_SET' + text.slice(end);
}
async function main() {
  const [phase, baselineArg, candidateArg, bunArg, outputArg, planArg] = process.argv.slice(2);
  assert.ok(['pilot', 'formal'].includes(phase) && baselineArg && candidateArg && bunArg && outputArg,
    'Usage: node benchmark.mjs pilot|formal BASELINE CANDIDATE BUN NEW_OUTPUT.json [PILOT.json]');
  const baseline = resolve(baselineArg), candidate = resolve(candidateArg), output = resolve(outputArg);
  assert.ok(!existsSync(output) && !existsSync(output + '.gz'), 'Choose a new output path'); mkdirSync(dirname(output), { recursive: true });
  const source = { baseline: manifest(baseline), candidate: manifest(candidate), driver: driverManifest() };
  validateSource(source);
  assert.equal(withoutVecSet(readFileSync(join(baseline, 'persistent-core.as.ts'), 'utf8')),
    withoutVecSet(readFileSync(join(candidate, 'persistent-core.as.ts'), 'utf8')),
    'Only exported vecSet may change; the original copy helper and tail path must remain identical');
  const pilot = phase === 'formal' ? JSON.parse(readFileSync(resolve(planArg), 'utf8')) : undefined;
  if (pilot) {
    assert.equal(pilot.status, 'complete'); assert.equal(pilot.phase, 'pilot'); assert.deepEqual(pilot.cases, CASES); assert.deepEqual(pilot.config, CONFIG);
    assert.deepEqual(pilot.source.driver, source.driver); assert.deepEqual(comparableSource(pilot.source), comparableSource(source));
  }
  const record = { schema: 'zerocopy-list-set-lookup/v1', phase, status: 'running', createdAt: new Date().toISOString(), config: CONFIG, cases: CASES, source,
    pilotFile: pilot ? { path: resolve(planArg), sha256: sha(readFileSync(resolve(planArg))) } : null,
    hardware: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, availableParallelism: os.availableParallelism(),
      affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] },
    plans: [], pairs: [], summary: [] };
  const save = () => {
    record.summary = ['node', 'bun'].flatMap(runtime => CASES.flatMap(workload => {
      const pairs = record.pairs.filter(row => row.runtime === runtime && row.name === workload.name && row.before?.status === 'complete' && row.after?.status === 'complete');
      return pairs.length === CONFIG[phase].pairs ? [{ runtime, name: workload.name, ...summarizePairs(pairs, phase === 'formal') }] : [];
    }));
    writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  };
  const temporary = mkdtempSync(join(os.tmpdir(), 'list-set-lookup-')), neutral = join(temporary, 'subject');
  const originals = { baseline, candidate };
  let sequence = 0;
  const execute = (executable, build, request) => {
    // Exactly one build per fresh process, copied to the same neutral pathname.
    rmSync(neutral, { recursive: true, force: true }); mkdirSync(neutral);
    cpSync(join(originals[build], 'dist'), join(neutral, 'dist'), { recursive: true });
    cpSync(join(originals[build], 'package.json'), join(neutral, 'package.json'));
    const startedAt = new Date().toISOString(), started = performance.now();
    const child = spawnSync(executable, [import.meta.filename, '--subject', JSON.stringify({ ...request,
      candidate: build === 'candidate', entry: pathToFileURL(join(neutral, 'dist/shared.js')).href })],
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
        for (const build of plan.order) { plan.calibration[build] = execute(executable, build, { workload, phase: 'calibrate' }); save(); assert.equal(plan.calibration[build].status, 'complete', plan.calibration[build].error); }
        const values = Object.values(plan.calibration);
        assert.equal(values[0].expectedDigest, values[1].expectedDigest); assert.equal(values[0].sourceSha256, values[1].sourceSha256);
        assert.equal(values[0].maxRepeat, values[1].maxRepeat);
        plan.repeat = Math.max(...values.map(value => value.repeat)); plan.expectedDigest = values[0].expectedDigest; plan.sourceSha256 = values[0].sourceSha256;
        save();
      }
      for (let pair = 0; pair < CONFIG[phase].pairs; pair++) {
        const ordered = [...CASES.slice(pair % CASES.length), ...CASES.slice(0, pair % CASES.length)];
        for (const workload of ordered) {
          const plan = record.plans.find(row => row.runtime === runtime && row.name === workload.name);
          const row = { runtime, name: workload.name, pair, order: pair % 2 ? ['after', 'before'] : ['before', 'after'] };
          record.pairs.push(row);
          for (const side of row.order) {
            row[side] = execute(executable, side === 'before' ? 'baseline' : 'candidate', { workload, phase: 'measure', repeat: plan.repeat, measurement: CONFIG[phase] });
            save();
            assert.equal(row[side].status, 'complete', row[side].error); assert.equal(row[side].runtime, runtime);
            assert.equal(row[side].expectedDigest, plan.expectedDigest); assert.equal(row[side].sourceSha256, plan.sourceSha256);
          }
          console.log(`${runtime} ${workload.name} pair ${pair + 1}: ${(row.after.medianMs / row.before.medianMs).toFixed(3)} candidate/baseline`);
        }
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
