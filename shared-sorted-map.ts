import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetSortedMap(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedSortedMapType = import('./types').ValueType;
export type Comparator<K> = (a: K, b: K) => number;
export class SharedSortedMap<T extends string = SharedSortedMapType> extends Snapshot {
  readonly root: number;
  readonly size: number;
  readonly valueType: T;
  private readonly comparator?: Comparator<string>;
  constructor(type: T, comparator?: Comparator<string>, root = 0, _size = 0, source: Arena = current) {
    super(source); this.valueType = type; this.comparator = comparator; this.root = root; this.size = source.wasm.seqSize(root); Object.freeze(this);
  }
  set(key: string, value: ValueOf<T>): SharedSortedMap<T> {
    const a = arenaOf(this); a.assertWritable(); const leaf = a.leaf(this.valueType, key, value);
    return new SharedSortedMap(this.valueType, this.comparator, a.wasm.treeInsert(this.root, leaf) >>> 0, 0, a);
  }
  get(key: string): ValueOf<T> | undefined { const a = arenaOf(this), leaf = a.treeFind(this.root, key); return leaf ? a.leafValue(this.valueType, leaf) : undefined; }
  has(key: string): boolean { return arenaOf(this).treeFind(this.root, key) !== 0; }
  delete(key: string): SharedSortedMap<T> {
    const a = arenaOf(this); a.assertWritable(); const leaf = a.treeFind(this.root, key); if (!leaf) return this;
    return new SharedSortedMap(this.valueType, this.comparator, a.wasm.treeDelete(this.root, leaf) >>> 0, 0, a);
  }
  private *naturalEntries(): Generator<[string, ValueOf<T>]> { const a = arenaOf(this); for (const leaf of a.sequence(this.root)) yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf)]; }
  *entries(): Generator<[string, ValueOf<T>]> {
    if (this.comparator) yield* [...this.naturalEntries()].sort((a, b) => this.comparator!(a[0], b[0])); else yield* this.naturalEntries();
  }
  *keys(): Generator<string> { for (const [key] of this.entries()) yield key; }
  *values(): Generator<ValueOf<T>> { for (const [, value] of this.entries()) yield value; }
  forEach(fn: (value: ValueOf<T>, key: string) => void): void { for (const [key, value] of this.entries()) fn(value, key); }
  toWorkerData() {
    if (this.comparator) throw new Error('Custom comparator functions cannot be sent to workers');
    return Object.freeze({ root: this.root, size: this.size, valueType: this.valueType });
  }
  static fromWorkerData<T extends string>(d: { root: number; size: number; valueType: T }, source: Arena = current): SharedSortedMap<T> { return new SharedSortedMap(d.valueType, undefined, d.root, d.size, source); }
}
structureRegistry.SharedSortedMap = { fromWorkerData: (d, a) => SharedSortedMap.fromWorkerData(d, a) };
