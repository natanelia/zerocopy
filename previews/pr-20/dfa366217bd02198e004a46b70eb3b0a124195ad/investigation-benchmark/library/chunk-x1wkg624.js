import {
  parseNestedType,
  structureRegistry,
  FORMAT_VERSION,
  vectorDepth,
  validIndex,
  checkedSize,
  arenaOf,
  Snapshot,
  Arena
} from "./chunk-bngxdyck.js";
import {
  SharedMap2
} from "./chunk-fvjmff4x.js";
import {
  SharedList2
} from "./chunk-374wjbs3.js";

// set-key.ts
function encodeSetKey(value) {
  if (typeof value !== "string" && typeof value !== "number")
    throw new TypeError("Set values must be strings or numbers");
  return (typeof value === "number" ? "n:" : "s:") + String(value);
}
function decodeSetKey(value) {
  return value.startsWith("n:") ? Number(value.slice(2)) : value.slice(2);
}

// shared-set.ts
class SharedSet2 extends Snapshot {
  _map;
  constructor(map) {
    const data = map ?? new SharedMap2("number");
    super(arenaOf(data));
    this._map = data;
    Object.freeze(this);
  }
  add(value) {
    const key = encodeSetKey(value);
    return this._map.has(key) ? this : new SharedSet2(this._map.set(key, 0));
  }
  has(value) {
    return this._map.has(encodeSetKey(value));
  }
  delete(value) {
    const map = this._map.delete(encodeSetKey(value));
    return map === this._map ? this : new SharedSet2(map);
  }
  get size() {
    return this._map.size;
  }
  *values() {
    for (const key of this._map.keys())
      yield decodeSetKey(key);
  }
  forEach(fn) {
    for (const value of this.values())
      fn(value);
  }
  toWorkerData() {
    return this._map.toWorkerData();
  }
  addMany(values) {
    const added = values.filter((value) => !this.has(value));
    return added.length ? new SharedSet2(this._map.setMany(added.map((v) => [encodeSetKey(v), 0]))) : this;
  }
  static fromWorkerData(d, a) {
    return new SharedSet2(SharedMap2.fromWorkerData(d.root, "number", d.size, a));
  }
}
structureRegistry.SharedSet = { fromWorkerData: (d, a) => SharedSet2.fromWorkerData(d, a) };

// shared-stack.ts
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
function resetStack2() {
  current = new Arena;
  publishCurrent();
}
class SharedStack2 extends Snapshot {
  head;
  encodedTop;
  size;
  valueType;
  constructor(type, head = 0, size = 0, _top, source = defaultArena(), encodedTop) {
    super(source);
    this.valueType = type;
    this.head = head;
    this.size = checkedSize(size);
    this.encodedTop = encodedTop ?? (head ? source.dv.getFloat64(head + 8, true) : 0);
    Object.freeze(this);
  }
  push(value) {
    const a = this.arena;
    a.assertWritable();
    const size = checkedSize(this.size + 1), raw = a.encode(this.valueType, value), head = a.wasm.cons(this.head, raw) >>> 0;
    return new SharedStack2(this.valueType, head, size, undefined, a, raw);
  }
  pop() {
    if (!this.size)
      return this;
    const a = this.arena;
    return new SharedStack2(this.valueType, a.dv.getUint32(this.head, true), this.size - 1, undefined, a);
  }
  peek() {
    return this.size ? this.arena.decode(this.valueType, this.encodedTop) : undefined;
  }
  get isEmpty() {
    return this.size === 0;
  }
  toWorkerData() {
    return Object.freeze({ head: this.head, size: this.size, type: this.valueType });
  }
  static fromWorkerData(d, source = defaultArena()) {
    return new SharedStack2(d.type, d.head, d.size, undefined, source);
  }
}
structureRegistry.SharedStack = { fromWorkerData: (d, a) => SharedStack2.fromWorkerData(d, a) };

// shared-queue.ts
var current2;
var sharedMemory2;
var sharedBuffer2;
function publishCurrent2() {
  sharedMemory2 = current2.memory;
  sharedBuffer2 = current2.memory.buffer;
}
function defaultArena2() {
  if (!current2) {
    current2 = new Arena;
    publishCurrent2();
  }
  return current2;
}
function resetQueue2() {
  current2 = new Arena;
  publishCurrent2();
}
class SharedQueue2 extends Snapshot {
  head;
  tail;
  block;
  depth;
  size;
  valueType;
  constructor(type, head = 0, tail = 0, size = 0, _front, source = defaultArena2(), block = 0, depth = 0) {
    super(source);
    this.valueType = type;
    this.head = head;
    this.tail = tail;
    this.size = checkedSize(size);
    checkedSize(tail + size);
    this.block = block;
    this.depth = depth;
    Object.freeze(this);
  }
  enqueue(value) {
    const a = this.arena, raw = a.encode(this.valueType, value), end = checkedSize(this.tail + this.size), total = checkedSize(end + 1);
    const length = end ? (end - 1 & 31) + 1 : 0;
    if (length < 32)
      return new SharedQueue2(this.valueType, this.head, this.tail, this.size + 1, undefined, a, a.wasm.tailAppend(this.block, length, raw) >>> 0, this.depth);
    const depth = vectorDepth(end), head = a.wasm.vecLink(this.head, this.depth, depth, end - 32, this.block, 32) >>> 0;
    return new SharedQueue2(this.valueType, head, this.tail, this.size + 1, undefined, a, a.wasm.tailAppend(0, 0, raw) >>> 0, depth);
  }
  dequeue() {
    if (!this.size)
      return this;
    const a = this.arena;
    return this.size > 1 ? new SharedQueue2(this.valueType, this.head, this.tail + 1, this.size - 1, undefined, a, this.block, this.depth) : new SharedQueue2(this.valueType, 0, 0, 0, undefined, a);
  }
  peek() {
    if (!this.size)
      return;
    const a = this.arena, start = this.tail + this.size - 1 & ~31;
    const raw = this.tail >= start ? a.dv.getFloat64(this.block + (this.tail - start) * 8, true) : a.wasm.vecGet(this.head, this.depth, this.tail);
    return a.decode(this.valueType, raw);
  }
  get isEmpty() {
    return this.size === 0;
  }
  toWorkerData() {
    return Object.freeze({ head: this.head, tail: this.tail, size: this.size, type: this.valueType, block: this.block, depth: this.depth });
  }
  static fromWorkerData(d, source = defaultArena2()) {
    return new SharedQueue2(d.type, d.head, d.tail, d.size, undefined, source, d.block, d.depth);
  }
}
structureRegistry.SharedQueue = { fromWorkerData: (d, a) => SharedQueue2.fromWorkerData(d, a) };

