import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseNestedType } from './types';
import { structureRegistry } from './codec';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, 'shared-map.wasm'));
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmMemory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
const wasmInstance = new WebAssembly.Instance(wasmModule, { env: { memory: wasmMemory } });
const wasm = wasmInstance.exports as any;
const keyBufPtr = wasm.keyBuf();
const batchBufPtr = wasm.batchBuf();

export const sharedBuffer = wasmMemory.buffer as SharedArrayBuffer;
let generation = 0;
const strCache = new Map<number, string>();
let clearObjPoolFn: () => void = () => {};
let clearObjCacheFn: () => void = () => {};
export function resetMap(): void { generation++; wasm.reset(); strCache.clear(); clearObjPoolFn(); clearObjCacheFn(); freeSlots.length = 0; pendingDispose.length = 0; opsSinceGC = 0; }
export function getUsedBytes(): number { return wasm.getUsedBytes(); }

// Auto-GC configuration
let autoGCEnabled = true;
let gcMemoryThreshold = 1024 * 1024; // 1MB
let gcOpsThreshold = 1000;
let opsSinceGC = 0;
const pendingDispose: SharedMap<any>[] = [];

export function configureAutoGC(opts: { enabled?: boolean; memoryThreshold?: number; opsThreshold?: number }) {
  if (opts.enabled !== undefined) autoGCEnabled = opts.enabled;
  if (opts.memoryThreshold !== undefined) gcMemoryThreshold = opts.memoryThreshold;
  if (opts.opsThreshold !== undefined) gcOpsThreshold = opts.opsThreshold;
}

function maybeGC() {
  if (!autoGCEnabled) return;
  opsSinceGC++;
  // Only dispose pending HAMTs when thresholds are hit
  if (pendingDispose.length > 0 && (opsSinceGC >= gcOpsThreshold || wasm.getUsedBytes() > gcMemoryThreshold)) {
    for (let i = pendingDispose.length - 1; i >= 0; i--) {
      const h = pendingDispose[i];
      // Only dispose if slot is still valid (not already disposed)
      if (h['slot'] < 0xFFFFFFFF) h.dispose();
    }
    pendingDispose.length = 0;
    opsSinceGC = 0;
  }
}

// Track HAMT for potential GC - only tracks if it will be replaced
function trackForGC(h: SharedMap<any>) {
  if (autoGCEnabled && h['slot'] < 0xFFFFFFFF) {
    pendingDispose.push(h);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Use WASM-side root tracking for automatic memory management
const freeSlots: number[] = [];
const registry = new FinalizationRegistry<{ slot: number; gen: number }>(({ slot, gen }) => { 
  if (gen === generation) wasm.unregisterRoot(slot); 
});

function strLen(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) len++;
    else if (c < 2048) len += 2;
    else if (c >= 0xD800 && c < 0xDC00) { len += 4; i++; }
    else len += 3;
  }
  return len;
}

const STR_CACHE_MAX = 1024;

function decodeStr(ptr: number, len: number): string {
  const cacheKey = ptr | (len << 24);
  const cached = strCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let s: string;
  if (len <= 16) {
    refreshMem();
    s = '';
    for (let i = 0; i < len; i++) {
      const c = memBuf[ptr + i];
      if (c > 127) { s = decoder.decode(new Uint8Array(wasmMemory.buffer, ptr, len)); break; }
      s += String.fromCharCode(c);
    }
  } else {
    s = decoder.decode(new Uint8Array(wasmMemory.buffer, ptr, len));
  }
  if (strCache.size < STR_CACHE_MAX) strCache.set(cacheKey, s);
  return s;
}

const refPool = new Map<number, any>();
let nextRefId = 1;
clearObjPoolFn = () => { refPool.clear(); nextRefId = 1; };

const objCache = new Map<number, object>();
const OBJ_CACHE_MAX = 1024;
clearObjCacheFn = () => objCache.clear();

function decodeObj(ptr: number, len: number): object {
  const cacheKey = ptr | (len << 20);
  const cached = objCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const obj = JSON.parse(decodeStr(ptr, len));
  if (objCache.size < OBJ_CACHE_MAX) objCache.set(cacheKey, obj);
  return obj;
}

function decodeNested(ptr: number, len: number): any {
  const { __t, __i, __d } = JSON.parse(decodeStr(ptr, len));
  const factory = structureRegistry[__t];
  if (!factory) throw new Error(`Unknown structure type: ${__t}`);
  return factory.fromWorkerData({ ...__d, valueType: __d.valueType ?? __i });
}

