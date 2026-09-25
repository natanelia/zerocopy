import { Arena, Snapshot, arenaOf, vectorDepth } from './arena';
import { parseNestedType } from './types';
import { structureRegistry } from './codec';
import { SharedMap } from './shared-map';
import { SharedList } from './shared-list';
import { SharedSet } from './shared-set';
import { SharedStack } from './shared-stack';
import { SharedQueue } from './shared-queue';
import { SharedLinkedList } from './shared-linked-list';
import { SharedDoublyLinkedList } from './shared-doubly-linked-list';
import { SharedOrderedMap } from './shared-ordered-map';
import { SharedOrderedSet } from './shared-ordered-set';
import { SharedSortedMap } from './shared-sorted-map';
import { SharedSortedSet } from './shared-sorted-set';
import { SharedPriorityQueue } from './shared-priority-queue';

const classes = { SharedMap, SharedList, SharedSet, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue };
const classEntries = Object.entries(classes);
export type Compactable = InstanceType<(typeof classes)[keyof typeof classes]>;

/** Rebuild selected live data in one fresh arena. Never reset or edit a source.
 * Old arenas become reclaimable only when all their holders release them.
 * Raw JSON/string bytes are copied without parsing; nested snapshots are rebuilt.
 */
class Compactor {
  readonly target = new Arena();
  private readonly snapshots = new Map<string, Compactable>();
  private readonly pointers = new Map<string, number>();
  private key(a: Arena, kind: string, p: number): string { return `${a.id}:${kind}:${p}`; }
  private bytes(a: Arena, start: number, length: number): number {
    const p = this.target.alloc(length); this.target.buf.set(a.buf.subarray(start, start + length), p); return p;
  }
  private raw(a: Arena, type: string, raw: number): number {
    if (type === 'number' || type === 'boolean') return raw;
    const key = this.key(a, type, raw), saved = this.pointers.get(key);
    if (saved !== undefined) return saved;
    const p = parseNestedType(type)
      ? this.target.encode(type, this.snapshot(a.decode(type, raw)))
      : this.bytes(a, raw, 4 + a.dv.getUint32(raw, true));
    this.pointers.set(key, p); return p;
  }
  private leaf(a: Arena, type: string, leaf: number, prefix = 0, ordinal = -1): number {
    const key = this.key(a, `${type}/${prefix}/${ordinal}`, leaf), saved = this.pointers.get(key);
    if (saved !== undefined) return saved;
    const dv = a.dv, keyLen = dv.getUint32(leaf + 8, true), length = dv.getUint32(leaf + 12, true);
    let value: Uint8Array;
    if (parseNestedType(type)) {
      const child = a.decodeAt(type, leaf + 16 + keyLen + prefix, length - prefix);
      value = this.target.prepare(type, this.snapshot(child));
    } else value = a.buf.subarray(leaf + 16 + keyLen + prefix, leaf + 16 + keyLen + length);
    const p = this.target.wasm.mapLeaf(keyLen, value.length + prefix) >>> 0;
    this.target.dv.setUint32(p + 4, dv.getUint32(leaf + 4, true), true);
    this.target.buf.set(a.buf.subarray(leaf + 16, leaf + 16 + keyLen), p + 16);
    if (prefix) this.target.dv.setUint32(p + 16 + keyLen, ordinal, true);
    this.target.buf.set(value, p + 16 + keyLen + prefix);
    this.pointers.set(key, p); return p;
  }
  private index(leaves: number[], sorted: boolean): number {
    if (!leaves.length) return 0;
    const input = this.target.alloc(leaves.length * 4), dv = this.target.dv;
    for (let i = 0; i < leaves.length; i++) dv.setUint32(input + i * 4, leaves[i], true);
    return (sorted ? this.target.wasm.radixBuild(input, leaves.length) : this.target.wasm.mapBatch(0, input, leaves.length)) >>> 0;
  }
  private vector(a: Arena, d: any, type: string, sequence: boolean, queue: boolean): { input: number; size: number } {
    const size = d.size;
    // Place blobs before the final contiguous values. Nested compaction may grow
    // memory, so reacquire the view after it returns.
    const values: number[] = [];
    if (sequence) {
      for (const value of a.blocks(d.head)) values.push(this.raw(a, type, value));
      for (let i = 0; i < d.tailSize; i++) values.push(this.raw(a, type, a.dv.getFloat64(d.tail + i * 8, true)));
    } else {
      const total = size + (queue ? d.tail : 0), tailLen = total ? ((total - 1) & 31) + 1 : 0, prefix = total - tailLen;
      const root = queue ? d.head : d.root, tail = queue ? d.block : d.tail;
      for (let i = queue ? d.tail : 0; i < total; i++) {
        const raw = i >= prefix ? a.dv.getFloat64(tail + (i - prefix) * 8, true) : a.wasm.vecGet(root, d.depth, i);
        values.push(this.raw(a, type, raw));
      }
    }
    if (values.length !== size) throw new Error('Invalid sequence descriptor');
    const input = size ? this.target.alloc(size * 8) : 0, dv = this.target.dv;
    for (let i = 0; i < size; i++) dv.setFloat64(input + i * 8, values[i], true);
    return { input, size };
  }
  private heap(a: Arena, type: string, root: number): number {
    if (!root) return 0;
    // Explicit postorder traversal also handles a long left spine.
    const todo: [number, boolean][] = [[root, false]];
    while (todo.length) {
      const [old, ready] = todo.pop()!, key = this.key(a, `heap/${type}`, old);
      if (!old || this.pointers.has(key)) continue;
      const left = a.dv.getUint32(old + 16, true), right = a.dv.getUint32(old + 20, true);
      if (!ready) { todo.push([old, true], [right, false], [left, false]); continue; }
      const value = this.raw(a, type, a.dv.getFloat64(old + 8, true)), p = this.bytes(a, old, 32);
      this.target.dv.setFloat64(p + 8, value, true);
      this.target.dv.setUint32(p + 16, left ? this.pointers.get(this.key(a, `heap/${type}`, left))! : 0, true);
      this.target.dv.setUint32(p + 20, right ? this.pointers.get(this.key(a, `heap/${type}`, right))! : 0, true);
      this.pointers.set(key, p);
    }
    return this.pointers.get(this.key(a, `heap/${type}`, root))!;
  }
  snapshot<T extends Compactable>(source: T): T {
    if (!(source instanceof Snapshot)) throw new TypeError('Expected an immutable shared collection');
    const kind = classEntries.find(([, C]) => source instanceof C)?.[0];
    if (!kind) throw new TypeError('Unsupported shared collection');
    const a = arenaOf(source);
    // Preserve a local pure comparator. It cannot be serialized to workers.
    const localSorted = source instanceof SharedSortedMap ? source : source instanceof SharedSortedSet ? (source as any)._map as SharedSortedMap<any> : undefined;
    const comparator = (localSorted as any)?.comparator;
    const d: any = comparator ? { root: localSorted!.root, size: localSorted!.size, valueType: localSorted!.valueType } : source.toWorkerData();
    const identity = `${a.id}/${kind}/${JSON.stringify(d)}`;
    const saved = comparator ? undefined : this.snapshots.get(identity);
    if (saved) return saved as T;
    const type = d.valueType ?? d.type ?? 'number';
    let next: any;
    if (kind === 'SharedMap' || kind === 'SharedSet' || kind === 'SharedSortedMap' || kind === 'SharedSortedSet') {
      const sorted = kind === 'SharedSortedMap' || kind === 'SharedSortedSet', leaves: number[] = [];
      for (const leaf of sorted ? a.radixLeaves(d.root) : a.leaves(d.root)) leaves.push(this.leaf(a, type, leaf));
      next = { ...d, root: this.index(leaves, sorted), size: leaves.length };
    } else if (kind === 'SharedOrderedMap' || kind === 'SharedOrderedSet') {
      const order: number[] = [], leaves: number[] = []; let p = d.head, head = 0;
      while (p) { order.push(a.dv.getUint32(p + 4, true)); p = a.dv.getUint32(p, true); }
      for (let i = order.length - 1; i >= 0; i--) {
        const old = order[i], n = a.dv.getUint32(old + 8, true), leaf = a.wasm.mapFind(d.root, old + 16, n, a.dv.getUint32(old + 4, true)) >>> 0;
        if (!leaf || a.dv.getUint32(leaf + 16 + n, true) !== a.dv.getUint32(old + 16 + n, true)) continue;
        const copied = this.leaf(a, type, leaf, 4, leaves.length); leaves.push(copied); head = this.target.wasm.orderCons(head, copied) >>> 0;
      }
      next = { ...d, root: this.index(leaves, false), head, tail: leaves.length, size: leaves.length, orderStable: true };
    } else if (kind === 'SharedStack') {
      const nodes: number[] = []; let old = d.head, head = 0;
      while (old) {
        const saved = this.pointers.get(this.key(a, `stack/${type}`, old));
        if (saved !== undefined) { head = saved; break; }
        nodes.push(old); old = a.dv.getUint32(old, true);
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        const old = nodes[i], value = this.raw(a, type, a.dv.getFloat64(old + 8, true));
        head = this.target.wasm.cons(head, value) >>> 0; this.pointers.set(this.key(a, `stack/${type}`, old), head);
      }
      next = { ...d, head };
    } else if (kind === 'SharedPriorityQueue') next = { ...d, root: this.heap(a, type, d.root) };
    else {
      const sequence = kind === 'SharedLinkedList' || kind === 'SharedDoublyLinkedList', queue = kind === 'SharedQueue';
      const { input, size } = this.vector(a, d, type, sequence, queue), tailSize = size ? ((size - 1) & 31) + 1 : 0;
      const prefix = size - tailSize, tail = size ? input + prefix * 8 : 0;
      if (sequence) next = { ...d, head: this.target.wasm.blockBuild(input, prefix / 32) >>> 0, tail, tailSize };
      else {
        const depth = vectorDepth(prefix), root = prefix ? this.target.wasm.vecLink(0, 0, depth, 0, input, prefix) >>> 0 : 0;
        next = queue ? { ...d, head: root, tail: 0, block: tail, depth } : { ...d, root, depth, tail };
      }
    }
    const result = comparator ? (kind === 'SharedSortedSet' ? new SharedSortedSet((source as any).comparator, new SharedSortedMap(type, comparator, next.root, next.size, this.target)) : new SharedSortedMap(type, comparator, next.root, next.size, this.target)) : structureRegistry[kind].fromWorkerData(next, this.target);
    if (!comparator) this.snapshots.set(identity, result); return result as T;
  }
}

/** Copy one snapshot's live data into a fresh writable arena. */
export function compact<T extends Compactable>(snapshot: T): T { return new Compactor().snapshot(snapshot); }

/** Compact a group together, retaining shared live blobs and nested snapshots. */
export function compactMany<T extends Record<keyof T, Compactable> & Record<Extract<keyof T, symbol>, never>>(snapshots: T): Readonly<T> {
  if (Object.getOwnPropertySymbols(snapshots).length) throw new TypeError('Snapshot names must be strings');
  const compactor = new Compactor(), result: Record<string, Compactable> = Object.create(null);
  for (const [name, snapshot] of Object.entries(snapshots) as [string, Compactable][]) result[name] = compactor.snapshot(snapshot);
  return Object.freeze(result) as Readonly<T>;
}
