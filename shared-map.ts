import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
import { JsonView } from './json-view';
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
  /** Read selected JSON fields from shared bytes without decoding/freezing the whole value. */
  getView(this: T extends 'object' ? SharedMap<T> : never, key: string): JsonView | undefined {
    if (this.valueType !== 'object') throw new TypeError('JSON views require an object map');
    const a = this.arena, leaf = a.find(this.root, key);
    if (!leaf) return undefined;
    const view = a.dv, start = leaf + 16 + view.getUint32(leaf + 8, true);
    return new JsonView(a, start, view.getUint32(leaf + 12, true));
  }
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
  /**
   * Conservatively identify keys that may have changed since a previous snapshot.
   * Within one Arena, identical immutable leaves/subtrees are skipped; a
   * rewritten but equal value may still be reported. Across different Arena
   * instances all keys from both snapshots are returned (including compaction
   * and separately attached payloads). Co-publish both snapshots in a single
   * worker payload to enable structural comparison there.
   * No values are decoded. Result order is unspecified.
   */
  changedKeysSince(previous: SharedMap<T>): Set<string> {
    if (previous.valueType !== this.valueType) throw new TypeError('Map value types must match');
    const changed = new Set<string>(), a = this.arena;
    if (a !== previous.arena) {
      for (const key of previous.keys()) changed.add(key);
      for (const key of this.keys()) changed.add(key);
      return changed;
    }
    if (this.root === previous.root) return changed;
    const view = a.dv;
    const addLeaves = (root: number): void => {
      for (const p of a.leaves(root)) changed.add(a.leafKey(p, view));
    };
    // Branch format is shared with Arena.leaves. Journal roots and collision
    // nodes deliberately use the generic leaf traversal.
    const bitmap = (p: number, tag: number): number =>
      tag === 0xffffffff ? 0 : tag & 0x80000000 ? view.getUint32(p + 8, true) >>> 16 :
      (tag & 3) === 1 ? view.getUint32(p + 4, true) : 0;
    const diff = (left: number, right: number): void => {
      if (left === right) return;
      if (!left || !right) { addLeaves(left || right); return; }
      const lt = view.getUint32(left, true), rt = view.getUint32(right, true);
      if (lt === 0 && rt === 0) {
        changed.add(a.leafKey(left, view));
        changed.add(a.leafKey(right, view));
        return;
      }
      const lm = bitmap(left, lt), rm = bitmap(right, rt);
      if (!lm || !rm) {
        const old = new Set(a.leaves(left));
        for (const p of a.leaves(right)) if (!old.delete(p)) changed.add(a.leafKey(p, view));
        for (const p of old) changed.add(a.leafKey(p, view));
        return;
      }
      // Ordinary branches store pointers in bitmap order. Overlay branches
      // require mapChild to resolve the patch chain without materializing it.
      const lp = !!(lt & 0x80000000), rp = !!(rt & 0x80000000);
      let li = left + 8, ri = right + 8;
      const union = lm | rm;
      for (let digit = 0; digit < 16; digit++) {
        const bit = 1 << digit;
        if (!(union & bit)) continue;
        let l = 0, r = 0;
        if (lm & bit) { l = lp ? a.wasm.mapChild(left, digit) >>> 0 : view.getUint32(li, true); li += 4; }
        if (rm & bit) { r = rp ? a.wasm.mapChild(right, digit) >>> 0 : view.getUint32(ri, true); ri += 4; }
        diff(l, r);
      }
    };
    diff(previous.root, this.root);
    return changed;
  }
  *entries(): Generator<[string, ValueOf<T>]> {
    if (!this.root) return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root)) yield [a.leafKey(leaf, view), a.leafValue(this.valueType, leaf, 0, view)];
  }
  *keys(): Generator<string> {
    if (!this.root) return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root)) yield a.leafKey(leaf, view);
  }
  *values(): Generator<ValueOf<T>> {
    if (!this.root) return;
    const a = this.arena, view = a.dv;
    // Published leaves already fit this view. Shared growth cannot detach it,
    // even when a consumer pauses iteration to create another snapshot.
    for (const leaf of a.leaves(this.root)) yield a.leafValue(this.valueType, leaf, 0, view);
  }
  forEach(fn: (value: ValueOf<T>, key: string) => void): void {
    if (!this.root) return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root)) fn(a.leafValue(this.valueType, leaf, 0, view), a.leafKey(leaf, view));
  }
  toWorkerData() { return Object.freeze({ root: this.root, valueType: this.valueType, size: this.size }); }
  static fromWorkerData<T extends string>(root: number, valueType: T, size?: number, source: Arena = defaultArena()): SharedMap<T> {
    return new SharedMap(valueType, root, size, source);
  }
}
/** Internal identity captured before consumers can replace the descriptor method. */
export const mapCompactionProtocol = Object.freeze({ descriptor: SharedMap.prototype.toWorkerData });
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
