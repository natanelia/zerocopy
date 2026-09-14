import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetPriorityQueue(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedPriorityQueueType = import('./types').ValueType;
export class SharedPriorityQueue<T extends string = SharedPriorityQueueType> extends Snapshot {
  readonly root: number;
  readonly size: number;
  readonly valueType: T;
  readonly isMaxHeap: boolean;
  constructor(type: T, options?: { maxHeap?: boolean } | { root: number; size: number; isMaxHeap: boolean }, source: Arena = current) {
    super(source); this.valueType = type;
    if (options && 'root' in options) { this.root = options.root; this.size = options.size; this.isMaxHeap = options.isMaxHeap; }
    else { this.root = 0; this.size = 0; this.isMaxHeap = options && 'maxHeap' in options ? options.maxHeap ?? false : false; }
    Object.freeze(this);
  }
  enqueue(value: ValueOf<T>, priority: number): SharedPriorityQueue<T> {
    if (typeof priority !== 'number' || Number.isNaN(priority)) throw new TypeError('Priority must be a number other than NaN');
    const a = this.arena; a.assertWritable(); const size = checkedSize(this.size + 1);
    const root = a.wasm.heapInsert(this.root, priority, a.encode(this.valueType, value), this.isMaxHeap) >>> 0;
    return new SharedPriorityQueue(this.valueType, { root, size, isMaxHeap: this.isMaxHeap }, a);
  }
  dequeue(): SharedPriorityQueue<T> {
    if (!this.size) return this;
    const a = this.arena; a.assertWritable();
    return new SharedPriorityQueue(this.valueType, { root: a.wasm.heapPop(this.root, this.isMaxHeap) >>> 0, size: this.size - 1, isMaxHeap: this.isMaxHeap }, a);
  }
  peek(): ValueOf<T> | undefined { const a = this.arena; return this.size ? a.decode(this.valueType, a.dv.getFloat64(this.root + 8, true)) : undefined; }
  peekPriority(): number | undefined { return this.size ? this.arena.dv.getFloat64(this.root, true) : undefined; }
  /** Read entries in heap traversal order, not priority order. This also works
   * on read-only worker snapshots and allocates no WASM nodes. Returned tuples
   * are detached from the immutable heap. Equal-priority order is unspecified.
   */
  *entries(): Generator<[ValueOf<T>, number]> {
    const arena = this.arena, pending = this.root ? [this.root] : [];
    while (pending.length) {
      const node = pending.pop()!;
      const priority = arena.dv.getFloat64(node, true);
      const value = arena.decode(this.valueType, arena.dv.getFloat64(node + 8, true));
      const left = arena.dv.getUint32(node + 16, true), right = arena.dv.getUint32(node + 20, true);
      if (right) pending.push(right);
      if (left) pending.push(left);
      yield [value, priority];
    }
  }
  get isEmpty(): boolean { return this.size === 0; }
  toWorkerData() { return Object.freeze({ root: this.root, size: this.size, type: this.valueType, isMaxHeap: this.isMaxHeap }); }
  static fromWorkerData<T extends string>(d: { root: number; size: number; type: T; isMaxHeap: boolean }, source: Arena = current): SharedPriorityQueue<T> { return new SharedPriorityQueue(d.type, d, source); }
}
structureRegistry.SharedPriorityQueue = { fromWorkerData: (d, a) => SharedPriorityQueue.fromWorkerData(d, a) };
