// Counts executed string-template and Map-construction expressions in the exact
// before/after Compactor. Not an engine allocation, retained heap or RSS estimate.
// Also compares complete compacted arena payloads under one fixed target ID.
// Usage: bun proofs/compaction-pointer-allocations.ts BASELINE_COMPACTION_TS
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Arena, Snapshot, arenaOf, vectorDepth, HEAP_START } from '../arena';
import { parseNestedType } from '../types';
import { structureRegistry } from '../codec';
import * as S from '../shared';

const baselinePath = process.argv[2];
if (!baselinePath) throw new Error('Pass the exact baseline compaction.ts path');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const classEntries = Object.entries(S).filter(([name]) => /^Shared/.test(name));
class TargetArena extends Arena { constructor() { super({ id: 'compaction-allocation-proof-target' }); } }
const environment = { ...S, Arena: TargetArena, Snapshot, arenaOf, vectorDepth, parseNestedType, structureRegistry, classEntries };
function prepare(path: string | URL) {
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile('compaction.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const cls = ast.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'Compactor') as ts.ClassDeclaration;
  assert.ok(cls);
  const begin = cls.getStart(ast), end = cls.end;
  const changes: { start: number; end: number; label: string; kind: string }[] = [];
  for (const member of cls.members) {
    const owner = member.name!.getText(ast);
    const visit = (node: ts.Node) => {
      if (ts.isTemplateExpression(node) || ts.isNewExpression(node) && node.expression.getText(ast) === 'Map') {
        changes.push({ start: node.getStart(ast) - begin, end: node.end - begin, label: owner, kind: ts.isTemplateExpression(node) ? 'template' : 'map' });
      }
      ts.forEachChild(node, visit);
    };
    visit(member);
  }
  let instrumented = source.slice(begin, end);
  for (const c of changes.sort((a, b) => b.start - a.start)) {
    instrumented = instrumented.slice(0, c.start) + `__allocated(${JSON.stringify(c.kind)}, ${JSON.stringify(c.label)}, ${instrumented.slice(c.start, c.end)})` + instrumented.slice(c.end);
  }
  let counts: Record<string, number> = {};
  const compiled = ts.transpileModule(`${instrumented}; return Compactor;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const C = new Function(...Object.keys(environment), '__allocated', compiled)(...Object.values(environment), (kind: string, label: string, value: any) => {
    const key = `${kind}:${label}`; counts[key] = (counts[key] ?? 0) + 1;
    if (kind === 'template') counts['templateCodeUnits'] = (counts['templateCodeUnits'] ?? 0) + value.length;
    return value;
  });
  return { sourceSha256: sha256(source), instrumentationSites: changes.length, run(snapshots: Record<string, any>) {
    counts = {}; const c = new C(), result: Record<string, any> = {};
    for (const [key, snapshot] of Object.entries(snapshots)) result[key] = c.snapshot(snapshot);
    return { counts, result, target: c.target as Arena };
  } };
}

const before = prepare(baselinePath), after = prepare(new URL('../compaction.ts', import.meta.url));
const fixtures: { name: string; snapshots: Record<string, any> }[] = [];
for (const size of [0, 1, 32, 4096]) {
  for (const type of ['number', 'boolean', 'string', 'object'] as const) {
    const a = new Arena(), values: any[] = Array.from({ length: size }, (_, i) => type === 'number' ? i : type === 'boolean' ? !!(i & 1) : type === 'string' ? `value${i}` : { i, nested: [i] });
    const list = new S.SharedList(type, 0, 0, 0, a).pushMany(values);
    fixtures.push({ name: `list-${type}-${size}`, snapshots: { list } });
    const map = new S.SharedMap(type, 0, 0, a).setMany(values.map((v, i) => [`key${i}`, v]));
    fixtures.push({ name: `map-${type}-${size}`, snapshots: { map } });
    if (size <= 32 || type === 'string') {
      let stack = new S.SharedStack(type, 0, 0, undefined, a), heap = new S.SharedPriorityQueue(type, undefined, a), ordered = new S.SharedOrderedMap(type, 0, 0, 0, 0, a);
      for (const [i, value] of values.entries()) { stack = stack.push(value); heap = heap.enqueue(value, i % 17); ordered = ordered.set(`key${i}`, value); }
      fixtures.push({ name: `nodes-${type}-${size}`, snapshots: { stack, heap, ordered } });
    }
  }
}
for (const count of [1, 32, 128]) {
  const snapshots: Record<string, any> = {};
  for (let i = 0; i < count; i++) {
    const a = new Arena();
    snapshots[`string${i}`] = new S.SharedList('string', 0, 0, 0, a).push('value');
    snapshots[`object${i}`] = new S.SharedList('object', 0, 0, 0, a).push({ i });
    snapshots[`map${i}`] = new S.SharedMap('string', 0, 0, a).set('key', 'value');
  }
  fixtures.push({ name: `tiny-three-kinds-${count}-arenas`, snapshots });
}
{
  const child = new S.SharedList('string', 0, 0, 0, new Arena()).pushMany(['first', '🙂'.repeat(40000)]);
  const list = new S.SharedList('SharedList<string>', 0, 0, 0, new Arena()).pushMany([child, child]);
  const map = new S.SharedMap('SharedList<string>', 0, 0, new Arena()).set('a', child).set('b', child);
  const data = S.getWorkerData({ child, list, map }, { copy: true });
  const first = await S.initWorker(data), second = await S.initWorker(data);
  fixtures.push({ name: 'nested-growth-attached-sessions', snapshots: { list: first.list, map: second.map, child: first.child, again: second.list } });
}
const results = fixtures.map(({ name, snapshots }) => {
  const baseline = before.run(snapshots), candidate = after.run(snapshots);
  for (const key of Object.keys(snapshots)) assert.deepEqual(candidate.result[key].toWorkerData(), baseline.result[key].toWorkerData(), name);
  assert.equal(candidate.target.used, baseline.target.used, `${name}: used bytes`);
  const bytes = candidate.target.buf.subarray(HEAP_START, candidate.target.used);
  assert.deepEqual(bytes, baseline.target.buf.subarray(HEAP_START, baseline.target.used), `${name}: all live and scratch payload bytes`);
  return { name, baseline: baseline.counts, candidate: candidate.counts, sharedBytes: bytes.length, payloadSha256: sha256(bytes) };
});
const metadata = ({ sourceSha256, instrumentationSites }: ReturnType<typeof prepare>) => ({ sourceSha256, instrumentationSites });
console.log(JSON.stringify({ schema: 1, runtime: process.versions, metric: 'executed template/Map allocation expressions, not heap/RSS', baseline: metadata(before), candidate: metadata(after), results }, null, 2));
