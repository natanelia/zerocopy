import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
import { compileStringSearch, type TextSearchOptions } from './text-search';
// Registering a collection must not allocate an unused writer in every reader.
let current: Arena | undefined;
/** Legacy live bindings are populated on first use, explicit reset, or attachment. */
export let sharedMemory: WebAssembly.Memory;
export let sharedBuffer: SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current!.memory; sharedBuffer = current!.memory.buffer as unknown as SharedArrayBuffer; }
function defaultArena(): Arena {
  if (!current) { current = new Arena(); publishCurrent(); }
  return current;
}
export function resetSharedList(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return defaultArena().state(); }
export function getBufferCopy(): Uint8Array { return defaultArena().copy(); }
export function getBuffer(): SharedArrayBuffer { return defaultArena().memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedListType = import('./types').ValueType;
export function syncBuffer(): void { defaultArena().refresh(); }
export class SharedList<T extends string = SharedListType> extends Snapshot {
  readonly root: number;
  readonly type: T;
  readonly size: number;
  readonly depth: number;
  readonly tail: number;
  // A leaf belongs to this immutable snapshot, not the arena shared by all
  // columns. Private fields remain mutable when the public handle is frozen.
  #readBlock = -1;
  #readAddress = 0;
  #readView: DataView | undefined;
  constructor(type: T, root = 0, depth = 0, size = 0, source: Arena = defaultArena(), tail = 0) {
    super(source); this.type = type; this.root = root; this.depth = depth; this.size = checkedSize(size); this.tail = tail; Object.freeze(this);
  }
  /** @deprecated Arena lifetime is managed by JavaScript reachability. */
  dispose(): void {}
  push(value: ValueOf<T>): SharedList<T> {
    const a = this.arena, raw = a.encode(this.type, value), size = checkedSize(this.size + 1);
    const length = this.size ? ((this.size - 1) & 31) + 1 : 0;
    if (length < 32) return new SharedList(this.type, this.root, this.depth, size, a, a.wasm.tailAppend(this.tail, length, raw) >>> 0);
    const depth = vectorDepth(this.size);
    const root = a.wasm.vecLink(this.root, this.depth, depth, this.size - 32, this.tail, 32) >>> 0;
    return new SharedList(this.type, root, depth, size, a, a.wasm.tailAppend(0, 0, raw) >>> 0);
  }
  pushMany(values: readonly ValueOf<T>[]): SharedList<T> {
    if (!values.length) return this;
    const a = this.arena; a.assertWritable();
    const size = checkedSize(this.size + values.length);
    const oldLength = this.size ? ((this.size - 1) & 31) + 1 : 0;
    // Encode first. User serialization may reenter the owning arena.
    const input = a.encodeRange(this.type, values, this.tail, oldLength);
    const length = ((size - 1) & 31) + 1, treeSize = size - length;
    const depth = vectorDepth(treeSize), start = this.size - oldLength;
    const root = a.wasm.vecLink(this.root, this.depth, depth, start, input, treeSize - start) >>> 0;
    return new SharedList(this.type, root, depth, size, a, input + (treeSize - start) * 8);
  }
  get(index: number): ValueOf<T> | undefined {
    if (!validIndex(index, this.size)) return undefined;
    const block = index >>> 5;
    if (block !== this.#readBlock) {
      const a = this.arena;
      this.#readAddress = block === ((this.size - 1) >>> 5)
        ? this.tail : a.wasm.vecLeaf(this.root, this.depth, index) >>> 0;
      // Published addresses never move. Shared memory growth does not detach
      // this view; every byte reachable from this snapshot already exists.
      this.#readView ??= a.dv;
      this.#readBlock = block;
    }
    const raw = this.#readView!.getFloat64(this.#readAddress + (index & 31) * 8, true);
    return this.type === 'number' ? raw as ValueOf<T> : this.arena.decode(this.type, raw);
  }
  /** Compile a literal substring predicate bound to this immutable snapshot.
   * Valid indices match like get(index).includes(term), or lowercase/includes
   * when caseSensitive is false. Invalid indices return false. The predicate
   * reads locally, works on read-only attachments, and is not transferable.
   */
  compileTextSearch(this: SharedList<'string'>, term: string, options?: TextSearchOptions): (index: number) => boolean {
    if (this.type !== 'string') throw new TypeError('Text search requires a string list');
    const a = this.arena, match = compileStringSearch(a, term, options), view = a.dv;
    const { size, root, depth, tail } = this;
    // Amortize the JS/WASM call across at most 16 adjacent immutable values.
    // Only two bit masks are cached, not strings or an index of the dataset.
    if (match.block16) {
      const scanBlock = match.block16, fallback = match.fallback!;
      let block = -1, address = 0, flags = 0;
      return index => {
        if (!validIndex(index, size)) return false;
        const nextBlock = index >>> 4;
        if (nextBlock !== block) {
          const first = nextBlock * 16;
          const leaf = (first >>> 5) === ((size - 1) >>> 5)
            ? tail : a.wasm.vecLeaf(root, depth, first) >>> 0;
          address = leaf + (first & 31) * 8;
          flags = scanBlock(address, Math.min(16, size - first));
          block = nextBlock;
        }
        const bit = 1 << (index & 15);
        return (flags & bit) !== 0 || ((flags >>> 16) & bit) !== 0
          && fallback(view.getFloat64(address + (index & 15) * 8, true));
      };
    }
    let block = -1, address = 0;
    return index => {
      if (!validIndex(index, size)) return false;
      const nextBlock = index >>> 5;
      if (nextBlock !== block) {
        address = nextBlock === ((size - 1) >>> 5) ? tail : a.wasm.vecLeaf(root, depth, index) >>> 0;
        block = nextBlock;
      }
      return match(view.getFloat64(address + (index & 31) * 8, true));
    };
  }
  set(index: number, value: ValueOf<T>): SharedList<T> {
    if (!validIndex(index, this.size)) return this;
    const a = this.arena, raw = a.encode(this.type, value), start = (this.size - 1) & ~31;
    if (index >= start) return new SharedList(this.type, this.root, this.depth, this.size, a, a.wasm.tailSet(this.tail, this.size - start, index - start, raw) >>> 0);
    return new SharedList(this.type, a.wasm.vecSet(this.root, this.depth, index, raw) >>> 0, this.depth, this.size, a, this.tail);
  }
  pop(): SharedList<T> {
    if (!this.size) return this;
    const a = this.arena, size = this.size - 1;
    if (!size) return new SharedList(this.type, 0, 0, 0, a);
    if ((this.size - 1) & 31) return new SharedList(this.type, this.root, this.depth, size, a, this.tail);
    const tail = a.wasm.vecLeaf(this.root, this.depth, size - 32) >>> 0;
    const depth = vectorDepth(size - 32); let root = this.root, oldDepth = this.depth;
    if (size === 32) root = 0;
    else while (oldDepth-- > depth) root = a.dv.getUint32(root, true);
    return new SharedList(this.type, root, depth, size, a, tail);
  }
  *values(): Generator<ValueOf<T>> {
    if (!this.size) return;
    const a = this.arena, view = a.dv, start = (this.size - 1) & ~31;
    const isNumber = this.type === 'number', isBoolean = this.type === 'boolean';
    // Capture one existing view when iteration starts. Shared growth cannot
    // detach it, and all bytes in this immutable snapshot already exist.
    // Explicit little-endian reads also work on big-endian hosts.
    for (let first = 0; first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const length = Math.min(32, this.size - first);
      if (isNumber) {
        for (let j = 0; j < length; j++) yield view.getFloat64(leaf + j * 8, true) as ValueOf<T>;
      } else if (isBoolean) {
        for (let j = 0; j < length; j++) yield (view.getFloat64(leaf + j * 8, true) !== 0) as ValueOf<T>;
      } else {
        for (let j = 0; j < length; j++) yield a.decode(this.type, view.getFloat64(leaf + j * 8, true));
      }
    }
  }
  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    const a = this.arena, view = a.dv, start = this.size ? (this.size - 1) & ~31 : 0;
    const isNumber = this.type === 'number', isBoolean = this.type === 'boolean';
    // A callback may grow the writer or scan a fork. This view and each leaf
    // still refer only to the original snapshot; no per-leaf view is allocated.
    for (let first = 0; first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const length = Math.min(32, this.size - first);
      if (isNumber) {
        for (let j = 0; j < length; j++) fn(view.getFloat64(leaf + j * 8, true) as ValueOf<T>, first + j);
      } else if (isBoolean) {
        for (let j = 0; j < length; j++) fn((view.getFloat64(leaf + j * 8, true) !== 0) as ValueOf<T>, first + j);
      } else {
        for (let j = 0; j < length; j++) fn(a.decode(this.type, view.getFloat64(leaf + j * 8, true)), first + j);
      }
    }
  }
  toArray(): ValueOf<T>[] {
    const a = this.arena, view = a.dv, result = new Array<ValueOf<T>>(this.size);
    const start = this.size ? (this.size - 1) & ~31 : 0;
    const isNumber = this.type === 'number', isBoolean = this.type === 'boolean';
    for (let first = 0; first < this.size; first += 32) {
      const leaf = first === start ? this.tail : a.wasm.vecLeaf(this.root, this.depth, first) >>> 0;
      const length = Math.min(32, this.size - first);
      if (isNumber) {
        for (let j = 0; j < length; j++) result[first + j] = view.getFloat64(leaf + j * 8, true) as ValueOf<T>;
      } else if (isBoolean) {
        for (let j = 0; j < length; j++) result[first + j] = (view.getFloat64(leaf + j * 8, true) !== 0) as ValueOf<T>;
      } else {
        for (let j = 0; j < length; j++) result[first + j] = a.decode(this.type, view.getFloat64(leaf + j * 8, true));
      }
    }
    return result;
  }
  toWorkerData() { return Object.freeze({ root: this.root, depth: this.depth, size: this.size, type: this.type, tail: this.tail }); }
  static fromWorkerData<T extends string>(d: { root: number; depth: number; size: number; type: T; tail: number }, source: Arena = defaultArena()): SharedList<T> {
    return new SharedList(d.type, d.root, d.depth, d.size, source, d.tail);
  }
}
structureRegistry.SharedList = { fromWorkerData: (d, a) => SharedList.fromWorkerData(d, a) };
