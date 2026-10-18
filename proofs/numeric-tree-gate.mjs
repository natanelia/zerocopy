import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN, endpoints, interval, schedule, summarize } from './numeric-tree-process.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function near(actual, expected, name) {
  assert.ok(Number.isFinite(actual) && actual > 0, `Invalid ${name}`);
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `Inconsistent ${name}`);
}
export function validatePhase(report, kind) {
  assert.ok(['aa', 'ab'].includes(kind));
  assert.equal(report.kind, kind); assert.equal(report.fullCoverage, true);
  assert.equal(report.error, null); assert.equal(report.pass, true);
  assert.deepEqual(report.rows.map(({ name, size }) => ({ name, size })), endpoints());
  for (const row of report.rows) {
    assert.equal(row.pairedRatios.length, PLAN.blocks * 2);
    assert.equal(row.blockRatios.length, PLAN.blocks);
    assert.ok(row.pairedRatios.every(n => Number.isFinite(n) && n > 0));
    const logs = Array.from({ length: PLAN.blocks }, (_, i) =>
      (Math.log(row.pairedRatios[i * 2]) + Math.log(row.pairedRatios[i * 2 + 1])) / 2);
    logs.forEach((value, i) => near(row.blockRatios[i], Math.exp(value), 'block ratio'));
    const stats = interval(logs);
    for (const key of ['speedup', 'lower', 'upper']) near(row[key], stats[key], key);
    const target = kind === 'ab' && row.size >= 1024 && ['range-simd', 'range-public'].includes(row.name);
    const pointPass = stats.speedup >= PLAN.regressionFloor &&
      (kind !== 'aa' || stats.speedup <= PLAN.aaCeiling) && (!target || stats.speedup > PLAN.improvementFloor);
    const confidencePass = stats.lower >= PLAN.regressionFloor &&
      (kind !== 'aa' || stats.upper <= PLAN.aaCeiling) && (!target || stats.lower > PLAN.improvementFloor);
    assert.equal(row.pointPass, pointPass, 'False point-pass flag');
    assert.equal(row.confidencePass, confidencePass, 'False confidence-pass flag');
    assert.equal(row.pass, pointPass && confidencePass, 'False endpoint-pass flag');
    assert.ok(row.pass, `Failed endpoint: ${row.name}/${row.size}`);
  }
  assert.deepEqual(report.cohorts.map(c => c.size), PLAN.sizes, 'Missing or duplicate size cohort');
  assert.ok(report.cohorts.every(c => c.error === null && c.pass === true));
}

// Recompute from every retained child, not the cached pass flags or estimates.
// No path or sample selection comes from the report. Failed evidence stays put.
export function verifyEvidence(directory, kind) {
  const report = read(resolve(directory, 'summary.json'));
  const plan = read(resolve(directory, 'plan.json'));
  assert.equal(report.kind, kind); assert.equal(plan.kind, kind);
  assert.deepEqual(plan.numericalPlan, PLAN, 'Wrong measurement version');
  assert.deepEqual(plan.inputSources, report.inputSources);
  assert.deepEqual(plan.sources, report.sources);
  assert.equal(plan.runtime, report.runtimeFile);
  assert.equal(plan.runtimeSha256, report.runtimeSha256);
  const rows = [], cohorts = [];
  for (const size of PLAN.sizes) {
    const dir = resolve(directory, `size-${size}`);
    const cohortPlan = read(resolve(dir, 'plan.json'));
    assert.equal(cohortPlan.kind, kind);
    assert.deepEqual(cohortPlan.plan, { ...PLAN, sizes: [size] });
    assert.deepEqual(cohortPlan.schedule, schedule());
    assert.deepEqual(cohortPlan.source, report.inputSources);
    assert.equal(cohortPlan.driver, report.sources.driver);
    assert.equal(cohortPlan.runtime, report.runtimeFile);
    const children = schedule().map((assignment, index) => {
      const prefix = resolve(dir, String(index + 1).padStart(2, '0'));
      const status = read(`${prefix}.status.json`);
      assert.deepEqual(status.assignment, assignment);
      const child = read(`${prefix}.json`);
      const journal = readFileSync(`${prefix}.json.samples.ndjson`, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(journal, child.results, 'Raw sample journal differs from child');
      assert.equal(child.driver, report.sources.driver);
      assert.deepEqual(child.runtime, report.runtime);
      const source = kind === 'aa' || assignment.role === 'B' ? 'candidate' : 'baseline';
      assert.deepEqual(child.bundle, report.inputSources[source].bundle, 'Wrong measured build');
      return { ...status, report: child };
    });
    const actual = summarize(children, kind, [size]);
    const summary = read(resolve(dir, 'summary.json'));
    assert.equal(summary.kind, kind); assert.equal(summary.complete, true); assert.equal(summary.error, null);
    assert.deepEqual(summary.rows, actual, 'Size summary differs from raw samples');
    const pass = actual.every(r => r.pass);
    assert.equal(summary.pass, pass);
    rows.push(...actual); cohorts.push({ size, error: null, pass });
  }
  assert.equal(report.fullCoverage, true); assert.equal(report.error, null);
  assert.deepEqual(report.rows, rows, 'Phase summary differs from raw samples');
  assert.deepEqual(report.cohorts, cohorts);
  assert.equal(report.pass, rows.every(r => r.pass));
  return report;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const directory = resolve(process.env.EVIDENCE_DIR ?? 'proofs/results/numeric-tree-hosted');
  const phases = [], verified = new Map();
  for (const runtime of ['node', 'bun']) for (const kind of ['aa', 'ab']) {
    const name = `${runtime}-${kind}`;
    const outcome = process.env[`${runtime.toUpperCase()}_${kind.toUpperCase()}_RESULT`] ?? 'missing';
    let report = null, error = null, evidenceVerified = false;
    try {
      report = verifyEvidence(resolve(directory, name), kind); evidenceVerified = true;
      verified.set(name, report);
      validatePhase(report, kind); assert.equal(outcome, 'success', 'Step outcome failed or missing');
    } catch (failure) { error = String(failure); }
    phases.push({ name, outcome, rawPass: report?.pass ?? null, evidenceVerified, error });
  }
  let identityError = null;
  try {
    assert.equal(verified.size, 4, 'All four evidence sets are required');
    const first = verified.get('node-aa');
    for (const report of verified.values()) {
      assert.deepEqual(report.inputSources, first.inputSources, 'Build inputs changed between phases');
      assert.deepEqual(report.sources, first.sources, 'Measurement source changed between phases');
    }
    for (const runtime of ['node', 'bun']) {
      const a = verified.get(`${runtime}-aa`), b = verified.get(`${runtime}-ab`);
      assert.equal(a.runtimeSha256, b.runtimeSha256, 'Runtime binary changed between A/A and A/B');
      assert.deepEqual(a.runtime, b.runtime, 'Runtime metadata changed between A/A and A/B');
    }
  } catch (failure) { identityError = String(failure); }
  const result = { pass: !identityError && phases.every(p => !p.error), identityError, phases };
  writeFileSync(resolve(directory, 'gate.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '# Numeric comparison gate\n\n' + phases.map(p => `- ${p.name}: ${p.error ? 'FAIL' : 'PASS'}; command outcome ${p.outcome}; raw evidence verified ${p.evidenceVerified}; raw pass ${p.rawPass}.`).join('\n') +
    `\n\nCross-phase identity: ${identityError ?? 'PASS'}.\n` +
    '\nAll estimates are recomputed from every retained child and raw sample journal. Continued step conclusions do not clear a failed command.\n');
  console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
}
