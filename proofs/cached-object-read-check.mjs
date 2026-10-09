import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const [rootArg, baseline, candidate, outArg] = process.argv.slice(2);
assert.ok(rootArg && baseline && candidate && outArg, 'root, baseline, candidate, output are required');
const root = resolve(rootArg), out = resolve(outArg);
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
const before = git('show', baseline + ':arena.ts').toString();
const after = git('show', candidate + ':arena.ts').toString();
const anchor = '    const leaf = sorted ? this.radixFind(root, key) : this.find(root, key);\n    // A root change can still resolve to the exact same immutable leaf.';
const insertion = '    if ((code === 0 || code === 4) && slot !== undefined && this.reads.root(slot) === root) {\n      const leaf = this.reads.leaf(slot);\n      return leaf ? this.leafValue(type, leaf, prefix) : undefined;\n    }\n';
assert.equal(before.split(anchor).length, 2, 'unique insertion anchor');
assert.equal(after, before.replace(anchor, insertion + anchor), 'only the stated production insertion is allowed');
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
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  schema: 1, baseline, candidate, proofCommit,
  baselineTree: git('rev-parse', baseline + '^{tree}').toString().trim(),
  candidateTree: git('rev-parse', candidate + '^{tree}').toString().trim(),
  proofTree: git('rev-parse', 'HEAD^{tree}').toString().trim(),
  node: process.version,
  bun: execFileSync('bun', ['--version']).toString().trim(),
  inputs: {},
};
for (const pin of [baseline, candidate]) {
  const tracked = git('ls-tree', '-r', '--name-only', pin).toString().trim().split('\n');
  const files = {};
  for (const path of tracked) files[path] = hash(git('show', pin + ':' + path));
  manifest.inputs[pin] = files;
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, baseline, candidate, proofCommit, sourceFiles: Object.values(manifest.inputs).map(x => Object.keys(x).length) }));
