import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
assert.ok(beforeArg && afterArg && outputArg, 'Supply baseline, candidate, and output JSON');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function graph(root) {
  const folder = resolve(root, 'dist'), files = {}, edges = {}, external = [], unresolved = [];
  function visit(file) {
    const name = relative(folder, file);
    assert.ok(!name.startsWith('..'), 'Dependency must stay in dist');
    if (files[name]) return;
    const bytes = readFileSync(file), source = ts.createSourceFile(name, bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    files[name] = { sha256: sha(bytes), bytes: bytes.length };
    const imports = [];
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteralLike(node.moduleSpecifier));
        imports.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
        else unresolved.push({ file: name, expression: node.getText(source) });
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
    edges[name] = [...new Set(imports)].sort();
    for (const specifier of edges[name]) {
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
      else external.push({ file: name, specifier });
    }
  }
  visit(resolve(folder, 'shared.js'));
  return { files: Object.fromEntries(Object.entries(files).sort()), edges, external, unresolved };
}
function hashes(root, names) { return Object.fromEntries(names.map(name => [name, sha(readFileSync(resolve(root, name)))])); }
const before = resolve(beforeArg), after = resolve(afterArg);
const a = graph(before), b = graph(after);
const paths = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort();
const changes = paths.filter(path => a.files[path]?.sha256 !== b.files[path]?.sha256)
  .map(path => ({ path, before: a.files[path] ?? null, after: b.files[path] ?? null }));
const wasmNames = readdirSync(before).filter(name => name.endsWith('.wasm')).sort();
const wasmBefore = hashes(before, wasmNames), wasmAfter = hashes(after, wasmNames);
const rootSources = readdirSync(before).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort();
const sourcesBefore = hashes(before, rootSources), sourcesAfter = hashes(after, rootSources);
const changedRootSources = rootSources.filter(name => sourcesBefore[name] !== sourcesAfter[name]);
const result = {
  baseline: before, candidate: after, entry: 'dist/shared.js',
  status: changes.length || a.external.length || b.external.length || a.unresolved.length || b.unresolved.length ? 'FAILED' : 'PASSED',
  comparison: 'Exact relative paths and complete SHA-256 content of every statically reachable JS module, with dynamic/require calls checked for literal paths',
  before: a, after: b, changes, changedRootSources,
  wasm: { identical: JSON.stringify(wasmBefore) === JSON.stringify(wasmAfter), before: wasmBefore, after: wasmAfter },
};
assert.deepEqual(changedRootSources, ['numeric.ts']);
assert.deepEqual(wasmBefore, wasmAfter);
writeFileSync(resolve(outputArg), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, reachableBefore: Object.keys(a.files).length,
  reachableAfter: Object.keys(b.files).length, changes, changedRootSources, wasmIdentical: result.wasm.identical,
  external: [...a.external, ...b.external], unresolved: [...a.unresolved, ...b.unresolved] }, null, 2));
assert.equal(result.status, 'PASSED', 'The shared entry graph must remain identical and fully resolved');
