import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetStack(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedStackType = import('./types').ValueType;
export class SharedStack<T extends string = SharedStackType> extends Snapshot {
  readonly head: number;
  readonly size: number;
  readonly valueType: T;
  constructor(type: T, head = 0, size = 0, _top?: ValueOf<T>, source: Arena = current) {
    super(source); this.valueType = type; this.head = head; this.size = checkedSize(size); Object.freeze(this);
  }
  push(value: ValueOf<T>): SharedStack<T> {
    const a = arenaOf(this); a.assertWritable();
    const size = checkedSize(this.size + 1), head = a.wasm.cons(this.head, a.encode(this.valueType, value)) >>> 0;
    return new SharedStack(this.valueType, head, size, undefined, a);
  }
  pop(): SharedStack<T> {
    if (!this.size) return this;
    const a = arenaOf(this); return new SharedStack(this.valueType, a.dv.getUint32(this.head, true), this.size - 1, undefined, a);
  }
  peek(): ValueOf<T> | undefined { const a = arenaOf(this); return this.size ? a.decode(this.valueType, a.dv.getFloat64(this.head + 8, true)) : undefined; }
  get isEmpty(): boolean { return this.size === 0; }
  toWorkerData() { return Object.freeze({ head: this.head, size: this.size, type: this.valueType }); }
  static fromWorkerData<T extends string>(d: { head: number; size: number; type: T }, source: Arena = current): SharedStack<T> { return new SharedStack(d.type, d.head, d.size, undefined, source); }
}
structureRegistry.SharedStack = { fromWorkerData: (d, a) => SharedStack.fromWorkerData(d, a) };
