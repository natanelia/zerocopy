import {
  structureRegistry,
  Snapshot,
  Arena,
  JsonView2
} from "./chunk-bkzs6rn0.js";

// shared-map.ts
var current;
var sharedMemory;
var sharedBuffer;
function publishCurrent() {
  sharedMemory = current.memory;
  sharedBuffer = current.memory.buffer;
}
function defaultArena() {
  if (!current) {
    current = new Arena;
    publishCurrent();
  }
  return current;
}
function resetMap2() {
  current = new Arena;
  publishCurrent();
}
function getBuffer() {
  return defaultArena().memory.buffer;
}
function equalLeafValues(type, a, leafA, b, leafB) {
  const length = a.getUint32(leafA + 12, true);
  if (length !== b.getUint32(leafB + 12, true))
    return false;
  const startA = leafA + 16 + a.getUint32(leafA + 8, true);
  const startB = leafB + 16 + b.getUint32(leafB + 8, true);
  if (type === "number")
    return Object.is(a.getFloat64(startA, true), b.getFloat64(startB, true));
  let i = 0;
  for (;i + 4 <= length; i += 4) {
    if (a.getUint32(startA + i, true) !== b.getUint32(startB + i, true))
      return false;
  }
  for (;i < length; i++) {
    if (a.getUint8(startA + i) !== b.getUint8(startB + i))
      return false;
  }
  return true;
}
class SharedMap2 extends Snapshot {
  static async init() {}
  static getSharedBuffer() {
    return getBuffer();
  }
  root;
  valueType;
  size;
  constructor(type, root = 0, _size = undefined, source = defaultArena()) {
    super(source);
    this.valueType = type;
    this.root = root;
    this.size = _size ?? source.wasm.mapSize(root);
    Object.freeze(this);
  }
  dispose() {}
  set(key, value) {
    const a = this.arena;
    a.assertWritable();
    if (a.sameValue(this.root, key, this.valueType, value))
      return this;
    const root = this.valueType === "number" ? a.setNumber(this.root, key, value, this.size) : this.valueType === "string" ? a.setString(this.root, key, value, this.size) : a.write(this.valueType, this.root, key, value);
    return new SharedMap2(this.valueType, root, a.writeSize, a);
  }
  get(key) {
    return this.arena.value(this.root, key, this.valueType);
  }
  getView(key) {
    if (this.valueType !== "object")
      throw new TypeError("JSON views require an object map");
    const a = this.arena, leaf = a.find(this.root, key);
    if (!leaf)
      return;
    const view = a.dv, start = leaf + 16 + view.getUint32(leaf + 8, true);
    return new JsonView2(a, start, view.getUint32(leaf + 12, true));
  }
  has(key) {
    return this.arena.contains(this.root, key);
  }
  delete(key) {
    const a = this.arena, root = a.delete(this.root, key);
    return root === this.root ? this : new SharedMap2(this.valueType, root, this.size - 1, a);
  }
  setMany(entries) {
    if (!entries.length)
      return this;
    const a = this.arena, root = a.bulk(this.valueType, this.root, entries);
    return new SharedMap2(this.valueType, root, undefined, a);
  }
  getMany(keys) {
    return keys.map((k) => this.get(k));
  }
  deleteMany(keys) {
    const a = this.arena;
    a.assertWritable();
    let root = this.root;
    for (const key of keys)
      root = a.delete(root, key);
    return root === this.root ? this : new SharedMap2(this.valueType, root, undefined, a);
  }
  *entries() {
    if (!this.root)
      return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root))
      yield [a.leafKey(leaf, view), a.leafValue(this.valueType, leaf, 0, view)];
  }
  *changesSince(previous) {
    if (!(previous instanceof SharedMap2) || previous.valueType !== this.valueType) {
      throw new TypeError("Map changes require two SharedMap snapshots with the same value type");
    }
    const current = this.arena, prior = previous.arena;
    const shared = current.memory === prior.memory;
    if (shared && this.root === previous.root)
      return;
    const view = current.dv, oldView = prior.dv;
    for (const leaf of current.uncoveredMapLeaves(this.root, shared ? previous.root : 0)) {
      const key = current.leafKey(leaf, view);
      const old = prior.find(previous.root, key);
      if (!old) {
        yield { type: "insert", key, before: undefined, after: current.leafValue(this.valueType, leaf, 0, view) };
      } else if (!(shared && old === leaf) && !equalLeafValues(this.valueType, view, leaf, oldView, old)) {
        yield {
          type: "update",
          key,
          before: prior.leafValue(this.valueType, old, 0, oldView),
          after: current.leafValue(this.valueType, leaf, 0, view)
        };
      }
    }
    for (const old of prior.uncoveredMapLeaves(previous.root, shared ? this.root : 0)) {
      const key = prior.leafKey(old, oldView);
      if (!current.find(this.root, key)) {
        yield { type: "delete", key, before: prior.leafValue(this.valueType, old, 0, oldView), after: undefined };
      }
    }
  }
  *keys() {
    if (!this.root)
      return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root))
      yield a.leafKey(leaf, view);
  }
  *values() {
    if (!this.root)
      return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root))
      yield a.leafValue(this.valueType, leaf, 0, view);
  }
  forEach(fn) {
    if (!this.root)
      return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root))
      fn(a.leafValue(this.valueType, leaf, 0, view), a.leafKey(leaf, view));
  }
  toWorkerData() {
    return Object.freeze({ root: this.root, valueType: this.valueType, size: this.size });
  }
  static fromWorkerData(root, valueType, size, source = defaultArena()) {
    return new SharedMap2(valueType, root, size, source);
  }
}
var mapCompactionProtocol = Object.freeze({ descriptor: SharedMap2.prototype.toWorkerData });
structureRegistry.SharedMap = { fromWorkerData: (d, a) => SharedMap2.fromWorkerData(d.root, d.valueType, d.size, a) };

export { resetMap2, SharedMap2, mapCompactionProtocol };
