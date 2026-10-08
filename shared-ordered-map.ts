import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
// Registering a collection must not allocate an unused writer in every reader.
let current: Arena | undefined;
/** Legacy live bindings are populated on first use, explicit reset, or attachment. */
export let sharedMemory: WebAssembly.Memory;
export let sharedBuffer: SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current!.memory; sharedBuffer = current!.memory.buffer as unknown as SharedArrayBuffer; }
function defaultArena(): Arena {
  if (!current) { current = new Arena(); publishCurrent(); }
  return current;
}
export function resetOrderedMap(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return defaultArena().state(); }
export function getBufferCopy(): Uint8Array { return defaultArena().copy(); }
export function getBuffer(): SharedArrayBuffer { return defaultArena().memory.buffer as unknown as SharedArrayBuffer; }
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
  constructor(type: T, root = 0, head = 0, tail = 0, _size: number | undefined = undefined, source: Arena = defaultArena(), orderStable = root === 0 && head === 0) {
    super(source); this.valueType = type; this.root = root; this.head = head; this.tail = tail; this.size = _size ?? source.wasm.mapSize(root); this.orderStable = orderStable; Object.freeze(this);
  }
  set(key: string, value: ValueOf<T>): SharedOrderedMap<T> {
    const a = this.arena; a.assertWritable();
    if (a.sameValue(this.root, key, this.valueType, value, 4)) return this;
    checkedSize(this.tail + 1);
    const root = (this.valueType === 'number' ? a.writeNumber(this.root, key, value as number, 1, this.head, this.tail) : this.valueType === 'string' ? a.writeString(this.root, key, value as string, 1, this.head, this.tail) : a.write(this.valueType, this.root, key, value, 1, this.head, this.tail));
    return new SharedOrderedMap(this.valueType, root, a.writeHead, a.writeCount, a.writeSize, a, this.orderStable && a.writeSize > this.size);
  }
  get(key: string): ValueOf<T> | undefined { return this.arena.value(this.root, key, this.valueType, 4); }
  has(key: string): boolean { return this.arena.contains(this.root, key); }
  delete(key: string): SharedOrderedMap<T> {
    const a = this.arena, root = a.delete(this.root, key);
    if (root === this.root) return this;
    return root ? new SharedOrderedMap(this.valueType, root, this.head, this.tail, this.size - 1, a, false)
      : new SharedOrderedMap(this.valueType, 0, 0, 0, 0, a);
  }
  *entries(): Generator<[string, ValueOf<T>]> {
    const a = this.arena, order: number[] = [], view = a.dv; let p = this.head;
    while (p) { order.push(view.getUint32(p + 4, true)); p = view.getUint32(p, true); }
    for (let i = order.length - 1; i >= 0; i--) {
      const old = order[i];
      if (this.orderStable) { yield [a.leafKey(old), a.leafValue(this.valueType, old, 4)]; continue; }
      const dv = a.dv, length = dv.getUint32(old + 8, true);
      const leaf = a.wasm.mapFind(this.root, old + 16, length, dv.getUint32(old + 4, true)) >>> 0;
      if (leaf && a.dv.getUint32(leaf + 16 + length, true) === a.dv.getUint32(old + 16 + length, true)) yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf, 4)];
    }
  }
  keys(): Generator<string> { return projectOrdered(this, 0); }
  values(): Generator<ValueOf<T>> { return projectOrdered(this, 1); }
  forEach(fn: (value: ValueOf<T>, key: string) => void): void { for (const [key, value] of this.entries()) fn(value, key); }
  toWorkerData() { return Object.freeze({ root: this.root, head: this.head, tail: this.tail, size: this.size, valueType: this.valueType, orderStable: this.orderStable }); }
  static fromWorkerData<T extends string>(d: { root: number; head: number; tail: number; size: number; valueType: T; orderStable?: boolean }, source: Arena = defaultArena()): SharedOrderedMap<T> { return new SharedOrderedMap(d.valueType, d.root, d.head, d.tail, d.size, source, d.orderStable ?? false); }
}
// Keep projection state local without adding a method to the exported prototype.
// The generator defers arena access until iteration begins.
function projectOrdered<T extends string>(map: SharedOrderedMap<T>, projection: 0): Generator<string>;
function projectOrdered<T extends string>(map: SharedOrderedMap<T>, projection: 1): Generator<ValueOf<T>>;
function* projectOrdered<T extends string>(map: SharedOrderedMap<T>, projection: 0 | 1): Generator<string | ValueOf<T>> {
  const a = arenaOf(map), order: number[] = [], view = a.dv; let p = map.head;
  while (p) { order.push(view.getUint32(p + 4, true)); p = view.getUint32(p, true); }
  for (let i = order.length - 1; i >= 0; i--) {
    const old = order[i]; let leaf = old;
    if (!map.orderStable) {
      const length = view.getUint32(old + 8, true);
      leaf = a.wasm.mapFind(map.root, old + 16, length, view.getUint32(old + 4, true)) >>> 0;
      if (!leaf || view.getUint32(leaf + 16 + length, true) !== view.getUint32(old + 16 + length, true)) continue;
    }
    // Project directly: keys never parse values, values never decode keys,
    // and neither allocates the discarded entry tuple.
    if (projection === 0) yield a.leafKey(leaf);
    else yield a.leafValue(map.valueType, leaf, 4);
  }
}
structureRegistry.SharedOrderedMap = { fromWorkerData: (d, a) => SharedOrderedMap.fromWorkerData(d, a) };
