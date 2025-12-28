import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder, structureRegistry } from './codec.ts';
import { parseNestedType } from './types.ts';
import type { ValueOf } from './types.ts';

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

let generation = 0;
const registry = new FinalizationRegistry<{ gen: number }>(({ gen }) => {});

export function attachToMemory(memory: WebAssembly.Memory, allocState?: { heapEnd: number; freeList: number }): void {
  initWasm(memory);
  if (allocState) { wasm.setHeapEnd(allocState.heapEnd); wasm.setFreeList(allocState.freeList); }
}

export function getBufferCopy(): Uint8Array { return new Uint8Array(wasmMemory.buffer).slice(); }
export function getAllocState() { return { heapEnd: wasm.getHeapEnd(), freeList: wasm.getFreeList() }; }
export function resetLinkedList(): void { generation++; wasm.reset(); }

export type SharedLinkedListType = 'string' | 'number' | 'boolean' | 'object' | `Shared${string}<${string}>`;

export class SharedLinkedList<T extends string = SharedLinkedListType> {
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

  private encodeForPrepend(value: ValueOf<T>): number {
    mem.refresh();
    if (this.valueType === 'number') return wasm.prepend(this.head, value as number);
    if (this.valueType === 'boolean') return wasm.prepend(this.head, (value as boolean) ? 1 : 0);
    let str: string;
    if (this.nestedInfo) {
      str = JSON.stringify({ __t: this.nestedInfo.structureType, __i: this.nestedInfo.innerType, __d: (value as any).toWorkerData() });
    } else {
      str = this.valueType === 'string' ? value as string : JSON.stringify(value);
    }
    const bytes = encoder.encode(str);
    mem.buf.set(bytes, blobBufPtr);
    const blobPtr = wasm.allocBlob(bytes.length);
    return wasm.prependBlob(this.head, blobPtr | (bytes.length << 20));
  }

  private encodeForAppend(value: ValueOf<T>): number {
    mem.refresh();
    if (this.valueType === 'number') return wasm.append(this.tail, value as number);
    if (this.valueType === 'boolean') return wasm.append(this.tail, (value as boolean) ? 1 : 0);
    let str: string;
    if (this.nestedInfo) {
      str = JSON.stringify({ __t: this.nestedInfo.structureType, __i: this.nestedInfo.innerType, __d: (value as any).toWorkerData() });
    } else {
      str = this.valueType === 'string' ? value as string : JSON.stringify(value);
    }
    const bytes = encoder.encode(str);
    mem.buf.set(bytes, blobBufPtr);
    const blobPtr = wasm.allocBlob(bytes.length);
    return wasm.appendBlob(this.tail, blobPtr | (bytes.length << 20));
  }

  private encodeForInsertAfter(node: number, value: ValueOf<T>): number {
    mem.refresh();
    if (this.valueType === 'number') return wasm.insertAfter(node, value as number);
    if (this.valueType === 'boolean') return wasm.insertAfter(node, (value as boolean) ? 1 : 0);
    let str: string;
    if (this.nestedInfo) {
      str = JSON.stringify({ __t: this.nestedInfo.structureType, __i: this.nestedInfo.innerType, __d: (value as any).toWorkerData() });
    } else {
      str = this.valueType === 'string' ? value as string : JSON.stringify(value);
    }
    const bytes = encoder.encode(str);
    mem.buf.set(bytes, blobBufPtr);
    const blobPtr = wasm.allocBlob(bytes.length);
    return wasm.insertAfterBlob(node, blobPtr | (bytes.length << 20));
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

  prepend(value: ValueOf<T>): SharedLinkedList<T> {
    const newHead = this.encodeForPrepend(value);
    const newTail = this.tail || newHead;
    return new SharedLinkedList(this.valueType, newHead, newTail, this.size + 1);
  }

  append(value: ValueOf<T>): SharedLinkedList<T> {
    const newTail = this.encodeForAppend(value);
    const newHead = this.head || newTail;
    return new SharedLinkedList(this.valueType, newHead, newTail, this.size + 1);
  }

  removeFirst(): SharedLinkedList<T> {
    if (this.size === 0) return this;
    const newHead = wasm.getNext(this.head);
    const newTail = newHead ? this.tail : 0;
    return new SharedLinkedList(this.valueType, newHead, newTail, this.size - 1);
  }

  getFirst(): ValueOf<T> | undefined { return this.decodeNode(this.head); }
  getLast(): ValueOf<T> | undefined { return this.decodeNode(this.tail); }

  get(index: number): ValueOf<T> | undefined {
    if (index < 0 || index >= this.size) return undefined;
    return this.decodeNode(wasm.getAt(this.head, index));
  }

  insertAfter(index: number, value: ValueOf<T>): SharedLinkedList<T> {
    if (index < 0 || index >= this.size) return this;
    const node = wasm.getAt(this.head, index);
    if (!node) return this;
    const newNode = this.encodeForInsertAfter(node, value);
    const newTail = index === this.size - 1 ? newNode : this.tail;
    return new SharedLinkedList(this.valueType, this.head, newTail, this.size + 1);
  }

  removeAfter(index: number): SharedLinkedList<T> {
    if (index < 0 || index >= this.size - 1) return this;
    const node = wasm.getAt(this.head, index);
    if (!node) return this;
    wasm.removeAfter(node);
    const newTail = index === this.size - 2 ? node : this.tail;
    return new SharedLinkedList(this.valueType, this.head, newTail, this.size - 1);
  }

  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    let node = this.head;
    let i = 0;
    while (node) {
      fn(this.decodeNode(node)!, i++);
      node = wasm.getNext(node);
    }
  }

  toArray(): ValueOf<T>[] {
    const arr: ValueOf<T>[] = [];
    this.forEach(v => arr.push(v));
    return arr;
  }

  get isEmpty(): boolean { return this.size === 0; }

  static fromWorkerData<T extends string>(data: { head: number; tail: number; size: number; type: T }): SharedLinkedList<T> {
    return new SharedLinkedList(data.type, data.head, data.tail, data.size);
  }

  toWorkerData() { return { head: this.head, tail: this.tail, size: this.size, type: this.valueType }; }
}

// Register SharedLinkedList in structure registry for nested type support
structureRegistry['SharedLinkedList'] = { fromWorkerData: (d: any) => SharedLinkedList.fromWorkerData(d) };
