import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';

if (process.argv[2] === '--test-report') {
  const report = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const tests = report.testResults.flatMap(file => file.assertionResults);
  assert.equal(report.success, true, 'full suite must succeed');
  assert.equal(report.numTotalTests, 774, 'all original and overlay tests discovered');
  assert.equal(report.numPassedTests, 774, 'all tests passed');
  assert.equal(tests.length, 774, 'complete assertion evidence');
  assert.ok(tests.every(test => test.status === 'passed'), 'no skipped, pending or failed tests');
  const overlay = report.testResults.filter(file => basename(file.name) === 'cached-object-read.test.ts');
  assert.equal(overlay.length, 1, 'candidate test overlay discovered once');
  assert.equal(overlay[0].assertionResults.length, 21, 'all 21 overlay cases ran');
  console.log(JSON.stringify({ passed: true, tests: tests.length, overlayTests: 21 }));
  process.exit(0);
}

const [rootArg, baseline, candidate, outArg] = process.argv.slice(2);
assert.ok(rootArg && baseline && candidate && outArg, 'root, baseline, candidate, output are required');
const root = resolve(rootArg), out = resolve(outArg);
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
const before = git('show', baseline + ':arena.ts').toString();
const after = git('show', candidate + ':arena.ts').toString();
const anchor = '    let slot = this.reads?.slot(key);\n';
const insertion = '    if (code === 0 || code === 4) {\n      const leaf = sorted ? this.radixFind(root, key) : this.find(root, key);\n      return leaf ? this.leafValue(type, leaf, prefix) : undefined;\n    }\n';
assert.equal(before.split(anchor).length, 2, 'unique insertion anchor');
assert.equal(after, before.replace(anchor, insertion + anchor), 'only the stated production insertion is allowed');
assert.equal(git('rev-parse', candidate + '^').toString().trim(), baseline, 'runtime is direct child of baseline');
assert.deepEqual(git('diff', '--name-only', baseline, candidate).toString().trim().split('\n').sort(),
  ['arena.ts', 'cached-object-read.test.ts'], 'runtime candidate scope');
const proofCommit = git('rev-parse', 'HEAD').toString().trim();
assert.equal(git('rev-parse', 'HEAD^').toString().trim(), candidate, 'proof is direct child of runtime');
const proofPaths = git('diff', '--name-only', candidate, proofCommit).toString().trim().split('\n').sort();
assert.deepEqual(proofPaths, [
  '.github/workflows/cached-object-read-correctness.yml',
  'proofs/cached-object-read-check.mjs',
  'proofs/cached-object-read-correctness.md',
  'proofs/cached-object-read-workers.mjs',
].sort(), 'proof-only child scope');
assert.equal(git('diff', 'HEAD', '--name-only').toString().trim(), '', 'tracked proof worktree is clean');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  schema: 2, baseline, candidate, proofCommit,
  baselineTree: git('rev-parse', baseline + '^{tree}').toString().trim(),
  candidateTree: git('rev-parse', candidate + '^{tree}').toString().trim(),
  proofTree: git('rev-parse', 'HEAD^{tree}').toString().trim(),
  node: process.version,
  bun: execFileSync('bun', ['--version']).toString().trim(),
  inputs: {},
};
for (const pin of [baseline, candidate, proofCommit]) {
  const tracked = git('ls-tree', '-r', '--name-only', pin).toString().trim().split('\n');
  const files = {};
  for (const path of tracked) files[path] = hash(git('show', pin + ':' + path));
  manifest.inputs[pin] = files;
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, baseline, candidate, proofCommit, sourceFiles: Object.values(manifest.inputs).map(x => Object.keys(x).length) }));
