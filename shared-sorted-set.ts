import { SharedSortedMap, type Comparator } from './shared-sorted-map';
import { Arena, Snapshot, arenaOf } from './arena';
import { structureRegistry } from './codec';
import { encodeSetKey, decodeSetKey } from './set-key';
export { sharedMemory as sortedSetMemory, getAllocState as getSortedSetAllocState, getBufferCopy as getSortedSetBufferCopy, attachToMemory as attachSortedSetToMemory, resetSortedMap as resetSortedSet } from './shared-sorted-map';
export class SharedSortedSet<T extends string | number = string | number> extends Snapshot {
  private readonly _map: SharedSortedMap<'number'>;
  private readonly comparator?: Comparator<string>;
  constructor(comparator?: Comparator<string>, map?: SharedSortedMap<'number'>) {
    const compare = comparator ? (a: string, b: string) => comparator(String(decodeSetKey(a)), String(decodeSetKey(b))) : undefined;
    const data = map ?? new SharedSortedMap('number', compare);
    super(arenaOf(data)); this._map = data; this.comparator = comparator; Object.freeze(this);
  }
  add(value: T): SharedSortedSet<T> { const key = encodeSetKey(value); return this._map.has(key) ? this : new SharedSortedSet(this.comparator, this._map.set(key, 0)); }
  has(value: T): boolean { return this._map.has(encodeSetKey(value)); }
  delete(value: T): SharedSortedSet<T> { const map = this._map.delete(encodeSetKey(value)); return map === this._map ? this : new SharedSortedSet(this.comparator, map); }
  get size(): number { return this._map.size; }
  *values(): Generator<T> { for (const key of this._map.keys()) yield decodeSetKey(key) as T; }
  forEach(fn: (value: T) => void): void { for (const value of this.values()) fn(value); }
  toWorkerData() { return this._map.toWorkerData(); }
  static fromWorkerData<T extends string | number>(d: { root: number; size: number }, a?: Arena): SharedSortedSet<T> { return new SharedSortedSet(undefined, SharedSortedMap.fromWorkerData({ ...d, valueType: 'number' }, a)); }
}
structureRegistry.SharedSortedSet = { fromWorkerData: (d, a) => SharedSortedSet.fromWorkerData(d, a) };
