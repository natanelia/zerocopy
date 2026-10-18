import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const ORIGINAL = '77842c9459547c616ea4f90ade8bb32118d2f4175408aecf2269e2d8d7d5d033';
const FROZEN = Object.freeze({
  1: { driver: 'def7637bc5941b6d23be343750efd5544388e061a9b116b69cb3e01826f15f5c', controller: '9fc8cec3e9a518d055bfca8d22849453b244762edb845d30081d8be1b03fc9f3' },
  4: { driver: '7deb2be47cc4611e159479aea254c6bef0c1fc11e875eb84f0b776e031a48d49', controller: '67f11224e7732d3dc6c9bcc9cb0ccd9554a49cc1a41971b6179b76443dc755c9' },
});
const TARGET = Object.freeze({ node: 'v22.16.0', arch: 'x64', bun: null });

/** Reconstruct the sealed diagnostic schedule; do not trust the stored list. */
export function expectedSchedule(multiplier) {
  assert.ok(multiplier === 1 || multiplier === 4);
  const sizes = multiplier === 1 ? [2, 1024, 32768] : [2], schedule = [];
  for (const size of sizes) for (let block = 0; block < 4; block++) {
    let groups = multiplier === 1 ? ['separate-aa', 'paired-aa', 'paired-ab'] : ['paired-aa', 'paired-ab'];
    const offset = block % groups.length;
    groups = [...groups.slice(offset), ...groups.slice(0, offset)];
    for (const mode of groups) {
      const roles = mode === 'separate-aa' ? (block & 1 ? 'BAAB' : 'ABBA') : 'P';
      [...roles].forEach((role, position) => schedule.push({ mode, size, block, position, role }));
    }
  }
  for (let block = 0; block < 4; block++) schedule.push({ mode: 'slow-control', size: 1024, block, position: 0, role: 'P' });
  return schedule;
}

/** Bind each report to its scheduled case before any grouping or statistics. */
export function bindRecord(child, assignment, plan, pairedRuntime) {
  assert.ok(pairedRuntime && pairedRuntime.version === TARGET.node, 'Wrong planned Node version');
  assert.equal(pairedRuntime.arch, TARGET.arch, 'Wrong planned architecture');
  assert.equal(pairedRuntime.versions.bun ?? null, TARGET.bun, 'Wrong planned runtime family');
  assert.equal(pairedRuntime.versions.node, TARGET.node.slice(1), 'Wrong planned Node metadata');
  assert.equal(pairedRuntime.binarySha256, plan.runtimeSha256, 'Wrong planned runtime binary');
  assert.equal(pairedRuntime.execPath, plan.runtime, 'Wrong planned runtime path');
  assert.deepEqual(pairedRuntime.execArgv, [], 'Runtime flags changed');
  if (assignment.mode === 'separate-aa') {
    assert.deepEqual(child.plan.sizes, [assignment.size], 'Scheduled size mismatch');
    assert.deepEqual(child.runtime, {
      node: pairedRuntime.version, bun: pairedRuntime.versions.bun ?? null,
      v8: pairedRuntime.versions.v8, arch: pairedRuntime.arch, cpu: pairedRuntime.cpu,
    }, 'Separate-process runtime differs from paired runtime');
  } else {
    assert.equal(child.size, assignment.size, 'Scheduled size mismatch');
    assert.equal(child.block, assignment.block, 'Scheduled block mismatch');
    assert.equal(child.kind, assignment.mode.replace('paired-', ''), 'Scheduled kind mismatch');
    assert.deepEqual(child.runtime, pairedRuntime, 'Paired runtime differs across cohorts');
  }
}

