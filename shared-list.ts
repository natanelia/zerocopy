import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, 'shared-list.wasm'));
const wasmModule = new WebAssembly.Module(wasmBytes);

let wasmMemory: WebAssembly.Memory;
let wasm: any;
let scratchPtr: number;
let blobBufPtr: number;
let isWorker = false;
let generation = 0;
let memBuf: Uint8Array;
let memDv: DataView;
let lastBuffer: ArrayBufferLike;

function refreshMem() {
  if (!lastBuffer || lastBuffer !== wasmMemory.buffer) {
    lastBuffer = wasmMemory.buffer;
    memBuf = new Uint8Array(lastBuffer);
    memDv = new DataView(lastBuffer);
  }
}

function initWasm(existingMemory?: WebAssembly.Memory) {
  wasmMemory = existingMemory || new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true });
  const wasmInstance = new WebAssembly.Instance(wasmModule, { env: { memory: wasmMemory } });
  wasm = wasmInstance.exports;
  scratchPtr = wasm.scratch();
  blobBufPtr = wasm.blobBuf();
  if (existingMemory) isWorker = true;
  refreshMem();
}

initWasm();

export const sharedBuffer = wasmMemory!.buffer as SharedArrayBuffer;
export const sharedMemory = wasmMemory!;

// Get current buffer (updates after attachToMemory)
export function getBuffer(): SharedArrayBuffer {
  return wasmMemory.buffer as SharedArrayBuffer;
}

// Get allocator state for passing to workers
export function getAllocState(): { heapEnd: number; freeNodes: number; freeLeaves: number } {
  return { heapEnd: wasm.getHeapEnd(), freeNodes: wasm.getFreeNodes(), freeLeaves: wasm.getFreeLeaves() };
}

// Attach worker to main thread's memory - true zero-copy (Node.js only)
// For Bun, use attachToBufferCopy instead
export function attachToMemory(memory: WebAssembly.Memory, allocState?: { heapEnd: number; freeNodes: number; freeLeaves: number }): void {
  initWasm(memory);
  if (allocState) {
    wasm.setHeapEnd(allocState.heapEnd);
    wasm.setFreeNodes(allocState.freeNodes);
    wasm.setFreeLeaves(allocState.freeLeaves);
  }
}

// Attach worker using buffer copy (works in Bun and Node.js)
export function attachToBufferCopy(bufferCopy: Uint8Array, allocState: { heapEnd: number; freeNodes: number; freeLeaves: number }): void {
  wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true });
  new Uint8Array(wasmMemory.buffer).set(bufferCopy);
  const wasmInstance = new WebAssembly.Instance(wasmModule, { env: { memory: wasmMemory } });
  wasm = wasmInstance.exports;
  scratchPtr = wasm.scratch();
  blobBufPtr = wasm.blobBuf();
  wasm.setHeapEnd(allocState.heapEnd);
  wasm.setFreeNodes(allocState.freeNodes);
  wasm.setFreeLeaves(allocState.freeLeaves);
  isWorker = true;
  refreshMem();
}

// Get buffer copy for Bun workers
export function getBufferCopy(): Uint8Array {
  return new Uint8Array(wasmMemory.buffer).slice();
}

export function resetSharedList(): void {
  generation++;
  wasm.reset();
}

export function syncBuffer(): void {
  refreshMem();
}

import { parseNestedType } from './types';
import { structureRegistry } from './codec';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const registry = new FinalizationRegistry<{ root: number; depth: number; gen: number }>(
  ({ root, depth, gen }) => {
    if (gen === generation && root && !isWorker) wasm.vecDecref(root, depth);
  }
);

export type SharedListType = 'number' | 'string' | 'boolean' | 'object' | `Shared${string}<${string}>`;
type ValueOf<T extends string> = T extends 'number' ? number : T extends 'string' ? string : T extends 'boolean' ? boolean : T extends 'object' ? object : any;

function packPtrLen(ptr: number, len: number): number {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, ptr, true);
  dv.setUint32(4, len, true);
  return dv.getFloat64(0, true);
}

function unpackPtrLen(val: number): [number, number] {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, val, true);
  return [dv.getUint32(0, true), dv.getUint32(4, true)];
}

export class SharedList<T extends string = SharedListType> {
  readonly root: number;
  private depth: number;
  private _size: number;
  private gen: number;
  private disposed = false;
  readonly type: T;
  private nestedInfo: { structureType: string; innerType: string } | null;

  constructor(type: T, root = 0, depth = 0, size = 0) {
    this.type = type;
    this.root = root;
    this.depth = depth;
    this._size = size;
    this.gen = generation;
    this.nestedInfo = parseNestedType(type);
    if (root && !isWorker) registry.register(this, { root, depth, gen: generation });
  }