// shared-linked-list.ts
var current3;
var sharedMemory3;
var sharedBuffer3;
function publishCurrent3() {
  sharedMemory3 = current3.memory;
  sharedBuffer3 = current3.memory.buffer;
}
function defaultArena3() {
  if (!current3) {
    current3 = new Arena;
    publishCurrent3();
  }
  return current3;
}
function resetLinkedList2() {
  current3 = new Arena;
  publishCurrent3();
}
class SharedLinkedList2 extends Snapshot {
  head;
  tail;
  tailSize;
  size;
  valueType;
  constructor(type, head = 0, tail = 0, size = 0, source = defaultArena3(), tailSize = 0) {
    super(source);
    this.valueType = type;
    this.head = head;
    this.tail = tail;
    this.size = checkedSize(size);
    this.tailSize = tailSize;
    Object.freeze(this);
  }
  insert(index, value) {
    if (index === this.size)
      return this.append(value);
    const a = this.arena, raw = a.encode(this.valueType, value), size = checkedSize(this.size + 1), before = this.size - this.tailSize;
    if (index >= before && this.tailSize < 32)
      return new SharedLinkedList2(this.valueType, this.head, a.wasm.tailInsert(this.tail, this.tailSize, index - before, raw) >>> 0, size, a, this.tailSize + 1);
    let head = this.head;
    if (index >= before && this.tailSize)
      head = a.wasm.blockAppend(head, this.tail, this.tailSize) >>> 0;
    const root = a.wasm.blockInsert(head, index, raw) >>> 0;
    return new SharedLinkedList2(this.valueType, root, index >= before ? 0 : this.tail, size, a, index >= before ? 0 : this.tailSize);
  }
  removeAt(index) {
    if (!validIndex(index, this.size))
      return this;
    const a = this.arena;
    a.assertWritable();
    const before = this.size - this.tailSize;
    if (index >= before)
      return new SharedLinkedList2(this.valueType, this.head, a.wasm.tailRemove(this.tail, this.tailSize, index - before) >>> 0, this.size - 1, a, this.tailSize - 1);
    return new SharedLinkedList2(this.valueType, a.wasm.blockDelete(this.head, index) >>> 0, this.tail, this.size - 1, a, this.tailSize);
  }
  prepend(value) {
    return this.insert(0, value);
  }
  append(value) {
    const a = this.arena, raw = a.encode(this.valueType, value), size = checkedSize(this.size + 1);
    if (this.tailSize < 32)
      return new SharedLinkedList2(this.valueType, this.head, a.wasm.tailAppend(this.tail, this.tailSize, raw) >>> 0, size, a, this.tailSize + 1);
    const head = a.wasm.blockAppend(this.head, this.tail, 32) >>> 0;
    return new SharedLinkedList2(this.valueType, head, a.wasm.tailAppend(0, 0, raw) >>> 0, size, a, 1);
  }
  removeFirst() {
    return this.removeAt(0);
  }
  getFirst() {
    return this.get(0);
  }
  getLast() {
    return this.get(this.size - 1);
  }
  get(index) {
    if (!validIndex(index, this.size))
      return;
    const a = this.arena, before = this.size - this.tailSize;
    const raw = index >= before ? a.dv.getFloat64(this.tail + (index - before) * 8, true) : a.wasm.blockGet(this.head, index);
    return a.decode(this.valueType, raw);
  }
  insertAfter(index, value) {
    return validIndex(index, this.size) ? this.insert(index + 1, value) : this;
  }
  forEach(fn) {
    const a = this.arena;
    let i = 0;
    for (const raw of a.blocks(this.head))
      fn(a.decode(this.valueType, raw), i++);
    for (let t = 0;t < this.tailSize; t++)
      fn(a.decode(this.valueType, a.dv.getFloat64(this.tail + t * 8, true)), i++);
  }
  toArray() {
    const result = [];
    this.forEach((value) => result.push(value));
    return result;
  }
  get isEmpty() {
    return this.size === 0;
  }
  toWorkerData() {
    return Object.freeze({ head: this.head, tail: this.tail, tailSize: this.tailSize, size: this.size, type: this.valueType });
  }
  static fromWorkerData(d, source = defaultArena3()) {
    return new SharedLinkedList2(d.type, d.head, d.tail, d.size, source, d.tailSize);
  }
  removeAfter(index) {
    return validIndex(index, this.size - 1) ? this.removeAt(index + 1) : this;
  }
}
structureRegistry.SharedLinkedList = { fromWorkerData: (d, a) => SharedLinkedList2.fromWorkerData(d, a) };

