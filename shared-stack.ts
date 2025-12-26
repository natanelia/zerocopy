import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder, structureRegistry } from './codec';
import { parseNestedType } from './types';
import type { ValueOf } from './types';

const wasmBytes = loadWasm('linked-list.wasm');
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
const registry = new FinalizationRegistry<{ gen: number }>(({ gen }) => {
  // Structure became unreachable - could trigger cleanup if gen matches
});

export function attachToMemory(memory: WebAssembly.Memory, allocState?: { heapEnd: number; freeList: number }): void {
  initWasm(memory);
  if (allocState) { wasm.setHeapEnd(allocState.heapEnd); wasm.setFreeList(allocState.freeList); }
}

export function attachToBufferCopy(bufferCopy: Uint8Array, allocState: { heapEnd: number; freeList: number }): void {
  wasmMemory = createSharedMemory();
  new Uint8Array(wasmMemory.buffer).set(bufferCopy);
  wasm = new WebAssembly.Instance(wasmModule, { env: { memory: wasmMemory } }).exports;
  blobBufPtr = wasm.blobBuf();
  wasm.setHeapEnd(allocState.heapEnd);
  wasm.setFreeList(allocState.freeList);
  mem = new MemoryView(wasmMemory);
}

export function getBufferCopy(): Uint8Array { return new Uint8Array(wasmMemory.buffer).slice(); }
export function getAllocState() { return { heapEnd: wasm.getHeapEnd(), freeList: wasm.getFreeList() }; }
export function resetStack(): void { generation++; wasm.reset(); }

export type SharedStackType = 'string' | 'number' | 'boolean' | 'object' | `Shared${string}<${string}>`;

export class SharedStack<T extends string = SharedStackType> {
  readonly head: number;
  readonly size: number;
  readonly valueType: T;
  private _top: ValueOf<T> | undefined;
  private nestedInfo: { structureType: string; innerType: string } | null;

  constructor(type: T, head = 0, size = 0, top?: ValueOf<T>) {
    this.valueType = type;
    this.head = head;
    this.size = size;
    this._top = top;
    this.nestedInfo = parseNestedType(type);
    if (head) registry.register(this, { gen: generation });
  }

  private encodeValue(value: ValueOf<T>): { isBlob: boolean; data: number } {
    if (this.valueType === 'number') return { isBlob: false, data: value as number };
    if (this.valueType === 'boolean') return { isBlob: false, data: (value as boolean) ? 1 : 0 };
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
    return { isBlob: true, data: blobPtr | (bytes.length << 20) };
  }

  private decodeValue(packed: number, isBlob: boolean): ValueOf<T> {
    if (this.valueType === 'number') return packed as ValueOf<T>;
    if (this.valueType === 'boolean') return (packed !== 0) as ValueOf<T>;
    mem.refresh();
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

  push(value: ValueOf<T>): SharedStack<T> {
    const { isBlob, data } = this.encodeValue(value);
    const newHead = isBlob ? wasm.pushBlob(this.head, data) : wasm.push(this.head, data);
    return new SharedStack(this.valueType, newHead, this.size + 1, value);
  }

  pop(): SharedStack<T> {
    if (this.size === 0) return this;
    const newHead = wasm.pop(this.head);
    let newTop: ValueOf<T> | undefined;
    if (this.size > 1 && newHead) {
      const isBlob = this.valueType !== 'number' && this.valueType !== 'boolean';
      const packed = isBlob ? wasm.peekBlob(newHead) : wasm.peek(newHead);
      newTop = this.decodeValue(packed, isBlob);
    }
    return new SharedStack(this.valueType, newHead, this.size - 1, newTop);
  }

  peek(): ValueOf<T> | undefined { return this._top; }
  get isEmpty(): boolean { return this.size === 0; }

  static fromWorkerData<T extends string>(data: { head: number; size: number; type: T }): SharedStack<T> {
    if (data.size === 0) return new SharedStack(data.type, 0, 0);
    mem.refresh();
    const isBlob = data.type !== 'number' && data.type !== 'boolean';
    const packed = isBlob ? wasm.peekBlob(data.head) : wasm.peek(data.head);
    const stack = new SharedStack(data.type, data.head, data.size);
    return new SharedStack(data.type, data.head, data.size, stack.decodeValue(packed, isBlob));
  }

  toWorkerData() { return { head: this.head, size: this.size, type: this.valueType }; }
}

// Register SharedStack in structure registry for nested type support
structureRegistry['SharedStack'] = { fromWorkerData: (d: any) => SharedStack.fromWorkerData(d) };
