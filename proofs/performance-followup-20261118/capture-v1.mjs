#!/usr/bin/env node
// Preserve a completed measurement directory without replacing prior evidence.
// Run only after the measurement owner releases the CPU and stops writing reports.
// Usage: node capture.mjs /path/to/perf-harness-followup /path/to/zerocopy
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
assert(process.argv[2] && process.argv[3], 'Pass the measurement directory and Git repository');
const source = resolve(process.argv[2]), repository = resolve(process.argv[3]);
const baseline = '1242908762b554e3574365c486d5a6c52d5e568f';
const candidates = [
  ['map-directory', '72d9ad0a421fbc72c4380667d08a3511819c53cb'],
  ['map-directory-inline', '5a00e4fa391e5eea1d4aeb92d3e5c395b5780335'],
  ['ascii-dataview', '8144fbd39d486ce04f7d935011be978f81c6848d'],
  ['arena-lazy-scalar', '5c155970f9354894c5a613612e69ad00d14404ce'],
  ['list-boolean-get', '333db44292d62b4660c7695d2e445efc5bd85c70'],
  ['ascii-byte-loads', '639335f59306ff532371cd84ad31c453f0680b56'],
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function retain(relative, bytes) {
  const target = join(directory, relative);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) assert(readFileSync(target).equals(bytes), `Refusing to replace changed evidence: ${relative}`);
  else writeFileSync(target, bytes, { flag: 'wx' });
  return { path: relative, bytes: bytes.length, sha256: hash(bytes) };
}
const scripts = [], reports = [], patches = [];
for (const file of readdirSync(source).sort()) {
  if (!file.endsWith('.mjs') && !file.endsWith('.json')) continue;
  const bytes = readFileSync(join(source, file));
  if (file.endsWith('.mjs')) scripts.push(retain(`harness/${file}`, bytes));
  else {
    const entry = {
      ...retain(`results/${file}.gz`, gzipSync(bytes, { level: 9 })),
      originalFile: file, originalBytes: bytes.length, originalSha256: hash(bytes),
    };
    try {
      const report = JSON.parse(bytes.toString('utf8'));
      if (report.schema === 'zerocopy-followup-performance/v1') {
        entry.study = {
          complete: report.complete, pairs: report.pairs, runtimes: report.runtimes,
          config: report.config, harness: report.harness,
          baselineCommit: report.variants?.baseline?.commit, candidateCommit: report.variants?.candidate?.commit,
          recordedSamples: report.samples?.length, error: report.error,
        };
      }
    } catch { entry.note = 'Preserved original non-JSON or empty output without alteration'; }
    reports.push(entry);
  }
  assert(readFileSync(join(source, file)).equals(bytes), `Source changed during capture: ${file}`);
}
for (const [name, commit] of candidates) {
  const bytes = execFileSync('git', ['-C', repository, 'diff', '--no-ext-diff', '--binary', '--full-index', baseline, commit, '--']);
  patches.push({ name, baseline, commit, ...retain(`patches/${name}-${commit.slice(0, 7)}.patch`, bytes) });
}
// Retain every harness version referenced by a report, including failed attempts.
const scriptHashes = new Set(scripts.map(item => item.sha256));
for (const report of reports) if (report.study) {
  assert(scriptHashes.has(report.study.harness.driverSha256), `Missing original controller for ${report.originalFile}`);
  assert(scriptHashes.has(report.study.harness.workloadsSha256), `Missing original workload for ${report.originalFile}`);
}
let sequence = 1;
while (existsSync(join(directory, `inventory-${String(sequence).padStart(3, '0')}.json`))) sequence++;
const inventory = { schema: 'zerocopy-followup-archive/v1', capturedAt: new Date().toISOString(), baseline, scripts, reports, patches };
const result = retain(`inventory-${String(sequence).padStart(3, '0')}.json`, Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`));
console.log(JSON.stringify({ inventory: result.path, scripts: scripts.length, reports: reports.length, patches: patches.length }));
