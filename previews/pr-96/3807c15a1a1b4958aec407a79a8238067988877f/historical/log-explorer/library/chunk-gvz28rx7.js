import {
  structureRegistry,
  Snapshot,
  Arena,
  JsonView2
} from "./chunk-wdgdtd4t.js";

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
  changedKeysSince(previous) {
    if (previous.valueType !== this.valueType)
      throw new TypeError("Map value types must match");
    const changed = new Set, a = this.arena;
    if (a !== previous.arena) {
      for (const key of previous.keys())
        changed.add(key);
      for (const key of this.keys())
        changed.add(key);
      return changed;
    }
    if (this.root === previous.root)
      return changed;
    const view = a.dv;
    const addLeaves = (root) => {
      for (const p of a.leaves(root))
        changed.add(a.leafKey(p, view));
    };
    const bitmap = (p, tag) => tag === 4294967295 ? 0 : tag & 2147483648 ? view.getUint32(p + 8, true) >>> 16 : (tag & 3) === 1 ? view.getUint32(p + 4, true) : 0;
    const diff = (left, right) => {
      if (left === right)
        return;
      if (!left || !right) {
        addLeaves(left || right);
        return;
      }
      const lt = view.getUint32(left, true), rt = view.getUint32(right, true);
      if (lt === 0 && rt === 0) {
        changed.add(a.leafKey(left, view));
        changed.add(a.leafKey(right, view));
        return;
      }
      const lm = bitmap(left, lt), rm = bitmap(right, rt);
      if (!lm || !rm) {
        const old = new Set(a.leaves(left));
        for (const p of a.leaves(right))
          if (!old.delete(p))
            changed.add(a.leafKey(p, view));
        for (const p of old)
          changed.add(a.leafKey(p, view));
        return;
      }
      const lp = !!(lt & 2147483648), rp = !!(rt & 2147483648);
      let li = left + 8, ri = right + 8;
      const union = lm | rm;
      for (let digit = 0;digit < 16; digit++) {
        const bit = 1 << digit;
        if (!(union & bit))
          continue;
        let l = 0, r = 0;
        if (lm & bit) {
          l = lp ? a.wasm.mapChild(left, digit) >>> 0 : view.getUint32(li, true);
          li += 4;
        }
        if (rm & bit) {
          r = rp ? a.wasm.mapChild(right, digit) >>> 0 : view.getUint32(ri, true);
          ri += 4;
        }
        diff(l, r);
      }
    };
    diff(previous.root, this.root);
    return changed;
  }
  *entries() {
    if (!this.root)
      return;
    const a = this.arena, view = a.dv;
    for (const leaf of a.leaves(this.root))
      yield [a.leafKey(leaf, view), a.leafValue(this.valueType, leaf, 0, view)];
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
structureRegistry.SharedMap = { fromWorkerData: (d, a) => SharedMap2.fromWorkerData(d.root, d.valueType, d.size, a) };

export { resetMap2, SharedMap2 };
