import {
  structureRegistry,
  vectorDepth,
  validIndex,
  checkedSize,
  Snapshot,
  Arena
} from "./chunk-myjykkzh.js";

// text-search.ts
function compileStringSearch(arena, term, options = {}) {
  if (typeof term !== "string")
    throw new TypeError("Search text must be a string");
  if (options === null || typeof options !== "object")
    throw new TypeError("Expected text search options");
  const sensitive = options.caseSensitive ?? true;
  if (typeof sensitive !== "boolean")
    throw new TypeError("caseSensitive must be a boolean");
  const query = sensitive ? term : term.toLowerCase();
  if (!query.length)
    return () => true;
  const fallback = sensitive ? (raw) => arena.decode("string", raw).includes(query) : (raw) => arena.decode("string", raw).toLowerCase().includes(query);
  for (let i = 0;i < query.length; i++) {
    const code = query.charCodeAt(i);
    if (!sensitive && code > 127)
      return fallback;
    if (code >= 55296 && code <= 56319) {
      const next = query.charCodeAt(++i);
      if (!(next >= 56320 && next <= 57343))
        return fallback;
    } else if (code >= 56320 && code <= 57343)
      return fallback;
  }
  const needle = new TextEncoder().encode(query);
  const { buf: bytes, dv: view } = arena;
  const length = needle.length;
  if (length <= 16) {
    const packed = new Uint32Array(4), masks = new Uint32Array(4);
    for (let i = 0;i < length; i++) {
      const code = needle[i], shift = (i & 3) * 8;
      packed[i >>> 2] |= code << shift;
      if (!sensitive && code >= 97 && code <= 122)
        masks[i >>> 2] |= 32 << shift;
    }
    const [q0, q1, q2, q3] = packed, [m0, m1, m2, m3] = masks;
    const scan = arena.wasm.textContains16;
    const test = (raw) => {
      const result = scan(raw, length, q0, q1, q2, q3, m0, m1, m2, m3, !sensitive);
      return result < 0 ? fallback(raw) : result !== 0;
    };
    const scanBlock = arena.wasm.textContainsBlock16;
    return Object.assign(test, {
      block16: (address, count) => scanBlock(address, count, length, q0, q1, q2, q3, m0, m1, m2, m3, !sensitive),
      fallback
    });
  }
  if (length <= 32) {
    const shifts = new Uint8Array(256);
    shifts.fill(length);
    const mask = new Uint8Array(length);
    for (let i = 0;i < length; i++) {
      const code = needle[i];
      if (!sensitive && code >= 97 && code <= 122)
        mask[i] = 32;
      if (i < length - 1) {
        shifts[code] = length - 1 - i;
        if (mask[i])
          shifts[code - 32] = length - 1 - i;
      }
    }
    const words = length >>> 2, matchWords = new Int32Array(words), maskWords = new Int32Array(words);
    for (let i = 0;i < words; i++) {
      const j = i * 4;
      matchWords[i] = needle[j] | needle[j + 1] << 8 | needle[j + 2] << 16 | needle[j + 3] << 24;
      maskWords[i] = mask[j] | mask[j + 1] << 8 | mask[j + 2] << 16 | mask[j + 3] << 24;
    }
    const last = length - 1, lastByte = needle[last], lastMask = mask[last];
    return (raw) => {
      const start = raw + 4, end = start + view.getUint32(raw, true);
      for (let p = start + last;p < end; ) {
        const code = bytes[p];
        if ((code | lastMask) === lastByte) {
          const first = p - last;
          let w = 0;
          while (w < words && (view.getUint32(first + w * 4, true) | maskWords[w]) === matchWords[w])
            w++;
          if (w === words) {
            let j = words * 4;
            while (j < last && (bytes[first + j] | mask[j]) === needle[j])
              j++;
            if (j >= last)
              return true;
          }
        }
        p += shifts[code];
      }
      if (!sensitive) {
        let p = start;
        for (;p + 16 <= end; p += 16) {
          if ((view.getUint32(p) | view.getUint32(p + 4) | view.getUint32(p + 8) | view.getUint32(p + 12)) & 2155905152)
            return fallback(raw);
        }
        for (;p < end; p++)
          if (bytes[p] > 127)
            return fallback(raw);
      }
      return false;
    };
  }
  const prefix = new Uint32Array(length);
  for (let i = 1, j = 0;i < length; i++) {
    while (j && needle[i] !== needle[j])
      j = prefix[j - 1];
    if (needle[i] === needle[j])
      j++;
    prefix[i] = j;
  }
  return (raw) => {
    const end = raw + 4 + view.getUint32(raw, true);
    let j = 0;
    for (let p = raw + 4;p < end; p++) {
      let code = bytes[p];
      if (!sensitive) {
        if (code > 127)
          return fallback(raw);
        if (code >= 65 && code <= 90)
          code += 32;
      }
      while (j && code !== needle[j])
        j = prefix[j - 1];
      if (code === needle[j] && ++j === length)
        return true;
    }
    return false;
  };
}

