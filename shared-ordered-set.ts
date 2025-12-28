import { SharedOrderedMap, sharedMemory, getAllocState, getBufferCopy, attachToMemory, resetOrderedMap } from './shared-ordered-map';
import { structureRegistry } from './codec.ts';

export { sharedMemory as orderedSetMemory, getAllocState as getOrderedSetAllocState, getBufferCopy as getOrderedSetBufferCopy, attachToMemory as attachOrderedSetToMemory, resetOrderedMap as resetOrderedSet };

export class SharedOrderedSet<T extends string | number> {
  private _map: SharedOrderedMap<'number'>;

  constructor(map?: SharedOrderedMap<'number'>) {
    this._map = map ?? new SharedOrderedMap('number');
  }

  add(value: T): SharedOrderedSet<T> {
    const key = String(value);
    if (this._map.has(key)) return this;
    return new SharedOrderedSet(this._map.set(key, 0));
  }

  has(value: T): boolean {
    return this._map.has(String(value));
  }

  delete(value: T): SharedOrderedSet<T> {
    const newMap = this._map.delete(String(value));
    return newMap === this._map ? this : new SharedOrderedSet(newMap);
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

  toWorkerData(): { root: number; head: number; tail: number; size: number } {
    const data = this._map.toWorkerData();
    return { root: data.root, head: data.head, tail: data.tail, size: data.size };
  }

  static fromWorkerData<T extends string | number>(data: { root: number; head: number; tail: number; size: number }): SharedOrderedSet<T> {
    return new SharedOrderedSet(SharedOrderedMap.fromWorkerData({ ...data, valueType: 'number' }));
  }
}

// Register SharedOrderedSet in structure registry for nested type support
structureRegistry['SharedOrderedSet'] = { fromWorkerData: (d: any) => SharedOrderedSet.fromWorkerData(d) };
