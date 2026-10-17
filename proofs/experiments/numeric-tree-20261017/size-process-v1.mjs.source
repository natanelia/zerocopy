import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN, digest, endpoints, runCohort } from './numeric-tree-process.mjs';

// Follow-up to process method 1: shorten each crossover block to one size
// and stop CPU migration. No extra samples or changed thresholds.
const self = fileURLToPath(import.meta.url);
const baseDir = resolve(process.env.BASE_DIR ?? '../zerocopy-base');
const candidateDir = resolve(process.env.CANDIDATE_DIR ?? '.');
const outDir = resolve(process.env.OUT_DIR ?? 'proofs/results/numeric-tree-size-process');
const runtime = process.env.RUNTIME_BIN ?? process.execPath;
const kind = process.env.KIND ?? 'aa';
assert.ok(['aa', 'ab'].includes(kind));
assert.equal(process.platform, 'linux', 'This fixed affinity diagnostic requires Linux');
assert.ok(!process.env.DIAGNOSTIC_SIZES, 'Full 48-endpoint coverage is required');
assert.ok(!existsSync(outDir), 'Refuse to overwrite a prior cohort');
mkdirSync(outDir, { recursive: true });
const affinity = () => readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)[1].trim();
const beforeAffinity = affinity();
const cpu = Number(beforeAffinity.split(/[,-]/)[0]);
assert.ok(Number.isSafeInteger(cpu) && cpu >= 0);
const pin = spawnSync('taskset', ['-pc', String(cpu), String(process.pid)], { encoding: 'utf8' });
assert.equal(pin.status, 0, `Cannot set CPU affinity: ${pin.stderr}`);
assert.equal(affinity(), String(cpu), 'Affinity did not become a single CPU');
const cpuStat = () => { try { return readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'); } catch { return null; } };
const sources = { controller: digest(self), driver: digest(new URL('./numeric-tree-process.mjs', import.meta.url)) };
const plan = { method: 'size-isolated-affinity-v1', created: new Date().toISOString(), kind, runtime, sources,
  baseline: baseDir, candidate: candidateDir, numericalPlan: PLAN, originalAffinity: beforeAffinity, cpu,
  affinityCommand: pin.stdout, cpuStatBefore: cpuStat(), schedule: PLAN.sizes,
  limits: 'One size per fresh-process ABBA/BAAB cohort. Pin this controller and its future children to the first allowed CPU; do not select a CPU by performance. Preserve four blocks, all warm-ups, all samples and the method-1 estimator and gates. Sequential cohorts. No retry. CPU pinning is not exclusive reservation. Per-endpoint confidence intervals are not simultaneous family-wise bounds.' };
writeFileSync(resolve(outDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
const cohorts = [];
for (const size of PLAN.sizes) {
  let report = null; let error = null;
  try {
    assert.equal(affinity(), String(cpu));
    report = runCohort({ baseDir, candidateDir, outDir: resolve(outDir, `size-${size}`), runtime, kind, sizes: [size] });
  } catch (failure) { error = String(failure); }
  cohorts.push({ size, report, error });
  writeFileSync(resolve(outDir, `size-${size}.status.json`), JSON.stringify({ size, error, pass: report?.pass ?? false }, null, 2) + '\n', { flag: 'wx' });
}
const rows = cohorts.flatMap(c => c.report?.rows ?? []);
let error = null;
try {
  assert.ok(cohorts.every(c => !c.error && c.report?.complete && !c.report.error), 'Incomplete cohort');
  assert.deepEqual(rows.map(({ name, size }) => ({ name, size })), endpoints(), 'Missing, extra or reordered endpoints');
  assert.equal(affinity(), String(cpu));
  assert.deepEqual({ controller: digest(self), driver: digest(new URL('./numeric-tree-process.mjs', import.meta.url)) }, sources, 'Source changed');
} catch (failure) { error = String(failure); }
const report = { method: plan.method, kind, sources, fullCoverage: !error && rows.length === endpoints().length,
  error, cohorts: cohorts.map(({ size, error, report }) => ({ size, error, pass: report?.pass ?? false })),
  cpuStatAfter: cpuStat(), rows, pass: !error && rows.every(r => r.pass) };
writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log('NUMERIC-SIZE-PROCESS-SUMMARY', JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
