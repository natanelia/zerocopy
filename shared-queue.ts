import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
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
export function resetQueue(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return defaultArena().state(); }
export function getBufferCopy(): Uint8Array { return defaultArena().copy(); }
export function getBuffer(): SharedArrayBuffer { return defaultArena().memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedQueueType = import('./types').ValueType;
/** Persistent block vector and a read offset. No old queue link is changed. */
export class SharedQueue<T extends string = SharedQueueType> extends Snapshot {
  readonly head: number;
  readonly tail: number;
  readonly block: number;
  readonly depth: number;
  readonly size: number;
  readonly valueType: T;
  constructor(type: T, head = 0, tail = 0, size = 0, _front?: ValueOf<T>, source: Arena = defaultArena(), block = 0, depth = 0) {
    super(source); this.valueType = type; this.head = head; this.tail = tail; this.size = checkedSize(size); checkedSize(tail + size); this.block = block; this.depth = depth; Object.freeze(this);
  }
  enqueue(value: ValueOf<T>): SharedQueue<T> {
    const a = this.arena, raw = a.encode(this.valueType, value), end = checkedSize(this.tail + this.size), total = checkedSize(end + 1);
    const length = end ? ((end - 1) & 31) + 1 : 0;
    if (length < 32) return new SharedQueue(this.valueType, this.head, this.tail, this.size + 1, undefined, a, a.wasm.tailAppend(this.block, length, raw) >>> 0, this.depth);
    const depth = vectorDepth(end), head = a.wasm.vecLink(this.head, this.depth, depth, end - 32, this.block, 32) >>> 0;
    return new SharedQueue(this.valueType, head, this.tail, this.size + 1, undefined, a, a.wasm.tailAppend(0, 0, raw) >>> 0, depth);
  }
  dequeue(): SharedQueue<T> {
    if (!this.size) return this;
    const a = this.arena;
    return this.size > 1 ? new SharedQueue(this.valueType, this.head, this.tail + 1, this.size - 1, undefined, a, this.block, this.depth) : new SharedQueue(this.valueType, 0, 0, 0, undefined, a);
  }
  peek(): ValueOf<T> | undefined {
    if (!this.size) return undefined;
    const a = this.arena, start = (this.tail + this.size - 1) & ~31;
    const raw = this.tail >= start ? a.dv.getFloat64(this.block + (this.tail - start) * 8, true) : a.wasm.vecGet(this.head, this.depth, this.tail);
    return a.decode(this.valueType, raw);
  }
  get isEmpty(): boolean { return this.size === 0; }
  toWorkerData() { return Object.freeze({ head: this.head, tail: this.tail, size: this.size, type: this.valueType, block: this.block, depth: this.depth }); }
  static fromWorkerData<T extends string>(d: { head: number; tail: number; size: number; type: T; block: number; depth: number }, source: Arena = defaultArena()): SharedQueue<T> { return new SharedQueue(d.type, d.head, d.tail, d.size, undefined, source, d.block, d.depth); }
}
structureRegistry.SharedQueue = { fromWorkerData: (d, a) => SharedQueue.fromWorkerData(d, a) };
