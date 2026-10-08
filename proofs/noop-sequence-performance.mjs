/** First x64 screen: fixed 16 cells, four independent ABBA/BAAB quartets per A/A and A/B. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { BASELINE_COMMIT, prepareComparison, bundleManifest, sha256, compilerContext, verifyProofSources } from './noop-sequence-source.mjs';
import { CASES, PAYLOAD_CAP, MAX_REPEATS, MIN_BATCH_MS } from './noop-sequence-workloads.mjs';
import { summarizeQuartets, applyControl } from './noop-sequence-stats.mjs';

export function freezeWork(pilots) {
  assert.equal(pilots.length, 2);
  assert.equal(pilots[0].result.cap, pilots[1].result.cap);
  assert.equal(pilots[0].result.fixtureUsed, pilots[1].result.fixtureUsed);
  const cap = pilots[0].result.cap, repeat = Math.max(...pilots.map(p => p.result.repeat));
  const estimates = pilots.map(p => p.result.calibration.at(-1).ms * repeat / p.result.repeat);
  const warmBatches = Math.min(100, Math.max(5, Math.ceil(150 / Math.min(...estimates))));
  return { cap, repeat, warmBatches, measuredBatches: 11,
    pilotCappedBelowFloor: pilots.some(p => p.result.repeat === cap && p.result.calibration.at(-1).ms < MIN_BATCH_MS) };
}
export function runComparison(baseline, candidate, output, receiptPath) {
  assert.equal(process.arch, 'x64', 'This first gate is x64 only');
  const compared = prepareComparison(baseline, candidate), root = dirname(dirname(compared.paths.candidate));
  const proofs = verifyProofSources(root, compared.candidateCommit), compiler = compilerContext(root);
  const receipt = JSON.parse(readFileSync(receiptPath));
  assert.equal(receipt.schema, 'noop-sequence-build/v1');
  assert.equal(receipt.candidateCommit, compared.candidateCommit);
  assert.deepEqual(receipt.manifests, compared.manifests);
  assert.deepEqual(receipt.sourceManifests, compared.sourceManifests);
  assert.deepEqual(receipt.proofs, proofs);
  assert.deepEqual(receipt.compiler.baseline, receipt.compiler.candidate);
  // A Bun launcher reports its own Node compatibility version. The receipt's
  // real Node build process version is retained independently.
  assert.equal(receipt.compiler.candidate.assemblyscript, compiler.assemblyscript);
  assert.equal(receipt.compiler.candidate.bun, compiler.bun);
  assert.deepEqual(receipt.compiler.candidate.buildScripts, compiler.buildScripts);
  assert.equal(receipt.commands.length, 4);
  assert.deepEqual(receipt.commands.map(c => [c.role, c.args, c.status]), ['baseline', 'candidate'].flatMap(role => ['build:wasm', 'build:browser'].map(target => [role, ['run', target], 0])));
  const scratch = mkdtempSync(join(tmpdir(), 'noop-sequence-')), neutralRoot = join(scratch, 'package'), neutral = join(neutralRoot, 'dist/shared.js');
  const report = { schema: 'noop-sequence-performance/v1', date: new Date().toISOString(), baseline: BASELINE_COMMIT,
    candidate: compared.candidateCommit, runtime: process.versions, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
    source: compared, proofs, buildReceiptSha256: sha256(readFileSync(receiptPath)), compiler: receipt.compiler,
    protocol: { cases: CASES, quartets: 4, orders: ['ABBA', 'BAAB', 'ABBA', 'BAAB'], samples: 11,
      payloadCap: PAYLOAD_CAP, maxRepeats: MAX_REPEATS, batchFloorMs: MIN_BATCH_MS, margin: 0.02, confidence: 0.95,
      neutral, packageJsonSha256: sha256(readFileSync(join(root, 'package.json'))),
      inference: 'Independent quartet means of paired log latency ratios; df=3 two-sided 95% Student t; per-case unadjusted; no A/A normalization or batch pooling',
      memory: 'Fresh fixture each batch; previous handles cleared and explicit GC outside timing; newest handle retained, old source validated; WASM growth and automatic GC included in elapsed time; payload cap excludes arena metadata, JS heap and backing reserve',
      scope: '16 predeclared primitive set cases on x64 Node and Bun only; no broad construction/read/uninterned string/object/browser/ARM performance claim' },
    checks: [], pilots: [], plans: [], subjects: [], summaries: [] };
  mkdirSync(dirname(output), { recursive: true });
  const save = () => { writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2) + '\n'); renameSync(`${output}.tmp`, `${output}.partial`); };
  save();
  const subjectFile = fileURLToPath(new URL('./noop-sequence-case.mjs', import.meta.url));
  const isBun = typeof Bun !== 'undefined';
  function run(build, config) {
    assert.deepEqual(bundleManifest(compared.paths[build]), compared.manifests[build]);
    rmSync(neutralRoot, { recursive: true, force: true }); mkdirSync(neutralRoot);
    cpSync(dirname(compared.paths[build]), join(neutralRoot, 'dist'), { recursive: true });
    // Preserve the original nearest package context, including its exports.
    cpSync(join(dirname(dirname(compared.paths[build])), 'package.json'), join(neutralRoot, 'package.json'));
    assert.equal(sha256(readFileSync(join(neutralRoot, 'package.json'))), report.protocol.packageJsonSha256);
    assert.deepEqual(bundleManifest(neutral), compared.manifests[build]);
    const child = spawnSync(process.execPath, [...(isBun ? [] : ['--expose-gc']), subjectFile, JSON.stringify({ ...config, module: neutral, reuse: build === 'candidate' })], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    if (child.status !== 0) {
      report.failure = { build, config, status: child.status, error: child.error?.message, stdout: child.stdout, stderr: child.stderr }; save();
      throw new Error(`Subject failed: ${child.error?.message ?? child.stderr ?? child.stdout}`);
    }
    assert.deepEqual(bundleManifest(neutral), compared.manifests[build]);
    return JSON.parse(child.stdout);
  }
  try {
    for (const build of ['baseline', 'candidate']) { report.checks.push({ build, result: run(build, { mode: 'checks' }) }); save(); }
    for (const workload of CASES) {
      const pilots = [];
      for (const build of ['baseline', 'candidate']) {
        const pilot = { name: workload.name, build, result: run(build, { name: workload.name, mode: 'pilot' }) };
        pilots.push(pilot); report.pilots.push(pilot); save();
      }
      const plan = { name: workload.name, ...freezeWork(pilots) }; report.plans.push(plan); save();
      for (let block = 0; block < 4; block++) for (const protocol of block % 2 ? ['AB', 'AA'] : ['AA', 'AB']) {
        for (let pair = 0; pair < 2; pair++) for (const label of (block + pair) % 2 ? ['B', 'A'] : ['A', 'B']) {
          const build = protocol === 'AB' && label === 'B' ? 'candidate' : 'baseline';
          const result = run(build, { ...plan, mode: 'measure' });
          report.subjects.push({ name: workload.name, block, pair, protocol, label, build, result }); save();
        }
      }
      const summaries = Object.fromEntries(['AA', 'AB'].map(protocol => [protocol, summarizeQuartets(report.subjects.filter(s => s.name === workload.name && s.protocol === protocol))]));
      report.summaries.push({ name: workload.name, group: workload.group, AA: summaries.AA, AB: applyControl(summaries.AA, summaries.AB) }); save();
      console.log(`${workload.name}: ${report.summaries.at(-1).AB.conclusion}`);
    }
    const final = prepareComparison(baseline, candidate);
    assert.deepEqual(final, compared); assert.deepEqual(verifyProofSources(root, compared.candidateCommit), proofs);
    report.completed = new Date().toISOString(); save(); renameSync(`${output}.partial`, output);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, output, receipt] = process.argv.slice(2); assert(baseline && candidate && output && receipt);
  runComparison(resolve(baseline), resolve(candidate), resolve(output), resolve(receipt));
}
