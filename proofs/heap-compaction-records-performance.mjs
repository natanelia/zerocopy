// Prospective diagnostic only. Derived from the audited compaction pointer
// controller's neutral-path, manifest, independent-quartet and partial-save design.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, lstatSync, mkdtempSync, renameSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cases, limits, chunkCompactions, makeFixture, logical, checkAliases, backingBound } from './heap-compaction-records-fixtures.mjs';
import { runOwnedCommand, assertLaunchBudget, assertOwnedClean, interruption, CLEANUP } from './heap-compaction-records-command.mjs';
import { evidenceWriter } from './heap-compaction-records-evidence.mjs';
import { RUNTIME, verifyActivation } from './heap-compaction-records-activation.mjs';
import { assertDisjointRoots } from './heap-compaction-records-discovery.mjs';
import { summarizeQuartets, assessCell } from './heap-compaction-records-stats.mjs';

export const protocol = Object.freeze({ blocks: 4, samples: 5, floorMs: 20, warmMs: 150,
  margin: 0.02, measureSubjectMs: 2000, pilotSubjectMs: 5000, engineMs: 720000 });
const median = values => { const a = [...values].sort((x, y) => x - y), i = a.length >> 1; return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const sha = data => createHash('sha256').update(data).digest('hex');

export async function subject(config) {
  if (config.mode !== 'checks') assert.equal(process.env.HEAP_ENABLE_TIMING, '1', 'Timing is disabled pending independent review and published-head pin review');
  const emit = evidenceWriter(config.evidencePath, config.identity);
  emit('started', { mode: config.mode, case: config.name });
  try {
    const result = await subjectBody(config, emit);
    emit('complete', { resultStatus: result.status ?? 'complete', result });
    return result;
  } catch (error) { emit('failed', { error: String(error.stack ?? error) }); throw error; }
}
async function subjectBody(config, emit) {
  assert(cases[config.name]);
  if (config.mode !== 'checks') assert.equal(process.env.HEAP_ENABLE_TIMING, '1', 'Timing is disabled pending independent review and published-head pin review');
  const api = await import(pathToFileURL(config.module).href);
  const sources = makeFixture(api, config.name), expected = logical(api, sources), names = Object.keys(sources);
  const original = api.getWorkerData(sources, { copy: true });
  const checksumExpected = Object.values(sources).reduce((n, s) => n + s.size, 1);
  const verify = () => {
    const result = api.compactMany(sources);
    assert.deepEqual(logical(api, result), expected); checkAliases(result, config.name);
    const payload = api.getWorkerData(result, { copy: false }); assert.equal(payload.arenas.length, 1);
    const arena = payload.arenas[0], counter = arena.id.split('-').at(-1);
    assert(/^\d{1,6}$/.test(counter), 'Target ID counter exceeded the predeclared width bound');
    assert(arena.memory.buffer.byteLength <= cases[config.name].backingCeiling);
    return { used: arena.used, backingBytes: arena.memory.buffer.byteLength, counterDigits: counter.length,
      bounds: backingBound(arena.used, config.name), names, size: checksumExpected - 1 };
  };
  const initial = verify();
  const scan = () => {
    const result = api.compactMany(sources); let checksum = 1;
    for (const name of names) checksum += result[name].size;
    return checksum;
  };
  assert.equal(scan(), checksumExpected);
  function finalChecks() {
    const final = verify();
    // Production IDs are never normalized. Record initial/final byte/backing
    // counts separately while requiring values, aliases and source bytes exact.
    assert.deepEqual(final.names, initial.names); assert.equal(final.size, initial.size);
    const after = api.getWorkerData(sources, { copy: true });
    assert.equal(after.arenas.length, original.arenas.length);
    after.arenas.forEach((a, i) => assert.deepEqual(a.copy, original.arenas[i].copy));
    return final;
  }
  if (config.mode === 'checks') return { name: config.name, mode: 'checks', initial, final: finalChecks(), passed: true };
  assert(['pilot', 'measure'].includes(config.mode));
  const gc = typeof Bun === 'undefined' ? globalThis.gc : () => Bun.gc(true);
  assert.equal(typeof gc, 'function', 'Explicit GC is required outside timed chunks');
  const perChunk = chunkCompactions(config.name);
  let scans = 1, measuredChunks = 0;
  function chunk(context) {
    gc(); // Source construction/checks and cleanup are outside the measurement.
    let checksum = 0;
    const start = performance.now();
    for (let i = 0; i < perChunk; i++) checksum += scan();
    const ms = performance.now() - start;
    assert.equal(checksum, checksumExpected * perChunk);
    scans += perChunk; measuredChunks++;
    assert(scans + 16 < 10 ** limits.processArenaCounterDigits);
    const record = { ms, checksum };
    emit('chunk', { context, ...record }); // Synchronous evidence I/O is AFTER both timer reads.
    return record;
  }
  const warm = { chunks: 0, bodyMs: 0 };
  if (config.mode === 'pilot') {
    while (warm.bodyMs < protocol.warmMs && warm.chunks < limits.pilotWarmChunks) { warm.bodyMs += chunk({ phase: 'warmup', chunk: warm.chunks }).ms; warm.chunks++; }
    if (warm.bodyMs < protocol.warmMs) return { mode: 'pilot', status: 'warmup-cap-invalid', warm, initial, final: finalChecks() };
    const calibration = [];
    for (const chunks of [1, 2, 4, 8, 16]) {
      let ms = 0; for (let i = 0; i < chunks; i++) ms += chunk({ phase: 'calibration', trialChunks: chunks, chunk: i }).ms;
      calibration.push({ chunks, ms, compactions: chunks * perChunk });
      emit('calibration', calibration.at(-1));
      if (ms >= protocol.floorMs * 1.5) return { mode: 'pilot', status: 'valid', chunks, warm, calibration, initial, final: finalChecks(), perChunk, scans };
    }
    return { mode: 'pilot', status: 'batch-cap-invalid', warm, calibration, initial, final: finalChecks(), perChunk, scans };
  }
  assert(Number.isInteger(config.chunks) && config.chunks >= 1 && config.chunks <= limits.batchChunks);
  assert(Number.isInteger(config.warmChunks) && config.warmChunks >= 1 && config.warmChunks <= 2 * limits.pilotWarmChunks);
  while (warm.chunks < config.warmChunks) { warm.bodyMs += chunk({ phase: 'warmup', chunk: warm.chunks }).ms; warm.chunks++; }
  const samples = [];
  for (let sample = 0; sample < protocol.samples; sample++) {
    const chunks = []; for (let i = 0; i < config.chunks; i++) chunks.push(chunk({ phase: 'measurement', sample, chunk: i }));
    samples.push({ ms: chunks.reduce((n, c) => n + c.ms, 0), chunks });
    emit('batch', { sample, ...samples.at(-1) });
  }
  const final = finalChecks(); gc();
  return { mode: 'measure', iterations: config.chunks * perChunk, samples,
    medianMs: median(samples.map(s => s.ms)), warmScans: warm.chunks * perChunk, warmElapsedMs: warm.bodyMs,
    warmFloorMet: warm.bodyMs >= protocol.warmMs, shortBatchCount: samples.filter(s => s.ms < protocol.floorMs).length,
    initial, final, perChunk, scans, measuredChunks, runtime: process.versions };
}

function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(); }
export function sourceManifest(baseline, candidate) {
  assertDisjointRoots(baseline, candidate);
  const base = 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad', head = git(candidate, 'rev-parse', 'HEAD');
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), base); assert.equal(git(candidate, 'merge-base', base, 'HEAD'), base);
  assert.equal(git(candidate, 'merge-base', RUNTIME, 'HEAD'), RUNTIME, 'Use the accepted published runtime ancestor');
  const production = path => /\.ts$/.test(path) && !path.endsWith('.test.ts') && !/^(proofs|type-tests|website|demo)\//.test(path)
    || path.startsWith('scripts/build-') || ['package.json', '.npmignore', 'vitest.config.ts'].includes(path) || path.startsWith('tsconfig');
  const paths = [...new Set([...git(baseline, 'ls-files').split('\n'), ...git(candidate, 'ls-files').split('\n')])].filter(production).sort();
  const result = { base, head, baseline: {}, candidate: {}, differences: [] };
  for (const path of paths) {
    const a = readFileSync(join(baseline, path)), b = readFileSync(join(candidate, path));
    assert.equal(sha(a), sha(execFileSync('git', ['-C', baseline, 'show', `${base}:${path}`])), `Dirty baseline ${path}`);
    assert.equal(sha(b), sha(execFileSync('git', ['-C', candidate, 'show', `HEAD:${path}`])), `Dirty candidate ${path}`);
    result.baseline[path] = sha(a); result.candidate[path] = sha(b); if (!a.equals(b)) result.differences.push(path);
  }
  assert.deepEqual(result.differences, ['compaction.ts']);
  for (const file of ['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm']) {
    const a = sha(readFileSync(join(baseline, file))), b = sha(readFileSync(join(candidate, file))); assert.equal(a, b, file);
    result.baseline[file] = a; result.candidate[file] = b;
  }
  const old = '      if (!ready) { todo.push([old, true], [right, false], [left, false]); continue; }';
  const next = `      if (!ready) {\n        todo.push([old, true]);\n        if (right) todo.push([right, false]);\n        if (left) todo.push([left, false]);\n        continue;\n      }`;
  assert.equal(readFileSync(join(candidate, 'compaction.ts'), 'utf8'), readFileSync(join(baseline, 'compaction.ts'), 'utf8').replace(old, next));
  return result;
}
function buildManifest(dir) { return Object.fromEntries(readdirSync(join(dir, 'dist')).filter(p => p.endsWith('.js')).sort().map(p => [p, sha(readFileSync(join(dir, 'dist', p)))])); }

