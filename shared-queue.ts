import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetQueue(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedQueueType = import('./types').ValueType;
/** Persistent vector plus a read offset: enqueue copies a path; dequeue changes only the descriptor. */
export class SharedQueue<T extends string = SharedQueueType> extends Snapshot {
  readonly head: number;
  readonly tail: number;
  readonly size: number;
  readonly valueType: T;
  constructor(type: T, head = 0, tail = 0, size = 0, _front?: ValueOf<T>, source: Arena = current) {
    super(source); this.valueType = type; this.head = head; this.tail = tail; this.size = checkedSize(size); checkedSize(tail + size); Object.freeze(this);
  }
  enqueue(value: ValueOf<T>): SharedQueue<T> {
    const a = arenaOf(this); a.assertWritable(); const end = checkedSize(this.tail + this.size), total = checkedSize(end + 1);
    const head = a.wasm.vecPush(this.head, vectorDepth(end), vectorDepth(total), end, a.encode(this.valueType, value)) >>> 0;
    return new SharedQueue(this.valueType, head, this.tail, this.size + 1, undefined, a);
  }
  dequeue(): SharedQueue<T> {
    if (!this.size) return this;
    return new SharedQueue(this.valueType, this.size > 1 ? this.head : 0, this.size > 1 ? this.tail + 1 : 0, this.size - 1, undefined, arenaOf(this));
  }
  peek(): ValueOf<T> | undefined {
    const a = arenaOf(this); return this.size ? a.decode(this.valueType, a.wasm.vecGet(this.head, vectorDepth(this.tail + this.size), this.tail)) : undefined;
  }
  get isEmpty(): boolean { return this.size === 0; }
  toWorkerData() { return Object.freeze({ head: this.head, tail: this.tail, size: this.size, type: this.valueType }); }
  static fromWorkerData<T extends string>(d: { head: number; tail: number; size: number; type: T }, source: Arena = current): SharedQueue<T> { return new SharedQueue(d.type, d.head, d.tail, d.size, undefined, source); }
}
structureRegistry.SharedQueue = { fromWorkerData: (d, a) => SharedQueue.fromWorkerData(d, a) };
