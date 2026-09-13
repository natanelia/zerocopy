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
  constructor(type: T, root = 0, depth = 0, size = 0, source: Arena = current) {
    super(source); this.type = type; this.root = root; this.depth = depth; this.size = checkedSize(size); Object.freeze(this);
  }
  /** @deprecated Arena lifetime is managed by JavaScript reachability. */
  dispose(): void {}
  push(value: ValueOf<T>): SharedList<T> {
    const a = arenaOf(this); a.assertWritable(); const size = checkedSize(this.size + 1), depth = vectorDepth(size);
    const root = a.wasm.vecPush(this.root, this.depth, depth, this.size, a.encode(this.type, value)) >>> 0;
    return new SharedList(this.type, root, depth, size, a);
  }
  pushMany(values: readonly ValueOf<T>[]): SharedList<T> {
    if (!values.length) return this;
    const a = arenaOf(this), size = checkedSize(this.size + values.length);
    return new SharedList(this.type, a.append(this.type, this.root, this.depth, this.size, values), vectorDepth(size), size, a);
  }
  get(index: number): ValueOf<T> | undefined {
    if (!validIndex(index, this.size)) return undefined;
    const a = arenaOf(this); return a.decode(this.type, a.wasm.vecGet(this.root, this.depth, index));
  }
  set(index: number, value: ValueOf<T>): SharedList<T> {
    if (!validIndex(index, this.size)) return this;
    const a = arenaOf(this); a.assertWritable();
    return new SharedList(this.type, a.wasm.vecSet(this.root, this.depth, index, a.encode(this.type, value)) >>> 0, this.depth, this.size, a);
  }
  pop(): SharedList<T> {
    if (!this.size) return this;
    const a = arenaOf(this), size = this.size - 1; let root = this.root, depth = this.depth;
    if (!size) { root = 0; depth = 0; }
    else while (depth > vectorDepth(size)) { root = a.dv.getUint32(root, true); depth--; }
    return new SharedList(this.type, root, depth, size, a);
  }
  *values(): Generator<ValueOf<T>> { const a = arenaOf(this); for (const raw of a.vector(this.root, this.depth, 0, this.size)) yield a.decode(this.type, raw); }
  forEach(fn: (value: ValueOf<T>, index: number) => void): void { let i = 0; for (const value of this.values()) fn(value, i++); }
  toArray(): ValueOf<T>[] {
    const a = arenaOf(this), result = new Array<ValueOf<T>>(this.size);
    for (let first = 0; first < this.size; first += 32) {
      const leaf = a.wasm.vecLeaf(this.root, this.depth, first) >>> 0, stop = Math.min(this.size, first + 32), dv = a.dv;
      for (let i = first; i < stop; i++) result[i] = a.decode(this.type, dv.getFloat64(leaf + (i - first) * 8, true));
    }
    return result;
  }
  toWorkerData() { return Object.freeze({ root: this.root, depth: this.depth, size: this.size, type: this.type }); }
  static fromWorkerData<T extends string>(d: { root: number; depth: number; size: number; type: T }, source: Arena = current): SharedList<T> {
    return new SharedList(d.type, d.root, d.depth, d.size, source);
  }
}
structureRegistry.SharedList = { fromWorkerData: (d, a) => SharedList.fromWorkerData(d, a) };
