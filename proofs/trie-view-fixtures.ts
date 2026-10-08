import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { Arena, arenaOf, popcount } from '../arena';
import { SharedMap, SharedSortedMap } from '../shared';

export const BASELINE = '3773c6e519c7c0958da13727ed1082f449f3ee25';
export const baselineSource = execFileSync('git', ['show', `${BASELINE}:arena.ts`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
export const methods = ['leaves', 'radixLeaves'] as const;
export type Method = typeof methods[number];
export function methodSource(source: string, name: Method) {
  const ast = ts.createSourceFile('arena.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const arena = ast.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'Arena') as ts.ClassDeclaration;
  const method = arena.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === name) as ts.MethodDeclaration;
  assert.ok(method.asteriskToken);
  return { ast, method, text: source.slice(method.getStart(ast), method.end) };
}
export function compileMethods(source: string) {
  const body = methods.map(name => methodSource(source, name).text).join('\n');
  return new Function('popcount', ts.transpileModule(`class Traversal { ${body} }; return Traversal.prototype;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(popcount) as Pick<Arena, Method>;
}
export const baselineMethods = compileMethods(baselineSource);
export function withMethods<T>(a: Arena, impl: Pick<Arena, Method>, run: () => T): T {
  const saved = methods.map(name => Object.getOwnPropertyDescriptor(a, name));
  methods.forEach(name => Object.defineProperty(a, name, { value: impl[name], configurable: true, writable: true }));
  try { return run(); } finally {
    methods.forEach((name, i) => saved[i] ? Object.defineProperty(a, name, saved[i]!) : delete (a as any)[name]);
  }
}
export function baselineLeaves(a: Arena, root: number, method: Method): number[] {
  return withMethods(a, baselineMethods, () => [...a[method](root)]);
}
export function mapOf(size: number, sorted = false) {
  if (!sorted) return new SharedMap('number', 0, 0, new Arena()).setMany(Array.from({ length: size }, (_, i) => [`key${i}`, i] as const));
  let map = new SharedSortedMap('number', undefined, 0, 0, new Arena());
  for (let i = 0; i < size; i++) map = map.set(`key${i}`, i);
  // A public deletion materializes any pending journal, yielding a canonical radix root.
  return size > 1 ? map.set('\0flush', -1).delete('\0flush') : map;
}
function childAt(a: Arena, p: number, digit: number): number {
  const dv = a.dv;
  while (dv.getUint32(p, true) & 0x80000000) {
    const tag = dv.getUint32(p, true);
    if ((dv.getUint32(p + 4, true) & 15) === digit) {
      const distance = (tag >>> 14) & 127; return distance ? p - distance * 4 : 0;
    }
    p -= (tag & 16383) * 4;
  }
  const bits = dv.getUint32(p + 4, true), bit = 1 << digit;
  return bits & bit ? dv.getUint32(p + 8 + popcount(bits & (bit - 1)) * 4, true) : 0;
}
const encoder = new TextEncoder();
export function utf8Compare(a: string, b: string): number {
  const x = encoder.encode(a), y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
// Independent recursive oracle: resolve HAMT edits newest-first per child;
// radix journals use decoded-key filtering and independent UTF-8 ordering.
export function reference(a: Arena, root: number, method: Method): number[] {
  if (!root) return [];
  const dv = a.dv, tag = dv.getUint32(root, true);
  if (!tag) return [root];
  if (tag === 0xffffffff) {
    const edits = Array.from({ length: dv.getUint32(root + 12, true) }, (_, i) => dv.getUint32(root + 16 + i * 4, true));
    const keys = new Set(edits.map(p => a.leafKey(p)));
    const result = edits.concat(reference(a, dv.getUint32(root + 4, true), method).filter(p => !keys.has(a.leafKey(p))));
    return method === 'leaves' ? result : result.sort((x, y) => utf8Compare(a.leafKey(x), a.leafKey(y)));
  }
  if (method === 'radixLeaves' || tag === 2) {
    const n = method === 'radixLeaves' ? popcount(dv.getUint32(root + 4, true)) : dv.getUint32(root + 8, true);
    return Array.from({ length: n }, (_, i) => dv.getUint32(root + 16 + 4 * i, true)).flatMap(p => reference(a, p, method));
  }
  const bits = tag & 0x80000000 ? dv.getUint32(root + 8, true) >>> 16 : dv.getUint32(root + 4, true);
  const result: number[] = [];
  for (let d = 0; d < 16; d++) if (bits & (1 << d)) result.push(...reference(a, childAt(a, root, d), method));
  return result;
}
export function journal(a: Arena, base: number, edits: readonly (readonly [string, number])[], method: Method): number {
  const leaves = edits.map(([key, value]) => a.leaf('number', key, value));
  const root = a.alloc(16 + 4 * leaves.length), dv = a.dv;
  dv.setUint32(root, 0xffffffff, true); dv.setUint32(root + 4, base, true);
  const keys = new Set(reference(a, base, method).map(p => a.leafKey(p)));
  edits.forEach(([key]) => keys.add(key));
  dv.setUint32(root + 8, keys.size, true); dv.setUint32(root + 12, leaves.length, true);
  leaves.forEach((p, i) => dv.setUint32(root + 16 + i * 4, p, true));
  return root;
}
export function fixtures() {
  const result: { name: string; a: Arena; root: number; method: Method }[] = [];
  for (const method of methods) {
    for (const size of [0, 1, 32, 4096]) {
      const map = mapOf(size, method === 'radixLeaves'), a = arenaOf(map);
      result.push({ name: `${method}-canonical-${size}`, a, root: map.root, method });
      if (size) {
        const changed = map.set('key0', -1).delete('key7').set('🙂', 17);
        result.push({ name: `${method}-edited-${size}`, a, root: changed.root, method });
      }
      const root = journal(a, map.root, [['costarring', 3], ['new', 4], ['key0', 5]], method);
      result.push({ name: `${method}-journal-${size}`, a, root, method });
      const nested = journal(a, root, [['new', 44], ['é', 8]], method);
      result.push({ name: `${method}-nested-journal-${size}`, a, root: nested, method });
    }
  }
  const collision = new SharedMap('number', 0, 0, new Arena()).setMany([['costarring', 1], ['liquid', 2]]), a = arenaOf(collision);
  assert.equal(a.dv.getUint32(collision.root, true), 2);
  result.push({ name: 'leaves-collision-2', a, root: collision.root, method: 'leaves' });
  const overlay = mapOf(512);
  let patched = overlay;
  for (let i = 0; i < 47; i++) patched = patched.set(`key${i * 7}`, -i - 1);
  const p = arenaOf(patched);
  assert.ok(p.dv.getUint32(patched.root, true) & 0x80000000);
  result.push({ name: 'leaves-overlay-512', a: p, root: patched.root, method: 'leaves' });
  return result;
}
