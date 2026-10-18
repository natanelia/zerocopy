#!/usr/bin/env node
// Audit existing A/A controls. Does not change their benchmark thresholds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function median(xs) {
  assert.ok(Array.isArray(xs) && xs.length && xs.every(x => Number.isFinite(x) && x > 0));
  const sorted = [...xs].sort((a, b) => a - b), m = sorted.length >> 1;
  return sorted.length & 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
export function audit(dir, arch) {
  const report = read(resolve(dir, 'summary.json'));
  const plan = read(resolve(dir, 'plan.json'));
  assert.equal(report.kind, 'aa'); assert.equal(plan.kind, 'aa');
  assert.equal(report.runtime.arch, arch);
  assert.equal(plan.numericalPlan.version, 2);
  assert.equal(plan.numericalPlan.samples, 21);
  assert.equal(plan.numericalPlan.warmup, 7);
  assert.equal(plan.numericalPlan.blocks, 4);
  const sizes = plan.numericalPlan.sizes;
  assert.equal(new Set(sizes).size, sizes.length);
  const data = [];
  let children = 0;
  for (const size of sizes) {
    const sizeDir = resolve(dir, 'size-' + size);
    const sizeReport = read(resolve(sizeDir, 'summary.json'));
    assert.equal(sizeReport.kind, 'aa');
    const groups = new Map();
    for (let n = 1; n <= 16; n++) {
      const prefix = resolve(sizeDir, String(n).padStart(2, '0'));
      const status = read(prefix + '.status.json');
      assert.equal(status.status, 0); assert.equal(status.error, null);
      const child = read(prefix + '.json');
      assert.deepEqual(child.plan.sizes, [size]);
      assert.equal(child.runtime.arch, arch);
      assert.deepEqual(child.bundle, report.inputSources.candidate.bundle);
      const journal = readFileSync(prefix + '.json.samples.ndjson', 'utf8').trimEnd().split('\n').map(JSON.parse);
      assert.deepEqual(journal, child.results);
      for (const row of child.results) {
        assert.equal(row.size, size);
        assert.equal(row.warmup.length, 7); assert.equal(row.samples.length, 21);
        const item = { size, name: row.name, child: n,
          fullMedian: median(row.samples),
          early: median(row.samples.slice(0, 7)),
          late: median(row.samples.slice(14, 21)) };
        item.lateOverEarly = item.late / item.early;
        const key = size + '/' + row.name;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      children++;
    }
    for (const row of sizeReport.rows) {
      const records = groups.get(size + '/' + row.name);
      assert.equal(records?.length, 16);
      const medians = records.map(x => x.fullMedian);
      data.push({ name: row.name, size, pointPass: row.pointPass, confidencePass: row.confidencePass,
        processSpread: Math.max(...medians) / Math.min(...medians), records });
    }
  }
  assert.deepEqual(data.map(x => ({ name: x.name, size: x.size })),
    report.rows.map(x => ({ name: x.name, size: x.size })));
  const all = data.flatMap(x => x.records);
  return {
    type: 'diagnostic-only', architecture: arch, runtime: report.runtime,
    planSha256: digest(resolve(dir, 'plan.json')),
    summarySha256: digest(resolve(dir, 'summary.json')),
    commit: report.inputSources.candidate.commit,
    sourceBundleSha256: report.inputSources.candidate.bundle,
    verifiedChildren: children, verifiedEndpoints: data.length,
    verifiedMeasuredSamples: all.length * 21, originalPass: report.pass,
    originalPointPasses: data.filter(x => x.pointPass).length,
    originalConfidencePasses: data.filter(x => x.confidencePass).length,
    largestProcessSpreads: [...data].sort((a,b) => b.processSpread - a.processSpread).slice(0,12)
      .map(({ records, ...other }) => other),
    largestLateRises: [...all].sort((a,b) => b.lateOverEarly - a.lateOverEarly).slice(0,12),
    markedLateRises: all.filter(x => x.lateOverEarly > 1.25).length,
    note: 'Split and >1.25 marker are descriptive, not a new benchmark gate. All original failures remain.'
  };
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  assert.equal(process.argv.length, 4, 'Usage: node audit.mjs <unpacked-AA-directory> <x64|arm64>');
  console.log(JSON.stringify(audit(resolve(process.argv[2]), process.argv[3]), null, 2));
}
