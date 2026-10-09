import {
  structureRegistry,
  Snapshot,
  Arena
} from "./chunk-ckkc933p.js";

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
    const a = this.arena;
    for (const leaf of a.leaves(this.root))
      yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf)];
  }
  *keys() {
    const a = this.arena;
    for (const leaf of a.leaves(this.root))
      yield a.leafKey(leaf);
  }
  *values() {
    const a = this.arena;
    for (const leaf of a.leaves(this.root))
      yield a.leafValue(this.valueType, leaf);
  }
  forEach(fn) {
    const a = this.arena;
    for (const leaf of a.leaves(this.root))
      fn(a.leafValue(this.valueType, leaf), a.leafKey(leaf));
  }
  toWorkerData() {
    return Object.freeze({ root: this.root, valueType: this.valueType, size: this.size });
  }
  static fromWorkerData(root, valueType, size, source = defaultArena()) {
    return new SharedMap2(valueType, root, size, source);
  }
}
structureRegistry.SharedMap = { fromWorkerData: (d, a) => SharedMap2.fromWorkerData(d.root, d.valueType, d.size, a) };

export { resetMap2, SharedMap2 };
