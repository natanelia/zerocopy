import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

// Exploratory screen, fixed before measurement. Each process imports both builds
// with separate lexical write/timer functions. No confidence claims from 2 runs.
const CASES = [
  { name: 'unicode-short-repeat', size: 2048, alphabet: 'unicode', length: 'short', repetition: 'repeat' },
  { name: 'unicode-short-unique', size: 2048, alphabet: 'unicode', length: 'short', repetition: 'unique' },
  { name: 'unicode-long-repeat', size: 2048, alphabet: 'unicode', length: 'long', repetition: 'repeat' },
  { name: 'unicode-long-unique', size: 2048, alphabet: 'unicode', length: 'long', repetition: 'unique' },
  { name: 'ascii-short-repeat', size: 2048, alphabet: 'ascii', length: 'short', repetition: 'repeat' },
  { name: 'ascii-short-unique', size: 2048, alphabet: 'ascii', length: 'short', repetition: 'unique' },
  { name: 'ascii-long-unique', size: 2048, alphabet: 'ascii', length: 'long', repetition: 'unique' },
  { name: 'mixed-short', size: 2048, alphabet: 'mixed', length: 'short', repetition: 'mixed' },
  { name: 'mixed-long', size: 2048, alphabet: 'mixed', length: 'long', repetition: 'mixed' },
  { name: 'replace-unicode-short-repeat', size: 2048, alphabet: 'unicode', length: 'short', repetition: 'repeat', replace: true },
  { name: 'replace-unicode-long-repeat', size: 2048, alphabet: 'unicode', length: 'long', repetition: 'repeat', replace: true },
  { name: 'replace-unicode-long-unique', size: 2048, alphabet: 'unicode', length: 'long', repetition: 'unique', replace: true },
  { name: 'small-unicode-short-repeat', size: 64, alphabet: 'unicode', length: 'short', repetition: 'repeat' },
  { name: 'small-unicode-short-unique', size: 64, alphabet: 'unicode', length: 'short', repetition: 'unique' },
  { name: 'fresh-unicode-long-unique', size: 2048, alphabet: 'unicode', length: 'long', repetition: 'unique', fresh: true },
  { name: 'fresh-unicode-long-early-repeat', size: 2048, alphabet: 'unicode', length: 'long', repetition: 'unique', fresh: true, earlyRepeat: true },
  { name: 'fresh-unicode-long-cache-abandonment', size: 2048, alphabet: 'unicode', length: 'long', repetition: 'unique', fresh: true, repeatedPrefix: 5 },
];
const CONFIG = Object.freeze({ rounds: 2, samples: 9, warmupMsPerVariant: 150, minimumWarmupPairs: 8,
  targetBatchMs: 10, batchByteBudget: 8 * 1024 * 1024, arenaByteBudget: 64 * 1024 * 1024 });
