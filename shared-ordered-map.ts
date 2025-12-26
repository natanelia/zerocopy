import { loadWasm, createSharedMemory, MemoryView } from './wasm-utils';
import { encoder, decoder, structureRegistry } from './codec';
import { parseNestedType } from './types';
import type { ValueOf } from './types';

const wasmBytes = loadWasm('ordered-map.wasm');
const wasmModule = new WebAssembly.Module(wasmBytes);

let wasmMemory: WebAssembly.Memory;
let wasm: any;
let keyBufPtr: number;
let blobBufPtr: number;
let mem: MemoryView;
let lastBuf: ArrayBuffer;

function initWasm(existingMemory?: WebAssembly.Memory) {
  wasmMemory = existingMemory || createSharedMemory();
  wasm = new WebAssembly.Instance(wasmModule, { env: { memory: wasmMemory } }).exports;
  keyBufPtr = wasm.keyBuf();
  blobBufPtr = wasm.blobBuf();
  mem = new MemoryView(wasmMemory);
  lastBuf = wasmMemory.buffer;
}

initWasm();

// Inline refresh - only when buffer detached
function refresh() {
  if (lastBuf !== wasmMemory.buffer) {
    lastBuf = wasmMemory.buffer;
    mem.buf = new Uint8Array(lastBuf);
    mem.dv = new DataView(lastBuf);
  }
}

export const sharedBuffer = wasmMemory!.buffer as SharedArrayBuffer;
export const sharedMemory = wasmMemory!;

export function attachToMemory(memory: WebAssembly.Memory, allocState?: { heapEnd: number; freeList: number }): void {
  initWasm(memory);
  if (allocState) { wasm.setHeapEnd(allocState.heapEnd); wasm.setFreeList(allocState.freeList); }
}

export function getBufferCopy(): Uint8Array { return new Uint8Array(wasmMemory.buffer).slice(); }
export function getAllocState() { return { heapEnd: wasm.getHeapEnd(), freeList: wasm.getFreeList() }; }
export function resetOrderedMap(): void { generation++; wasm.reset(); }

let generation = 0;
const registry = new FinalizationRegistry<{ gen: number }>(({ gen }) => {
  // Structure became unreachable - could trigger cleanup if gen matches
});

// Fast ASCII key encoding
function encodeKeyFast(key: string): number {
  refresh();
  const len = key.length;
  const buf = mem.buf;
  for (let i = 0; i < len; i++) {
    const c = key.charCodeAt(i);
    if (c > 127) {
      const bytes = encoder.encode(key);
      buf.set(bytes, keyBufPtr);
      return bytes.length;
    }
    buf[keyBufPtr + i] = c;
  }
  return len;
}

// Encode value directly to blobBuf, return length
function encodeValueFast(type: string, value: any, nestedInfo: { structureType: string; innerType: string } | null): number {
  refresh();
  if (type === 'number') {
    mem.dv.setFloat64(blobBufPtr, value as number, true);
    return 8;
  }
  if (type === 'boolean') {
    mem.buf[blobBufPtr] = (value as boolean) ? 1 : 0;
    return 1;
  }
  let str: string;
  if (nestedInfo) {
    str = JSON.stringify({ __t: nestedInfo.structureType, __i: nestedInfo.innerType, __d: value.toWorkerData() });
  } else {
    str = type === 'string' ? value as string : JSON.stringify(value);
  }
  const bytes = encoder.encode(str);
  mem.buf.set(bytes, blobBufPtr);
  return bytes.length;
}