// shared-doubly-linked-list.ts
var current4;
var sharedMemory4;
var sharedBuffer4;
function publishCurrent4() {
  sharedMemory4 = current4.memory;
  sharedBuffer4 = current4.memory.buffer;
}
function defaultArena4() {
  if (!current4) {
    current4 = new Arena;
    publishCurrent4();
  }
  return current4;
}
function resetDoublyLinkedList2() {
  current4 = new Arena;
  publishCurrent4();
}
class SharedDoublyLinkedList2 extends Snapshot {
  head;
  tail;
  tailSize;
  size;
  valueType;
  constructor(type, head = 0, tail = 0, size = 0, source = defaultArena4(), tailSize = 0) {
    super(source);
    this.valueType = type;
    this.head = head;
    this.tail = tail;
    this.size = checkedSize(size);
    this.tailSize = tailSize;
    Object.freeze(this);
  }
  insert(index, value) {
    if (index === this.size)
      return this.append(value);
    const a = this.arena, raw = a.encode(this.valueType, value), size = checkedSize(this.size + 1), before = this.size - this.tailSize;
    if (index >= before && this.tailSize < 32)
      return new SharedDoublyLinkedList2(this.valueType, this.head, a.wasm.tailInsert(this.tail, this.tailSize, index - before, raw) >>> 0, size, a, this.tailSize + 1);
    let head = this.head;
    if (index >= before && this.tailSize)
      head = a.wasm.blockAppend(head, this.tail, this.tailSize) >>> 0;
    const root = a.wasm.blockInsert(head, index, raw) >>> 0;
    return new SharedDoublyLinkedList2(this.valueType, root, index >= before ? 0 : this.tail, size, a, index >= before ? 0 : this.tailSize);
  }
  removeAt(index) {
    if (!validIndex(index, this.size))
      return this;
    const a = this.arena;
    a.assertWritable();
    const before = this.size - this.tailSize;
    if (index >= before)
      return new SharedDoublyLinkedList2(this.valueType, this.head, a.wasm.tailRemove(this.tail, this.tailSize, index - before) >>> 0, this.size - 1, a, this.tailSize - 1);
    return new SharedDoublyLinkedList2(this.valueType, a.wasm.blockDelete(this.head, index) >>> 0, this.tail, this.size - 1, a, this.tailSize);
  }
  prepend(value) {
    return this.insert(0, value);
  }
  append(value) {
    const a = this.arena, raw = a.encode(this.valueType, value), size = checkedSize(this.size + 1);
    if (this.tailSize < 32)
      return new SharedDoublyLinkedList2(this.valueType, this.head, a.wasm.tailAppend(this.tail, this.tailSize, raw) >>> 0, size, a, this.tailSize + 1);
    const head = a.wasm.blockAppend(this.head, this.tail, 32) >>> 0;
    return new SharedDoublyLinkedList2(this.valueType, head, a.wasm.tailAppend(0, 0, raw) >>> 0, size, a, 1);
  }
  removeFirst() {
    return this.removeAt(0);
  }
  getFirst() {
    return this.get(0);
  }
  getLast() {
    return this.get(this.size - 1);
  }
  get(index) {
    if (!validIndex(index, this.size))
      return;
    const a = this.arena, before = this.size - this.tailSize;
    const raw = index >= before ? a.dv.getFloat64(this.tail + (index - before) * 8, true) : a.wasm.blockGet(this.head, index);
    return a.decode(this.valueType, raw);
  }
  insertAfter(index, value) {
    return validIndex(index, this.size) ? this.insert(index + 1, value) : this;
  }
  forEach(fn) {
    const a = this.arena;
    let i = 0;
    for (const raw of a.blocks(this.head))
      fn(a.decode(this.valueType, raw), i++);
    for (let t = 0;t < this.tailSize; t++)
      fn(a.decode(this.valueType, a.dv.getFloat64(this.tail + t * 8, true)), i++);
  }
  toArray() {
    const result = [];
    this.forEach((value) => result.push(value));
    return result;
  }
  get isEmpty() {
    return this.size === 0;
  }
  toWorkerData() {
    return Object.freeze({ head: this.head, tail: this.tail, tailSize: this.tailSize, size: this.size, type: this.valueType });
  }
  static fromWorkerData(d, source = defaultArena4()) {
    return new SharedDoublyLinkedList2(d.type, d.head, d.tail, d.size, source, d.tailSize);
  }
  removeLast() {
    return this.removeAt(this.size - 1);
  }
  remove(index) {
    return this.removeAt(index);
  }
  insertBefore(index, value) {
    return validIndex(index, this.size) ? this.insert(index, value) : this;
  }
  forEachReverse(fn) {
    const a = this.arena;
    let i = this.size - 1;
    for (let t = this.tailSize - 1;t >= 0; t--)
      fn(a.decode(this.valueType, a.dv.getFloat64(this.tail + t * 8, true)), i--);
    for (const raw of a.blocks(this.head, true))
      fn(a.decode(this.valueType, raw), i--);
  }
  toArrayReverse() {
    const result = [];
    this.forEachReverse((value) => result.push(value));
    return result;
  }
}
structureRegistry.SharedDoublyLinkedList = { fromWorkerData: (d, a) => SharedDoublyLinkedList2.fromWorkerData(d, a) };

