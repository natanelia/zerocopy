import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder } from './codec';
import type { ValueType, ValueOf } from './types';

const wasmBytes = loadWasm('priority-queue.wasm');
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

export const sharedMemory = wasmMemory!;
export function attachToMemory(memory: WebAssembly.Memory, allocState?: { heapEnd: number; freeList: number }): void {
  initWasm(memory);
  if (allocState) { wasm.setHeapEnd(allocState.heapEnd); wasm.setFreeList(allocState.freeList); }
}
export function getBufferCopy(): Uint8Array { return new Uint8Array(wasmMemory.buffer).slice(); }
export function getAllocState() { return { heapEnd: wasm.getHeapEnd(), freeList: wasm.getFreeList() }; }
export function resetPriorityQueue(): void { wasm.reset(); }

// Fast ASCII encode
function encodeValueFast(str: string, buf: Uint8Array, ptr: number): number {
  let isAscii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) { isAscii = false; break; }
  }
  if (isAscii) {
    for (let i = 0; i < str.length; i++) buf[ptr + i] = str.charCodeAt(i);
    return str.length;
  }
  const bytes = encoder.encode(str);
  buf.set(bytes, ptr);
  return bytes.length;
}

// Fast ASCII decode
function decodeValueFast(buf: Uint8Array, ptr: number, len: number): string {
  let isAscii = true;
  for (let i = 0; i < len; i++) {
    if (buf[ptr + i] > 127) { isAscii = false; break; }
  }
  if (isAscii) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[ptr + i]);
    return s;
  }
  return decoder.decode(buf.subarray(ptr, ptr + len));
}

export type SharedPriorityQueueType = ValueType;

export class SharedPriorityQueue<T extends SharedPriorityQueueType> {
  readonly root: number;
  readonly size: number;
  readonly valueType: T;
  readonly isMaxHeap: boolean;

  constructor(type: T, options?: { maxHeap?: boolean } | { root: number; size: number; isMaxHeap: boolean }) {
    this.valueType = type;
    if (options && 'root' in options) {
      this.root = options.root;
      this.size = options.size;
      this.isMaxHeap = options.isMaxHeap;
    } else {
      this.root = 0;
      this.size = 0;
      this.isMaxHeap = options?.maxHeap ?? false;
    }
  }

  enqueue(value: ValueOf<T>, priority: number): SharedPriorityQueue<T> {
    if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
    let valuePacked: number;
    if (this.valueType === 'number') {
      // Store f64 as blob (8 bytes)
      const f64 = new Float64Array([value as number]);
      const bytes = new Uint8Array(f64.buffer);
      mem.buf.set(bytes, blobBufPtr);
      const blobPtr = wasm.allocBlob(8);
      valuePacked = blobPtr | (8 << 20);
    } else if (this.valueType === 'boolean') {
      valuePacked = (value as boolean) ? 1 : 0;
    } else {
      const str = this.valueType === 'string' ? value as string : JSON.stringify(value);
      const len = encodeValueFast(str, mem.buf, blobBufPtr);
      const blobPtr = wasm.allocBlob(len);
      valuePacked = blobPtr | (len << 20);
    }
    const newRoot = wasm.insert(this.root, priority, valuePacked, this.isMaxHeap ? 1 : 0);
    return new SharedPriorityQueue(this.valueType, { root: newRoot, size: this.size + 1, isMaxHeap: this.isMaxHeap });
  }

  dequeue(): SharedPriorityQueue<T> {
    if (this.size === 0) return this;
    const newRoot = wasm.extractTop(this.root, this.isMaxHeap ? 1 : 0);
    return new SharedPriorityQueue(this.valueType, { root: newRoot, size: this.size - 1, isMaxHeap: this.isMaxHeap });
  }

  peek(): ValueOf<T> | undefined {
    if (this.size === 0) return undefined;
    return this._decodeValue(wasm.peekValue(this.root));
  }

  peekPriority(): number | undefined {
    if (this.size === 0) return undefined;
    return wasm.peekPriority(this.root);
  }

  get isEmpty(): boolean { return this.size === 0; }

  private _decodeValue(packed: number): ValueOf<T> {
    if (this.valueType === 'number') {
      const ptr = packed & 0xFFFFF;
      if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
      const f64 = new Float64Array(mem.buf.buffer, ptr, 1);
      return f64[0] as ValueOf<T>;
    }
    if (this.valueType === 'boolean') return (packed !== 0) as ValueOf<T>;
    const ptr = packed & 0xFFFFF, len = packed >>> 20;
    if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
    const str = decodeValueFast(mem.buf, ptr, len);
    return (this.valueType === 'string' ? str : JSON.parse(str)) as ValueOf<T>;
  }

  static fromWorkerData<T extends SharedPriorityQueueType>(data: { root: number; size: number; type: T; isMaxHeap: boolean }): SharedPriorityQueue<T> {
    return new SharedPriorityQueue(data.type, { root: data.root, size: data.size, isMaxHeap: data.isMaxHeap });
  }

  toWorkerData() { return { root: this.root, size: this.size, type: this.valueType, isMaxHeap: this.isMaxHeap }; }
}
