import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpoints } from './numeric-tree-process.mjs';

export function validatePhase(report, kind) {
  assert.equal(report.kind, kind); assert.equal(report.fullCoverage, true);
  assert.equal(report.error, null); assert.equal(report.pass, true);
  assert.deepEqual(report.rows.map(({ name, size }) => ({ name, size })), endpoints());
  assert.ok(report.rows.every(r => r.pointPass === true && r.confidencePass === true && r.pass === true));
  assert.ok(report.cohorts.length === 11 && report.cohorts.every(c => c.error === null && c.pass === true));
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const directory = resolve(process.env.EVIDENCE_DIR ?? 'proofs/results/numeric-tree-hosted');
  const phases = [];
  for (const runtime of ['node', 'bun']) for (const kind of ['aa', 'ab']) {
    const name = `${runtime}-${kind}`;
    const outcome = process.env[`${runtime.toUpperCase()}_${kind.toUpperCase()}_RESULT`] ?? 'missing';
    let report = null; let error = null;
    try {
      report = JSON.parse(readFileSync(resolve(directory, name, 'summary.json'), 'utf8'));
      validatePhase(report, kind); assert.equal(outcome, 'success', 'Step outcome failed or missing');
    } catch (failure) { error = String(failure); }
    phases.push({ name, outcome, rawPass: report?.pass ?? null, error });
  }
  const result = { pass: phases.every(p => !p.error), phases };
  writeFileSync(resolve(directory, 'gate.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '# Numeric comparison gate\n\n' + phases.map(p => `- ${p.name}: ${p.error ? 'FAIL' : 'PASS'}; command outcome ${p.outcome}; raw report pass ${p.rawPass}.`).join('\n') +
    '\n\nA continued step can show a successful conclusion after a failed command. This gate uses the command outcome and raw report.\n');
  console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
}