/** Replay unmodified retained records. This cannot create missing attestations. */
export async function verifyRetained(directory, originalDriver) {
  directory = resolve(directory); originalDriver = resolve(originalDriver);
  const raw = resolve(directory, 'raw'), plan = read(resolve(raw, 'plan.json'));
  const multiplier = plan.batchMultiplier ?? 1, frozen = FROZEN[multiplier];
  assert.ok(frozen, 'Unrecognized frozen method');
  assert.equal(plan.originalDriverSha256, ORIGINAL); assert.equal(sha(originalDriver), ORIGINAL);
  assert.equal(plan.pairedDriverSha256, frozen.driver); assert.equal(sha(resolve(directory, 'paired.mjs')), frozen.driver);
  assert.equal(plan.controllerSha256, frozen.controller); assert.equal(sha(resolve(directory, 'run.py')), frozen.controller);
  const inputs = {};
  // ASCII file names: use byte order, not locale order, for the canonical source seal.
  for (const role of ['baseline', 'candidate']) inputs[role] = Object.fromEntries(Object.keys(plan.inputs[role]).sort().map(name => [name, plan.inputs[role][name]]));
  assert.deepEqual(Object.keys(plan.inputs).sort(), ['baseline', 'candidate']);
  assert.equal(createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), '3f49dd934a3950240a09a0765b27716151f860cb7288dd3a1d1ed8687bb910d4', 'Frozen build manifests changed');
  assert.equal(plan.inputZipSha256, 'c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb');
  assert.equal(plan.baselineCommit, 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e');
  assert.equal(plan.sourceCommit, 'd16d82c9ac8b4264870c8c3687b25b53a6e553bf');
  assert.deepEqual(plan.sizes, multiplier === 1 ? [2, 1024, 32768] : [2]);
  for (const [key, value] of Object.entries({ blocks: 4, warmup: 7, samples: 21, work: 8000000, regressionFloor: 0.95, improvementFloor: 1.05, aaCeiling: 1 / 0.95 })) assert.equal(plan[key], value, `Plan ${key} changed`);
  const schedule = expectedSchedule(multiplier); assert.deepEqual(plan.schedule, schedule, 'Stored schedule changed');
  const { summarize: pairedSummary, expectedCount } = await import(pathToFileURL(resolve(directory, 'paired.mjs')).href);
  const { summarize: originalSummary } = await import(pathToFileURL(originalDriver).href);
  const anchorIndex = schedule.findIndex(a => a.mode === 'paired-aa');
  const anchor = read(resolve(raw, `${String(anchorIndex + 1).padStart(3, '0')}.json`)).runtime;
  const cohorts = new Map(); let measuredBatches = 0, warmupBatches = 0, separateProcesses = 0;
  for (const [i, assignment] of schedule.entries()) {
    const prefix = resolve(raw, String(i + 1).padStart(3, '0'));
    const status = read(prefix + '.status.json');
    assert.deepEqual(read(prefix + '.assignment.json'), assignment); assert.deepEqual(status.assignment, assignment);
    assert.equal(status.exitCode, 0, 'Failed child'); assert.equal(status.error, null, 'Failed child');
    const child = read(prefix + '.json'), separate = assignment.mode === 'separate-aa';
    bindRecord(child, assignment, plan, anchor);
    assert.equal(child.driver, separate ? ORIGINAL : frozen.driver, 'Wrong child driver');
    const journal = readFileSync(prefix + (separate ? '.json.samples.ndjson' : '.json.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    if (separate) {
      separateProcesses++;
      assert.deepEqual(child.bundle, plan.inputs.candidate);
      assert.ok(child.maximumArenaBytes > 0 && child.maximumArenaBytes <= 64 * 1024 * 1024);
      assert.deepEqual(journal, child.results, 'Journal mismatch');
      child.results.forEach(row => {
        assert.equal(row.size, assignment.size, 'Scheduled row size mismatch');
        assert.equal(row.expected, expectedCount(row.name, assignment.size), 'Wrong oracle count');
        measuredBatches += row.samples.length; warmupBatches += row.warmup.length;
      });
    } else {
      assert.deepEqual(child.source.A, plan.inputs[assignment.mode === 'paired-ab' ? 'baseline' : 'candidate']);
      assert.deepEqual(child.source.B, plan.inputs.candidate);
      assert.deepEqual(journal, child.rows.flatMap(r => [...r.warmup, ...r.samples]), 'Journal mismatch');
      child.rows.forEach(row => { measuredBatches += 2 * row.samples.length; warmupBatches += 2 * row.warmup.length; });
    }
    const key = `${assignment.mode}/${assignment.size}`;
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(separate ? { assignment: { block: assignment.block, position: assignment.position, role: assignment.role }, status: 0, signal: null, error: null, report: child } : child);
  }
  const results = [];
  for (const [key, children] of cohorts) {
    const [mode, textSize] = key.split('/'), size = Number(textSize);
    const rows = mode === 'separate-aa' ? originalSummary(children, 'aa', [size]) : pairedSummary(children, mode.replace('paired-', ''));
    assert.ok(rows.every(row => row.size === size), 'Summary size mismatch');
    results.push({ mode, size, children: children.length, rows, pointPass: rows.filter(r => r.pointPass).length, confidencePass: rows.filter(r => r.confidencePass).length, pass: rows.every(r => r.pass) });
  }
  return { verifier: 'retained-replay-2', verifierSha256: sha(fileURLToPath(import.meta.url)),
    planSha256: sha(resolve(raw, 'plan.json')), processes: schedule.length, measuredBatches, warmupBatches,
    evidenceVerified: true, separateProcessesWithoutPerChildBinaryAttestation: separateProcesses,
    binaryBindingLimit: separateProcesses ? 'Legacy separate-process reports have runtime metadata and whole-run controller binary checks, but no per-child binary attestation. Replay cannot add one.' : null,
    results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 5, 'Usage: node verify-retained.mjs STAGE_DIRECTORY ORIGINAL_DRIVER OUTPUT_JSON');
  const result = await verifyRetained(process.argv[2], process.argv[3]);
  writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ evidenceVerified: result.evidenceVerified, processes: result.processes,
    missingPerChildBinaryAttestations: result.separateProcessesWithoutPerChildBinaryAttestation,
    checks: result.results.map(r => [r.mode, r.size, r.pointPass, r.confidencePass]) }));
}
