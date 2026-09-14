import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetSharedList(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedListType = import('./types').ValueType;
export function syncBuffer(): void { current.refresh(); }
export class SharedList<T extends string = SharedListType> extends Snapshot {
  readonly root: number;
  readonly type: T;
  readonly size: number;
  readonly depth: number;
  readonly tail: number;
  constructor(type: T, root = 0, depth = 0, size = 0, source: Arena = current, tail = 0) {
    super(source); this.type = type; this.root = root; this.depth = depth; this.size = checkedSize(size); this.tail = tail; Object.freeze(this);
  }
  /** @deprecated Arena lifetime is managed by JavaScript reachability. */
  dispose(): void {}
  push(value: ValueOf<T>): SharedList<T> {
    const a = this.arena, raw = a.encode(this.type, value), size = checkedSize(this.size + 1);
    const length = this.size ? ((this.size - 1) & 31) + 1 : 0;
    if (length < 32) return new SharedList(this.type, this.root, this.depth, size, a, a.wasm.tailAppend(this.tail, length, raw) >>> 0);
    const depth = vectorDepth(this.size);
    const root = a.wasm.vecLink(this.root, this.depth, depth, this.size - 32, this.tail, 32) >>> 0;
    return new SharedList(this.type, root, depth, size, a, a.wasm.tailAppend(0, 0, raw) >>> 0);
  }
  pushMany(values: readonly ValueOf<T>[]): SharedList<T> {
    if (!values.length) return this;
    const a = this.arena; a.assertWritable();
    const size = checkedSize(this.size + values.length);
    const oldLength = this.size ? ((this.size - 1) & 31) + 1 : 0;
    // Encode first. User serialization may reenter the owning arena.
    const input = a.encodeRange(this.type, values, this.tail, oldLength);
    const length = ((size - 1) & 31) + 1, treeSize = size - length;
    const depth = vectorDepth(treeSize), start = this.size - oldLength;
    const root = a.wasm.vecLink(this.root, this.depth, depth, start, input, treeSize - start) >>> 0;
    return new SharedList(this.type, root, depth, size, a, input + (treeSize - start) * 8);
  }
  get(index: number): ValueOf<T> | undefined {
    if (!validIndex(index, this.size)) return undefined;
    const a = this.arena, start = (this.size - 1) & ~31;
    const raw = index >= start ? a.dv.getFloat64(this.tail + (index - start) * 8, true) : a.vectorValue(this.root, this.depth, index);
    return this.type === 'number' ? raw as ValueOf<T> : a.decode(this.type, raw);
  }
  set(index: number, value: ValueOf<T>): SharedList<T> {
    if (!validIndex(index, this.size)) return this;
    const a = this.arena, raw = a.encode(this.type, value), start = (this.size - 1) & ~31;
    if (index >= start) return new SharedList(this.type, this.root, this.depth, this.size, a, a.wasm.tailSet(this.tail, this.size - start, index - start, raw) >>> 0);
    return new SharedList(this.type, a.wasm.vecSet(this.root, this.depth, index, raw) >>> 0, this.depth, this.size, a, this.tail);
  }
  pop(): SharedList<T> {
    if (!this.size) return this;
    const a = this.arena, size = this.size - 1;
    if (!size) return new SharedList(this.type, 0, 0, 0, a);
    if ((this.size - 1) & 31) return new SharedList(this.type, this.root, this.depth, size, a, this.tail);
    const tail = a.wasm.vecLeaf(this.root, this.depth, size - 32) >>> 0;
    const depth = vectorDepth(size - 32); let root = this.root, oldDepth = this.depth;
    if (size === 32) root = 0;
    else while (oldDepth-- > depth) root = a.dv.getUint32(root, true);
    return new SharedList(this.type, root, depth, size, a, tail);
  }
  *values(): Generator<ValueOf<T>> {
    if (!this.size) return;
    const a = this.arena, start = (this.size - 1) & ~31;
    for (const raw of a.vector(this.root, this.depth, 0, start)) yield a.decode(this.type, raw);
    for (let i = 0; i < this.size - start; i++) yield a.decode(this.type, a.dv.getFloat64(this.tail + i * 8, true));
  }
  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    const a = this.arena, start = this.size ? (this.size - 1) & ~31 : 0;
    for (let first = 0; first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const stop = Math.min(this.size, first + 32), view = a.dv;
      // Shared views remain valid if the callback grows memory or creates forks.
      for (let i = first; i < stop; i++) fn(a.decode(this.type, view.getFloat64(leaf + (i - first) * 8, true)), i);
    }
  }
  toArray(): ValueOf<T>[] {
    const a = this.arena, result = new Array<ValueOf<T>>(this.size);
    const start = this.size ? (this.size - 1) & ~31 : 0;
    for (let first = 0; first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const stop = Math.min(this.size, first + 32), dv = a.dv;
      for (let i = first; i < stop; i++) result[i] = a.decode(this.type, dv.getFloat64(leaf + (i - first) * 8, true));
    }
    return result;
  }
  toWorkerData() { return Object.freeze({ root: this.root, depth: this.depth, size: this.size, type: this.type, tail: this.tail }); }
  static fromWorkerData<T extends string>(d: { root: number; depth: number; size: number; type: T; tail: number }, source: Arena = current): SharedList<T> {
    return new SharedList(d.type, d.root, d.depth, d.size, source, d.tail);
  }
}
structureRegistry.SharedList = { fromWorkerData: (d, a) => SharedList.fromWorkerData(d, a) };
