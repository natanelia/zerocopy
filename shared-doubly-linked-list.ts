import { Arena, Snapshot, arenaOf, vectorDepth, validIndex, checkedSize } from './arena';
import { structureRegistry } from './codec';
import type { ValueOf } from './types';
let current = new Arena();
export let sharedMemory = current.memory;
export let sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer;
function publishCurrent(): void { sharedMemory = current.memory; sharedBuffer = current.memory.buffer as unknown as SharedArrayBuffer; }
export function resetDoublyLinkedList(): void { current = new Arena(); publishCurrent(); }
export function getAllocState() { return current.state(); }
export function getBufferCopy(): Uint8Array { return current.copy(); }
export function getBuffer(): SharedArrayBuffer { return current.memory.buffer as unknown as SharedArrayBuffer; }
export function attachToMemory(memory: WebAssembly.Memory, state?: { heapEnd: number }): void {
  current = new Arena({ memory, used: state?.heapEnd, readOnly: true }); publishCurrent();
}
export function attachToBufferCopy(copy: Uint8Array, state: { heapEnd: number }): void {
  current = new Arena({ copy, used: state.heapEnd, readOnly: true }); publishCurrent();
}

export type SharedDoublyLinkedListType = import('./types').ValueType;
/** The list interface uses an indexed persistent AVL tree. Raw v1 node pointers are not compatible. */
export class SharedDoublyLinkedList<T extends string = SharedDoublyLinkedListType> extends Snapshot {
  readonly head: number;
  readonly size: number;
  readonly valueType: T;
  constructor(type: T, head = 0, _tail = 0, _size = 0, source: Arena = current) {
    super(source); this.valueType = type; this.head = head; this.size = source.wasm.seqSize(head); Object.freeze(this);
  }
  get tail(): number { return this.size ? arenaOf(this).wasm.seqNode(this.head, this.size - 1) >>> 0 : 0; }
  private insert(index: number, value: ValueOf<T>): SharedDoublyLinkedList<T> {
    const a = arenaOf(this); a.assertWritable(); checkedSize(this.size + 1);
    return new SharedDoublyLinkedList(this.valueType, a.wasm.seqInsert(this.head, index, a.encode(this.valueType, value)) >>> 0, 0, 0, a);
  }
  private removeAt(index: number): SharedDoublyLinkedList<T> {
    if (!validIndex(index, this.size)) return this;
    const a = arenaOf(this); a.assertWritable(); return new SharedDoublyLinkedList(this.valueType, a.wasm.seqDelete(this.head, index) >>> 0, 0, 0, a);
  }
  prepend(value: ValueOf<T>): SharedDoublyLinkedList<T> { return this.insert(0, value); }
  append(value: ValueOf<T>): SharedDoublyLinkedList<T> { return this.insert(this.size, value); }
  removeFirst(): SharedDoublyLinkedList<T> { return this.removeAt(0); }
  getFirst(): ValueOf<T> | undefined { return this.get(0); }
  getLast(): ValueOf<T> | undefined { return this.get(this.size - 1); }
  get(index: number): ValueOf<T> | undefined {
    if (!validIndex(index, this.size)) return undefined;
    const a = arenaOf(this), node = a.wasm.seqNode(this.head, index) >>> 0;
    return a.decode(this.valueType, a.dv.getFloat64(node + 16, true));
  }
  insertAfter(index: number, value: ValueOf<T>): SharedDoublyLinkedList<T> { return validIndex(index, this.size) ? this.insert(index + 1, value) : this; }
  forEach(fn: (value: ValueOf<T>, index: number) => void): void { const a = arenaOf(this); let i = 0; for (const raw of a.sequence(this.head)) fn(a.decode(this.valueType, raw), i++); }
  toArray(): ValueOf<T>[] { const result: ValueOf<T>[] = []; this.forEach(value => result.push(value)); return result; }
  get isEmpty(): boolean { return this.size === 0; }
  toWorkerData() { return Object.freeze({ head: this.head, tail: this.tail, size: this.size, type: this.valueType }); }
  static fromWorkerData<T extends string>(d: { head: number; tail: number; size: number; type: T }, source: Arena = current): SharedDoublyLinkedList<T> { return new SharedDoublyLinkedList(d.type, d.head, d.tail, d.size, source); }
  removeLast(): SharedDoublyLinkedList<T> { return this.removeAt(this.size - 1); }
  remove(index: number): SharedDoublyLinkedList<T> { return this.removeAt(index); }
  insertBefore(index: number, value: ValueOf<T>): SharedDoublyLinkedList<T> { return validIndex(index, this.size) ? this.insert(index, value) : this; }
  forEachReverse(fn: (value: ValueOf<T>, index: number) => void): void { const a = arenaOf(this); let i = this.size - 1; for (const raw of a.sequence(this.head, true)) fn(a.decode(this.valueType, raw), i--); }
  toArrayReverse(): ValueOf<T>[] { const result: ValueOf<T>[] = []; this.forEachReverse(value => result.push(value)); return result; }
}
structureRegistry.SharedDoublyLinkedList = { fromWorkerData: (d, a) => SharedDoublyLinkedList.fromWorkerData(d, a) };