// shared-list.ts
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
function resetSharedList2() {
  current = new Arena;
  publishCurrent();
}
class SharedList2 extends Snapshot {
  root;
  type;
  size;
  depth;
  tail;
  #readBlock = -1;
  #readAddress = 0;
  #readView;
  constructor(type, root = 0, depth = 0, size = 0, source = defaultArena(), tail = 0) {
    super(source);
    this.type = type;
    this.root = root;
    this.depth = depth;
    this.size = checkedSize(size);
    this.tail = tail;
    Object.freeze(this);
  }
  dispose() {}
  push(value) {
    const a = this.arena, raw = a.encode(this.type, value), size = checkedSize(this.size + 1);
    const length = this.size ? (this.size - 1 & 31) + 1 : 0;
    if (length < 32)
      return new SharedList2(this.type, this.root, this.depth, size, a, a.wasm.tailAppend(this.tail, length, raw) >>> 0);
    const depth = vectorDepth(this.size);
    const root = a.wasm.vecLink(this.root, this.depth, depth, this.size - 32, this.tail, 32) >>> 0;
    return new SharedList2(this.type, root, depth, size, a, a.wasm.tailAppend(0, 0, raw) >>> 0);
  }
  pushMany(values) {
    if (!values.length)
      return this;
    const a = this.arena;
    a.assertWritable();
    const size = checkedSize(this.size + values.length);
    const oldLength = this.size ? (this.size - 1 & 31) + 1 : 0;
    const input = a.encodeRange(this.type, values, this.tail, oldLength);
    const length = (size - 1 & 31) + 1, treeSize = size - length;
    const depth = vectorDepth(treeSize), start = this.size - oldLength;
    const root = a.wasm.vecLink(this.root, this.depth, depth, start, input, treeSize - start) >>> 0;
    return new SharedList2(this.type, root, depth, size, a, input + (treeSize - start) * 8);
  }
  get(index) {
    if (!validIndex(index, this.size))
      return;
    const block = index >>> 5;
    if (block !== this.#readBlock) {
      const a = this.arena;
      this.#readAddress = block === this.size - 1 >>> 5 ? this.tail : a.wasm.vecLeaf(this.root, this.depth, index) >>> 0;
      this.#readView ??= a.dv;
      this.#readBlock = block;
    }
    const raw = this.#readView.getFloat64(this.#readAddress + (index & 31) * 8, true);
    return this.type === "number" ? raw : this.arena.decode(this.type, raw);
  }
  compileTextSearch(term, options) {
    if (this.type !== "string")
      throw new TypeError("Text search requires a string list");
    const a = this.arena, match = compileStringSearch(a, term, options), view = a.dv;
    const { size, root, depth, tail } = this;
    if (match.block16) {
      const { block16: scanBlock, fallback } = match;
      let block = -1, address = 0, flags = 0;
      return (index) => {
        if (!validIndex(index, size))
          return false;
        const nextBlock = index >>> 4;
        if (nextBlock !== block) {
          const first = nextBlock * 16;
          const leaf = first >>> 5 === size - 1 >>> 5 ? tail : a.wasm.vecLeaf(root, depth, first) >>> 0;
          address = leaf + (first & 31) * 8;
          flags = scanBlock(address, Math.min(16, size - first));
          block = nextBlock;
        }
        const bit = 1 << (index & 15);
        return (flags & bit) !== 0 || (flags >>> 16 & bit) !== 0 && fallback(view.getFloat64(address + (index & 15) * 8, true));
      };
    }
    let block = -1, address = 0;
    return (index) => {
      if (!validIndex(index, size))
        return false;
      const nextBlock = index >>> 5;
      if (nextBlock !== block) {
        address = nextBlock === size - 1 >>> 5 ? tail : a.wasm.vecLeaf(root, depth, index) >>> 0;
        block = nextBlock;
      }
      return match(view.getFloat64(address + (index & 31) * 8, true));
    };
  }
  set(index, value) {
    if (!validIndex(index, this.size))
      return this;
    const a = this.arena, raw = a.encode(this.type, value), start = this.size - 1 & ~31;
    if (index >= start)
      return new SharedList2(this.type, this.root, this.depth, this.size, a, a.wasm.tailSet(this.tail, this.size - start, index - start, raw) >>> 0);
    return new SharedList2(this.type, a.wasm.vecSet(this.root, this.depth, index, raw) >>> 0, this.depth, this.size, a, this.tail);
  }
  pop() {
    if (!this.size)
      return this;
    const a = this.arena, size = this.size - 1;
    if (!size)
      return new SharedList2(this.type, 0, 0, 0, a);
    if (this.size - 1 & 31)
      return new SharedList2(this.type, this.root, this.depth, size, a, this.tail);
    const tail = a.wasm.vecLeaf(this.root, this.depth, size - 32) >>> 0;
    const depth = vectorDepth(size - 32);
    let root = this.root, oldDepth = this.depth;
    if (size === 32)
      root = 0;
    else
      while (oldDepth-- > depth)
        root = a.dv.getUint32(root, true);
    return new SharedList2(this.type, root, depth, size, a, tail);
  }
  *values() {
    if (!this.size)
      return;
    const a = this.arena, view = a.dv, start = this.size - 1 & ~31;
    const isNumber = this.type === "number", isBoolean = this.type === "boolean";
    for (let first = 0;first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const length = Math.min(32, this.size - first);
      if (isNumber) {
        for (let j = 0;j < length; j++)
          yield view.getFloat64(leaf + j * 8, true);
      } else if (isBoolean) {
        for (let j = 0;j < length; j++)
          yield view.getFloat64(leaf + j * 8, true) !== 0;
      } else {
        for (let j = 0;j < length; j++)
          yield a.decode(this.type, view.getFloat64(leaf + j * 8, true));
      }
    }
  }
  forEach(fn) {
    const a = this.arena, start = this.size ? this.size - 1 & ~31 : 0;
    for (let first = 0;first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const stop = Math.min(this.size, first + 32), view = a.dv;
      for (let i = first;i < stop; i++)
        fn(a.decode(this.type, view.getFloat64(leaf + (i - first) * 8, true)), i);
    }
  }
  toArray() {
    const a = this.arena, result = new Array(this.size);
    const start = this.size ? this.size - 1 & ~31 : 0;
    for (let first = 0;first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const stop = Math.min(this.size, first + 32), dv = a.dv;
      for (let i = first;i < stop; i++)
        result[i] = a.decode(this.type, dv.getFloat64(leaf + (i - first) * 8, true));
    }
    return result;
  }
  toWorkerData() {
    return Object.freeze({ root: this.root, depth: this.depth, size: this.size, type: this.type, tail: this.tail });
  }
  static fromWorkerData(d, source = defaultArena()) {
    return new SharedList2(d.type, d.root, d.depth, d.size, source, d.tail);
  }
}
structureRegistry.SharedList = { fromWorkerData: (d, a) => SharedList2.fromWorkerData(d, a) };

export { resetSharedList2, SharedList2 };
