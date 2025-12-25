import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder } from './codec';
import type { ValueType, ValueOf } from './types';

const wasmBytes = loadWasm('ordered-map.wasm');
const wasmModule = new WebAssembly.Module(wasmBytes);

let wasmMemory: WebAssembly.Memory;
let wasm: any;
let keyBufPtr: number;
let blobBufPtr: number;
let mem: MemoryView;

function initWasm(existingMemory?: WebAssembly.Memory) {
  wasmMemory = existingMemory || createSharedMemory();
  wasm = new WebAssembly.Instance(wasmModule, { env: { memory: wasmMemory } }).exports;
  keyBufPtr = wasm.keyBuf();
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
export function resetOrderedMap(): void { wasm.reset(); }

function encodeKey(key: string): number {
  mem.refresh();
  const bytes = encoder.encode(key);
  mem.buf.set(bytes, keyBufPtr);
  return bytes.length;
}

function encodeValue<T extends ValueType>(type: T, value: ValueOf<T>): number {
  mem.refresh();
  if (type === 'number') {
    mem.dv.setFloat64(blobBufPtr, value as number, true);
    return 8;
  }
  if (type === 'boolean') {
    mem.buf[blobBufPtr] = (value as boolean) ? 1 : 0;
    return 1;
  }
  const str = type === 'string' ? value as string : JSON.stringify(value);
  const bytes = encoder.encode(str);
  mem.buf.set(bytes, blobBufPtr);
  return bytes.length;
}

function decodeValue<T extends ValueType>(type: T, ptr: number, len: number): ValueOf<T> {
  mem.refresh();
  if (type === 'number') return mem.dv.getFloat64(ptr, true) as ValueOf<T>;
  if (type === 'boolean') return (mem.buf[ptr] !== 0) as ValueOf<T>;
  const str = decoder.decode(mem.buf.subarray(ptr, ptr + len));
  return (type === 'string' ? str : JSON.parse(str)) as ValueOf<T>;
}

export class SharedOrderedMap<T extends ValueType> {
  readonly root: number;
  readonly head: number;
  readonly tail: number;
  readonly size: number;
  readonly valueType: T;

  constructor(type: T, root = 0, head = 0, tail = 0, size = 0) {
    this.valueType = type;
    this.root = root;
    this.head = head;
    this.tail = tail;
    this.size = size;
  }

  set(key: string, value: ValueOf<T>): SharedOrderedMap<T> {
    const keyLen = encodeKey(key);
    const valLen = encodeValue(this.valueType, value);
    
    wasm.set(this.root, this.head, this.tail, keyLen, valLen);
    mem.refresh();
    
    const newRoot = wasm.getResultRoot();
    const newHead = wasm.getResultHead();
    const newTail = wasm.getResultTail();
    const isNew = wasm.getResultIsNew();
    
    return new SharedOrderedMap(this.valueType, newRoot, newHead, newTail, isNew ? this.size + 1 : this.size);
  }

  get(key: string): ValueOf<T> | undefined {
    if (!this.root) return undefined;
    const keyLen = encodeKey(key);
    const node = wasm.find(this.root, keyLen);
    if (!node) return undefined;
    mem.refresh();
    const valPtr = wasm.getListValPtr(node);
    const valLen = wasm.getListValLen(node);
    return decodeValue(this.valueType, valPtr, valLen);
  }

  has(key: string): boolean {
    if (!this.root) return false;
    const keyLen = encodeKey(key);
    return wasm.find(this.root, keyLen) !== 0;
  }

  delete(key: string): SharedOrderedMap<T> {
    if (!this.root) return this;
    const keyLen = encodeKey(key);
    const exists = wasm.find(this.root, keyLen) !== 0;
    if (!exists) return this;
    
    wasm.del(this.root, this.head, this.tail, keyLen);
    mem.refresh();
    
    const newRoot = wasm.getResultRoot();
    const newHead = wasm.getResultHead();
    const newTail = wasm.getResultTail();
    
    return new SharedOrderedMap(this.valueType, newRoot, newHead, newTail, this.size - 1);
  }

  *entries(): Generator<[string, ValueOf<T>]> {
    mem.refresh();
    let node = this.head;
    while (node) {
      const keyPtr = wasm.getListKeyPtr(node);
      const keyLen = wasm.getListKeyLen(node);
      const valPtr = wasm.getListValPtr(node);
      const valLen = wasm.getListValLen(node);
      
      const key = decoder.decode(mem.buf.subarray(keyPtr, keyPtr + keyLen));
      const value = decodeValue(this.valueType, valPtr, valLen);
      yield [key, value];
      
      node = wasm.getListNext(node);
      mem.refresh();
    }
  }

  *keys(): Generator<string> {
    for (const [k] of this.entries()) yield k;
  }

  *values(): Generator<ValueOf<T>> {
    for (const [, v] of this.entries()) yield v;
  }

  forEach(fn: (value: ValueOf<T>, key: string) => void): void {
    for (const [k, v] of this.entries()) fn(v, k);
  }

  toWorkerData(): { root: number; head: number; tail: number; size: number; valueType: T } {
    return { root: this.root, head: this.head, tail: this.tail, size: this.size, valueType: this.valueType };
  }

  static fromWorkerData<T extends ValueType>(data: { root: number; head: number; tail: number; size: number; valueType: T }): SharedOrderedMap<T> {
    return new SharedOrderedMap(data.valueType, data.root, data.head, data.tail, data.size);
  }
}
