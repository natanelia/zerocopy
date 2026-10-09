/** Bounded CI-only timing driver. `check` never samples a clock. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpus, platform, arch } from 'node:os';
import { verifyManifest, hash } from './scalar-text-screen-inventory.mjs';
import { verifyGitHubActivation } from './scalar-text-screen-activation.mjs';
import { makeCases, caseManifest, build, scan, checkCase, expectedScore } from './scalar-text-screen-cases.mjs';

const [mode = 'check', rootArg, blockArg, armArg] = process.argv.slice(2);
assert(rootArg, 'Provide the staged evidence directory');
const root = resolve(rootArg), repo = resolve(import.meta.dirname, '..');
const arms = ['A0', 'A1', 'B0', 'B1'];
const manifest = verifyManifest(root);
assert.equal(process.version, 'v22.23.3');
const cases = mode === 'cold-child' ? [] : makeCases();
if (mode !== 'cold-child') assert.deepEqual(caseManifest(cases), manifest.cases);
for (const file of [...manifest.sourcePins, ...manifest.buildPins, ...manifest.proofFiles]) {
  assert.equal(hash(readFileSync(join(repo, file.file))), file.sha256, file.file);
}
const entry = arm => pathToFileURL(join(root, 'runtime', arm, 'shared.js')).href;
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
// Williams order balances position and predecessor over a four-row cycle.
function order(row) {
  const sequence = [0, 1, 3, 2].map(i => arms[(i + row) % 4]);
  return Math.floor(row / 4) % 2 ? sequence.reverse() : sequence;
}
const metadata = { node: process.version, v8: process.versions.v8, execArgv: process.execArgv,
  platform: platform(), arch: arch(), cpu: cpus()[0]?.model, pid: process.pid,
  runnerImage: process.env.ImageVersion ?? null, runnerOs: process.env.RUNNER_OS ?? null,
  manifestSha256: hash(readFileSync(join(root, 'manifest.json'))) };
if (mode === 'check') {
  const results = [];
  for (const arm of arms) {
    const api = await import(entry(arm));
    for (const item of cases) results.push({ arm, ...checkCase(api, item) });
  }
  const result = { kind: 'correctness', metadata, cases: results, timingsRun: false };
  writeFileSync(join(root, 'correctness.json'), JSON.stringify(result, null, 2) + '\n');
  emit({ kind: 'correctness', armCases: results.length, timingsRun: false });
  process.exit(0);
}
assert(['run', 'warm-child', 'cold-child'].includes(mode), 'Unknown mode');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Timings require the reviewed GitHub CI job');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a clean GitHub-hosted job');
assert.equal(platform(), 'linux'); assert.equal(arch(), 'x64');
assert.deepEqual(process.execArgv, [], 'Default runtime settings only');
for (const name of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE']) assert(!process.env[name], `${name} must be absent`);
const activation = verifyGitHubActivation(repo);
assert.equal(activation.reviewedTree, manifest.sourceTree, 'Immutable push activation must match the manifest');
assert.equal(activation.runtimeCommit, manifest.runtimeCommit);
assert.equal(process.env.SCALAR_TEXT_SCREEN_REVIEWED_TREE, manifest.sourceTree, 'Exact reviewed tree required');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim(), manifest.sourceTree);
assert.equal(JSON.parse(readFileSync(join(root, 'correctness.json'))).metadata.manifestSha256, metadata.manifestSha256);
const gate = JSON.parse(readFileSync(join(root, 'gates.json')));
assert.equal(gate.manifestSha256, metadata.manifestSha256);
assert.equal(gate.complete, true, 'Every fresh standard/correctness gate must pass');
assert(gate.checks.length > 0 && gate.checks.every(x => x.status === 0));
for (const file of gate.logs) assert.equal(hash(readFileSync(join(root, file.file))), file.sha256);
assert.equal(hash(readFileSync(process.execPath)), manifest.nodeSha256, 'Same Node executable as fresh gates');
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', '.'], { cwd: repo });
const now = () => process.hrtime.bigint();
function precision() {
  const samples = [];
  for (let i = 0; i < 4096; i++) { const start = now(); samples.push(Number(now() - start)); }
  samples.sort((a, b) => a - b);
  return { minPositiveNs: samples.find(x => x > 0), medianPairNs: samples[2048], p99PairNs: samples[4055] };
}
function measure(fn) {
  const start = now(), value = fn(), elapsedNs = Number(now() - start);
  return { value, elapsedNs };
}
if (mode === 'warm-child') {
  const block = Number(blockArg), timer = precision(), floorNs = Math.max(10_000_000, 1000 * timer.p99PairNs);
  emit({ kind: 'warm-start', block, metadata, timer, floorNs });
  const apis = {};
  for (const arm of order(block)) apis[arm] = await import(entry(arm));
  const items = cases.map((_, i) => cases[(i + 2 * block) % cases.length]);
  for (const item of items) {
    const lists = Object.fromEntries(arms.map(arm => [arm, build(apis[arm], item)]));
    const expected = expectedScore(item);
    const batch = (arm, repeats) => {
      let score = 0;
      for (let i = 0; i < repeats; i++) score += scan(lists[arm], item);
      return score;
    };
    // Fixed activation/warmup, without constructor instrumentation in this process.
    for (let pass = 0; pass < 8; pass++) for (const arm of order(block + pass)) assert.equal(batch(arm, 1), expected);
    const calibrations = {};
    for (const arm of order(block)) {
      let repeats = 1;
      for (;;) {
        const sample = measure(() => batch(arm, repeats));
        assert.equal(sample.value, expected * repeats);
        const targetReached = sample.elapsedNs >= 20_000_000;
        const cappedBeforeTarget = repeats === 1024 && !targetReached;
        emit({ kind: 'calibration', block, id: item.id, arm, repeats, elapsedNs: sample.elapsedNs,
          terminal: targetReached || cappedBeforeTarget, targetReached, cappedBeforeTarget });
        if (targetReached || cappedBeforeTarget) break;
        repeats *= 2;
      }
      calibrations[arm] = repeats;
    }
    // The fastest arm needs the most repeats. All arms use this same fixed count.
    const repeats = Math.max(...Object.values(calibrations));
    for (let sample = 0; sample < 6; sample++) {
      const sequence = order(block * 6 + sample);
      for (const arm of sequence) {
        const result = measure(() => batch(arm, repeats));
        assert.equal(result.value, expected * repeats);
        emit({ kind: 'warm', block, id: item.id, arm, sample, sequence, repeats,
          elapsedNs: result.elapsedNs, nsPerOperation: result.elapsedNs / repeats,
          requestedIndexes: item.indexes.length, floorNs, belowFloor: result.elapsedNs < floorNs });
      }
    }
  }
  emit({ kind: 'warm-complete', block });
} else if (mode === 'cold-child') {
  const block = Number(blockArg), arm = armArg;
  assert(arms.includes(arm));
  emit({ kind: 'cold-start', block, arm, metadata });
  let api;
  const start = now(); api = await import(entry(arm));
  emit({ kind: 'cold', block, arm, stage: 'ordinary-import', elapsedNs: Number(now() - start) });
  const ordinary = measure(() => new api.SharedList('number').pushMany([1, 2, 3]));
  assert.deepEqual(ordinary.value.toArray(), [1, 2, 3]);
  emit({ kind: 'cold', block, arm, stage: 'ordinary-construction-after-import', elapsedNs: ordinary.elapsedNs });
  const item = { values: Array.from({ length: 16 }, (_, i) => String(i).padStart(8, '0') + 'x'.repeat(120) + 'needle') };
  const first = build(api, item), second = build(api, item);
  const firstMemory = api.getWorkerData({ first }, { copy: false }).arenas[0].memory;
  const secondMemory = api.getWorkerData({ second }, { copy: false }).arenas[0].memory;
  assert.notEqual(firstMemory, secondMemory);
  const unused = measure(() => first.compileTextSearch('unused'));
  assert.equal(typeof unused.value, 'function');
  emit({ kind: 'cold', block, arm, stage: 'unused-query-creation', elapsedNs: unused.elapsedNs });
  const valid = measure(() => first.compileTextSearch('needle')(0));
  assert.equal(valid.value, true);
  emit({ kind: 'cold', block, arm, stage: 'first-valid-query-and-access', elapsedNs: valid.elapsedNs });
  const other = measure(() => second.compileTextSearch('needle')(0));
  assert.equal(other.value, true);
  emit({ kind: 'cold', block, arm, stage: 'first-query-and-access-on-second-memory', elapsedNs: other.elapsedNs });
  // Probe timer precision after cold observations, never warm up the import stage.
  emit({ kind: 'cold-complete', block, arm, timer: precision() });
} else {
  const output = join(root, 'timing'); mkdirSync(output); // Existing timing evidence fails closed; no retries.
  assert.equal(manifest.design.warmBlocks, 8); assert.equal(manifest.design.coldBlocks, 8);
  const schedule = [
    ...Array.from({ length: 8 }, (_, block) => ({ kind: 'warm', block })),
    ...Array.from({ length: 8 }, (_, block) => order(block).map(arm => ({ kind: 'cold', block, arm }))).flat(),
  ];
  writeFileSync(join(output, 'schedule.json'), JSON.stringify({ metadata, schedule, budgetMs: 240000 }, null, 2));
  const started = now();
  try {
  for (const job of schedule) {
    const remaining = 240000 - Number(now() - started) / 1e6;
    if (remaining <= 0) throw new Error('Four-minute budget exhausted; retain partial evidence, do not infer success');
    const name = `${job.kind}-${job.block}${job.arm ? '-' + job.arm : ''}`;
    const stdout = openSync(join(output, name + '.jsonl'), 'wx'), stderr = openSync(join(output, name + '.stderr'), 'wx');
    let result;
    try {
      result = spawnSync(process.execPath, [import.meta.filename, `${job.kind}-child`, root, String(job.block), ...(job.arm ? [job.arm] : [])],
        { stdio: ['ignore', stdout, stderr], timeout: Math.ceil(remaining), killSignal: 'SIGKILL' });
    } finally { closeSync(stdout); closeSync(stderr); }
    writeFileSync(join(output, name + '.status.json'), JSON.stringify({ ...job, status: result.status, signal: result.signal, error: result.error?.message ?? null }));
    if (result.status !== 0) throw new Error(`Incomplete ${name}; preserve partial data and stop`);
  }
  } catch (error) {
    writeFileSync(join(output, 'incomplete.json'), JSON.stringify({ complete: false, reason: error.message, budgetMs: 240000 }));
    throw error;
  }
  writeFileSync(join(output, 'complete.json'), JSON.stringify({ complete: true, processes: schedule.length }));
  emit({ complete: true, processes: schedule.length });
}
