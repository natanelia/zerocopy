// Counts executed allocation expressions in the exact baseline/candidate leaves
// methods. This is not a retained-heap or RSS estimate; an engine can optimize JS
// arrays. Each executed new Uint32Array(16) requests a 64-byte backing buffer.
// Usage: bun proofs/trie-iterator-allocations.ts BASELINE_ARENA_TS [CANDIDATE_ARENA_TS]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Arena, arenaOf, popcount } from '../arena';
import { SharedMap } from '../shared';

const baselinePath = process.argv[2];
if (!baselinePath) throw new Error('Pass the exact baseline arena.ts path');
const candidatePath = process.argv[3] ?? new URL('../arena.ts', import.meta.url);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
type Counts = { stack: number; lanes: number; patches: number; laneBackingBytes: number };
const empty = (): Counts => ({ stack: 0, lanes: 0, patches: 0, laneBackingBytes: 0 });

function prepare(path: string | URL) {
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile('arena.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const arena = ast.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'Arena') as ts.ClassDeclaration;
  assert.ok(arena);
  const method = arena.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === 'leaves') as ts.MethodDeclaration;
  assert.ok(method?.asteriskToken, 'leaves remains a generator method');
  const begin = method.getStart(ast), end = method.end;
  const changes: { start: number; end: number; label: keyof Counts }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) || ts.isNewExpression(node) && node.expression.getText(ast) === 'Uint32Array') {
      const parent = node.parent;
      const owner = ts.isVariableDeclaration(parent) ? parent.name.getText(ast)
        : ts.isConditionalExpression(parent) && ts.isVariableDeclaration(parent.parent) ? parent.parent.name.getText(ast)
        : ts.isBinaryExpression(parent) ? parent.left.getText(ast) : '';
      assert.ok(['stack', 'lanes', 'patches'].includes(owner), `Unexpected allocation owner: ${owner}`);
      changes.push({ start: node.getStart(ast) - begin, end: node.end - begin, label: owner as keyof Counts });
    }
    ts.forEachChild(node, visit);
  };
  visit(method);
  assert.ok(changes.some(c => c.label === 'stack') && changes.some(c => c.label === 'lanes') && changes.some(c => c.label === 'patches'));
  let instrumented = source.slice(begin, end);
  for (const c of changes.sort((a, b) => b.start - a.start)) {
    instrumented = instrumented.slice(0, c.start) + `__allocated(${JSON.stringify(c.label)}, ${instrumented.slice(c.start, c.end)})` + instrumented.slice(c.end);
  }
  let counts = empty();
  const compiled = ts.transpileModule(`class Traversal { ${instrumented} }; return Traversal.prototype.leaves;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const leaves = new Function('__allocated', 'popcount', compiled)((label: keyof Counts, result: any) => {
    counts[label]++; if (label === 'lanes') counts.laneBackingBytes += result.byteLength;
    return result;
  }, popcount) as (this: Arena, root: number) => Generator<number>;
  return {
    sourceSha256: sha256(source), methodSha256: sha256(source.slice(begin, end)), instrumentationSites: changes.length,
    run(a: Arena, root: number, consume = true) {
      counts = empty();
      const iterator = leaves.call(a, root);
      if (consume) [...iterator]; else iterator.return(undefined);
      return { ...counts };
    },
    leaves,
  };
}

const before = prepare(baselinePath), after = prepare(candidatePath);
const fixtures: { name: string; map: SharedMap<'number'>; patched: boolean }[] = [];
for (const size of [0, 1, 2, 32, 4096]) {
  const map = new SharedMap('number', 0, 0, new Arena()).setMany(Array.from({ length: size }, (_, i) => [`key${i}`, i] as const));
  fixtures.push({ name: `canonical-${size}`, map, patched: false });
}
fixtures.push({ name: 'collision-2', map: new SharedMap('number', 0, 0, new Arena()).setMany([['costarring', 1], ['liquid', 2]]), patched: false });
for (const size of [32, 4096]) {
  let map = new SharedMap('number', 0, 0, new Arena()).setMany(Array.from({ length: size }, (_, i) => [`key${i}`, i] as const));
  for (let i = 0; i < 17; i++) map = map.set(`key${i}`, -i - 1);
  fixtures.push({ name: `patched-${size}`, map, patched: true });
}
const results = fixtures.map(({ name, map, patched }) => {
  const a = arenaOf(map);
  assert.deepEqual([...before.leaves.call(a, map.root)], [...after.leaves.call(a, map.root)]);
  assert.deepEqual(before.run(a, map.root, false), empty()); assert.deepEqual(after.run(a, map.root, false), empty());
  const baseline = before.run(a, map.root), candidate = after.run(a, map.root);
  assert.deepEqual(baseline, { stack: 1, lanes: 1, patches: 1, laneBackingBytes: 64 });
  assert.deepEqual(candidate, { stack: map.size > 1 ? 1 : 0, lanes: Number(patched), patches: Number(patched), laneBackingBytes: patched ? 64 : 0 });
  return { name, size: map.size, baseline, candidate };
});
const { run: _b, leaves: _bl, ...baseline } = before;
const { run: _a, leaves: _al, ...candidate } = after;
console.log(JSON.stringify({ schema: 1, runtime: process.versions, metric: 'executed allocation sites, not retained heap/RSS', baseline, candidate, results }, null, 2));
