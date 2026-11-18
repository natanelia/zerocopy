import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse CI's build and installed browser. These are current-source correctness
// checks, not the historical timing studies that originally hosted them.
const root = fileURLToPath(new URL('../../', import.meta.url));
const phase = process.argv[2] ?? 'all';
if (!['native', 'browser', 'all'].includes(phase)) {
  throw new Error('Usage: node scripts/ci/check-regressions.mjs [native|browser|all]');
}
const artifactRoot = resolve(process.env.CI_REGRESSION_ARTIFACTS ?? join(tmpdir(), 'zerocopy-ci-regressions'));
mkdirSync(artifactRoot, { recursive: true });
const artifacts = mkdtempSync(join(artifactRoot, `${phase}-`));
const checks = [];
const node = (name, args, timeout = 60000) => checks.push({ name, command: process.execPath, args, timeout });
const bun = (name, args) => checks.push({ name, command: 'bun', args, timeout: 60000 });

if (phase !== 'browser') {
  // The full source suite runs in Bun; allocation failure also needs Node's
  // WebAssembly implementation. Do not repeat the whole suite per proof.
  node('Node allocation failure and retained snapshots', [
    'node_modules/vitest/vitest.mjs', 'run', 'allocation-failure.test.ts', '--maxWorkers=1',
  ], 120000);
  node('Portable codecs and text search, including real workers', [
    '--test', '--test-concurrency=1', '--test-timeout=30000',
    'proofs/list-codecs.mjs', 'proofs/text-search.mjs', 'proofs/text-kernel.mjs',
    'proofs/text-batch.mjs', 'proofs/long-text-search-worker.node.mjs',
  ]);
  node('Portable JSON reads and shared/copied workers', ['proofs/json-read-correctness.mjs']);
  for (const [name, file, ...args] of [
    ['Numeric workers after memory growth', 'proofs/numeric-worker.mjs'],
    ['Spatial workers after memory growth', 'proofs/spatial-worker.mjs'],
    ['Many-arena workers and retained attachments', 'proofs/worker-arenas.mjs'],
    ['Heap compaction in shared/copied workers', 'proofs/heap-compaction-20261108/worker.mjs'],
    ['Redux heap codecs in real workers', 'proofs/redux-heap-read-view-20261108/node-workers.mjs'],
    ['Redux sequence codecs in real workers', 'proofs/redux-sequence-reads-20261105/worker.mjs'],
    ['Batched list edits in shared/copied workers', 'proofs/list-set-many-20261108/worker.mjs', 'list', '.'],
    ['Retained JSON array cursors after worker growth', 'proofs/json-array-cursor-20261118/workers.mjs'],
  ]) node(name, [file, ...args]);

  // Import-order regressions need fresh processes: the main Vitest suite
  // deliberately shares its module cache. Preserve portable Node/Bun and Bun
  // source entrypoints, with both override modes for each optional Redux path.
  for (const [label, file, option] of [
    ['heap', 'proofs/redux-heap-read-view-20261108/late-import.mjs', '--view'],
    ['sequence', 'proofs/redux-sequence-reads-20261105/late-import.mjs', '--decode'],
  ]) {
    for (const mode of [[], [option]]) {
      const suffix = mode[0] ?? 'default';
      node(`Late Redux ${label} import: Node portable ${suffix}`, [file, ...mode]);
      bun(`Late Redux ${label} import: Bun portable ${suffix}`, [file, ...mode]);
      bun(`Late Redux ${label} import: Bun source ${suffix}`, [file, '--source', ...mode]);
    }
  }
}

if (phase !== 'native') {
  // The checkpoint and sequence directories contain the same browser driver.
  // Its "both" mode covers the two former workflows in one browser launch.
  node('Chromium checkpoint and sequence workers', [
    'proofs/checkpoint-validation-20261105/browser-check.mjs', '.', 'both',
  ], 90000);
  node('Chromium heap codecs and retained snapshots', [
    'proofs/redux-heap-read-view-20261108/browser-check.mjs', '.',
  ], 90000);
  node('Chromium batched list edits and worker growth', [
    'proofs/list-set-many-20261108/browser.mjs', '.', join(artifacts, 'list-set-many-browser.json'),
  ], 90000);
}

const report = { phase, node: process.version, startedAt: new Date().toISOString(), checks: [] };
const save = () => writeFileSync(join(artifacts, 'results.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (const [index, check] of checks.entries()) {
    console.log(`\n[${index + 1}/${checks.length}] ${check.name}`);
    console.log([check.command, ...check.args].join(' '));
    const start = performance.now();
    // No shell or parallel child jobs. SIGKILL also bounds a stuck process that
    // cannot handle its normal termination signal; CI cleans up its runner.
    const result = spawnSync(check.command, check.args, {
      cwd: root, stdio: 'inherit', timeout: check.timeout, killSignal: 'SIGKILL',
    });
    const elapsedMs = Math.round(performance.now() - start);
    report.checks.push({ name: check.name, command: check.command, args: check.args,
      elapsedMs, status: result.status, signal: result.signal, error: result.error?.message });
    save();
    if (result.error) throw new Error(`${check.name}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${check.name} failed (${result.signal ?? `exit ${result.status}`})`);
    console.log(`Passed in ${(elapsedMs / 1000).toFixed(2)}s`);
  }
  report.status = 'passed';
  console.log(`\nAll ${checks.length} ${phase} regression checks passed.`);
} catch (error) {
  report.status = 'failed';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  save();
  console.log(`Regression evidence: ${artifacts}`);
}
