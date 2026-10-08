// Untimed mechanism proof. Counts executed getter/refresh calls and allocation
// expressions, not retained heap, bytes allocated by the JS engine, or speed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Arena, popcount } from '../arena';
import { BASELINE, baselineSource, fixtures, methodSource, methods, withMethods } from './trie-view-fixtures';

const candidateSource = readFileSync(new URL('../arena.ts', import.meta.url), 'utf8');
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
// Pin the whole production file to the exact baseline plus these local edits.
// This also guards unchanged raw WASM methods, decode paths, control flow,
// allocation expressions, prototype shape and yields outside the capture edits.
let expectedSource = baselineSource;
for (const [before, after, count] of [
  ['if (root && this.dv.getUint32(root, true) === 0xffffffff) {', '// Published pointers stay within this view after shared-memory growth.\n    let dv!: DataView;\n    if (root && (dv = this.dv).getUint32(root, true) === 0xffffffff) {', 2],
  ['const pending: number[] = [], n = this.dv.getUint32(root + 12, true);', 'const pending: number[] = [], n = dv.getUint32(root + 12, true);', 1],
  ['pending.push(this.dv.getUint32(root + 16 + i * 4, true))', 'pending.push(dv.getUint32(root + 16 + i * 4, true))', 1],
  ['this.radixLeaves(this.dv.getUint32(root + 4, true))', 'this.radixLeaves(dv.getUint32(root + 4, true))', 1],
  ['const p = stack.pop()!, dv = this.dv;', 'const p = stack.pop()!;', 1],
  ['const n = this.dv.getUint32(root + 12, true), base = this.dv.getUint32(root + 4, true);', 'const n = dv.getUint32(root + 12, true), base = dv.getUint32(root + 4, true);', 1],
  ['yield this.dv.getUint32(root + 16 + i * 4, true)', 'yield dv.getUint32(root + 16 + i * 4, true)', 1],
  ['for (const leaf of this.leaves(base)) {\n        const dv = this.dv;', 'for (const leaf of this.leaves(base)) {', 1],
  ['const p = stack.pop()!, dv = this.dv, tag = dv.getUint32(p, true);', 'const p = stack.pop()!, tag = dv.getUint32(p, true);', 1],
] as const) {
  assert.equal(expectedSource.split(before).length - 1, count, `Exact source site: ${before}`);
  expectedSource = expectedSource.replaceAll(before, after);
}
assert.equal(candidateSource, expectedSource, 'only the prospectively described capture edits are allowed');
function instrument(source: string) {
  const zero = () => ({ dv: 0, refresh: 0, stack: 0, lanes: 0, patches: 0, pending: 0 });
  let counts = zero();
  const sites: { method: string; owner: string; expression: string }[] = [];
  const bodies = methods.map(name => {
    const { ast, method, text } = methodSource(source, name), start = method.getStart(ast);
    const changes: { start: number; end: number; owner: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isArrayLiteralExpression(node) || ts.isNewExpression(node) && node.expression.getText(ast) === 'Uint32Array') {
        const parent = node.parent;
        const owner = ts.isVariableDeclaration(parent) ? parent.name.getText(ast)
          : ts.isConditionalExpression(parent) && ts.isVariableDeclaration(parent.parent) ? parent.parent.name.getText(ast) : '';
        assert.ok(['stack', 'lanes', 'patches', 'pending'].includes(owner), `Unexpected allocation: ${owner}`);
        sites.push({ method: name, owner, expression: node.getText(ast) });
        changes.push({ start: node.getStart(ast) - start, end: node.end - start, owner });
      }
      ts.forEachChild(node, visit);
    };
    visit(method);
    let modified = text;
    for (const c of changes.sort((a, b) => b.start - a.start)) modified = modified.slice(0, c.start) + `allocated('${c.owner}', ${modified.slice(c.start, c.end)})` + modified.slice(c.end);
    return modified;
  });
  const compiled = ts.transpileModule(`class Traversal { ${bodies.join('\n')} }; return Traversal.prototype;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const impl = new Function('allocated', 'popcount', compiled)((owner: keyof ReturnType<typeof zero>, value: any) => { counts[owner]++; return value; }, popcount);
  const dv = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!, refresh = Arena.prototype.refresh;
  return {
    sourceSha256: sha256(source), sites,
    measure(a: Arena, root: number, name: typeof methods[number], mode: 'complete' | 'first' | 'return' | 'throw') {
      counts = zero();
      Object.defineProperty(a, 'dv', { configurable: true, get() { counts.dv++; return dv.call(this); } });
      Object.defineProperty(a, 'refresh', { configurable: true, value() { counts.refresh++; return refresh.call(this); } });
      try {
        return withMethods(a, impl, () => {
          const iterator = a[name](root);
          assert.deepEqual(counts, zero(), 'generator creation is lazy');
          let pointers: number[] = [];
          if (mode === 'complete') pointers = [...iterator];
          else if (mode === 'first') { const first = iterator.next(); if (!first.done) pointers.push(first.value); iterator.return(undefined); }
          else if (mode === 'return') iterator.return(undefined);
          else { const error = new Error('stop'); assert.throws(() => iterator.throw(error), e => e === error); }
          assert.equal(counts.dv, counts.refresh, 'exactly one refresh per dv getter');
          return { counts: { ...counts }, pointers };
        });
      } finally { delete (a as any).dv; delete (a as any).refresh; }
    },
  };
}
const before = instrument(baselineSource), after = instrument(candidateSource);
assert.deepEqual(after.sites, before.sites, 'all array allocation expressions and owners remain exact');
const results = [];
for (const fixture of fixtures()) {
  const { name, a, root, method } = fixture;
  for (const mode of ['complete', 'first', 'return', 'throw'] as const) {
    const used = a.used, sourceBytes = a.buf.slice(0, used);
    const baseline = before.measure(a, root, method, mode), candidate = after.measure(a, root, method, mode);
    assert.deepEqual(candidate.pointers, baseline.pointers, `${name}/${mode}: exact pointer order`);
    const allocations = ({ dv, refresh, ...rest }: typeof baseline.counts) => rest;
    assert.deepEqual(allocations(candidate.counts), allocations(baseline.counts), `${name}/${mode}: unchanged executed allocations`);
    assert.ok(candidate.counts.dv <= baseline.counts.dv);
    if (name.includes('-canonical-') && mode === 'complete') assert.equal(candidate.counts.dv, Number(root !== 0));
    assert.equal(a.used, used); assert.deepEqual(a.buf.subarray(0, used), sourceBytes);
    results.push({ name, mode, size: baseline.pointers.length, baseline: baseline.counts, candidate: candidate.counts, allocatedSharedBytes: a.used - used });
  }
}
console.log(JSON.stringify({ schema: 1, baselineCommit: BASELINE, runtime: process.versions,
  metric: 'executed calls and allocation expressions only; untimed; no heap or performance conclusion',
  baseline: { sourceSha256: before.sourceSha256, sites: before.sites }, candidate: { sourceSha256: after.sourceSha256, sites: after.sites }, results }, null, 2));
