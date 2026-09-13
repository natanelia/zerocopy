import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetOrderedMap(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedOrderedMapType = import('./types').ValueType;
/** Two immutable indexes: key HAMT and insertion-order vector of leaf pointers. */
export class SharedOrderedMap<T extends string = SharedOrderedMapType> extends Snapshot {
  readonly root: number;
  readonly head: number;
  readonly tail: number;
  readonly size: number;
  readonly valueType: T;
  constructor(type: T, root = 0, head = 0, tail = 0, _size = 0, source: Arena = current) {
    super(source); this.valueType = type; this.root = root; this.head = head; this.tail = tail; this.size = source.wasm.mapSize(root); Object.freeze(this);
  }
  set(key: string, value: ValueOf<T>): SharedOrderedMap<T> {
    const a = arenaOf(this); a.assertWritable(); const previous = a.find(this.root, key);
    const ordinal = previous ? a.dv.getUint32(previous + 16 + a.dv.getUint32(previous + 8, true), true) : this.tail;
    const leaf = a.leaf(this.valueType, key, value, ordinal), root = a.wasm.mapInsert(this.root, leaf) >>> 0;
    const tail = previous ? this.tail : checkedSize(this.tail + 1);
    const head = previous ? a.wasm.vecSet(this.head, vectorDepth(this.tail), ordinal, leaf) >>> 0 : a.wasm.vecPush(this.head, vectorDepth(this.tail), vectorDepth(tail), this.tail, leaf) >>> 0;
    return new SharedOrderedMap(this.valueType, root, head, tail, 0, a);
  }
  get(key: string): ValueOf<T> | undefined { const a = arenaOf(this), leaf = a.find(this.root, key); return leaf ? a.leafValue(this.valueType, leaf, 4) : undefined; }
  has(key: string): boolean { return arenaOf(this).find(this.root, key) !== 0; }
  delete(key: string): SharedOrderedMap<T> {
    const a = arenaOf(this); a.assertWritable(); const leaf = a.find(this.root, key); if (!leaf) return this;
    const ordinal = a.dv.getUint32(leaf + 16 + a.dv.getUint32(leaf + 8, true), true);
    const root = a.delete(this.root, key), head = a.wasm.vecSet(this.head, vectorDepth(this.tail), ordinal, 0) >>> 0;
    return new SharedOrderedMap(this.valueType, root, head, this.tail, 0, a);
  }
  *entries(): Generator<[string, ValueOf<T>]> { const a = arenaOf(this); for (const leaf of a.vector(this.head, vectorDepth(this.tail), 0, this.tail)) if (leaf) yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf, 4)]; }
  *keys(): Generator<string> { for (const [key] of this.entries()) yield key; }
  *values(): Generator<ValueOf<T>> { for (const [, value] of this.entries()) yield value; }
  forEach(fn: (value: ValueOf<T>, key: string) => void): void { for (const [key, value] of this.entries()) fn(value, key); }
  toWorkerData() { return Object.freeze({ root: this.root, head: this.head, tail: this.tail, size: this.size, valueType: this.valueType }); }
  static fromWorkerData<T extends string>(d: { root: number; head: number; tail: number; size: number; valueType: T }, source: Arena = current): SharedOrderedMap<T> { return new SharedOrderedMap(d.valueType, d.root, d.head, d.tail, d.size, source); }
}
structureRegistry.SharedOrderedMap = { fromWorkerData: (d, a) => SharedOrderedMap.fromWorkerData(d, a) };
