import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder, structureRegistry } from './codec.ts';
import { parseNestedType } from './types.ts';
import type { ValueOf } from './types.ts';

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
export function resetPriorityQueue(): void { generation++; wasm.reset(); }

let generation = 0;
const registry = new FinalizationRegistry<{ gen: number }>(({ gen }) => {});

export type SharedPriorityQueueType = 'string' | 'number' | 'boolean' | 'object' | `Shared${string}<${string}>`;

export class SharedPriorityQueue<T extends string = SharedPriorityQueueType> {
  readonly root: number;
  readonly size: number;
  readonly valueType: T;
  readonly isMaxHeap: boolean;
  private nestedInfo: { structureType: string; innerType: string } | null;

  constructor(type: T, options?: { maxHeap?: boolean } | { root: number; size: number; isMaxHeap: boolean }) {
    this.valueType = type;
    this.nestedInfo = parseNestedType(type);
    if (options && 'root' in options) {
      this.root = options.root;
      this.size = options.size;
      this.isMaxHeap = options.isMaxHeap;
      if (this.root) registry.register(this, { gen: generation });
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
      const f64 = new Float64Array([value as number]);
      mem.buf.set(new Uint8Array(f64.buffer), blobBufPtr);
      valuePacked = wasm.allocBlob(8) | (8 << 20);
    } else if (this.valueType === 'boolean') {
      valuePacked = (value as boolean) ? 1 : 0;
    } else {
      let str: string;
      if (this.nestedInfo) {
        str = JSON.stringify({ __t: this.nestedInfo.structureType, __i: this.nestedInfo.innerType, __d: (value as any).toWorkerData() });
      } else {
        str = this.valueType === 'string' ? value as string : JSON.stringify(value);
      }
      const bytes = encoder.encode(str);
      mem.buf.set(bytes, blobBufPtr);
      valuePacked = wasm.allocBlob(bytes.length) | (bytes.length << 20);
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
      if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
      return new Float64Array(mem.buf.buffer, packed & 0xFFFFF, 1)[0] as ValueOf<T>;
    }
    if (this.valueType === 'boolean') return (packed !== 0) as ValueOf<T>;
    const ptr = packed & 0xFFFFF, len = packed >>> 20;
    if (mem.buf.buffer !== wasmMemory.buffer) mem.refresh();
    const str = decoder.decode(mem.buf.subarray(ptr, ptr + len));
    if (this.nestedInfo) {
      const { __t, __i, __d } = JSON.parse(str);
      const factory = structureRegistry[__t];
      if (!factory) throw new Error(`Unknown structure type: ${__t}`);
      return factory.fromWorkerData({ ...__d, valueType: __d.valueType ?? __i }) as ValueOf<T>;
    }
    return (this.valueType === 'string' ? str : JSON.parse(str)) as ValueOf<T>;
  }

  static fromWorkerData<T extends string>(data: { root: number; size: number; type: T; isMaxHeap: boolean }): SharedPriorityQueue<T> {
    return new SharedPriorityQueue(data.type, { root: data.root, size: data.size, isMaxHeap: data.isMaxHeap });
  }

  toWorkerData() { return { root: this.root, size: this.size, type: this.valueType, isMaxHeap: this.isMaxHeap }; }
}

// Register SharedPriorityQueue in structure registry for nested type support
structureRegistry['SharedPriorityQueue'] = { fromWorkerData: (d: any) => SharedPriorityQueue.fromWorkerData(d) };
