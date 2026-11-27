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
export type SharedMapChange<V> =
  | { readonly type: 'insert'; readonly key: string; readonly before: undefined; readonly after: V }
  | { readonly type: 'update'; readonly key: string; readonly before: V; readonly after: V }
  | { readonly type: 'delete'; readonly key: string; readonly before: V; readonly after: undefined };

function equalLeafValues(type: string, a: DataView, leafA: number, b: DataView, leafB: number): boolean {
  const length = a.getUint32(leafA + 12, true);
  if (length !== b.getUint32(leafB + 12, true)) return false;
  const startA = leafA + 16 + a.getUint32(leafA + 8, true);
  const startB = leafB + 16 + b.getUint32(leafB + 8, true);
  if (type === 'number') return Object.is(a.getFloat64(startA, true), b.getFloat64(startB, true));
  let i = 0;
  for (; i + 4 <= length; i += 4) {
    if (a.getUint32(startA + i, true) !== b.getUint32(startB + i, true)) return false;
  }
  for (; i < length; i++) {
    if (a.getUint8(startA + i) !== b.getUint8(startB + i)) return false;
  }
  return true;
}

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
  *entries(): Generator<[string, ValueOf<T>]> {
    if (!this.root) return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root)) yield [a.leafKey(leaf, view), a.leafValue(this.valueType, leaf, 0, view)];
  }
  /** Net changes since another snapshot with the same value codec. Immutable shared branches are skipped. */
  *changesSince(previous: SharedMap<T>): Generator<SharedMapChange<ValueOf<T>>, void> {
    if (!(previous instanceof SharedMap) || previous.valueType !== this.valueType) {
      throw new TypeError('Map changes require two SharedMap snapshots with the same value type');
    }
    const current = this.arena, prior = previous.arena;
    // Independent copies can have the same arena ID and numeric addresses.
    const shared = current.memory === prior.memory;
    if (shared && this.root === previous.root) return;
    const view = current.dv, oldView = prior.dv;
    for (const leaf of current.uncoveredMapLeaves(this.root, shared ? previous.root : 0)) {
      const key = current.leafKey(leaf, view);
      const old = prior.find(previous.root, key);
      if (!old) {
        yield { type: 'insert', key, before: undefined, after: current.leafValue(this.valueType, leaf, 0, view) };
      } else if (!(shared && old === leaf) && !equalLeafValues(this.valueType, view, leaf, oldView, old)) {
        yield { type: 'update', key,
          before: prior.leafValue(this.valueType, old, 0, oldView),
          after: current.leafValue(this.valueType, leaf, 0, view) };
      }
    }
    for (const old of prior.uncoveredMapLeaves(previous.root, shared ? this.root : 0)) {
      const key = prior.leafKey(old, oldView);
      if (!current.find(this.root, key)) {
        yield { type: 'delete', key, before: prior.leafValue(this.valueType, old, 0, oldView), after: undefined };
      }
    }
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
