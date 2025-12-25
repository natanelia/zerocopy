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
  readonly heapPtr: number;
  readonly size: number;
  readonly valueType: T;
  readonly isMaxHeap: boolean;
  private _topValue: ValueOf<T> | undefined;
  private _topPriority: number | undefined;

  constructor(type: T, options?: { maxHeap?: boolean } | { heapPtr: number; size: number; isMaxHeap: boolean; topValue?: ValueOf<T>; topPriority?: number }) {
    this.valueType = type;
    if (options && 'heapPtr' in options) {
      this.heapPtr = options.heapPtr;
      this.size = options.size;
      this.isMaxHeap = options.isMaxHeap;
      this._topValue = options.topValue;
      this._topPriority = options.topPriority;
    } else {
      if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
      this.heapPtr = wasm.createHeap(16);
      this.size = 0;
      this.isMaxHeap = options?.maxHeap ?? false;
    }
  }

  enqueue(value: ValueOf<T>, priority: number): SharedPriorityQueue<T> {
    if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
    let valuePacked: number;
    if (this.valueType === 'number') {
      const f64 = new Float64Array([value as number]);
      valuePacked = new Uint32Array(f64.buffer)[0];
    } else if (this.valueType === 'boolean') {
      valuePacked = (value as boolean) ? 1 : 0;
    } else {
      const str = this.valueType === 'string' ? value as string : JSON.stringify(value);
      const len = encodeValueFast(str, mem.buf, blobBufPtr);
      const blobPtr = wasm.allocBlob(len);
      valuePacked = blobPtr | (len << 20);
    }
    const newHeapPtr = wasm.insert(this.heapPtr, priority, valuePacked, this.isMaxHeap ? 1 : 0);
    const newSize = this.size + 1;
    // Update top if this is now the best priority
    let topValue = this._topValue, topPriority = this._topPriority;
    if (newSize === 1 || (this.isMaxHeap ? priority > topPriority! : priority < topPriority!)) {
      topValue = value;
      topPriority = priority;
    }
    return new SharedPriorityQueue(this.valueType, { heapPtr: newHeapPtr, size: newSize, isMaxHeap: this.isMaxHeap, topValue, topPriority });
  }

  dequeue(): SharedPriorityQueue<T> {
    if (this.size === 0) return this;
    wasm.extract(this.heapPtr, this.isMaxHeap ? 1 : 0);
    const newSize = this.size - 1;
    let topValue: ValueOf<T> | undefined, topPriority: number | undefined;
    if (newSize > 0) {
      if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
      topPriority = wasm.peekPriority(this.heapPtr);
      topValue = this._decodeValue(wasm.peekValue(this.heapPtr));
    }
    return new SharedPriorityQueue(this.valueType, { heapPtr: this.heapPtr, size: newSize, isMaxHeap: this.isMaxHeap, topValue, topPriority });
  }

  peek(): ValueOf<T> | undefined { return this._topValue; }
  peekPriority(): number | undefined { return this._topPriority; }
  get isEmpty(): boolean { return this.size === 0; }

  private _decodeValue(packed: number): ValueOf<T> {
    if (this.valueType === 'number') {
      const u32 = new Uint32Array([packed, 0]);
      return new Float64Array(u32.buffer)[0] as ValueOf<T>;
    }
    if (this.valueType === 'boolean') return (packed !== 0) as ValueOf<T>;
    const ptr = packed & 0xFFFFF, len = packed >>> 20;
    if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
    const str = decodeValueFast(mem.buf, ptr, len);
    return (this.valueType === 'string' ? str : JSON.parse(str)) as ValueOf<T>;
  }

  static fromWorkerData<T extends SharedPriorityQueueType>(data: { heapPtr: number; size: number; type: T; isMaxHeap: boolean }): SharedPriorityQueue<T> {
    if (data.size === 0) return new SharedPriorityQueue(data.type, { heapPtr: data.heapPtr, size: 0, isMaxHeap: data.isMaxHeap });
    if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
    const topPriority = wasm.peekPriority(data.heapPtr);
    const pq = new SharedPriorityQueue(data.type, { heapPtr: data.heapPtr, size: data.size, isMaxHeap: data.isMaxHeap, topPriority });
    const topValue = pq._decodeValue(wasm.peekValue(data.heapPtr));
    return new SharedPriorityQueue(data.type, { heapPtr: data.heapPtr, size: data.size, isMaxHeap: data.isMaxHeap, topValue, topPriority });
  }

  toWorkerData() { return { heapPtr: this.heapPtr, size: this.size, type: this.valueType, isMaxHeap: this.isMaxHeap }; }
}
