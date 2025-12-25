import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder } from './codec';
import type { ValueType, ValueOf } from './types';

const wasmBytes = loadWasm('doubly-linked-list.wasm');
const wasmModule = new WebAssembly.Module(wasmBytes);

let wasmMemory: WebAssembly.Memory;
let wasm: any;
let blobBufPtr: number;
let mem: MemoryView;

function initWasm(existingMemory?: WebAssembly.Memory) {
  wasmMemory = existingMemory || createSharedMemory();
  wasm = new WebAssembly.Instance(wasmModule, { env: { memory: wasmMemory } }).exports;
  blobBufPtr = wasm.blobBuf();
  mem = new MemoryView(wasmMemory);
}

initWasm();

export const sharedBuffer = wasmMemory!.buffer as SharedArrayBuffer;
export const sharedMemory = wasmMemory!;

export function attachToMemory(memory: WebAssembly.Memory, allocState?: { heapEnd: number; freeList: number }): void {
  initWasm(memory);
  if (allocState) { wasm.setHeapEnd(allocState.heapEnd); wasm.setFreeList(allocState.freeList); }
}

export function getBufferCopy(): Uint8Array { return new Uint8Array(wasmMemory.buffer).slice(); }
export function getAllocState() { return { heapEnd: wasm.getHeapEnd(), freeList: wasm.getFreeList() }; }
export function resetDoublyLinkedList(): void { wasm.reset(); }

export type SharedDoublyLinkedListType = ValueType;

function decodeValue<T extends SharedDoublyLinkedListType>(type: T, node: number): ValueOf<T> | undefined {
  if (!node) return undefined;
  mem.refresh();
  if (type === 'number') return wasm.getValue(node) as ValueOf<T>;
  if (type === 'boolean') return (wasm.getValue(node) !== 0) as ValueOf<T>;
  const packed = wasm.getValueBlob(node);
  const ptr = packed & 0xFFFFF, len = packed >>> 20;
  const str = decoder.decode(mem.buf.subarray(ptr, ptr + len));
  return (type === 'string' ? str : JSON.parse(str)) as ValueOf<T>;
}

export class SharedDoublyLinkedList<T extends SharedDoublyLinkedListType> {
  readonly head: number;
  readonly tail: number;
  readonly size: number;
  readonly valueType: T;

  constructor(type: T, head = 0, tail = 0, size = 0) {
    this.valueType = type;
    this.head = head;
    this.tail = tail;
    this.size = size;
  }

  prepend(value: ValueOf<T>): SharedDoublyLinkedList<T> {
    mem.refresh();
    let newHead: number;
    if (this.valueType === 'number') {
      newHead = wasm.prepend(this.head, value as number);
    } else if (this.valueType === 'boolean') {
      newHead = wasm.prepend(this.head, (value as boolean) ? 1 : 0);
    } else {
      const str = this.valueType === 'string' ? value as string : JSON.stringify(value);
      const bytes = encoder.encode(str);
      mem.buf.set(bytes, blobBufPtr);
      const blobPtr = wasm.allocBlob(bytes.length);
      newHead = wasm.prependBlob(this.head, blobPtr | (bytes.length << 20));
    }
    const newTail = this.tail || newHead;
    return new SharedDoublyLinkedList(this.valueType, newHead, newTail, this.size + 1);
  }

  append(value: ValueOf<T>): SharedDoublyLinkedList<T> {
    mem.refresh();
    let newTail: number;
    if (this.valueType === 'number') {
      newTail = wasm.append(this.tail, value as number);
    } else if (this.valueType === 'boolean') {
      newTail = wasm.append(this.tail, (value as boolean) ? 1 : 0);
    } else {
      const str = this.valueType === 'string' ? value as string : JSON.stringify(value);
      const bytes = encoder.encode(str);
      mem.buf.set(bytes, blobBufPtr);
      const blobPtr = wasm.allocBlob(bytes.length);
      newTail = wasm.appendBlob(this.tail, blobPtr | (bytes.length << 20));
    }
    const newHead = this.head || newTail;
    return new SharedDoublyLinkedList(this.valueType, newHead, newTail, this.size + 1);
  }

  removeFirst(): SharedDoublyLinkedList<T> {
    if (this.size === 0) return this;
    const newHead = wasm.getNext(this.head);
    if (newHead) wasm.setPrev(newHead, 0);
    const newTail = newHead ? this.tail : 0;
    return new SharedDoublyLinkedList(this.valueType, newHead, newTail, this.size - 1);
  }