function decodeValue(type: string, ptr: number, len: number, nestedInfo: { structureType: string; innerType: string } | null): any {
  refresh();
  if (type === 'number') return mem.dv.getFloat64(ptr, true);
  if (type === 'boolean') return mem.buf[ptr] !== 0;
  const buf = mem.buf;
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[ptr + i];
    if (c > 127) { s = decoder.decode(buf.subarray(ptr, ptr + len)); break; }
    s += String.fromCharCode(c);
  }
  if (nestedInfo) {
    const { __t, __i, __d } = JSON.parse(s);
    const factory = structureRegistry[__t];
    if (!factory) throw new Error(`Unknown structure type: ${__t}`);
    return factory.fromWorkerData({ ...__d, valueType: __d.valueType ?? __i });
  }
  return type === 'string' ? s : JSON.parse(s);
}

export type SharedOrderedMapType = 'string' | 'number' | 'boolean' | 'object' | `Shared${string}<${string}>`;

export class SharedOrderedMap<T extends string = SharedOrderedMapType> {
  readonly root: number;
  readonly head: number;
  readonly tail: number;
  readonly size: number;
  readonly valueType: T;
  private nestedInfo: { structureType: string; innerType: string } | null;

  constructor(type: T, root = 0, head = 0, tail = 0, size = 0) {
    this.valueType = type;
    this.root = root;
    this.head = head;
    this.tail = tail;
    this.size = size;
    this.nestedInfo = parseNestedType(type);
    if (root) registry.register(this, { gen: generation });
  }

  set(key: string, value: ValueOf<T>): SharedOrderedMap<T> {
    const keyLen = encodeKeyFast(key);
    const valLen = encodeValueFast(this.valueType, value, this.nestedInfo);
    
    wasm.set(this.root, this.head, this.tail, keyLen, valLen);
    refresh();
    
    return new SharedOrderedMap(
      this.valueType,
      wasm.getResultRoot(),
      wasm.getResultHead(),
      wasm.getResultTail(),
      wasm.getResultIsNew() ? this.size + 1 : this.size
    );
  }

  get(key: string): ValueOf<T> | undefined {
    if (!this.root) return undefined;
    const node = wasm.find(this.root, encodeKeyFast(key));
    if (!node) return undefined;
    refresh();
    return decodeValue(this.valueType, wasm.getListValPtr(node), wasm.getListValLen(node), this.nestedInfo);
  }

  has(key: string): boolean {
    if (!this.root) return false;
    return wasm.find(this.root, encodeKeyFast(key)) !== 0;
  }

  delete(key: string): SharedOrderedMap<T> {
    if (!this.root) return this;
    const keyLen = encodeKeyFast(key);
    if (!wasm.find(this.root, keyLen)) return this;
    
    wasm.del(this.root, this.head, this.tail, keyLen);
    refresh();
    
    return new SharedOrderedMap(
      this.valueType,
      wasm.getResultRoot(),
      wasm.getResultHead(),
      wasm.getResultTail(),
      this.size - 1
    );
  }

  *entries(): Generator<[string, ValueOf<T>]> {
    let node = this.head;
    while (node) {
      refresh();
      const keyPtr = wasm.getListKeyPtr(node);
      const keyLen = wasm.getListKeyLen(node);
      const valPtr = wasm.getListValPtr(node);
      const valLen = wasm.getListValLen(node);
      
      // Fast ASCII key decode
      const buf = mem.buf;
      let key = '';
      for (let i = 0; i < keyLen; i++) {
        const c = buf[keyPtr + i];
        if (c > 127) { key = decoder.decode(buf.subarray(keyPtr, keyPtr + keyLen)); break; }
        key += String.fromCharCode(c);
      }
      
      yield [key, decodeValue(this.valueType, valPtr, valLen, this.nestedInfo)];
      node = wasm.getListNext(node);
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

  static fromWorkerData<T extends string>(data: { root: number; head: number; tail: number; size: number; valueType: T }): SharedOrderedMap<T> {
    return new SharedOrderedMap(data.valueType, data.root, data.head, data.tail, data.size);
  }
}

// Register SharedOrderedMap in structure registry for nested type support
structureRegistry['SharedOrderedMap'] = { fromWorkerData: (d: any) => SharedOrderedMap.fromWorkerData(d) };