const sha = value => createHash('sha256').update(value).digest('hex');
const median = values => { const a = [...values].sort((x, y) => x - y), m = a.length >>> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function makeInput(workload, nonce) {
  // Flat strings are created outside timing. Separate calls give each build
  // independent strings; neither Set nor value-keyed Map warms their hashes.
  const pool = [], result = [];
  for (let i = 0; i < workload.size; i++) {
    const unicode = workload.alphabet === 'unicode' || workload.alphabet === 'mixed' && i % 4 === 0;
    const repeated = workload.repetition === 'repeat' || workload.repetition === 'mixed' && unicode;
    const prefixRepeated = i < (workload.repeatedPrefix ?? 0);
    const token = prefixRepeated || workload.earlyRepeat && i === 1 ? 0 : repeated ? Math.floor(i / (workload.alphabet === 'mixed' ? 4 : 1)) % 8 : i;
    const slot = prefixRepeated || workload.earlyRepeat && i < 2 ? 0 : repeated ? token : -1;
    let value = slot >= 0 ? pool[slot] : undefined;
    if (value === undefined) {
      const stem = unicode ? (workload.length === 'long' ? '界🙂'.repeat(64) : '界🙂')
        : workload.length === 'long' ? 'x'.repeat(192) : 'xxxxxxx';
      value = decoder.decode(encoder.encode(`${stem}:${String(token).padStart(4, '0')}${workload.fresh ? `:${String(nonce).padStart(12, '0')}` : ''}`));
      if (slot >= 0) pool[slot] = value;
    }
    result.push([`key-${String(i).padStart(6, '0')}`, value]);
  }
  return result;
}

function verify(map, entries) {
  const model = new Map(entries); // Hashes only keys, never value strings.
  assert.equal(map.size, model.size);
  let count = 0, checksum = 0;
  for (const [key, value] of map.entries()) {
    assert.equal(value, model.get(key)); assert.ok(model.has(key));
    checksum += key.length + value.length; count++;
  }
  assert.equal(count, model.size);
  return { count, checksum };
}

async function child() {
  const [left, right, name, phaseText] = process.argv.slice(3), phase = Number(phaseText);
  const workload = CASES.find(row => row.name === name); assert.ok(workload);
  let baselineApi, candidateApi;
  if (phase % 2) { candidateApi = await import(pathToFileURL(right).href); baselineApi = await import(pathToFileURL(left).href); }
  else { baselineApi = await import(pathToFileURL(left).href); candidateApi = await import(pathToFileURL(right).href); }
  const leftInput = makeInput(workload, 0), rightInput = makeInput(workload, 0);
  const oldEntries = leftInput.map(([key], i) => [key, `before-${i}`]);
  const state = (api, map) => api.getWorkerData({ map }, { copy: false }).arenas[0];
  const digest = (source, start, end = source.used) => sha(new Uint8Array(source.memory.buffer, start, end - start));
  let baseline, candidate, initialUsed, initialDigest, resets = 0, nonce = 1;
  function resetBaseline() { baselineApi.resetMap(); baseline = new baselineApi.SharedMap('string'); if (workload.replace) baseline = baseline.setMany(oldEntries); }
  function resetCandidate() { candidateApi.resetMap(); candidate = new candidateApi.SharedMap('string'); if (workload.replace) candidate = candidate.setMany(oldEntries); }
  function reset() {
    if ((resets + phase) % 2) { resetCandidate(); resetBaseline(); } else { resetBaseline(); resetCandidate(); }
    const a = state(baselineApi, baseline), b = state(candidateApi, candidate);
    assert.equal(a.used, b.used); assert.equal(digest(a, 65536), digest(b, 65536));
    initialUsed = a.used; initialDigest = digest(a, 65536); resets++;
  }
  reset();
  const firstA = baseline.setMany(leftInput), firstB = candidate.setMany(rightInput);
  assert.deepEqual(verify(firstA, leftInput), verify(firstB, rightInput));
  const initialA = state(baselineApi, firstA), initialB = state(candidateApi, firstB);
  assert.equal(initialA.used, initialB.used); assert.equal(firstA.root, firstB.root);
  assert.equal(digest(initialA, 65536), digest(initialB, 65536));
  const operationBytes = initialA.used - initialUsed;
  assert.ok(operationBytes > 0);
  const maxRepeat = Math.max(1, Math.floor(CONFIG.batchByteBudget / operationBytes));
  reset();

  // Distinct lexical functions prevent the hot setMany call site from mixing
  // classes/modules. Setup, result validation and bytes checks are untimed.
  function writeBaseline(inputs) {
    const outputs = new Array(inputs.length);
    for (let i = 0; i < inputs.length; i++) outputs[i] = baseline.setMany(inputs[i]);
    return outputs;
  }
  function writeCandidate(inputs) {
    const outputs = new Array(inputs.length);
    for (let i = 0; i < inputs.length; i++) outputs[i] = candidate.setMany(inputs[i]);
    return outputs;
  }
  function timeBaseline(inputs) { const start = performance.now(), outputs = writeBaseline(inputs); return { elapsed: performance.now() - start, outputs }; }
  function timeCandidate(inputs) { const start = performance.now(), outputs = writeCandidate(inputs); return { elapsed: performance.now() - start, outputs }; }
  function pair(repeat, index) {
    if (state(baselineApi, baseline).used + repeat * operationBytes * 2 > CONFIG.arenaByteBudget) reset();
    const startA = state(baselineApi, baseline), startB = state(candidateApi, candidate);
    assert.equal(startA.used, startB.used);
    const leftInputs = [], rightInputs = [];
    for (let i = 0; i < repeat; i++) {
      if (workload.fresh) { const n = nonce++; leftInputs.push(makeInput(workload, n)); rightInputs.push(makeInput(workload, n)); }
      else { leftInputs.push(leftInput); rightInputs.push(rightInput); }
    }
    let a, b;
    if ((index + phase) % 2) { b = timeCandidate(rightInputs); a = timeBaseline(leftInputs); }
    else { a = timeBaseline(leftInputs); b = timeCandidate(rightInputs); }
    for (let i = 0; i < repeat; i++) {
      assert.equal(a.outputs[i].size, workload.size); assert.equal(b.outputs[i].size, workload.size);
      assert.equal(a.outputs[i].root, b.outputs[i].root, 'Exact root addresses');
    }
    const expected = verify(a.outputs.at(-1), leftInputs.at(-1));
    assert.deepEqual(verify(b.outputs.at(-1), rightInputs.at(-1)), expected);
    const afterA = state(baselineApi, baseline), afterB = state(candidateApi, candidate);
    assert.equal(afterA.used, afterB.used, 'Equal shared allocation');
    const bytes = digest(afterA, startA.used);
    assert.equal(bytes, digest(afterB, startB.used), 'Every newly allocated byte matches');
    assert.equal(digest(afterA, 65536, initialUsed), initialDigest, 'Baseline published root unchanged');
    assert.equal(digest(afterB, 65536, initialUsed), initialDigest, 'Candidate published root unchanged');
    return { baselineMs: a.elapsed, candidateMs: b.elapsed, order: (index + phase) % 2 ? 'BA' : 'AB',
      repeat, allocatedBytes: afterA.used - startA.used, bytesSha256: bytes, ...expected };
  }
  let repeat = Math.min(maxRepeat, Math.max(1, Math.ceil(8192 / workload.size))), index = 0, warmA = 0, warmB = 0;
  const warmup = [], calibration = [];
  while (Math.min(warmA, warmB) < CONFIG.warmupMsPerVariant || warmup.length < CONFIG.minimumWarmupPairs) {
    const row = pair(repeat, index++); warmA += row.baselineMs; warmB += row.candidateMs; warmup.push(row);
  }
  for (let step = 0; step < 12; step++) {
    const trials = Array.from({ length: 3 }, () => pair(repeat, index++)); calibration.push({ repeat, trials });
    const faster = Math.min(median(trials.map(x => x.baselineMs)), median(trials.map(x => x.candidateMs)));
    if (faster >= CONFIG.targetBatchMs * 1.25 || repeat === maxRepeat) break;
    repeat = Math.min(maxRepeat, Math.ceil(repeat * Math.max(1.1, Math.min(8, CONFIG.targetBatchMs * 1.5 / Math.max(faster, .001)))));
  }
  assert.equal(calibration.at(-1).repeat, repeat);
  const samples = Array.from({ length: CONFIG.samples }, (_, i) => pair(repeat, i));
  if (workload.replace) { verify(baseline, oldEntries); verify(candidate, oldEntries); }
  return { runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, name, phase, operationBytes,
    maxRepeat, repeat, capped: repeat === maxRepeat, resets, warmup, calibration, samples,
    baselineMs: median(samples.map(x => x.baselineMs / repeat)), candidateMs: median(samples.map(x => x.candidateMs / repeat)),
    pairedRatio: Math.exp(samples.reduce((sum, x) => sum + Math.log(x.candidateMs / x.baselineMs), 0) / samples.length) };
}

function manifest(root) {
  const sourceFiles = readdirSync(root).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).sort();
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sources: Object.fromEntries(sourceFiles.map(file => [file, sha(readFileSync(join(root, file)))])),
    support: Object.fromEntries(['package.json', 'bun.lock', 'bun.lockb', 'scripts/build-browser.ts', 'tsconfig.json'].map(file => [file,
      existsSync(join(root, file)) ? sha(readFileSync(join(root, file))) : null])),
    wasm: Object.fromEntries(readdirSync(root).filter(file => file.endsWith('.wasm')).sort().map(file => [file, sha(readFileSync(join(root, file)))])),
    bundles: Object.fromEntries(readdirSync(join(root, 'dist')).filter(file => file.endsWith('.js')).sort().map(file => [file, sha(readFileSync(join(root, 'dist', file)))])) };
}
function summarize(runs) {
  return ['node', 'bun'].flatMap(runtime => CASES.flatMap(workload => {
    const rows = runs.filter(row => row.runtime === runtime && row.name === workload.name);
    if (rows.length !== CONFIG.rounds) return [];
    const ratios = rows.map(row => row.pairedRatio);
    return [{ runtime, ...workload, processes: rows.length, baselineMs: median(rows.map(row => row.baselineMs)),
      candidateMs: median(rows.map(row => row.candidateMs)), ratio: Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length),
      minRatio: Math.min(...ratios), maxRatio: Math.max(...ratios), processRatios: ratios,
      minBatchMs: Math.min(...rows.flatMap(row => row.samples.flatMap(s => [s.baselineMs, s.candidateMs]))),
      cappedProcesses: rows.filter(row => row.capped).length }];
  }));
}
async function main() {
  const [beforeArg, afterArg, bunArg, outputArg] = process.argv.slice(2);
  assert.ok(beforeArg && afterArg && bunArg && outputArg, 'Usage: node pilot.mjs BASELINE CANDIDATE BUN NEW_OUTPUT.json');
  const baseline = resolve(beforeArg), candidate = resolve(afterArg), output = resolve(outputArg);
  assert.ok(!existsSync(output), 'Choose a fresh output path'); mkdirSync(dirname(output), { recursive: true });
  const source = { baseline: manifest(baseline), candidate: manifest(candidate), driver: sha(readFileSync(import.meta.filename)) };
  assert.deepEqual(source.baseline.wasm, source.candidate.wasm);
  assert.deepEqual(source.baseline.support, source.candidate.support);
  assert.deepEqual(Object.keys(source.baseline.sources), Object.keys(source.candidate.sources));
  assert.deepEqual(Object.keys(source.baseline.sources).filter(file => source.baseline.sources[file] !== source.candidate.sources[file]), ['arena.ts']);
  const record = { schema: 1, kind: 'exploratory-paired-screen', createdAt: new Date().toISOString(), status: 'running', config: CONFIG, cases: CASES, source,
    hardware: { cpu: os.cpus()[0].model, platform: process.platform, arch: process.arch, availableParallelism: os.availableParallelism() }, runs: [], summary: [] };
  const save = () => { record.summary = summarize(record.runs); writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); };
  const temporary = mkdtempSync(join(os.tmpdir(), 'bulk-string-prepare-'));
  try {
    for (const [label, root] of [['left', baseline], ['right', candidate]]) {
      mkdirSync(join(temporary, label)); cpSync(join(root, 'dist'), join(temporary, label, 'dist'), { recursive: true });
      cpSync(join(root, 'package.json'), join(temporary, label, 'package.json'));
    }
    save();
    for (const [runtime, executable] of [['node', process.execPath], ['bun', resolve(bunArg)]]) for (let round = 0; round < CONFIG.rounds; round++) {
      const ordered = [...CASES.slice(round), ...CASES.slice(0, round)];
      for (const workload of ordered) {
        const args = [import.meta.filename, '--child', join(temporary, 'left/dist/shared.js'), join(temporary, 'right/dist/shared.js'), workload.name, String(round)];
        const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) { record.status = 'failed'; record.failure = { runtime, workload, round, stdout: result.stdout, stderr: result.stderr, error: String(result.error ?? '') }; save(); throw new Error(result.stderr); }
        const row = JSON.parse(result.stdout); assert.equal(row.runtime, runtime); record.runs.push(row); save();
      }
      console.log(`${runtime} pilot round ${round + 1} complete`);
    }
    assert.deepEqual(manifest(baseline), source.baseline); assert.deepEqual(manifest(candidate), source.candidate);
    assert.equal(sha(readFileSync(import.meta.filename)), source.driver);
    record.status = 'complete'; record.completedAt = new Date().toISOString(); save();
    for (const row of record.summary) console.log(JSON.stringify(row));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[2] === '--child') process.stdout.write(JSON.stringify(await child()));
else await main();