  removeLast(): SharedDoublyLinkedList<T> {
    if (this.size === 0) return this;
    const newTail = wasm.getPrev(this.tail);
    if (newTail) wasm.setNext(newTail, 0);
    const newHead = newTail ? this.head : 0;
    return new SharedDoublyLinkedList(this.valueType, newHead, newTail, this.size - 1);
  }

  getFirst(): ValueOf<T> | undefined { return decodeValue(this.valueType, this.head); }
  getLast(): ValueOf<T> | undefined { return decodeValue(this.valueType, this.tail); }

  get(index: number): ValueOf<T> | undefined {
    if (index < 0 || index >= this.size) return undefined;
    // Optimize: traverse from closer end
    const node = index < this.size / 2
      ? wasm.getAt(this.head, index)
      : wasm.getAtReverse(this.tail, this.size - 1 - index);
    return decodeValue(this.valueType, node);
  }

  insertAfter(index: number, value: ValueOf<T>): SharedDoublyLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    const node = index < this.size / 2
      ? wasm.getAt(this.head, index)
      : wasm.getAtReverse(this.tail, this.size - 1 - index);
    if (!node) return this;
    mem.refresh();
    let newNode: number;
    if (this.valueType === 'number') {
      newNode = wasm.insertAfter(node, value as number);
    } else if (this.valueType === 'boolean') {
      newNode = wasm.insertAfter(node, (value as boolean) ? 1 : 0);
    } else {
      const str = this.valueType === 'string' ? value as string : JSON.stringify(value);
      const bytes = encoder.encode(str);
      mem.buf.set(bytes, blobBufPtr);
      const blobPtr = wasm.allocBlob(bytes.length);
      newNode = wasm.insertAfterBlob(node, blobPtr | (bytes.length << 20));
    }
    const newTail = index === this.size - 1 ? newNode : this.tail;
    return new SharedDoublyLinkedList(this.valueType, this.head, newTail, this.size + 1);
  }

  insertBefore(index: number, value: ValueOf<T>): SharedDoublyLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    const node = index < this.size / 2
      ? wasm.getAt(this.head, index)
      : wasm.getAtReverse(this.tail, this.size - 1 - index);
    if (!node) return this;
    mem.refresh();
    let newNode: number;
    if (this.valueType === 'number') {
      newNode = wasm.insertBefore(node, value as number);
    } else if (this.valueType === 'boolean') {
      newNode = wasm.insertBefore(node, (value as boolean) ? 1 : 0);
    } else {
      const str = this.valueType === 'string' ? value as string : JSON.stringify(value);
      const bytes = encoder.encode(str);
      mem.buf.set(bytes, blobBufPtr);
      const blobPtr = wasm.allocBlob(bytes.length);
      newNode = wasm.insertBeforeBlob(node, blobPtr | (bytes.length << 20));
    }
    const newHead = index === 0 ? newNode : this.head;
    return new SharedDoublyLinkedList(this.valueType, newHead, this.tail, this.size + 1);
  }

  remove(index: number): SharedDoublyLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    if (index === 0) return this.removeFirst();
    if (index === this.size - 1) return this.removeLast();
    const node = index < this.size / 2
      ? wasm.getAt(this.head, index)
      : wasm.getAtReverse(this.tail, this.size - 1 - index);
    if (!node) return this;
    wasm.removeNode(node);
    return new SharedDoublyLinkedList(this.valueType, this.head, this.tail, this.size - 1);
  }

  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    let node = this.head;
    let i = 0;
    while (node) {
      fn(decodeValue(this.valueType, node)!, i++);
      node = wasm.getNext(node);
    }
  }

  forEachReverse(fn: (value: ValueOf<T>, index: number) => void): void {
    let node = this.tail;
    let i = this.size - 1;
    while (node) {
      fn(decodeValue(this.valueType, node)!, i--);
      node = wasm.getPrev(node);
    }
  }

  toArray(): ValueOf<T>[] {
    const arr: ValueOf<T>[] = [];
    this.forEach(v => arr.push(v));
    return arr;
  }

  toArrayReverse(): ValueOf<T>[] {
    const arr: ValueOf<T>[] = [];
    this.forEachReverse(v => arr.push(v));
    return arr;
  }

  get isEmpty(): boolean { return this.size === 0; }

  static fromWorkerData<T extends SharedDoublyLinkedListType>(data: { head: number; tail: number; size: number; type: T }): SharedDoublyLinkedList<T> {
    return new SharedDoublyLinkedList(data.type, data.head, data.tail, data.size);
  }

  toWorkerData() { return { head: this.head, tail: this.tail, size: this.size, type: this.valueType }; }
}