// shared-ordered-map.ts
var current5;
var sharedMemory5;
var sharedBuffer5;
function publishCurrent5() {
  sharedMemory5 = current5.memory;
  sharedBuffer5 = current5.memory.buffer;
}
function defaultArena5() {
  if (!current5) {
    current5 = new Arena;
    publishCurrent5();
  }
  return current5;
}
function resetOrderedMap2() {
  current5 = new Arena;
  publishCurrent5();
}
class SharedOrderedMap2 extends Snapshot {
  root;
  head;
  tail;
  size;
  valueType;
  orderStable;
  constructor(type, root = 0, head = 0, tail = 0, _size = undefined, source = defaultArena5(), orderStable = root === 0 && head === 0) {
    super(source);
    this.valueType = type;
    this.root = root;
    this.head = head;
    this.tail = tail;
    this.size = _size ?? source.wasm.mapSize(root);
    this.orderStable = orderStable;
    Object.freeze(this);
  }
  set(key, value) {
    const a = this.arena;
    a.assertWritable();
    if (a.sameValue(this.root, key, this.valueType, value, 4))
      return this;
    checkedSize(this.tail + 1);
    const root = this.valueType === "number" ? a.writeNumber(this.root, key, value, 1, this.head, this.tail) : this.valueType === "string" ? a.writeString(this.root, key, value, 1, this.head, this.tail) : a.write(this.valueType, this.root, key, value, 1, this.head, this.tail);
    return new SharedOrderedMap2(this.valueType, root, a.writeHead, a.writeCount, a.writeSize, a, this.orderStable && a.writeSize > this.size);
  }
  get(key) {
    return this.arena.value(this.root, key, this.valueType, 4);
  }
  has(key) {
    return this.arena.contains(this.root, key);
  }
  delete(key) {
    const a = this.arena, root = a.delete(this.root, key);
    if (root === this.root)
      return this;
    return root ? new SharedOrderedMap2(this.valueType, root, this.head, this.tail, this.size - 1, a, false) : new SharedOrderedMap2(this.valueType, 0, 0, 0, 0, a);
  }
  *entries() {
    const a = this.arena, order = [], view = a.dv;
    let p = this.head;
    while (p) {
      order.push(view.getUint32(p + 4, true));
      p = view.getUint32(p, true);
    }
    for (let i = order.length - 1;i >= 0; i--) {
      const old = order[i];
      if (this.orderStable) {
        yield [a.leafKey(old), a.leafValue(this.valueType, old, 4)];
        continue;
      }
      const dv = a.dv, length = dv.getUint32(old + 8, true);
      const leaf = a.wasm.mapFind(this.root, old + 16, length, dv.getUint32(old + 4, true)) >>> 0;
      if (leaf && a.dv.getUint32(leaf + 16 + length, true) === a.dv.getUint32(old + 16 + length, true))
        yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf, 4)];
    }
  }
  *keys() {
    for (const [key] of this.entries())
      yield key;
  }
  *values() {
    for (const [, value] of this.entries())
      yield value;
  }
  forEach(fn) {
    for (const [key, value] of this.entries())
      fn(value, key);
  }
  toWorkerData() {
    return Object.freeze({ root: this.root, head: this.head, tail: this.tail, size: this.size, valueType: this.valueType, orderStable: this.orderStable });
  }
  static fromWorkerData(d, source = defaultArena5()) {
    return new SharedOrderedMap2(d.valueType, d.root, d.head, d.tail, d.size, source, d.orderStable ?? false);
  }
}
structureRegistry.SharedOrderedMap = { fromWorkerData: (d, a) => SharedOrderedMap2.fromWorkerData(d, a) };

// shared-ordered-set.ts
class SharedOrderedSet2 extends Snapshot {
  _map;
  constructor(map) {
    const data = map ?? new SharedOrderedMap2("number");
    super(arenaOf(data));
    this._map = data;
    Object.freeze(this);
  }
  add(value) {
    const key = encodeSetKey(value);
    return this._map.has(key) ? this : new SharedOrderedSet2(this._map.set(key, 0));
  }
  has(value) {
    return this._map.has(encodeSetKey(value));
  }
  delete(value) {
    const map = this._map.delete(encodeSetKey(value));
    return map === this._map ? this : new SharedOrderedSet2(map);
  }
  get size() {
    return this._map.size;
  }
  *values() {
    for (const key of this._map.keys())
      yield decodeSetKey(key);
  }
  forEach(fn) {
    for (const value of this.values())
      fn(value);
  }
  toWorkerData() {
    return this._map.toWorkerData();
  }
  static fromWorkerData(d, a) {
    return new SharedOrderedSet2(SharedOrderedMap2.fromWorkerData({ ...d, valueType: "number" }, a));
  }
}
structureRegistry.SharedOrderedSet = { fromWorkerData: (d, a) => SharedOrderedSet2.fromWorkerData(d, a) };

