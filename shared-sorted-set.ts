import { SharedSortedMap, Comparator, sharedMemory, getAllocState, getBufferCopy, attachToMemory, resetSortedMap } from './shared-sorted-map';
import { structureRegistry } from './codec';

export { sharedMemory as sortedSetMemory, getAllocState as getSortedSetAllocState, getBufferCopy as getSortedSetBufferCopy, attachToMemory as attachSortedSetToMemory, resetSortedMap as resetSortedSet };

export class SharedSortedSet<T extends string | number> {
  private _map: SharedSortedMap<'number'>;
  private comparator?: Comparator<string>;

  constructor(comparator?: Comparator<string>, map?: SharedSortedMap<'number'>) {
    this.comparator = comparator;
    this._map = map ?? new SharedSortedMap('number', comparator);
  }

  add(value: T): SharedSortedSet<T> {
    const key = String(value);
    if (this._map.has(key)) return this;
    return new SharedSortedSet(this.comparator, this._map.set(key, 0));
  }

  has(value: T): boolean {
    return this._map.has(String(value));
  }

  delete(value: T): SharedSortedSet<T> {
    const newMap = this._map.delete(String(value));
    return newMap === this._map ? this : new SharedSortedSet(this.comparator, newMap);
  }

  get size(): number { return this._map.size; }

  *values(): Generator<T> {
    for (const k of this._map.keys()) {
      yield (typeof k === 'string' && /^-?\d+(\.\d+)?$/.test(k) ? Number(k) : k) as T;
    }
  }

  forEach(fn: (value: T) => void): void {
    for (const v of this.values()) fn(v);
  }

  toWorkerData(): { root: number; size: number } {
    return { root: this._map.root, size: this._map.size };
  }

  static fromWorkerData<T extends string | number>(data: { root: number; size: number }): SharedSortedSet<T> {
    return new SharedSortedSet(undefined, new SharedSortedMap('number', undefined, data.root, data.size));
  }
}

// Register SharedSortedSet in structure registry for nested type support
structureRegistry['SharedSortedSet'] = { fromWorkerData: (d: any) => SharedSortedSet.fromWorkerData(d) };
