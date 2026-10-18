import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize as pairedSummary, expectedCount, hash } from './paired.mjs';
import { summarize as originalSummary } from '../repo/proofs/numeric-tree-process.mjs';
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), 'raw');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const plan = read(resolve(root, 'plan.json'));
const cohorts = new Map(); let measured = 0, warmup = 0;
for (const [i, assignment] of plan.schedule.entries()) {
  const prefix = resolve(root, String(i + 1).padStart(3, '0'));
  const status = read(prefix + '.status.json');
  assert.deepEqual(read(prefix + '.assignment.json'), assignment); assert.deepEqual(status.assignment, assignment);
  assert.equal(status.exitCode, 0, 'Failed child'); assert.equal(status.error, null);
  const child = read(prefix + '.json'), separate = assignment.mode === 'separate-aa';
  assert.equal(child.driver, separate ? plan.originalDriverSha256 : plan.pairedDriverSha256);
  const records = readFileSync(prefix + (separate ? '.json.samples.ndjson' : '.json.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  if (separate) {
    assert.deepEqual(child.bundle, plan.inputs.candidate);
    assert.ok(child.maximumArenaBytes > 0 && child.maximumArenaBytes <= 64 * 1024 * 1024);
    assert.deepEqual(records, child.results);
    child.results.forEach(row => { assert.equal(row.expected, expectedCount(row.name, row.size)); measured += row.samples.length; warmup += row.warmup.length; });
  } else {
    assert.deepEqual(child.source.A, plan.inputs[assignment.mode === 'paired-ab' ? 'baseline' : 'candidate']);
    assert.deepEqual(child.source.B, plan.inputs.candidate);
    assert.equal(child.runtime.binarySha256, plan.runtimeSha256);
    assert.equal(child.runtime.arch, 'x64'); assert.equal(child.runtime.versions.bun, undefined);
    assert.deepEqual(records, child.rows.flatMap(r => [...r.warmup, ...r.samples]));
    child.rows.forEach(row => { measured += 2 * row.samples.length; warmup += 2 * row.warmup.length; });
  }
  const key = `${assignment.mode}/${assignment.size}`;
  if (!cohorts.has(key)) cohorts.set(key, []);
  cohorts.get(key).push(separate ? { assignment: { block: assignment.block, position: assignment.position, role: assignment.role }, status: 0, signal: null, error: null, report: child } : child);
}
const results = [];
for (const [key, children] of cohorts) {
  const [mode, size] = key.split('/');
  const rows = mode === 'separate-aa' ? originalSummary(children, 'aa', [Number(size)]) : pairedSummary(children, mode.replace('paired-', ''));
  results.push({ mode, size: Number(size), children: children.length, rows, pointPass: rows.filter(r => r.pointPass).length, confidencePass: rows.filter(r => r.confidencePass).length, pass: rows.every(r => r.pass) });
}
assert.equal(plan.schedule.length, 76); assert.equal(cohorts.size, 10);
assert.equal(hash(resolve(root, '../../repo/proofs/numeric-tree-process.mjs')), plan.originalDriverSha256);
assert.equal(hash(resolve(root, '../paired.mjs')), plan.pairedDriverSha256);
assert.equal(hash(resolve(root, '../run.py')), plan.controllerSha256);
const result = { planSha256: hash(resolve(root, 'plan.json')), processes: plan.schedule.length, measuredBatches: measured, warmupBatches: warmup, results };
writeFileSync(resolve(root, '../audit.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