// shared-sorted-map.ts
var current6;
var sharedMemory6;
var sharedBuffer6;
function publishCurrent6() {
  sharedMemory6 = current6.memory;
  sharedBuffer6 = current6.memory.buffer;
}
function defaultArena6() {
  if (!current6) {
    current6 = new Arena;
    publishCurrent6();
  }
  return current6;
}
function resetSortedMap2() {
  current6 = new Arena;
  publishCurrent6();
}
class SharedSortedMap2 extends Snapshot {
  root;
  size;
  valueType;
  comparator;
  constructor(type, comparator, root = 0, _size = undefined, source = defaultArena6()) {
    super(source);
    this.valueType = type;
    this.comparator = comparator;
    this.root = root;
    this.size = _size ?? source.wasm.radixSize(root);
    Object.freeze(this);
  }
  set(key, value) {
    const a = this.arena;
    a.assertWritable();
    if (a.sameValue(this.root, key, this.valueType, value, 0, true))
      return this;
    const root = this.valueType === "number" ? a.writeNumber(this.root, key, value, 2) : this.valueType === "string" ? a.writeString(this.root, key, value, 2) : a.write(this.valueType, this.root, key, value, 2);
    return new SharedSortedMap2(this.valueType, this.comparator, root, a.writeSize, a);
  }
  get(key) {
    return this.arena.value(this.root, key, this.valueType, 0, true);
  }
  has(key) {
    return this.arena.radixFind(this.root, key) !== 0;
  }
  delete(key) {
    const a = this.arena;
    a.assertWritable();
    const leaf = a.radixFind(this.root, key);
    if (!leaf)
      return this;
    return new SharedSortedMap2(this.valueType, this.comparator, a.wasm.radixDelete(this.root, leaf + 16, a.dv.getUint32(leaf + 8, true)) >>> 0, undefined, a);
  }
  *naturalEntries() {
    const a = this.arena;
    for (const leaf of a.radixLeaves(this.root))
      yield [a.leafKey(leaf), a.leafValue(this.valueType, leaf)];
  }
  *entries() {
    if (this.comparator)
      yield* [...this.naturalEntries()].sort((a, b) => this.comparator(a[0], b[0]));
    else
      yield* this.naturalEntries();
  }
  *keys() {
    for (const [key] of this.entries())
      yield key;
  }
  *values() {
    for (const [, value] of this.entries())
      yield value;
  }
  forEach(fn) {
    for (const [key, value] of this.entries())
      fn(value, key);
  }
  toWorkerData() {
    if (this.comparator)
      throw new Error("Custom comparator functions cannot be sent to workers");
    return Object.freeze({ root: this.root, size: this.size, valueType: this.valueType });
  }
  static fromWorkerData(d, source = defaultArena6()) {
    return new SharedSortedMap2(d.valueType, undefined, d.root, d.size, source);
  }
}
structureRegistry.SharedSortedMap = { fromWorkerData: (d, a) => SharedSortedMap2.fromWorkerData(d, a) };

// shared-sorted-set.ts
class SharedSortedSet2 extends Snapshot {
  _map;
  comparator;
  constructor(comparator, map) {
    const compare = comparator ? (a, b) => comparator(String(decodeSetKey(a)), String(decodeSetKey(b))) : undefined;
    const data = map ?? new SharedSortedMap2("number", compare);
    super(arenaOf(data));
    this._map = data;
    this.comparator = comparator;
    Object.freeze(this);
  }
  add(value) {
    const key = encodeSetKey(value);
    return this._map.has(key) ? this : new SharedSortedSet2(this.comparator, this._map.set(key, 0));
  }
  has(value) {
    return this._map.has(encodeSetKey(value));
  }
  delete(value) {
    const map = this._map.delete(encodeSetKey(value));
    return map === this._map ? this : new SharedSortedSet2(this.comparator, map);
  }
  get size() {
    return this._map.size;
  }
  *values() {
    for (const key of this._map.keys())
      yield decodeSetKey(key);
  }
  forEach(fn) {
    for (const value of this.values())
      fn(value);
  }
  toWorkerData() {
    return this._map.toWorkerData();
  }
  static fromWorkerData(d, a) {
    return new SharedSortedSet2(undefined, SharedSortedMap2.fromWorkerData({ ...d, valueType: "number" }, a));
  }
}
structureRegistry.SharedSortedSet = { fromWorkerData: (d, a) => SharedSortedSet2.fromWorkerData(d, a) };

