// Untimed mechanism proof. Counts executed getter/refresh calls and allocation
// expressions, not retained heap, bytes allocated by the JS engine, or speed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Arena, popcount } from '../arena';
import { BASELINE, baselineSource, fixtures, methodSource, methods, withMethods } from './trie-view-fixtures';

const candidateSource = readFileSync(new URL('../arena.ts', import.meta.url), 'utf8');
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
// This narrowing must use the exact held radix method and exact main everywhere
// else. In particular HAMT leaves, its scratch, and every loop remain unchanged.
const COMBINED = '47402ad2ec2ac7226831a577e6e224c555710af8';
const combinedSource = execFileSync('git', ['show', `${COMBINED}:arena.ts`], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8',
});
const oldRadix = methodSource(baselineSource, 'radixLeaves').text;
const heldRadix = methodSource(combinedSource, 'radixLeaves').text;
assert.equal(baselineSource.split(oldRadix).length - 1, 1);
assert.equal(candidateSource, baselineSource.replace(oldRadix, heldRadix),
  'only the exact held radixLeaves method may replace pinned main');
assert.equal(methodSource(candidateSource, 'leaves').text, methodSource(baselineSource, 'leaves').text,
  'HAMT is an unchanged control');
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
    if (method === 'leaves') assert.deepEqual(candidate.counts, baseline.counts, `${name}/${mode}: unchanged HAMT control`);
    else {
      assert.ok(candidate.counts.dv <= baseline.counts.dv);
      if (name.includes('-canonical-') && mode === 'complete') assert.equal(candidate.counts.dv, Number(root !== 0));
      if (mode === 'complete') {
        let calls = 0, p = root;
        while (p) { calls++; if (a.dv.getUint32(p, true) !== 0xffffffff) break; p = a.dv.getUint32(p + 4, true); }
        assert.equal(candidate.counts.dv, calls, `${name}: one capture per nonempty recursive invocation`);
      }
    }
    assert.equal(a.used, used); assert.deepEqual(a.buf.subarray(0, used), sourceBytes);
    results.push({ name, role: method === 'leaves' ? 'unchanged HAMT control' : 'radix capture', mode, size: baseline.pointers.length, baseline: baseline.counts, candidate: candidate.counts, allocatedSharedBytes: a.used - used });
  }
}
console.log(JSON.stringify({ schema: 1, baselineCommit: BASELINE, combinedCommit: COMBINED, scope: 'radix-only', runtime: process.versions,
  metric: 'executed calls and allocation expressions only; untimed; no heap or performance conclusion',
  baseline: { sourceSha256: before.sourceSha256, sites: before.sites }, candidate: { sourceSha256: after.sourceSha256, sites: after.sites }, results }, null, 2));