export type ValueType = 'string' | 'number' | 'boolean' | 'object' | `Shared${string}<${string}>`;
type Codec<T> = [(v: T) => number, (v: T, buf: Uint8Array, ptr: number) => number, (ptr: number, len: number) => T];

const codecs: Record<string, Codec<any>> = {
  string: [
    (v: string) => strLen(v),
    (v: string, buf: Uint8Array, ptr: number) => encoder.encodeInto(v, buf.subarray(ptr)).written!,
    (ptr: number, len: number) => decodeStr(ptr, len)
  ],
  number: [
    () => 8,
    (v: number, buf: Uint8Array, ptr: number) => { new DataView(buf.buffer).setFloat64(ptr, v, true); return 8; },
    (ptr: number, _: number) => new DataView(wasmMemory.buffer).getFloat64(ptr, true)
  ],
  boolean: [
    () => 1,
    (v: boolean, buf: Uint8Array, ptr: number) => { buf[ptr] = v ? 1 : 0; return 1; },
    (ptr: number, _: number) => new Uint8Array(wasmMemory.buffer)[ptr] === 1
  ],
  object: [
    (v: object) => strLen(JSON.stringify(v)),
    (v: object, buf: Uint8Array, ptr: number) => encoder.encodeInto(JSON.stringify(v), buf.subarray(ptr)).written!,
    (ptr: number, len: number) => decodeObj(ptr, len)
  ],
};

function getCodecForType(type: string): Codec<any> {
  if (codecs[type]) return codecs[type];
  const nested = parseNestedType(type);
  if (nested) {
    return [
      (v: any) => strLen(JSON.stringify({ __t: nested.structureType, __i: nested.innerType, __d: v.toWorkerData() })),
      (v: any, buf: Uint8Array, ptr: number) => encoder.encodeInto(JSON.stringify({ __t: nested.structureType, __i: nested.innerType, __d: v.toWorkerData() }), buf.subarray(ptr)).written!,
      (ptr: number, len: number) => decodeNested(ptr, len)
    ];
  }
  throw new Error(`Unknown type: ${type}`);
}

type ValueOf<T extends string> = T extends 'string' ? string : T extends 'number' ? number : T extends 'boolean' ? boolean : T extends 'object' ? object : any;

let memBuf = new Uint8Array(wasmMemory.buffer);
let memDv = new DataView(wasmMemory.buffer);
let lastBuffer = wasmMemory.buffer;
function refreshMem() {
  if (lastBuffer !== wasmMemory.buffer) {
    lastBuffer = wasmMemory.buffer;
    memBuf = new Uint8Array(lastBuffer);
    memDv = new DataView(lastBuffer);
  }
}

function encodeKey(key: string, ptr: number): number {
  refreshMem();
  const len = key.length;
  for (let i = 0; i < len; i++) {
    const c = key.charCodeAt(i);
    if (c > 127) return encoder.encodeInto(key, memBuf.subarray(ptr)).written!;
    memBuf[ptr + i] = c;
  }
  return len;
}

export class SharedMap<T extends string = ValueType> {
  private _type: T;
  private root: number;
  private _size: number;
  private slot: number;
  private valLen: (v: ValueOf<T>) => number;
  private enc: (v: ValueOf<T>, buf: Uint8Array, ptr: number) => number;
  private dec: (ptr: number, len: number) => ValueOf<T>;

  constructor(type: T, root = 0, size = 0) {
    this._type = type;
    this.root = root;
    this._size = size;
    const codec = getCodecForType(type);
    this.valLen = codec[0];
    this.enc = codec[1];
    this.dec = codec[2];
    // Register root in WASM for automatic refcounting
    if (root) {
      const reused = freeSlots.pop();
      if (reused !== undefined) {
        this.slot = reused;
        wasm.updateRoot(this.slot, root); // decrefs old (0), stores new
      } else {
        this.slot = wasm.registerRoot(root); // just stores, no incref
      }
      if (this.slot < 0xFFFFFFFF) {
        registry.register(this, { slot: this.slot, gen: generation });
      }
    } else {
      this.slot = 0xFFFFFFFF;
    }
  }

  // Explicit dispose for immediate cleanup
  dispose(): void {
    if (this.slot < 0xFFFFFFFF) {
      wasm.updateRoot(this.slot, 0);
      freeSlots.push(this.slot);
      registry.unregister(this);
      this.slot = 0xFFFFFFFF;
    }
  }

