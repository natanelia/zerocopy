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
export function resetStack(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return defaultArena().state(); }
export function getBufferCopy(): Uint8Array { return defaultArena().copy(); }
export function getBuffer(): SharedArrayBuffer { return defaultArena().memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedStackType = import('./types').ValueType;
export class SharedStack<T extends string = SharedStackType> extends Snapshot {
  readonly head: number;
  private readonly encodedTop: number;
  readonly size: number;
  readonly valueType: T;
  constructor(type: T, head = 0, size = 0, _top?: ValueOf<T>, source: Arena = defaultArena(), encodedTop?: number) {
    super(source); this.valueType = type; this.head = head; this.size = checkedSize(size); this.encodedTop = encodedTop ?? (head ? source.dv.getFloat64(head + 8, true) : 0); Object.freeze(this);
  }
  push(value: ValueOf<T>): SharedStack<T> {
    const a = this.arena; a.assertWritable();
    const size = checkedSize(this.size + 1), raw = a.encode(this.valueType, value), head = a.wasm.cons(this.head, raw) >>> 0;
    return new SharedStack(this.valueType, head, size, undefined, a, raw);
  }
  pop(): SharedStack<T> {
    if (!this.size) return this;
    const a = this.arena; return new SharedStack(this.valueType, a.dv.getUint32(this.head, true), this.size - 1, undefined, a);
  }
  peek(): ValueOf<T> | undefined { return this.size ? this.arena.decode(this.valueType, this.encodedTop) : undefined; }
  get isEmpty(): boolean { return this.size === 0; }
  toWorkerData() { return Object.freeze({ head: this.head, size: this.size, type: this.valueType }); }
  static fromWorkerData<T extends string>(d: { head: number; size: number; type: T }, source: Arena = defaultArena()): SharedStack<T> { return new SharedStack(d.type, d.head, d.size, undefined, source); }
}
structureRegistry.SharedStack = { fromWorkerData: (d, a) => SharedStack.fromWorkerData(d, a) };
