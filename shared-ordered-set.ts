import { SharedOrderedMap } from './shared-ordered-map';
import { Arena, Snapshot, arenaOf } from './arena';
import { structureRegistry } from './codec';
import { encodeSetKey, decodeSetKey } from './set-key';
export { sharedMemory as orderedSetMemory, getAllocState as getOrderedSetAllocState, getBufferCopy as getOrderedSetBufferCopy, attachToMemory as attachOrderedSetToMemory, resetOrderedMap as resetOrderedSet } from './shared-ordered-map';
export class SharedOrderedSet<T extends string | number = string | number> extends Snapshot {
  private readonly _map: SharedOrderedMap<'number'>;
  constructor(map?: SharedOrderedMap<'number'>) {
    const data = map ?? new SharedOrderedMap('number'); super(arenaOf(data)); this._map = data; Object.freeze(this);
  }
  add(value: T): SharedOrderedSet<T> { const key = encodeSetKey(value); return this._map.has(key) ? this : new SharedOrderedSet(this._map.set(key, 0)); }
  has(value: T): boolean { return this._map.has(encodeSetKey(value)); }
  delete(value: T): SharedOrderedSet<T> { const map = this._map.delete(encodeSetKey(value)); return map === this._map ? this : new SharedOrderedSet(map); }
  get size(): number { return this._map.size; }
  *values(): Generator<T> { for (const key of this._map.keys()) yield decodeSetKey(key) as T; }
  forEach(fn: (value: T) => void): void { for (const value of this.values()) fn(value); }
  toWorkerData() { return this._map.toWorkerData(); }
  static fromWorkerData<T extends string | number>(d: { root: number; head: number; tail: number; size: number }, a?: Arena): SharedOrderedSet<T> { return new SharedOrderedSet(SharedOrderedMap.fromWorkerData({ ...d, valueType: 'number' }, a)); }
}
structureRegistry.SharedOrderedSet = { fromWorkerData: (d, a) => SharedOrderedSet.fromWorkerData(d, a) };
