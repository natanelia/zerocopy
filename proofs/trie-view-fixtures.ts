import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Arena, arenaOf, popcount } from '../arena';
import { SharedMap, SharedSortedMap } from '../shared';

export const BASELINE = '3773c6e519c7c0958da13727ed1082f449f3ee25';
// Exact generator method bytes from the pinned baseline above. Keeping this
// fixture local lets the semantic tests run in shallow checkouts and archives.
export const baselineSource = String.raw`class Arena {
*leaves(root: number): Generator<number> {
    // Each iterator owns its continuation. No shared stack or scratch survives yield.
    if (root && this.dv.getUint32(root, true) === 0xffffffff) {
      const n = this.dv.getUint32(root + 12, true), base = this.dv.getUint32(root + 4, true);
      for (let i = 0; i < n; i++) yield this.dv.getUint32(root + 16 + i * 4, true);
      for (const leaf of this.leaves(base)) {
        const dv = this.dv;
        if (!this.wasm.journalFind(root, leaf + 16, dv.getUint32(leaf + 8, true), dv.getUint32(leaf + 4, true))) yield leaf;
      }
      return;
    }
    const stack = root ? [root] : [];
    // These two small work arrays belong to this iterator, not shared memory.
    const lanes = new Uint32Array(16), patches: number[] = [];
    while (stack.length) {
      const p = stack.pop()!, dv = this.dv, tag = dv.getUint32(p, true);
      if (tag === 0) { yield p; continue; }
      if (tag & 0x80000000) {
        const bitmap = dv.getUint32(p + 8, true) >>> 16;
        patches.length = 0; let base = p;
        while (dv.getUint32(base, true) & 0x80000000) {
          patches.push(base); base = base - (dv.getUint32(base, true) & 16383) * 4;
        }
        const bits = dv.getUint32(base + 4, true); let offset = 0;
        for (let d = 0; d < 16; d++) if (bits & (1 << d)) lanes[d] = dv.getUint32(base + 8 + offset++ * 4, true);
        for (let i = patches.length - 1; i >= 0; i--) { const q = patches[i], t = dv.getUint32(q, true), distance = (t >>> 14) & 127;
          lanes[dv.getUint32(q + 4, true) & 15] = distance ? q - distance * 4 : 0; }
        for (let digit = 15; digit >= 0; digit--) if (bitmap & (1 << digit)) stack.push(lanes[digit]);
        continue;
      }
      const dense = (tag & 3) === 1;
      const count = dense ? popcount(dv.getUint32(p + 4, true)) : dv.getUint32(p + 8, true);
      for (let i = count - 1; i >= 0; i--) stack.push(dv.getUint32(p + (dense ? 8 : 16) + i * 4, true));
    }
  }
*radixLeaves(root: number): Generator<number> {
    if (root && this.dv.getUint32(root, true) === 0xffffffff) {
      const pending: number[] = [], n = this.dv.getUint32(root + 12, true);
      for (let i = 0; i < n; i++) pending.push(this.dv.getUint32(root + 16 + i * 4, true));
      pending.sort((a, b) => this.wasm.compareLeaves(a, b));
      let i = 0;
      for (const leaf of this.radixLeaves(this.dv.getUint32(root + 4, true))) {
        while (i < n && this.wasm.compareLeaves(pending[i], leaf) < 0) yield pending[i++];
        if (i < n && this.wasm.compareLeaves(pending[i], leaf) === 0) yield pending[i++]; else yield leaf;
      }
      while (i < n) yield pending[i++]; return;
    }
    const stack = root ? [root] : [];
    while (stack.length) {
      const p = stack.pop()!, dv = this.dv;
      if (!dv.getUint32(p, true)) yield p;
      else for (let i = popcount(dv.getUint32(p + 4, true)) - 1; i >= 0; i--) stack.push(dv.getUint32(p + 16 + i * 4, true));
    }
  }
}`;
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
const baselineMethodDigests = {
  "leaves": "8f8912ccc6d344d28207fd3fb01d5cd7ec6c85cd0658704e739cecd5d39f3365",
  "radixLeaves": "f5450c8eb333782ca090685d51bdaa5e08c5529b50694ab0a3eaa40253386c04"
};
for (const name of methods) {
  assert.equal(createHash('sha256').update(methodSource(baselineSource, name).text).digest('hex'),
    baselineMethodDigests[name], `Pinned baseline method changed: ${name}`);
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
