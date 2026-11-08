import {
  structureRegistry,
  popcount,
  Snapshot,
  Arena
} from "./chunk-en3kfc9j.js";

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
    if (!this.root)
      return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root))
      yield a.leafValue(this.valueType, leaf, 0, view);
  }
  forEach(fn) {
    const a = this.arena, leaves = a.leaves;
    if (leaves !== defaultLeaves) {
      for (const leaf of Reflect.apply(leaves, a, [this.root]))
        fn(a.leafValue(this.valueType, leaf), a.leafKey(leaf));
      return;
    }
    if (!this.root)
      return;
    const view = a.dv;
    if (view.getUint32(this.root, true) === 4294967295) {
      for (const leaf of leaves.call(a, this.root))
        fn(a.leafValue(this.valueType, leaf), a.leafKey(leaf));
      return;
    }
    const stack = [this.root], lanes = new Uint32Array(16), patches = [];
    while (stack.length) {
      const p = stack.pop(), tag = view.getUint32(p, true);
      if (!tag) {
        fn(a.leafValue(this.valueType, p), a.leafKey(p));
        continue;
      }
      if (tag & 2147483648) {
        const bitmap = view.getUint32(p + 8, true) >>> 16;
        patches.length = 0;
        let base = p;
        while (view.getUint32(base, true) & 2147483648) {
          patches.push(base);
          base -= (view.getUint32(base, true) & 16383) * 4;
        }
        const bits = view.getUint32(base + 4, true);
        let offset = 0;
        for (let digit = 0;digit < 16; digit++)
          if (bits & 1 << digit)
            lanes[digit] = view.getUint32(base + 8 + offset++ * 4, true);
        for (let i = patches.length - 1;i >= 0; i--) {
          const patch = patches[i], distance = view.getUint32(patch, true) >>> 14 & 127;
          lanes[view.getUint32(patch + 4, true) & 15] = distance ? patch - distance * 4 : 0;
        }
        for (let digit = 15;digit >= 0; digit--)
          if (bitmap & 1 << digit)
            stack.push(lanes[digit]);
      } else {
        const dense = (tag & 3) === 1;
        const count = dense ? popcount(view.getUint32(p + 4, true)) : view.getUint32(p + 8, true);
        for (let i = count - 1;i >= 0; i--)
          stack.push(view.getUint32(p + (dense ? 8 : 16) + i * 4, true));
      }
    }
  }
  toWorkerData() {
    return Object.freeze({ root: this.root, valueType: this.valueType, size: this.size });
  }
  static fromWorkerData(root, valueType, size, source = defaultArena()) {
    return new SharedMap2(valueType, root, size, source);
  }
}
var defaultLeaves = Arena.prototype.leaves;
structureRegistry.SharedMap = { fromWorkerData: (d, a) => SharedMap2.fromWorkerData(d.root, d.valueType, d.size, a) };

export { resetMap2, SharedMap2 };