// shared-priority-queue.ts
var current7;
var sharedMemory7;
var sharedBuffer7;
function publishCurrent7() {
  sharedMemory7 = current7.memory;
  sharedBuffer7 = current7.memory.buffer;
}
function defaultArena7() {
  if (!current7) {
    current7 = new Arena;
    publishCurrent7();
  }
  return current7;
}
function resetPriorityQueue2() {
  current7 = new Arena;
  publishCurrent7();
}
class SharedPriorityQueue2 extends Snapshot {
  root;
  size;
  valueType;
  isMaxHeap;
  constructor(type, options, source = defaultArena7()) {
    super(source);
    this.valueType = type;
    if (options && "root" in options) {
      this.root = options.root;
      this.size = options.size;
      this.isMaxHeap = options.isMaxHeap;
    } else {
      this.root = 0;
      this.size = 0;
      this.isMaxHeap = options && "maxHeap" in options ? options.maxHeap ?? false : false;
    }
    Object.freeze(this);
  }
  enqueue(value, priority) {
    if (typeof priority !== "number" || Number.isNaN(priority))
      throw new TypeError("Priority must be a number other than NaN");
    const a = this.arena;
    a.assertWritable();
    const size = checkedSize(this.size + 1);
    const root = a.wasm.heapInsert(this.root, priority, a.encode(this.valueType, value), this.isMaxHeap) >>> 0;
    return new SharedPriorityQueue2(this.valueType, { root, size, isMaxHeap: this.isMaxHeap }, a);
  }
  dequeue() {
    if (!this.size)
      return this;
    const a = this.arena;
    a.assertWritable();
    return new SharedPriorityQueue2(this.valueType, { root: a.wasm.heapPop(this.root, this.isMaxHeap) >>> 0, size: this.size - 1, isMaxHeap: this.isMaxHeap }, a);
  }
  peek() {
    const a = this.arena;
    return this.size ? a.decode(this.valueType, a.dv.getFloat64(this.root + 8, true)) : undefined;
  }
  peekPriority() {
    return this.size ? this.arena.dv.getFloat64(this.root, true) : undefined;
  }
  *entries() {
    const arena = this.arena, pending = this.root ? [this.root] : [];
    while (pending.length) {
      const node = pending.pop();
      const priority = arena.dv.getFloat64(node, true);
      const value = arena.decode(this.valueType, arena.dv.getFloat64(node + 8, true));
      const left = arena.dv.getUint32(node + 16, true), right = arena.dv.getUint32(node + 20, true);
      if (right)
        pending.push(right);
      if (left)
        pending.push(left);
      yield [value, priority];
    }
  }
  get isEmpty() {
    return this.size === 0;
  }
  toWorkerData() {
    return Object.freeze({ root: this.root, size: this.size, type: this.valueType, isMaxHeap: this.isMaxHeap });
  }
  static fromWorkerData(d, source = defaultArena7()) {
    return new SharedPriorityQueue2(d.type, d, source);
  }
}
structureRegistry.SharedPriorityQueue = { fromWorkerData: (d, a) => SharedPriorityQueue2.fromWorkerData(d, a) };
// compaction.ts
var classes = {
  SharedMap: SharedMap2,
  SharedList: SharedList2,
  SharedSet: SharedSet2,
  SharedStack: SharedStack2,
  SharedQueue: SharedQueue2,
  SharedLinkedList: SharedLinkedList2,
  SharedDoublyLinkedList: SharedDoublyLinkedList2,
  SharedOrderedMap: SharedOrderedMap2,
  SharedOrderedSet: SharedOrderedSet2,
  SharedSortedMap: SharedSortedMap2,
  SharedSortedSet: SharedSortedSet2,
  SharedPriorityQueue: SharedPriorityQueue2
};
var classEntries = Object.entries(classes);

