import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder, structureRegistry } from './codec';
import { parseNestedType } from './types';
import type { ValueOf } from './types';

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

let generation = 0;
const registry = new FinalizationRegistry<{ gen: number }>(({ gen }) => {});

export function attachToMemory(memory: WebAssembly.Memory, allocState?: { heapEnd: number; freeList: number }): void {
  initWasm(memory);
  if (allocState) { wasm.setHeapEnd(allocState.heapEnd); wasm.setFreeList(allocState.freeList); }
}

export function getBufferCopy(): Uint8Array { return new Uint8Array(wasmMemory.buffer).slice(); }
export function getAllocState() { return { heapEnd: wasm.getHeapEnd(), freeList: wasm.getFreeList() }; }
export function resetDoublyLinkedList(): void { generation++; wasm.reset(); }

export type SharedDoublyLinkedListType = 'string' | 'number' | 'boolean' | 'object' | `Shared${string}<${string}>`;

export class SharedDoublyLinkedList<T extends string = SharedDoublyLinkedListType> {
  readonly head: number;
  readonly tail: number;
  readonly size: number;
  readonly valueType: T;
  private nestedInfo: { structureType: string; innerType: string } | null;

  constructor(type: T, head = 0, tail = 0, size = 0) {
    this.valueType = type;
    this.head = head;
    this.tail = tail;
    this.size = size;
    this.nestedInfo = parseNestedType(type);
    if (head) registry.register(this, { gen: generation });
  }

  private encodeBlob(value: ValueOf<T>): number {
    let str: string;
    if (this.nestedInfo) {
      str = JSON.stringify({ __t: this.nestedInfo.structureType, __i: this.nestedInfo.innerType, __d: (value as any).toWorkerData() });
    } else {
      str = this.valueType === 'string' ? value as string : JSON.stringify(value);
    }
    const bytes = encoder.encode(str);
    mem.refresh();
    mem.buf.set(bytes, blobBufPtr);
    const blobPtr = wasm.allocBlob(bytes.length);
    return blobPtr | (bytes.length << 20);
  }

  private decodeNode(node: number): ValueOf<T> | undefined {
    if (!node) return undefined;
    mem.refresh();
    if (this.valueType === 'number') return wasm.getValue(node) as ValueOf<T>;
    if (this.valueType === 'boolean') return (wasm.getValue(node) !== 0) as ValueOf<T>;
    const packed = wasm.getValueBlob(node);
    const ptr = packed & 0xFFFFF, len = packed >>> 20;
    const str = decoder.decode(mem.buf.subarray(ptr, ptr + len));
    if (this.nestedInfo) {
      const { __t, __i, __d } = JSON.parse(str);
      const factory = structureRegistry[__t];
      if (!factory) throw new Error(`Unknown structure type: ${__t}`);
      return factory.fromWorkerData({ ...__d, valueType: __d.valueType ?? __i }) as ValueOf<T>;
    }
    return (this.valueType === 'string' ? str : JSON.parse(str)) as ValueOf<T>;
  }

  prepend(value: ValueOf<T>): SharedDoublyLinkedList<T> {
    mem.refresh();
    let newHead: number;
    if (this.valueType === 'number') newHead = wasm.prepend(this.head, value as number);
    else if (this.valueType === 'boolean') newHead = wasm.prepend(this.head, (value as boolean) ? 1 : 0);
    else newHead = wasm.prependBlob(this.head, this.encodeBlob(value));
    return new SharedDoublyLinkedList(this.valueType, newHead, this.tail || newHead, this.size + 1);
  }

  append(value: ValueOf<T>): SharedDoublyLinkedList<T> {
    mem.refresh();
    let newTail: number;
    if (this.valueType === 'number') newTail = wasm.append(this.tail, value as number);
    else if (this.valueType === 'boolean') newTail = wasm.append(this.tail, (value as boolean) ? 1 : 0);
    else newTail = wasm.appendBlob(this.tail, this.encodeBlob(value));
    return new SharedDoublyLinkedList(this.valueType, this.head || newTail, newTail, this.size + 1);
  }

