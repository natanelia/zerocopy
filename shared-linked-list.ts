import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetLinkedList(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedLinkedListType = import('./types').ValueType;
/** Persistent block sequence with an append-only tail. */
export class SharedLinkedList<T extends string = SharedLinkedListType> extends Snapshot {
  readonly head: number;
  readonly tail: number;
  readonly tailSize: number;
  readonly size: number;
  readonly valueType: T;
  constructor(type: T, head = 0, tail = 0, size = 0, source: Arena = current, tailSize = 0) {
    super(source); this.valueType = type; this.head = head; this.tail = tail; this.size = checkedSize(size); this.tailSize = tailSize; Object.freeze(this);
  }
  private insert(index: number, value: ValueOf<T>): SharedLinkedList<T> {
    if (index === this.size) return this.append(value);
    const a = arenaOf(this), raw = a.encode(this.valueType, value), size = checkedSize(this.size + 1), before = this.size - this.tailSize;
    if (index >= before && this.tailSize < 32) return new SharedLinkedList(this.valueType, this.head, a.wasm.tailInsert(this.tail, this.tailSize, index - before, raw) >>> 0, size, a, this.tailSize + 1);
    let head = this.head;
    if (index >= before && this.tailSize) head = a.wasm.blockAppend(head, this.tail, this.tailSize) >>> 0;
    const root = a.wasm.blockInsert(head, index, raw) >>> 0;
    return new SharedLinkedList(this.valueType, root, index >= before ? 0 : this.tail, size, a, index >= before ? 0 : this.tailSize);
  }
  private removeAt(index: number): SharedLinkedList<T> {
    if (!validIndex(index, this.size)) return this;
    const a = arenaOf(this); a.assertWritable(); const before = this.size - this.tailSize;
    if (index >= before) return new SharedLinkedList(this.valueType, this.head, a.wasm.tailRemove(this.tail, this.tailSize, index - before) >>> 0, this.size - 1, a, this.tailSize - 1);
    return new SharedLinkedList(this.valueType, a.wasm.blockDelete(this.head, index) >>> 0, this.tail, this.size - 1, a, this.tailSize);
  }
  prepend(value: ValueOf<T>): SharedLinkedList<T> { return this.insert(0, value); }
  append(value: ValueOf<T>): SharedLinkedList<T> {
    const a = arenaOf(this), raw = a.encode(this.valueType, value), size = checkedSize(this.size + 1);
    if (this.tailSize < 32) return new SharedLinkedList(this.valueType, this.head, a.wasm.tailAppend(this.tail, this.tailSize, raw) >>> 0, size, a, this.tailSize + 1);
    const head = a.wasm.blockAppend(this.head, this.tail, 32) >>> 0;
    return new SharedLinkedList(this.valueType, head, a.wasm.tailAppend(0, 0, raw) >>> 0, size, a, 1);
  }
  removeFirst(): SharedLinkedList<T> { return this.removeAt(0); }
  getFirst(): ValueOf<T> | undefined { return this.get(0); }
  getLast(): ValueOf<T> | undefined { return this.get(this.size - 1); }
  get(index: number): ValueOf<T> | undefined {
    if (!validIndex(index, this.size)) return undefined;
    const a = arenaOf(this), before = this.size - this.tailSize;
    const raw = index >= before ? a.dv.getFloat64(this.tail + (index - before) * 8, true) : a.wasm.blockGet(this.head, index);
    return a.decode(this.valueType, raw);
  }
  insertAfter(index: number, value: ValueOf<T>): SharedLinkedList<T> { return validIndex(index, this.size) ? this.insert(index + 1, value) : this; }
  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    const a = arenaOf(this); let i = 0;
    for (const raw of a.blocks(this.head)) fn(a.decode(this.valueType, raw), i++);
    for (let t = 0; t < this.tailSize; t++) fn(a.decode(this.valueType, a.dv.getFloat64(this.tail + t * 8, true)), i++);
  }
  toArray(): ValueOf<T>[] { const result: ValueOf<T>[] = []; this.forEach(value => result.push(value)); return result; }
  get isEmpty(): boolean { return this.size === 0; }
  toWorkerData() { return Object.freeze({ head: this.head, tail: this.tail, tailSize: this.tailSize, size: this.size, type: this.valueType }); }
  static fromWorkerData<T extends string>(d: { head: number; tail: number; tailSize: number; size: number; type: T }, source: Arena = current): SharedLinkedList<T> { return new SharedLinkedList(d.type, d.head, d.tail, d.size, source, d.tailSize); }
  removeAfter(index: number): SharedLinkedList<T> { return validIndex(index, this.size - 1) ? this.removeAt(index + 1) : this; }
}
structureRegistry.SharedLinkedList = { fromWorkerData: (d, a) => SharedLinkedList.fromWorkerData(d, a) };
