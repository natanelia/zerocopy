import { SharedMap } from './shared-map';
import { Arena, Snapshot, arenaOf } from './arena';
import { structureRegistry } from './codec';
import { encodeSetKey, decodeSetKey } from './set-key';
export class SharedSet<T extends string | number = string | number> extends Snapshot {
  private readonly _map: SharedMap<'number'>;
  constructor(map?: SharedMap<'number'>) {
    const data = map ?? new SharedMap('number'); super(arenaOf(data)); this._map = data; Object.freeze(this);
  }
  add(value: T): SharedSet<T> { const key = encodeSetKey(value); return this._map.has(key) ? this : new SharedSet(this._map.set(key, 0)); }
  has(value: T): boolean { return this._map.has(encodeSetKey(value)); }
  delete(value: T): SharedSet<T> { const map = this._map.delete(encodeSetKey(value)); return map === this._map ? this : new SharedSet(map); }
  get size(): number { return this._map.size; }
  *values(): Generator<T> { for (const key of this._map.keys()) yield decodeSetKey(key) as T; }
  forEach(fn: (value: T) => void): void { for (const value of this.values()) fn(value); }
  toWorkerData() { return this._map.toWorkerData(); }
  addMany(values: readonly T[]): SharedSet<T> { const added = values.filter(value => !this.has(value)); return added.length ? new SharedSet(this._map.setMany(added.map(v => [encodeSetKey(v), 0] as const))) : this; }
  static fromWorkerData<T extends string | number>(d: { root: number; size: number }, a?: Arena): SharedSet<T> { return new SharedSet(SharedMap.fromWorkerData(d.root, 'number', d.size, a)); }
}
structureRegistry.SharedSet = { fromWorkerData: (d, a) => SharedSet.fromWorkerData(d, a) };
