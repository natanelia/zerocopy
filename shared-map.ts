import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize, popcount, nativeMapLeaves } from './arena';
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
export function resetMap(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return defaultArena().state(); }
export function getBufferCopy(): Uint8Array { return defaultArena().copy(); }
export function getBuffer(): SharedArrayBuffer { return defaultArena().memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type ValueType = import('./types').ValueType;
export function getUsedBytes(): number { return current ? current.used - 65536 : 0; }
/** @deprecated Reachable snapshots are never disposed by update-count heuristics. */
export function configureAutoGC(_options: { enabled?: boolean; memoryThreshold?: number; opsThreshold?: number }): void {}

export class SharedMap<T extends string = ValueType> extends Snapshot {
  /** Compatibility with the browser demo. The embedded core initializes at import. */
  static async init(): Promise<void> {}
  static getSharedBuffer(): SharedArrayBuffer { return getBuffer(); }

  readonly root: number;
  readonly valueType: T;
  readonly size: number;
  constructor(type: T, root = 0, _size: number | undefined = undefined, source: Arena = defaultArena()) {
    super(source); this.valueType = type; this.root = root; this.size = _size ?? source.wasm.mapSize(root); Object.freeze(this);
  }
  /** @deprecated Arena lifetime is managed by JavaScript reachability. */
  dispose(): void {}
  set(key: string, value: ValueOf<T>): SharedMap<T> {
    const a = this.arena; a.assertWritable();
    if (a.sameValue(this.root, key, this.valueType, value)) return this;
    const root = (this.valueType === 'number' ? a.setNumber(this.root, key, value as number, this.size) : this.valueType === 'string' ? a.setString(this.root, key, value as string, this.size) : a.write(this.valueType, this.root, key, value));
    return new SharedMap(this.valueType, root, a.writeSize, a);
  }
  get(key: string): ValueOf<T> | undefined { return this.arena.value(this.root, key, this.valueType); }
  has(key: string): boolean { return this.arena.contains(this.root, key); }
  delete(key: string): SharedMap<T> {
    const a = this.arena, root = a.delete(this.root, key);
    return root === this.root ? this : new SharedMap(this.valueType, root, this.size - 1, a);
  }
  setMany(entries: readonly (readonly [string, ValueOf<T>])[]): SharedMap<T> {
    if (!entries.length) return this;
    const a = this.arena, root = a.bulk(this.valueType, this.root, entries);
    return new SharedMap(this.valueType, root, undefined, a);
  }
  getMany(keys: readonly string[]): (ValueOf<T> | undefined)[] { return keys.map(k => this.get(k)); }
  deleteMany(keys: readonly string[]): SharedMap<T> {
    const a = this.arena; a.assertWritable(); let root = this.root;
    for (const key of keys) root = a.delete(root, key);
    return root === this.root ? this : new SharedMap(this.valueType, root, undefined, a);
  }
  *entries(): Generator<[string, ValueOf<T>]> {
    const a = this.arena;
    for (const leaf of a.leaves(this.root)) yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf)];
  }
  *keys(): Generator<string> { const a = this.arena; for (const leaf of a.leaves(this.root)) yield a.leafKey(leaf); }
  *values(): Generator<ValueOf<T>> {
    if (!this.root) return;
    const a = this.arena, view = a.dv;
    // Published leaves already fit this view. Shared growth cannot detach it,
    // even when a consumer pauses iteration to create another snapshot.
    for (const leaf of a.leaves(this.root)) yield a.leafValue(this.valueType, leaf, 0, view);
  }
  forEach(fn: (value: ValueOf<T>, key: string) => void): void {
    const a = this.arena, leaves = a.leaves;
    if (leaves !== nativeMapLeaves) {
      for (const leaf of Reflect.apply(leaves, a, [this.root])) fn(a.leafValue(this.valueType, leaf), a.leafKey(leaf));
      return;
    }
    if (!this.root) return;
    const view = a.dv;
    // Retain legacy journal ordering and duplicate suppression. Ordinary HAMT
    // traversal keeps its entire continuation local, without generator yields.
    if (view.getUint32(this.root, true) === 0xffffffff) {
      for (const leaf of leaves.call(a, this.root)) fn(a.leafValue(this.valueType, leaf), a.leafKey(leaf));
      return;
    }
    const stack = [this.root], lanes = new Uint32Array(16), patches: number[] = [];
    while (stack.length) {
      const p = stack.pop()!, tag = view.getUint32(p, true);
      if (!tag) {
        // Published leaves remain inside this view when a callback grows the
        // shared arena, reenters the traversal, or creates a fork.
        fn(a.leafValue(this.valueType, p), a.leafKey(p));
        continue;
      }
      if (tag & 0x80000000) {
        const bitmap = view.getUint32(p + 8, true) >>> 16;
        patches.length = 0; let base = p;
        while (view.getUint32(base, true) & 0x80000000) {
          patches.push(base); base -= (view.getUint32(base, true) & 16383) * 4;
        }
        const bits = view.getUint32(base + 4, true); let offset = 0;
        for (let digit = 0; digit < 16; digit++) if (bits & (1 << digit)) lanes[digit] = view.getUint32(base + 8 + offset++ * 4, true);
        for (let i = patches.length - 1; i >= 0; i--) {
          const patch = patches[i], distance = (view.getUint32(patch, true) >>> 14) & 127;
          lanes[view.getUint32(patch + 4, true) & 15] = distance ? patch - distance * 4 : 0;
        }
        for (let digit = 15; digit >= 0; digit--) if (bitmap & (1 << digit)) stack.push(lanes[digit]);
      } else {
        const dense = (tag & 3) === 1;
        const count = dense ? popcount(view.getUint32(p + 4, true)) : view.getUint32(p + 8, true);
        for (let i = count - 1; i >= 0; i--) stack.push(view.getUint32(p + (dense ? 8 : 16) + i * 4, true));
      }
    }
  }
  /** Eagerly materialize entries without suspending the entries generator per key.
   * Useful when consumers need all keys/values as a JavaScript array.
   * Like forEach, this reads the immutable snapshot and honors custom traversal.
   */
  toEntriesArray(): [string, ValueOf<T>][] {
    const result = new Array<[string, ValueOf<T>]>(this.size);
    let count = 0;
    this.forEach((value, key) => { result[count++] = [key, value]; });
    // Historical journal descriptors can report a larger reserved size.
    if (result.length !== count) result.length = count;
    return result;
  }
  toWorkerData() { return Object.freeze({ root: this.root, valueType: this.valueType, size: this.size }); }
  static fromWorkerData<T extends string>(root: number, valueType: T, size?: number, source: Arena = defaultArena()): SharedMap<T> {
    return new SharedMap(valueType, root, size, source);
  }
}
structureRegistry.SharedMap = { fromWorkerData: (d, a) => SharedMap.fromWorkerData(d.root, d.valueType, d.size, a) };

/** Compatibility wrapper for internal numeric-key users. */
export class SharedMapNumeric<T extends string = ValueType> {
  private readonly map: SharedMap<T>;
  readonly root: number;
  readonly _type: T;
  constructor(type: T, root = 0, source: Arena = defaultArena()) { this._type = type; this.root = root; this.map = new SharedMap(type, root, undefined, source); Object.freeze(this); }
  set(index: number, value: ValueOf<T>): SharedMapNumeric<T> { const m = this.map.set(String(index), value); return new SharedMapNumeric(this._type, m.root, arenaOf(m)); }
  get(index: number): ValueOf<T> | undefined { return this.map.get(String(index)); }
  has(index: number): boolean { return this.map.has(String(index)); }
  delete(index: number): SharedMapNumeric<T> { const m = this.map.delete(String(index)); return m === this.map ? this : new SharedMapNumeric(this._type, m.root, arenaOf(m)); }
}