  dispose(): void {
    if (!this.disposed && this.gen === generation && this.root && !isWorker) {
      wasm.vecDecref(this.root, this.depth);
      this.disposed = true;
    }
  }

  private encode(value: ValueOf<T>): number {
    if (this.type === 'number') return value as number;
    if (this.type === 'boolean') return (value as boolean) ? 1 : 0;
    refreshMem();
    let str: string;
    if (this.nestedInfo) {
      str = JSON.stringify({ __t: this.nestedInfo.structureType, __i: this.nestedInfo.innerType, __d: (value as any).toWorkerData() });
    } else {
      str = this.type === 'string' ? value as string : JSON.stringify(value);
    }
    const { written } = encoder.encodeInto(str, memBuf.subarray(blobBufPtr));
    const ptr = wasm.allocBlob(written);
    refreshMem();
    return packPtrLen(ptr, written!);
  }

  private decode(raw: number): ValueOf<T> {
    if (this.type === 'number') return raw as ValueOf<T>;
    if (this.type === 'boolean') return (raw !== 0) as ValueOf<T>;
    refreshMem();
    const [ptr, len] = unpackPtrLen(raw);
    const str = decoder.decode(memBuf.subarray(ptr, ptr + len));
    if (this.nestedInfo) {
      const { __t, __i, __d } = JSON.parse(str);
      const factory = structureRegistry[__t];
      if (!factory) throw new Error(`Unknown structure type: ${__t}`);
      return factory.fromWorkerData({ ...__d, valueType: __d.valueType ?? __i }) as ValueOf<T>;
    }
    if (this.type === 'string') return str as ValueOf<T>;
    return JSON.parse(str) as ValueOf<T>;
  }

  push(value: ValueOf<T>): SharedList<T> {
    if (this.gen !== generation || this.disposed) return new SharedList(this.type).push(value);
    wasm.vecPush(this.root, this.depth, this._size, this.encode(value));
    refreshMem();
    return new SharedList(
      this.type,
      memDv.getUint32(scratchPtr, true),
      memDv.getUint32(scratchPtr + 4, true),
      memDv.getUint32(scratchPtr + 8, true)
    );
  }

  get(index: number): ValueOf<T> | undefined {
    if (this.gen !== generation || this.disposed || index < 0 || index >= this._size) return undefined;
    return this.decode(wasm.vecGet(this.root, this.depth, index));
  }

  set(index: number, value: ValueOf<T>): SharedList<T> {
    if (this.gen !== generation || this.disposed || index < 0 || index >= this._size) return this;
    const newRoot = wasm.vecSet(this.root, this.depth, index, this.encode(value));
    return new SharedList(this.type, newRoot, this.depth, this._size);
  }

  pop(): SharedList<T> {
    if (this.gen !== generation || this.disposed || this._size === 0) return this;
    wasm.vecPop(this.root, this.depth, this._size);
    refreshMem();
    return new SharedList(
      this.type,
      memDv.getUint32(scratchPtr, true),
      memDv.getUint32(scratchPtr + 4, true),
      memDv.getUint32(scratchPtr + 8, true)
    );
  }

  get size(): number {
    return (this.gen === generation && !this.disposed) ? this._size : 0;
  }

  *values(): Generator<ValueOf<T>> {
    if (this.gen !== generation || this.disposed) return;
    for (let i = 0; i < this._size; i++) yield this.decode(wasm.vecGet(this.root, this.depth, i));
  }

  forEach(fn: (value: ValueOf<T>, index: number) => void): void {
    if (this.gen !== generation || this.disposed) return;
    for (let i = 0; i < this._size; i++) fn(this.decode(wasm.vecGet(this.root, this.depth, i)), i);
  }

  toArray(): ValueOf<T>[] {
    if (this.gen !== generation || this.disposed) return [];
    const arr = new Array(this._size);
    for (let i = 0; i < this._size; i++) arr[i] = this.decode(wasm.vecGet(this.root, this.depth, i));
    return arr;
  }

  pushMany(values: ValueOf<T>[]): SharedList<T> {
    let v: SharedList<T> = this;
    for (const val of values) v = v.push(val);
    return v;
  }

  toWorkerData(): { root: number; depth: number; size: number; type: T } {
    return { root: this.root, depth: this.depth, size: this._size, type: this.type };
  }

  static fromWorkerData<T extends string>(data: { root: number; depth: number; size: number; type: T }): SharedList<T> {
    return new SharedList(data.type, data.root, data.depth, data.size);
  }
}

// Register SharedList in structure registry for nested type support
structureRegistry['SharedList'] = { fromWorkerData: (d: any) => SharedList.fromWorkerData(d) };
