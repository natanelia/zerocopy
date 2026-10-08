// Untimed exact-source proof. It never loads the timing harness.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = '3773c6e519c7c0958da13727ed1082f449f3ee25';
const combined = '47402ad2ec2ac7226831a577e6e224c555710af8';
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const hash = data => createHash('sha256').update(data).digest('hex');
function method(source, name) {
  const ast = ts.createSourceFile('arena.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const arena = ast.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'Arena');
  const found = arena.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === name);
  assert.ok(found.asteriskToken);
  return source.slice(found.getStart(ast), found.end);
}
const before = git('show', `${baseline}:arena.ts`).toString(), held = git('show', `${combined}:arena.ts`).toString();
const actual = readFileSync(new URL('../arena.ts', import.meta.url), 'utf8');
assert.equal(actual, before.replace(method(before, 'radixLeaves'), method(held, 'radixLeaves')));
assert.equal(method(actual, 'leaves'), method(before, 'leaves'));
const sourceFiles = {};
for (const file of git('ls-tree', '-r', '--name-only', baseline).toString().trim().split('\n')) {
  const expected = git('show', `${baseline}:${file}`), path = new URL('../' + file, import.meta.url);
  assert.ok(existsSync(path), `Missing baseline file ${file}`);
  const bytes = readFileSync(path);
  if (file !== 'arena.ts') assert.deepEqual(bytes, expected, `Changed baseline file ${file}`);
  sourceFiles[file] = hash(bytes);
}
const allowedAdditions = ['trie-view-capture.test.ts', 'proofs/trie-view-fixtures.ts', 'proofs/trie-view-mechanism.ts',
  'proofs/trie-view-worker.mjs', 'proofs/trie-view-workers.mjs', 'proofs/radix-view-source.mjs',
  'proofs/radix-view-source.patch', 'proofs/radix-view-only.md', 'proofs/radix-view-plan.json'].sort();
const baseFiles = new Set(Object.keys(sourceFiles));
// node_modules is the local dependency symlink; geometry-kernels.wat is the
// build script's untracked text output. Neither is a source/package input.
const currentFiles = new Set([...git('ls-files').toString().trim().split('\n'),
  ...git('ls-files', '--others', '--exclude-standard', '--exclude=node_modules', '--exclude=geometry-kernels.wat').toString().trim().split('\n')].filter(Boolean));
assert.deepEqual([...currentFiles].filter(file => !baseFiles.has(file)).sort(), allowedAdditions, 'Unexpected added files');
for (const file of allowedAdditions) sourceFiles[file] = hash(readFileSync(new URL('../' + file, import.meta.url)));
console.log(JSON.stringify({ schema: 1, baseline, combined, scope: 'exact held radixLeaves only',
  unchangedBaselineFiles: baseFiles.size - 1, arenaSha256: hash(actual),
  hamtMethodSha256: hash(method(actual, 'leaves')), radixMethodSha256: hash(method(actual, 'radixLeaves')),
  sourceFiles }, null, 2));