  removeFirst(): SharedDoublyLinkedList<T> {
    if (this.size === 0) return this;
    const newHead = wasm.getNext(this.head);
    if (newHead) wasm.setPrev(newHead, 0);
    return new SharedDoublyLinkedList(this.valueType, newHead, newHead ? this.tail : 0, this.size - 1);
  }

  removeLast(): SharedDoublyLinkedList<T> {
    if (this.size === 0) return this;
    const newTail = wasm.getPrev(this.tail);
    if (newTail) wasm.setNext(newTail, 0);
    return new SharedDoublyLinkedList(this.valueType, newTail ? this.head : 0, newTail, this.size - 1);
  }

  getFirst(): ValueOf<T> | undefined { return this.decodeNode(this.head); }
  getLast(): ValueOf<T> | undefined { return this.decodeNode(this.tail); }

  get(index: number): ValueOf<T> | undefined {
    if (index < 0 || index >= this.size) return undefined;
    const node = index < this.size / 2 ? wasm.getAt(this.head, index) : wasm.getAtReverse(this.tail, this.size - 1 - index);
    return this.decodeNode(node);
  }

  insertAfter(index: number, value: ValueOf<T>): SharedDoublyLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    const node = index < this.size / 2 ? wasm.getAt(this.head, index) : wasm.getAtReverse(this.tail, this.size - 1 - index);
    if (!node) return this;
    mem.refresh();
    let newNode: number;
    if (this.valueType === 'number') newNode = wasm.insertAfter(node, value as number);
    else if (this.valueType === 'boolean') newNode = wasm.insertAfter(node, (value as boolean) ? 1 : 0);
    else newNode = wasm.insertAfterBlob(node, this.encodeBlob(value));
    return new SharedDoublyLinkedList(this.valueType, this.head, index === this.size - 1 ? newNode : this.tail, this.size + 1);
  }

  insertBefore(index: number, value: ValueOf<T>): SharedDoublyLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    const node = index < this.size / 2 ? wasm.getAt(this.head, index) : wasm.getAtReverse(this.tail, this.size - 1 - index);
    if (!node) return this;
    mem.refresh();
    let newNode: number;
    if (this.valueType === 'number') newNode = wasm.insertBefore(node, value as number);
    else if (this.valueType === 'boolean') newNode = wasm.insertBefore(node, (value as boolean) ? 1 : 0);
    else newNode = wasm.insertBeforeBlob(node, this.encodeBlob(value));
    return new SharedDoublyLinkedList(this.valueType, index === 0 ? newNode : this.head, this.tail, this.size + 1);
  }

  remove(index: number): SharedDoublyLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    if (index === 0) return this.removeFirst();
    if (index === this.size - 1) return this.removeLast();
    const node = index < this.size / 2 ? wasm.getAt(this.head, index) : wasm.getAtReverse(this.tail, this.size - 1 - index);
    if (!node) return this;
    wasm.removeNode(node);
    return new SharedDoublyLinkedList(this.valueType, this.head, this.tail, this.size - 1);
  }

  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    let node = this.head, i = 0;
    while (node) { fn(this.decodeNode(node)!, i++); node = wasm.getNext(node); }
  }

  forEachReverse(fn: (value: ValueOf<T>, index: number) => void): void {
    let node = this.tail, i = this.size - 1;
    while (node) { fn(this.decodeNode(node)!, i--); node = wasm.getPrev(node); }
  }

  toArray(): ValueOf<T>[] { const arr: ValueOf<T>[] = []; this.forEach(v => arr.push(v)); return arr; }
  toArrayReverse(): ValueOf<T>[] { const arr: ValueOf<T>[] = []; this.forEachReverse(v => arr.push(v)); return arr; }
  get isEmpty(): boolean { return this.size === 0; }

  static fromWorkerData<T extends string>(data: { head: number; tail: number; size: number; type: T }): SharedDoublyLinkedList<T> {
    return new SharedDoublyLinkedList(data.type, data.head, data.tail, data.size);
  }

  toWorkerData() { return { head: this.head, tail: this.tail, size: this.size, type: this.valueType }; }
}

// Register SharedDoublyLinkedList in structure registry for nested type support
structureRegistry['SharedDoublyLinkedList'] = { fromWorkerData: (d: any) => SharedDoublyLinkedList.fromWorkerData(d) };
