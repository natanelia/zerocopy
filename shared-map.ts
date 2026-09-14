import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetMap(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type ValueType = import('./types').ValueType;
export function getUsedBytes(): number { return current.used - 65536; }
/** @deprecated Reachable snapshots are never disposed by update-count heuristics. */
export function configureAutoGC(_options: { enabled?: boolean; memoryThreshold?: number; opsThreshold?: number }): void {}

export class SharedMap<T extends string = ValueType> extends Snapshot {
  /** Compatibility with the browser demo. The embedded core initializes at import. */
  static async init(): Promise<void> {}
  static getSharedBuffer(): SharedArrayBuffer { return getBuffer(); }

  readonly root: number;
  readonly valueType: T;
  readonly size: number;
  constructor(type: T, root = 0, _size: number | undefined = undefined, source: Arena = current) {
    super(source); this.valueType = type; this.root = root; this.size = _size ?? source.wasm.mapSize(root); Object.freeze(this);
  }
  /** @deprecated Arena lifetime is managed by JavaScript reachability. */
  dispose(): void {}
  set(key: string, value: ValueOf<T>): SharedMap<T> {
    const a = this.arena; a.assertWritable();
    if (a.sameValue(this.root, key, this.valueType, value)) return this;
    const root = (this.valueType === 'number' ? a.writeNumber(this.root, key, value as number) : this.valueType === 'string' ? a.writeString(this.root, key, value as string) : a.write(this.valueType, this.root, key, value));
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
  *values(): Generator<ValueOf<T>> { const a = this.arena; for (const leaf of a.leaves(this.root)) yield a.leafValue(this.valueType, leaf); }
  forEach(fn: (value: ValueOf<T>, key: string) => void): void { const a = this.arena; for (const leaf of a.leaves(this.root)) fn(a.leafValue(this.valueType, leaf), a.leafKey(leaf)); }
  toWorkerData() { return Object.freeze({ root: this.root, valueType: this.valueType, size: this.size }); }
  static fromWorkerData<T extends string>(root: number, valueType: T, size?: number, source: Arena = current): SharedMap<T> {
    return new SharedMap(valueType, root, size, source);
  }
}
structureRegistry.SharedMap = { fromWorkerData: (d, a) => SharedMap.fromWorkerData(d.root, d.valueType, d.size, a) };

/** Compatibility wrapper for internal numeric-key users. */
export class SharedMapNumeric<T extends string = ValueType> {
  private readonly map: SharedMap<T>;
  readonly root: number;
  readonly _type: T;
  constructor(type: T, root = 0, source: Arena = current) { this._type = type; this.root = root; this.map = new SharedMap(type, root, undefined, source); Object.freeze(this); }
  set(index: number, value: ValueOf<T>): SharedMapNumeric<T> { const m = this.map.set(String(index), value); return new SharedMapNumeric(this._type, m.root, arenaOf(m)); }
  get(index: number): ValueOf<T> | undefined { return this.map.get(String(index)); }
  has(index: number): boolean { return this.map.has(String(index)); }
  delete(index: number): SharedMapNumeric<T> { const m = this.map.delete(String(index)); return m === this.map ? this : new SharedMapNumeric(this._type, m.root, arenaOf(m)); }
}
