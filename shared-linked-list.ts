import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder } from './codec';
import type { ValueType, ValueOf } from './types';

const wasmBytes = loadWasm('singly-linked-list.wasm');
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
export function resetLinkedList(): void { wasm.reset(); }

export type SharedLinkedListType = ValueType;

function encodeValue<T extends SharedLinkedListType>(type: T, value: ValueOf<T>): number {
  mem.refresh();
  if (type === 'number') return wasm.createNode(value as number);
  if (type === 'boolean') return wasm.createNode((value as boolean) ? 1 : 0);
  const str = type === 'string' ? value as string : JSON.stringify(value);
  const bytes = encoder.encode(str);
  mem.buf.set(bytes, blobBufPtr);
  const blobPtr = wasm.allocBlob(bytes.length);
  return wasm.createNodeBlob(blobPtr | (bytes.length << 20));
}

function decodeValue<T extends SharedLinkedListType>(type: T, node: number): ValueOf<T> | undefined {
  if (!node) return undefined;
  mem.refresh();
  if (type === 'number') return wasm.getValue(node) as ValueOf<T>;
  if (type === 'boolean') return (wasm.getValue(node) !== 0) as ValueOf<T>;
  const packed = wasm.getValueBlob(node);
  const ptr = packed & 0xFFFFF, len = packed >>> 20;
  const str = decoder.decode(mem.buf.subarray(ptr, ptr + len));
  return (type === 'string' ? str : JSON.parse(str)) as ValueOf<T>;
}

export class SharedLinkedList<T extends SharedLinkedListType> {
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

  prepend(value: ValueOf<T>): SharedLinkedList<T> {
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
    return new SharedLinkedList(this.valueType, newHead, newTail, this.size + 1);
  }

  append(value: ValueOf<T>): SharedLinkedList<T> {
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
    return new SharedLinkedList(this.valueType, newHead, newTail, this.size + 1);
  }

  removeFirst(): SharedLinkedList<T> {
    if (this.size === 0) return this;
    const newHead = wasm.getNext(this.head);
    const newTail = newHead ? this.tail : 0;
    return new SharedLinkedList(this.valueType, newHead, newTail, this.size - 1);
  }

  getFirst(): ValueOf<T> | undefined { return decodeValue(this.valueType, this.head); }
  getLast(): ValueOf<T> | undefined { return decodeValue(this.valueType, this.tail); }

  get(index: number): ValueOf<T> | undefined {
    if (index < 0 || index >= this.size) return undefined;
    const node = wasm.getAt(this.head, index);
    return decodeValue(this.valueType, node);
  }

  insertAfter(index: number, value: ValueOf<T>): SharedLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    const node = wasm.getAt(this.head, index);
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
    return new SharedLinkedList(this.valueType, this.head, newTail, this.size + 1);
  }

  removeAfter(index: number): SharedLinkedList<T> {
    if (index < 0 || index >= this.size - 1) return this;
    const node = wasm.getAt(this.head, index);
    if (!node) return this;
    const removedNext = wasm.getNext(wasm.getNext(node));
    wasm.removeAfter(node);
    const newTail = index === this.size - 2 ? node : this.tail;
    return new SharedLinkedList(this.valueType, this.head, newTail, this.size - 1);
  }

  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    let node = this.head;
    let i = 0;
    while (node) {
      fn(decodeValue(this.valueType, node)!, i++);
      node = wasm.getNext(node);
    }
  }

  toArray(): ValueOf<T>[] {
    const arr: ValueOf<T>[] = [];
    this.forEach(v => arr.push(v));
    return arr;
  }

  get isEmpty(): boolean { return this.size === 0; }

  static fromWorkerData<T extends SharedLinkedListType>(data: { head: number; tail: number; size: number; type: T }): SharedLinkedList<T> {
    return new SharedLinkedList(data.type, data.head, data.tail, data.size);
  }

  toWorkerData() { return { head: this.head, tail: this.tail, size: this.size, type: this.valueType }; }
}