async function controller() {
  assert.equal(process.env.HEAP_ENABLE_TIMING, '1', 'Timing is disabled pending independent review and published-head pin review');
  const engineDeadline = Date.now() + protocol.engineMs;
  const root = resolve(import.meta.dirname, '..');
  const activation = verifyActivation(root, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env.GITHUB_EVENT_NAME);
  assert(activation.enabled, 'The reviewed creation-push intent must enable this screen');
  assert(process.env.HEAP_BASE, 'An external baseline path is required');
  const baseline = resolve(process.env.HEAP_BASE);
  assertDisjointRoots(baseline, root);
  const output = resolve(process.env.HEAP_OUTPUT ?? join(root, 'proofs/results/heap-compaction-records/screen.json'));
  assert(!existsSync(output) && !existsSync(`${output}.partial`), 'Refuse to overwrite a prior screen result');
  const expectedHead = process.env.HEAP_EXPECTED_HEAD;
  assert(/^[0-9a-f]{40}$/.test(expectedHead ?? ''), 'Supply the verified published candidate SHA, never a local-only commit pin');
  const sources = sourceManifest(baseline, root); assert.equal(sources.head, expectedHead);
  const receipt = JSON.parse(readFileSync(resolve(process.env.HEAP_GATE_RECEIPT ?? join(root, 'proofs/results/heap-compaction-records/gates.json')), 'utf8'));
  assert(receipt.complete && receipt.passed && receipt.candidate === expectedHead && receipt.baseline === sources.base, 'Fresh exact-head standard gates must pass first');
  for (const file of git(root, 'ls-files', 'proofs/heap-compaction-records*').split('\n').filter(Boolean)) {
    assert.equal(sha(readFileSync(join(root, file))), sha(execFileSync('git', ['-C', root, 'show', `HEAD:${file}`])), `Dirty proof ${file}`);
  }
  if (typeof Bun === 'undefined') assert.equal(process.version, 'v22.23.3'); else assert.equal(Bun.version, '1.4.2');
  const builds = { baseline: buildManifest(baseline), candidate: buildManifest(root) };
  const staging = mkdtempSync(join(tmpdir(), 'heap-compaction-records-')), neutral = join(staging, 'dist');
  writeFileSync(join(staging, 'package.json'), '{"type":"module"}');
  const report = { schema: 1, status: 'incomplete', runtime: process.versions, executable: process.execPath, architecture: process.arch, cpu: cpus()[0]?.model,
    activation, sources, builds, protocol, cleanup: CLEANUP, limits, cases, launches: [], pilots: [], subjects: [], comparisons: [], summaries: [], cells: [], errors: [],
    estimand: 'Complete compactMany plus size checksum; source construction, checks, explicit GC and neutral staging excluded. No physical-memory estimand.',
    uncertainty: 'Four independent quartet-mean log ratios; two-sided 95% Student-t, df=3. Batches/pairs descriptive; no AA subtraction or pooling; per-case unadjusted intervals.' };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2)); renameSync(`${output}.tmp`, `${output}.partial`); };
  async function run(build, config) {
    assertOwnedClean(); // A prior cleanup failure must block even neutral staging replacement.
    assertLaunchBudget(engineDeadline);
    assert.deepEqual(buildManifest(build === 'baseline' ? baseline : root), builds[build]);
    rmSync(neutral, { force: true, recursive: true }); cpSync(join(build === 'baseline' ? baseline : root, 'dist'), neutral, { recursive: true });
    for (const [file, hash] of Object.entries(builds[build])) { assert(!lstatSync(join(neutral, file)).isSymbolicLink()); assert.equal(sha(readFileSync(join(neutral, file))), hash); }
    assertLaunchBudget(engineDeadline); // Staging can consume the remaining envelope; do not launch after it.
    const ordinal = report.launches.length, prefix = `${output}.launch-${String(ordinal).padStart(3, '0')}`;
    const identity = { engine: typeof Bun === 'undefined' ? 'node22' : 'bun142', case: config.name, build, mode: config.mode,
      protocol: config.protocol ?? null, block: config.block ?? null, pair: config.pair ?? null, label: config.label ?? build,
      frozenCounts: { chunks: config.chunks ?? null, warmChunks: config.warmChunks ?? null, samples: protocol.samples, perChunk: chunkCompactions(config.name) } };
    const launch = { ...identity, ordinal, status: 'planned', commandReceipt: `${prefix}.command.json`, stdout: `${prefix}.stdout.log`, stderr: `${prefix}.stderr.log`, evidence: `${prefix}.subject.ndjson` };
    report.launches.push(launch); save(); // Exact comparison slot is durable BEFORE spawn.
    const args = [...(typeof Bun === 'undefined' ? ['--expose-gc'] : []), import.meta.filename, '--subject', JSON.stringify({ ...config, identity, evidencePath: launch.evidence, module: join(neutral, 'shared.js') })];
    const command = await runOwnedCommand({ command: process.execPath, args, cwd: root, prefix,
      totalMs: config.mode === 'pilot' ? protocol.pilotSubjectMs : protocol.measureSubjectMs, deadline: engineDeadline, identity });
    launch.status = command.status; launch.pid = command.pid; launch.group = command.group; launch.cleanup = command.cleanup; save();
    if (!command.complete) {
      report.errors.push({ ...identity, status: command.status, commandReceipt: launch.commandReceipt, evidence: launch.evidence }); save();
      throw new Error(command.timedOut ? 'subject-cap-invalid' : command.interrupted ? 'controller-interrupted' : command.status === 'not-started-budget-or-interrupt' ? 'engine-budget-exhausted' : 'subject-failed');
    }
    assertOwnedClean();
    for (const [file, hash] of Object.entries(builds[build])) assert.equal(sha(readFileSync(join(neutral, file))), hash);
    const state = JSON.parse(readFileSync(`${launch.evidence}.state.json`, 'utf8'));
    assert.equal(state.status, 'complete', 'Partial subject evidence cannot enter inference');
    return JSON.parse(readFileSync(launch.stdout, 'utf8'));
  }
  save();
  try {
    for (const [name, spec] of Object.entries(cases)) {
      try {
        const pilots = [];
        for (const build of ['baseline', 'candidate']) { const row = { name, build, result: await run(build, { mode: 'pilot', name }) }; pilots.push(row); report.pilots.push(row); save(); }
        if (pilots.some(p => p.result.status !== 'valid')) { report.cells.push({ name, dataStatus: 'pilot-cap-invalid', adoptionSignal: false }); save(); continue; }
        // Slower arm: max common batch/warmup work, never separate AB/AA plans.
        const chunks = Math.max(...pilots.map(p => p.result.chunks)), warmChunks = 2 * Math.max(...pilots.map(p => p.result.warm.chunks));
        for (let block = 0; block < protocol.blocks; block++) for (const comparison of block % 2 ? ['AB', 'AA'] : ['AA', 'AB']) {
          for (let pair = 0; pair < 2; pair++) {
            const members = [];
            for (const label of (block + pair) % 2 ? ['right', 'left'] : ['left', 'right']) {
              const build = comparison === 'AB' && label === 'right' ? 'candidate' : 'baseline';
              const result = await run(build, { mode: 'measure', name, chunks, warmChunks, protocol: comparison, block, pair, label });
              const row = { name, block, pair, protocol: comparison, label, build, result }; members.push(row); report.subjects.push(row); save();
            }
            const left = members.find(s => s.label === 'left').result, right = members.find(s => s.label === 'right').result;
            report.comparisons.push({ name, block, pair, protocol: comparison, speedup: left.medianMs / right.medianMs }); save();
          }
        }
        const summaries = {};
        for (const comparison of ['AA', 'AB']) {
          summaries[comparison] = summarizeQuartets(report.comparisons.filter(r => r.name === name && r.protocol === comparison), report.subjects.filter(s => s.name === name && s.protocol === comparison));
          report.summaries.push({ name, protocol: comparison, ...summaries[comparison] });
        }
        report.cells.push({ name, ...assessCell(summaries.AA, summaries.AB, spec.role) }); save();
      } catch (error) {
        report.cells.push({ name, dataStatus: error.message.includes('cap') ? 'cap-invalid' : error.message === 'subject-failed' ? 'proof-failed' : 'incomplete', error: String(error), adoptionSignal: false }); save();
        if (error.message === 'engine-budget-exhausted' || interruption()) break;
      }
    }
    assert.deepEqual(sourceManifest(baseline, root), sources);
    report.status = interruption() ? 'interrupted' : report.cells.length === Object.keys(cases).length && report.cells.every(c => c.dataStatus === 'complete-valid') ? 'complete-valid' : 'incomplete-or-invalid';
    report.noDetectedMaterialLoss = report.status === 'complete-valid' && !report.cells.some(c => c.effect === 'detected-material-loss');
    report.signalForBroaderValidation = report.status === 'complete-valid' && report.noDetectedMaterialLoss && report.cells.every(c => c.aaStatus === 'within-materiality-band') && report.cells.some(c => c.adoptionSignal);
    save(); renameSync(`${output}.partial`, output);
    console.log(JSON.stringify({ status: report.status, cells: report.cells, signalForBroaderValidation: report.signalForBroaderValidation }));
    if (report.status !== 'complete-valid') process.exitCode = 2;
  } finally { assertOwnedClean(); rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[2] === '--subject') console.log(JSON.stringify(await subject(JSON.parse(process.argv[3]))));
else if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  if (process.argv[2] === '--checks') {
    const module = resolve(process.env.HEAP_MODULE ?? join(import.meta.dirname, '../dist/shared.js'));
    const results = []; for (const name of Object.keys(cases)) results.push(await subject({ name, module, mode: 'checks' }));
    console.log(JSON.stringify({ passed: true, runtime: process.versions, results }));
  } else await controller();
}
