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
/** Key HAMT and immutable insertion log. No copied vector path on each write. */
export class SharedOrderedMap<T extends string = SharedOrderedMapType> extends Snapshot {
  readonly root: number;
  readonly head: number;
  readonly tail: number;
  readonly size: number;
  readonly valueType: T;
  readonly orderStable: boolean;
  constructor(type: T, root = 0, head = 0, tail = 0, _size: number | undefined = undefined, source: Arena = current, orderStable = root === 0 && head === 0) {
    super(source); this.valueType = type; this.root = root; this.head = head; this.tail = tail; this.size = _size ?? source.wasm.mapSize(root); this.orderStable = orderStable; Object.freeze(this);
  }
  set(key: string, value: ValueOf<T>): SharedOrderedMap<T> {
    const a = arenaOf(this); checkedSize(this.tail + 1);
    const root = (this.valueType === 'number' ? a.writeNumber(this.root, key, value as number, 1, this.head, this.tail) : a.write(this.valueType, this.root, key, value, 1, this.head, this.tail));
    return new SharedOrderedMap(this.valueType, root, a.writeHead, a.writeCount, a.writeSize, a, this.orderStable && a.writeSize > this.size);
  }
  get(key: string): ValueOf<T> | undefined { const a = arenaOf(this), leaf = a.find(this.root, key); return leaf ? a.leafValue(this.valueType, leaf, 4) : undefined; }
  has(key: string): boolean { return arenaOf(this).find(this.root, key) !== 0; }
  delete(key: string): SharedOrderedMap<T> {
    const a = arenaOf(this); a.assertWritable(); const leaf = a.find(this.root, key); if (!leaf) return this;
    const root = a.delete(this.root, key);
    return root ? new SharedOrderedMap(this.valueType, root, this.head, this.tail, undefined, a, false)
      : new SharedOrderedMap(this.valueType, 0, 0, 0, 0, a);
  }
  *entries(): Generator<[string, ValueOf<T>]> {
    const a = arenaOf(this), order: number[] = [], view = a.dv; let p = this.head;
    while (p) { order.push(view.getUint32(p + 4, true)); p = view.getUint32(p, true); }
    for (let i = order.length - 1; i >= 0; i--) {
      const old = order[i];
      if (this.orderStable) { yield [a.leafKey(old), a.leafValue(this.valueType, old, 4)]; continue; }
      const dv = a.dv, length = dv.getUint32(old + 8, true);
      const leaf = a.wasm.mapFind(this.root, old + 16, length, dv.getUint32(old + 4, true)) >>> 0;
      if (leaf && a.dv.getUint32(leaf + 16 + length, true) === a.dv.getUint32(old + 16 + length, true)) yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf, 4)];
    }
  }
  *keys(): Generator<string> { for (const [key] of this.entries()) yield key; }
  *values(): Generator<ValueOf<T>> { for (const [, value] of this.entries()) yield value; }
  forEach(fn: (value: ValueOf<T>, key: string) => void): void { for (const [key, value] of this.entries()) fn(value, key); }
  toWorkerData() { return Object.freeze({ root: this.root, head: this.head, tail: this.tail, size: this.size, valueType: this.valueType, orderStable: this.orderStable }); }
  static fromWorkerData<T extends string>(d: { root: number; head: number; tail: number; size: number; valueType: T; orderStable?: boolean }, source: Arena = current): SharedOrderedMap<T> { return new SharedOrderedMap(d.valueType, d.root, d.head, d.tail, d.size, source, d.orderStable ?? false); }
}
structureRegistry.SharedOrderedMap = { fromWorkerData: (d, a) => SharedOrderedMap.fromWorkerData(d, a) };