  set(key: string, value: ValueOf<T>): SharedMap<T> {
    maybeGC();
    trackForGC(this);
    const keyLen = encodeKey(key, keyBufPtr);
    const valLen = this.valLen(value);
    wasm.insertKey(this.root, keyLen, valLen);
    refreshMem();
    const newRoot = memDv.getUint32(batchBufPtr, true);
    const existed = memDv.getUint32(batchBufPtr + 4, true);
    const valPtr = memDv.getUint32(batchBufPtr + 8, true);
    this.enc(value, memBuf, valPtr);
    return new SharedMap<T>(this._type, newRoot, this._size + (existed ? 0 : 1));
  }

  get(key: string): ValueOf<T> | undefined {
    const keyLen = encodeKey(key, keyBufPtr);
    if (!wasm.getInfo(this.root, keyLen)) return undefined;
    refreshMem();
    const kLen = memDv.getUint32(batchBufPtr, true);
    const vLen = memDv.getUint32(batchBufPtr + 4, true);
    const keyPtr = memDv.getUint32(batchBufPtr + 8, true);
    return this.dec(keyPtr + kLen, vLen);
  }

  has(key: string): boolean {
    return wasm.has(this.root, encodeKey(key, keyBufPtr)) === 1;
  }

  delete(key: string): SharedMap<T> {
    maybeGC();
    const keyLen = encodeKey(key, keyBufPtr);
    const newRoot = wasm.tryRemove(this.root, keyLen) >>> 0;
    if (newRoot === 0xFFFFFFFF) return this;
    trackForGC(this);
    return new SharedMap<T>(this._type, newRoot, this._size - 1);
  }

  get size(): number { return this._size; }

  forEach(fn: (value: ValueOf<T>, key: string) => void): void {
    wasm.initIter(this.root);
    const dv = new DataView(wasmMemory.buffer);
    let count;
    while ((count = wasm.nextLeaves(512))) {
      for (let i = 0, off = batchBufPtr; i < count; i++, off += 12) {
        const ptr = dv.getUint32(off, true);
        const kLen = dv.getUint32(off + 4, true);
        const vLen = dv.getUint32(off + 8, true);
        const keyPtr = wasm.leafKeyPtr(ptr);
        fn(this.dec(keyPtr + kLen, vLen), decodeStr(keyPtr, kLen));
      }
    }
  }

  *entries(): Generator<[string, ValueOf<T>]> {
    wasm.initIter(this.root);
    const dv = new DataView(wasmMemory.buffer);
    let count;
    while ((count = wasm.nextLeaves(512))) {
      for (let i = 0, off = batchBufPtr; i < count; i++, off += 12) {
        const ptr = dv.getUint32(off, true);
        const kLen = dv.getUint32(off + 4, true);
        const vLen = dv.getUint32(off + 8, true);
        const keyPtr = wasm.leafKeyPtr(ptr);
        yield [decodeStr(keyPtr, kLen), this.dec(keyPtr + kLen, vLen)];
      }
    }
  }

  *keys(): Generator<string> {
    wasm.initIter(this.root);
    const dv = new DataView(wasmMemory.buffer);
    let count;
    while ((count = wasm.nextLeaves(512))) {
      for (let i = 0, off = batchBufPtr; i < count; i++, off += 12) {
        const ptr = dv.getUint32(off, true);
        const kLen = dv.getUint32(off + 4, true);
        yield decodeStr(wasm.leafKeyPtr(ptr), kLen);
      }
    }
  }

  *values(): Generator<ValueOf<T>> {
    wasm.initIter(this.root);
    const dv = new DataView(wasmMemory.buffer);
    let count;
    while ((count = wasm.nextLeaves(512))) {
      for (let i = 0, off = batchBufPtr; i < count; i++, off += 12) {
        const ptr = dv.getUint32(off, true);
        const kLen = dv.getUint32(off + 4, true);
        const vLen = dv.getUint32(off + 8, true);
        yield this.dec(wasm.leafKeyPtr(ptr) + kLen, vLen);
      }
    }
  }