class Compactor {
  target = new Arena;
  snapshots = new Map;
  pointers = new Map;
  key(a, kind, p) {
    return `${a.id}:${kind}:${p}`;
  }
  bytes(a, start, length) {
    const p = this.target.alloc(length);
    this.target.buf.set(a.buf.subarray(start, start + length), p);
    return p;
  }
  raw(a, type, raw) {
    if (type === "number" || type === "boolean")
      return raw;
    const key = this.key(a, type, raw), saved = this.pointers.get(key);
    if (saved !== undefined)
      return saved;
    const p = parseNestedType(type) ? this.target.encode(type, this.snapshot(a.decode(type, raw))) : this.bytes(a, raw, 4 + a.dv.getUint32(raw, true));
    this.pointers.set(key, p);
    return p;
  }
  leaf(a, type, leaf, prefix = 0, ordinal = -1) {
    const key = this.key(a, `${type}/${prefix}/${ordinal}`, leaf), saved = this.pointers.get(key);
    if (saved !== undefined)
      return saved;
    const dv = a.dv, keyLen = dv.getUint32(leaf + 8, true), length = dv.getUint32(leaf + 12, true);
    let value;
    if (parseNestedType(type)) {
      const child = a.decodeAt(type, leaf + 16 + keyLen + prefix, length - prefix);
      value = this.target.prepare(type, this.snapshot(child));
    } else
      value = a.buf.subarray(leaf + 16 + keyLen + prefix, leaf + 16 + keyLen + length);
    const p = this.target.wasm.mapLeaf(keyLen, value.length + prefix) >>> 0;
    this.target.dv.setUint32(p + 4, dv.getUint32(leaf + 4, true), true);
    this.target.buf.set(a.buf.subarray(leaf + 16, leaf + 16 + keyLen), p + 16);
    if (prefix)
      this.target.dv.setUint32(p + 16 + keyLen, ordinal, true);
    this.target.buf.set(value, p + 16 + keyLen + prefix);
    this.pointers.set(key, p);
    return p;
  }
  index(leaves, sorted) {
    if (!leaves.length)
      return 0;
    const input = this.target.alloc(leaves.length * 4), dv = this.target.dv;
    for (let i = 0;i < leaves.length; i++)
      dv.setUint32(input + i * 4, leaves[i], true);
    return (sorted ? this.target.wasm.radixBuild(input, leaves.length) : this.target.wasm.mapBatch(0, input, leaves.length)) >>> 0;
  }
  vector(a, d, type, sequence, queue) {
    const size = d.size;
    const values = [];
    if (sequence) {
      for (const value of a.blocks(d.head))
        values.push(this.raw(a, type, value));
      for (let i = 0;i < d.tailSize; i++)
        values.push(this.raw(a, type, a.dv.getFloat64(d.tail + i * 8, true)));
    } else {
      const total = size + (queue ? d.tail : 0), tailLen = total ? (total - 1 & 31) + 1 : 0, prefix = total - tailLen;
      const root = queue ? d.head : d.root, tail = queue ? d.block : d.tail;
      for (let i = queue ? d.tail : 0;i < total; i++) {
        const raw = i >= prefix ? a.dv.getFloat64(tail + (i - prefix) * 8, true) : a.wasm.vecGet(root, d.depth, i);
        values.push(this.raw(a, type, raw));
      }
    }
    if (values.length !== size)
      throw new Error("Invalid sequence descriptor");
    const input = size ? this.target.alloc(size * 8) : 0, dv = this.target.dv;
    for (let i = 0;i < size; i++)
      dv.setFloat64(input + i * 8, values[i], true);
    return { input, size };
  }
  heap(a, type, root) {
    if (!root)
      return 0;
    const todo = [[root, false]];
    while (todo.length) {
      const [old, ready] = todo.pop(), key = this.key(a, `heap/${type}`, old);
      if (!old || this.pointers.has(key))
        continue;
      const left = a.dv.getUint32(old + 16, true), right = a.dv.getUint32(old + 20, true);
      if (!ready) {
        todo.push([old, true], [right, false], [left, false]);
        continue;
      }
      const value = this.raw(a, type, a.dv.getFloat64(old + 8, true)), p = this.bytes(a, old, 32);
      this.target.dv.setFloat64(p + 8, value, true);
      this.target.dv.setUint32(p + 16, left ? this.pointers.get(this.key(a, `heap/${type}`, left)) : 0, true);
      this.target.dv.setUint32(p + 20, right ? this.pointers.get(this.key(a, `heap/${type}`, right)) : 0, true);
      this.pointers.set(key, p);
    }
    return this.pointers.get(this.key(a, `heap/${type}`, root));
  }
  snapshot(source) {
    if (!(source instanceof Snapshot))
      throw new TypeError("Expected an immutable shared collection");
    const kind = classEntries.find(([, C]) => source instanceof C)?.[0];
    if (!kind)
      throw new TypeError("Unsupported shared collection");
    const a = arenaOf(source);
    const localSorted = source instanceof SharedSortedMap2 ? source : source instanceof SharedSortedSet2 ? source._map : undefined;
    const comparator = localSorted?.comparator;
    const d = comparator ? { root: localSorted.root, size: localSorted.size, valueType: localSorted.valueType } : source.toWorkerData();
    const identity = `${a.id}/${kind}/${JSON.stringify(d)}`;
    const saved = comparator ? undefined : this.snapshots.get(identity);
    if (saved)
      return saved;
    const type = d.valueType ?? d.type ?? "number";
    let next;
    if (kind === "SharedMap" || kind === "SharedSet" || kind === "SharedSortedMap" || kind === "SharedSortedSet") {
      const sorted = kind === "SharedSortedMap" || kind === "SharedSortedSet", leaves = [];
      for (const leaf of sorted ? a.radixLeaves(d.root) : a.leaves(d.root))
        leaves.push(this.leaf(a, type, leaf));
      next = { ...d, root: this.index(leaves, sorted), size: leaves.length };
    } else if (kind === "SharedOrderedMap" || kind === "SharedOrderedSet") {
      const order = [], leaves = [];
      let p = d.head, head = 0;
      while (p) {
        order.push(a.dv.getUint32(p + 4, true));
        p = a.dv.getUint32(p, true);
      }
      for (let i = order.length - 1;i >= 0; i--) {
        const old = order[i], n = a.dv.getUint32(old + 8, true), leaf = a.wasm.mapFind(d.root, old + 16, n, a.dv.getUint32(old + 4, true)) >>> 0;
        if (!leaf || a.dv.getUint32(leaf + 16 + n, true) !== a.dv.getUint32(old + 16 + n, true))
          continue;
        const copied = this.leaf(a, type, leaf, 4, leaves.length);
        leaves.push(copied);
        head = this.target.wasm.orderCons(head, copied) >>> 0;
      }
      next = { ...d, root: this.index(leaves, false), head, tail: leaves.length, size: leaves.length, orderStable: true };
    } else if (kind === "SharedStack") {
      const nodes = [];
      let old = d.head, head = 0;
      while (old) {
        const saved = this.pointers.get(this.key(a, `stack/${type}`, old));
        if (saved !== undefined) {
          head = saved;
          break;
        }
        nodes.push(old);
        old = a.dv.getUint32(old, true);
      }
      for (let i = nodes.length - 1;i >= 0; i--) {
        const old = nodes[i], value = this.raw(a, type, a.dv.getFloat64(old + 8, true));
        head = this.target.wasm.cons(head, value) >>> 0;
        this.pointers.set(this.key(a, `stack/${type}`, old), head);
      }
      next = { ...d, head };
    } else if (kind === "SharedPriorityQueue")
      next = { ...d, root: this.heap(a, type, d.root) };
    else {
      const sequence = kind === "SharedLinkedList" || kind === "SharedDoublyLinkedList", queue = kind === "SharedQueue";
      const { input, size } = this.vector(a, d, type, sequence, queue), tailSize = size ? (size - 1 & 31) + 1 : 0;
      const prefix = size - tailSize, tail = size ? input + prefix * 8 : 0;
      if (sequence)
        next = { ...d, head: this.target.wasm.blockBuild(input, prefix / 32) >>> 0, tail, tailSize };
      else {
        const depth = vectorDepth(prefix), root = prefix ? this.target.wasm.vecLink(0, 0, depth, 0, input, prefix) >>> 0 : 0;
        next = queue ? { ...d, head: root, tail: 0, block: tail, depth } : { ...d, root, depth, tail };
      }
    }
    const result = comparator ? kind === "SharedSortedSet" ? new SharedSortedSet2(source.comparator, new SharedSortedMap2(type, comparator, next.root, next.size, this.target)) : new SharedSortedMap2(type, comparator, next.root, next.size, this.target) : structureRegistry[kind].fromWorkerData(next, this.target);
    if (!comparator)
      this.snapshots.set(identity, result);
    return result;
  }
}
function compact2(snapshot) {
  return new Compactor().snapshot(snapshot);
}
function compactMany2(snapshots) {
  if (Object.getOwnPropertySymbols(snapshots).length)
    throw new TypeError("Snapshot names must be strings");
  const compactor = new Compactor, result = Object.create(null);
  for (const [name, snapshot] of Object.entries(snapshots))
    result[name] = compactor.snapshot(snapshot);
  return Object.freeze(result);
}
// shared.ts
var constructors = {
  SharedMap: SharedMap2,
  SharedList: SharedList2,
  SharedSet: SharedSet2,
  SharedStack: SharedStack2,
  SharedQueue: SharedQueue2,
  SharedLinkedList: SharedLinkedList2,
  SharedDoublyLinkedList: SharedDoublyLinkedList2,
  SharedOrderedMap: SharedOrderedMap2,
  SharedOrderedSet: SharedOrderedSet2,
  SharedSortedMap: SharedSortedMap2,
  SharedSortedSet: SharedSortedSet2,
  SharedPriorityQueue: SharedPriorityQueue2
};
var constructorEntries = Object.entries(constructors);
function getWorkerData2(structures, options = {}) {
  if (Object.getOwnPropertySymbols(structures).length)
    throw new TypeError("Worker structure names must be strings");
  const copy = options.copy ?? typeof Bun !== "undefined";
  const found = new Map;
  const collect = (root) => {
    const pending = [root];
    while (pending.length) {
      const arena = pending.pop();
      if (found.has(arena.id))
        continue;
      found.set(arena.id, arena);
      for (const nested of arena.dependencies.values())
        pending.push(nested);
    }
  };
  const serialized = Object.create(null);
  for (const [name, structure] of Object.entries(structures)) {
    const type = constructorEntries.find(([, ctor]) => structure instanceof ctor)?.[0];
    if (!type)
      throw new TypeError(`Unsupported shared structure: ${name}`);
    const arena = arenaOf(structure);
    collect(arena);
    serialized[name] = Object.freeze({ type, arena: arena.id, data: structure.toWorkerData() });
  }
  const arenas = [...found.values()].map((arena) => Object.freeze(copy ? { id: arena.id, used: arena.used, copy: arena.copy() } : { id: arena.id, used: arena.used, memory: arena.memory }));
  return Object.freeze({ __shared: true, version: FORMAT_VERSION, arenas: Object.freeze(arenas), structures: Object.freeze(serialized) });
}
async function initWorker2(data) {
  if (!data?.__shared || data.version !== FORMAT_VERSION)
    throw new Error("Unsupported worker data; create a v4 payload with getWorkerData()");
  const arenas = new Map;
  for (const source of data.arenas) {
    if (!source.memory && !source.copy || arenas.has(source.id))
      throw new Error("Invalid arena transport");
    if (!Number.isSafeInteger(source.used) || source.used < 65536 || source.used > (source.memory?.buffer.byteLength ?? source.copy.byteLength))
      throw new Error("Invalid arena length");
    arenas.set(source.id, new Arena({ ...source, readOnly: true }));
  }
  for (const arena of arenas.values())
    for (const dependency of arenas.values())
      if (arena !== dependency)
        arena.dependencies.set(dependency.id, dependency);
  const result = Object.create(null);
  for (const [name, item] of Object.entries(data.structures)) {
    const arena = arenas.get(item.arena), factory = structureRegistry[item.type];
    if (!arena || !Object.hasOwn(constructors, item.type) || !factory)
      throw new Error(`Invalid structure: ${name}`);
    result[name] = factory.fromWorkerData(item.data, arena);
  }
  return Object.freeze(result);
}

export { SharedSet2, resetStack2, SharedStack2, resetQueue2, SharedQueue2, resetLinkedList2, SharedLinkedList2, resetDoublyLinkedList2, SharedDoublyLinkedList2, resetOrderedMap2, SharedOrderedMap2, SharedOrderedSet2, resetSortedMap2, SharedSortedMap2, SharedSortedSet2, resetPriorityQueue2, SharedPriorityQueue2, compact2, compactMany2, getWorkerData2, initWorker2 };
