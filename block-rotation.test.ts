import { describe, expect, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedLinkedList, SharedDoublyLinkedList, compact, getWorkerData, initWorker } from './shared';

function payload(a: Arena, length: number, first: number): number {
  const p = a.alloc(length * 8);
  for (let i = 0; i < length; i++) a.dv.setFloat64(p + i * 8, first + i, true);
  return p;
}
function inspect(a: Arena, root: number) {
  const nodes = new Set<number>(), values: number[] = [];
  function visit(p: number): [number, number] {
    if (!p) return [0, 0];
    expect(nodes.has(p)).toBe(false); nodes.add(p);
    expect(p % 8).toBe(0); expect(p).toBeGreaterThanOrEqual(HEAP_START); expect(p + 24).toBeLessThanOrEqual(a.used);
    const d = a.dv, left = d.getUint32(p, true), right = d.getUint32(p + 4, true);
    const data = d.getUint32(p + 16, true), length = d.getUint32(p + 20, true);
    expect(length).toBeGreaterThan(0); expect(length).toBeLessThanOrEqual(32);
    expect(data + length * 8).toBeLessThanOrEqual(a.used);
    const [ls, lh] = visit(left);
    for (let i = 0; i < length; i++) values.push(d.getFloat64(data + i * 8, true));
    const [rs, rh] = visit(right);
    expect(Math.abs(lh - rh)).toBeLessThanOrEqual(1);
    expect(d.getUint32(p + 8, true)).toBe(ls + length + rs);
    expect(d.getUint32(p + 12, true)).toBe(Math.max(lh, rh) + 1);
    return [ls + length + rs, Math.max(lh, rh) + 1];
  }
  visit(root); return { nodes, values };
}
function pair(a: Arena) {
  const first = a.wasm.blockAppend(0, payload(a, 32, 0), 32) >>> 0;
  return a.wasm.blockAppend(first, payload(a, 32, 32), 32) >>> 0;
}
function prefix(a: Arena) { return a.buf.slice(0, a.used); }
function unchanged(a: Arena, before: Uint8Array) {
  expect(Buffer.compare(Buffer.from(a.buf.subarray(0, before.length)), Buffer.from(before))).toBe(0);
}

describe('block rotations only reuse unpublished nodes from the current call', () => {
  it('retains every new node in a single append rotation', () => {
    const a = new Arena(), root = pair(a), data = payload(a, 32, 64), before = prefix(a), start = a.used;
    const next = a.wasm.blockAppend(root, data, 32) >>> 0, result = inspect(a, next);
    expect(result.values).toEqual(Array.from({ length: 96 }, (_, i) => i));
    expect(a.used - start).toBe(3 * 24);
    for (let p = start; p < a.used; p += 24) expect(result.nodes.has(p)).toBe(true);
    unchanged(a, before); expect(inspect(a, root).values).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  it('retains both consumed nodes in a double insertion rotation', () => {
    const a = new Arena(), root = pair(a), before = prefix(a), start = a.used;
    const next = a.wasm.blockInsert(root, 0, -1) >>> 0, result = inspect(a, next);
    expect(result.values).toEqual(Array.from({ length: 65 }, (_, i) => i - 1));
    expect(a.used - start).toBe(33 * 8 + 3 * 24);
    for (let p = start + 33 * 8; p < a.used; p += 24) expect(result.nodes.has(p)).toBe(true);
    unchanged(a, before); expect(inspect(a, root).values).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  it('protects all earlier calls and forked roots through left and right insertions', () => {
    const a = new Arena(), roots = [pair(a)], models = [Array.from({ length: 64 }, (_, i) => i)];
    for (let i = 0; i < 160; i++) {
      const parent = i % 5 === 0 ? Math.floor(i / 3) : roots.length - 1;
      const model = [...models[parent]], index = [0, model.length, Math.floor(model.length / 2)][i % 3];
      const before = prefix(a), next = a.wasm.blockInsert(roots[parent], index, -i - 1) >>> 0;
      model.splice(index, 0, -i - 1); roots.push(next); models.push(model); unchanged(a, before);
      expect(inspect(a, next).values).toEqual(model);
    }
    for (let i = 0; i < roots.length; i++) expect(inspect(a, roots[i]).values).toEqual(models[i]);
  });

  it('preserves a four-byte-aligned frontier while allocating aligned block nodes', () => {
    const a = new Arena(), root = pair(a), data = payload(a, 32, 64);
    a.wasm.mapLeaf(1, 0); expect(a.used % 8).toBe(4);
    const before = prefix(a), next = a.wasm.blockAppend(root, data, 32) >>> 0;
    unchanged(a, before); expect(inspect(a, next).values).toEqual(Array.from({ length: 96 }, (_, i) => i));
  });

  for (const insertion of [false, true]) it(`keeps the old prefix after allocation failure (${insertion ? 'insert' : 'append'})`, () => {
    const a = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }) });
    const root = pair(a), data = payload(a, 32, 64), budget = insertion ? 33 * 8 + 24 : 48;
    a.alloc(a.memory.buffer.byteLength - a.used - budget);
    const before = prefix(a);
    expect(() => insertion ? a.wasm.blockInsert(root, 0, -1) : a.wasm.blockAppend(root, data, 32)).toThrow();
    unchanged(a, before); expect(inspect(a, root).values).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  for (const C of [SharedLinkedList, SharedDoublyLinkedList] as const) for (const copy of [false, true]) {
    it(`${C.name} preserves shared/copy readers across rotations, growth and compaction (copy=${copy})`, async () => {
      const a = new Arena(); let list: any = new C('number', 0, 0, 0, a);
      for (let i = 0; i < 96; i++) list = list.append(i);
      const old = list, oldValues = old.toArray(), before = prefix(a);
      const reader = (await initWorker<{ list: SharedLinkedList<'number'> }>(getWorkerData({ list: old }, { copy }))).list;
      list = list.prepend(-1).insertAfter(33, -2);
      a.alloc(a.memory.buffer.byteLength);
      for (let i = 96; i < 256; i++) list = list.append(i);
      unchanged(a, before); expect(old.toArray()).toEqual(oldValues); expect(reader.toArray()).toEqual(oldValues);
      const nextReader = (await initWorker<{ list: SharedLinkedList<'number'> }>(getWorkerData({ list }, { copy }))).list;
      expect(nextReader.toArray()).toEqual(list.toArray()); expect(compact(list).toArray()).toEqual(list.toArray());
      expect(() => reader.append(999)).toThrow(/read-only/);
    });
  }
});