  setMany(entries: [string, ValueOf<T>][]): SharedMap<T> {
    refreshMem();
    let offset = 0;
    for (const [key, value] of entries) {
      const keyLen = encoder.encodeInto(key, memBuf.subarray(batchBufPtr + offset + 8)).written!;
      const valLen = this.enc(value, memBuf, batchBufPtr + offset + 8 + keyLen);
      memDv.setUint32(batchBufPtr + offset, keyLen, true);
      memDv.setUint32(batchBufPtr + offset + 4, valLen, true);
      offset += 8 + keyLen + valLen;
    }
    const newRoot = wasm.batchInsertTransient(this.root, entries.length);
    const inserted = memDv.getUint32(batchBufPtr - 4, true);
    return new SharedMap<T>(this._type, newRoot, this._size + inserted);
  }

  getMany(keys: string[]): (ValueOf<T> | undefined)[] {
    refreshMem();
    let offset = 0;
    for (const key of keys) {
      const written = encoder.encodeInto(key, memBuf.subarray(batchBufPtr + offset + 4)).written!;
      memDv.setUint32(batchBufPtr + offset, written, true);
      offset += 4 + written;
    }
    wasm.batchGet(this.root, keys.length);
    const results: (ValueOf<T> | undefined)[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const ptr = memDv.getUint32(batchBufPtr + (i << 2), true);
      if (ptr) {
        const kLen = wasm.leafKeyLen(ptr), vLen = wasm.leafValLen(ptr);
        results[i] = this.dec(wasm.leafKeyPtr(ptr) + kLen, vLen);
      }
    }
    return results;
  }

  deleteMany(keys: string[]): SharedMap<T> {
    refreshMem();
    let offset = 0;
    for (const key of keys) {
      const written = encoder.encodeInto(key, memBuf.subarray(batchBufPtr + offset + 4)).written!;
      memDv.setUint32(batchBufPtr + offset, written, true);
      offset += 4 + written;
    }
    const newRoot = wasm.batchDeleteTransient(this.root, keys.length);
    const deleted = memDv.getUint32(batchBufPtr - 4, true);
    return new SharedMap<T>(this._type, newRoot, this._size - deleted);
  }

  /** Get value type */
  get valueType(): T { return this._type; }

  /** Create from worker data (read-only in worker) */
  static fromWorkerData<T extends string>(root: number, valueType: T, size?: number): SharedMap<T> {
    const map = new SharedMap<T>(valueType, 0, 0);
    (map as any).root = root;
    if (size !== undefined) (map as any)._size = size;
    return map;
  }

  /** Serialize for worker transfer */
  toWorkerData(): { root: number; valueType: T; size: number } {
    return { root: this.root, valueType: this._type, size: this._size };
  }
}

// Register SharedMap in structure registry for nested type support
structureRegistry['SharedMap'] = { fromWorkerData: (d: any) => SharedMap.fromWorkerData(d.root, d.valueType, d.size) };

// Internal numeric key class for HAMTList - shares WASM instance
export class SharedMapNumeric<T extends string = ValueType> {
  readonly _type: T;
  readonly root: number;
  private valLen: (v: ValueOf<T>) => number;
  private enc: (v: ValueOf<T>, buf: Uint8Array, ptr: number) => number;
  readonly dec: (ptr: number, len: number) => ValueOf<T>;

  constructor(type: T, root = 0) {
    this._type = type;
    this.root = root;
    const codec = getCodecForType(type);
    this.valLen = codec[0];
    this.enc = codec[1];
    this.dec = codec[2];
  }

  set(idx: number, value: ValueOf<T>): SharedMapNumeric<T> {
    const valLen = this.valLen(value);
    wasm.insertNum(this.root, idx, valLen);
    refreshMem();
    const newRoot = memDv.getUint32(batchBufPtr, true);
    const valPtr = memDv.getUint32(batchBufPtr + 8, true);
    this.enc(value, memBuf, valPtr);
    return new SharedMapNumeric(this._type, newRoot);
  }

  get(idx: number): ValueOf<T> | undefined {
    if (!wasm.getNumInfo(this.root, idx)) return undefined;
    refreshMem();
    const vLen = memDv.getUint32(batchBufPtr + 4, true);
    const keyPtr = memDv.getUint32(batchBufPtr + 8, true);
    return this.dec(keyPtr + 4, vLen);
  }

  delete(idx: number): SharedMapNumeric<T> {
    const newRoot = wasm.removeNum(this.root, idx) >>> 0;
    if (newRoot === 0xFFFFFFFF) return this;
    return new SharedMapNumeric(this._type, newRoot);
  }

  has(idx: number): boolean {
    return wasm.hasNum(this.root, idx) === 1;
  }
}
