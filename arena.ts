import { decodeUtf8 } from './utf8';
import { loadWasm } from './wasm-utils';
import { structureRegistry } from './codec';
import { parseNestedType } from './types';

const module = new WebAssembly.Module(loadWasm('persistent-core.wasm') as BufferSource);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
let nextId = 0;
interface KeyToken { bytes: Uint8Array | undefined; length: number; hash: number; ptr: number | undefined; readRoot?: number; readValue?: number }
const realmId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const FORMAT_VERSION = 3;
export const HEAP_START = 65536;
export const MAX_SIZE = 0x3fffffff;

/** Freeze decoded JSON, not the caller's input. JSON trees contain no cycles. */
export function freezeJSON<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const todo: object[] = [value as object];
  while (todo.length) {
    const item = todo.pop()!;
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') todo.push(child);
    Object.freeze(item);
  }
  return value;
}

export function normalizeKey(key: string): string {
  if (typeof key !== 'string') throw new TypeError('Map keys must be strings');
  // TextEncoder replaces unpaired UTF-16 surrogates. Use the same equivalence
  // for scalar writes and bulk deduplication. Valid keys do not need a copy.
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = key.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return decoder.decode(encoder.encode(key));
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return decoder.decode(encoder.encode(key));
  }
  return key;
}
export function hashBytes(bytes: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return h >>> 0;
}
export function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
export function vectorDepth(size: number): number {
  let depth = 0, capacity = 32;
  while (size > capacity) { capacity *= 32; depth++; }
  return depth;
}
export function validIndex(index: number, size: number): boolean { return typeof index === 'number' && (index >>> 0) === index && index < size; }
export function checkedSize(size: number): number {
  if (typeof size !== 'number' || (size >>> 0) !== size || size > MAX_SIZE) throw new RangeError(`Size must be between 0 and ${MAX_SIZE}`);
  return size;
}
export function arenaOf(snapshot: object): Arena {
  return Snapshot.owner(snapshot as Snapshot);
}
export abstract class Snapshot {
  readonly #owner: Arena;
  protected constructor(arena: Arena) { this.#owner = arena; }
  static owner(snapshot: Snapshot): Arena { return snapshot.#owner; }
}

/** A single-writer, append-only allocation lifetime. Published bytes never change.
 * Reset is implemented by replacing the Arena, not by reusing its addresses.
 * Attached arenas are read-only: their allocator and scratch cannot race a writer.
 */
export class Arena {
  readonly memory: WebAssembly.Memory;
  readonly wasm: any;
  readonly id: string;
  readonly readOnly: boolean;
  readonly dependencies = new Map<string, Arena>();
  writeHead = 0;
  writeSize = 0;
  writeCount = 0;
  private buffer: ArrayBufferLike;
  private bytes: Uint8Array;
  private view: DataView;
  private readonly objects = new Map<number, unknown>();
  private readonly keys = new Map<string, KeyToken>();
  private keyBytes = 0;
  private objectBytes = 0;
  private stringBytes = 0;
  private readonly strings = new Map<number, string>();
  private readonly scalar = new Uint8Array(8);
  private readonly scalarView = new DataView(this.scalar.buffer);

  constructor(options: { memory?: WebAssembly.Memory; copy?: Uint8Array; used?: number; id?: string; readOnly?: boolean } = {}) {
    const initial = Math.max(2, Math.ceil((options.copy?.byteLength ?? HEAP_START) / 65536));
    this.memory = options.memory ?? new WebAssembly.Memory({ initial, maximum: 65536, shared: true });
    if (options.copy) new Uint8Array(this.memory.buffer).set(options.copy);
    this.wasm = new WebAssembly.Instance(module, { env: { memory: this.memory } }).exports;
    if (options.used !== undefined) this.wasm.setHeapEnd(options.used);
    this.readOnly = options.readOnly ?? false;
    this.id = options.id ?? `${realmId}-${++nextId}`;
    this.buffer = this.memory.buffer;
    this.bytes = new Uint8Array(this.buffer);
    this.view = new DataView(this.buffer);
  }
  get buf(): Uint8Array { this.refresh(); return this.bytes; }
  get dv(): DataView { this.refresh(); return this.view; }
  refresh(): void {
    if (this.buffer !== this.memory.buffer) {
      this.buffer = this.memory.buffer;
      this.bytes = new Uint8Array(this.buffer);
      this.view = new DataView(this.buffer);
    }
  }
  get used(): number { return this.wasm.getHeapEnd() >>> 0; }
  assertWritable(): void { if (this.readOnly) throw new Error('Attached snapshots are read-only; update them in the owning writer'); }
  alloc(bytes: number): number {
    this.assertWritable();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0x7ffe0000) throw new RangeError('Allocation exceeds the arena limit');
    const ptr = this.wasm.alloc(bytes) >>> 0;
    this.refresh();
    return ptr;
  }
  copy(): Uint8Array { return this.buf.slice(0, this.used); }
  state(): { heapEnd: number; freeList: number; freeNodes: number; freeLeaves: number } {
    return Object.freeze({ heapEnd: this.used, freeList: 0, freeNodes: 0, freeLeaves: 0 });
  }
  prepare(type: string, value: any): Uint8Array {
    if (type === 'number') {
      if (typeof value !== 'number') throw new TypeError('Expected a number');
      this.scalarView.setFloat64(0, value, true); return this.scalar;
    }
    if (type === 'boolean') {
      if (typeof value !== 'boolean') throw new TypeError('Expected a boolean');
      this.scalar[0] = value ? 1 : 0; return this.scalar.subarray(0, 1);
    }
    if (type === 'string') {
      if (typeof value !== 'string') throw new TypeError('Expected a string');
      return encoder.encode(value);
    }
    const nested = parseNestedType(type);
    let text: string | undefined;
    if (nested) {
      const dependency = arenaOf(value);
      if (dependency !== this) this.dependencies.set(dependency.id, dependency);
      text = JSON.stringify({ __t: nested.structureType, __i: nested.innerType, __a: dependency.id, __d: value.toWorkerData() });
    } else {
      if (type !== 'object') throw new TypeError(`Unknown value type: ${type}`);
      text = JSON.stringify(value);
    }
    if (text === undefined) throw new TypeError('Value is not JSON-serializable');
    return encoder.encode(text);
  }
  encode(type: string, value: any): number {
    this.assertWritable();
    if (type === 'number') { if (typeof value !== 'number') throw new TypeError('Expected a number'); return value; }
    if (type === 'boolean') { if (typeof value !== 'boolean') throw new TypeError('Expected a boolean'); return value ? 1 : 0; }
    const bytes = this.prepare(type, value);
    const p = this.alloc(4 + bytes.length);
    this.view.setUint32(p, bytes.length, true); this.bytes.set(bytes, p + 4);
    return p;
  }
  decode(type: string, raw: number): any {
    if (type === 'number') return raw;
    if (type === 'boolean') return raw !== 0;
    return this.decodeAt(type, raw + 4, this.dv.getUint32(raw, true));
  }
  decodeAt(type: string, ptr: number, len: number): any {
    this.refresh();
    if (type === 'number') return this.view.getFloat64(ptr, true);
    if (type === 'boolean') return this.bytes[ptr] !== 0;
    if (type === 'string') return this.string(ptr, len);
    if (this.objects.has(ptr)) return this.objects.get(ptr);
    const parsed = JSON.parse(decodeUtf8(decoder, this.bytes.subarray(ptr, ptr + len)));
    const nested = parseNestedType(type);
    let result: any;
    if (nested) {
      const factory = structureRegistry[parsed.__t];
      if (!factory || parsed.__t !== nested.structureType) throw new TypeError('Invalid nested structure type');
      const source = parsed.__a === this.id ? this : this.dependencies.get(parsed.__a);
      if (!source) throw new Error('Missing nested arena in worker data');
      result = factory.fromWorkerData({ ...parsed.__d, valueType: parsed.__d.valueType ?? parsed.__i }, source);
    } else result = freezeJSON(parsed);
    if (this.objects.size < 2048 && this.objectBytes + len <= 2097152) { this.objects.set(ptr, result); this.objectBytes += len; }
    return result;
  }
  string(ptr: number, len: number): string {
    if (!len) return '';
    const cached = this.strings.get(ptr);
    if (cached !== undefined) return cached;
    this.refresh();
    let value = '';
    if (len <= 32) {
      for (let i = 0; i < len; i++) {
        const c = this.bytes[ptr + i];
        if (c > 127) { value = decodeUtf8(decoder, this.bytes.subarray(ptr, ptr + len)); break; }
        value += String.fromCharCode(c);
      }
    } else value = decodeUtf8(decoder, this.bytes.subarray(ptr, ptr + len));
    // Empty byte ranges can share an address with a following allocation.
    if (len && this.strings.size < 2048 && this.stringBytes + len <= 2097152) { this.strings.set(ptr, value); this.stringBytes += len; }
    return value;
  }
  private rememberKey(key: string, token: KeyToken): KeyToken {
    if (this.keys.size < 2048 && this.keyBytes + token.length <= 262144) {
      if (!this.keys.has(key)) { this.keys.set(key, token); this.keyBytes += token.length; }
    }
    return token;
  }
  private key(key: string): KeyToken {
    if (typeof key !== 'string') throw new TypeError('Map keys must be strings');
    const cached = this.keys.get(key);
    if (cached) return cached;
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (c > 127) {
        const bytes = encoder.encode(key);
        return this.rememberKey(key, { bytes, length: bytes.length, hash: hashBytes(bytes), ptr: undefined });
      }
      hash = Math.imul(hash ^ c, 16777619);
    }
    return this.rememberKey(key, { bytes: undefined, length: key.length, hash: hash >>> 0, ptr: undefined });
  }
  leaf(type: string, key: string, value: any, ordinal?: number, prepared?: Uint8Array): number {
    this.assertWritable();
    if (typeof key !== 'string') throw new TypeError('Map keys must be strings');
    let token = this.keys.get(key);
    if (!token) {
      // Short ASCII keys need neither a TextEncoder allocation nor a JS byte
      // copy. Their first immutable leaf becomes the key's interned byte token.
      let hash = 2166136261, ascii = true;
      for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        if (c > 127) { ascii = false; break; }
        hash = Math.imul(hash ^ c, 16777619);
      }
      token = ascii ? { bytes: undefined, length: key.length, hash: hash >>> 0, ptr: undefined } : this.key(key);
    }
    // Finish user serialization before writing bytes. It can run callbacks.
    const number = type === 'number', boolean = type === 'boolean';
    if (number && typeof value !== 'number' || boolean && typeof value !== 'boolean') throw new TypeError(`Expected a ${type}`);
    const v = number || boolean ? undefined : prepared ?? this.prepare(type, value);
    const length = number ? 8 : boolean ? 1 : v!.length;
    const prefix = ordinal === undefined ? 0 : 4;
    const p = this.wasm.mapLeaf(token.length, length + prefix) >>> 0;
    this.refresh();
    if (token.ptr !== undefined) this.bytes.copyWithin(p + 16, token.ptr, token.ptr + token.length);
    else if (token.bytes) this.bytes.set(token.bytes, p + 16);
    else for (let i = 0; i < key.length; i++) this.bytes[p + 16 + i] = key.charCodeAt(i);
    const valuePtr = p + 16 + token.length;
    if (prefix) this.view.setUint32(valuePtr, ordinal!, true);
    if (number) this.view.setFloat64(valuePtr + prefix, value, true);
    else if (boolean) this.bytes[valuePtr + prefix] = value ? 1 : 0;
    else this.bytes.set(v!, valuePtr + prefix);
    this.view.setUint32(p + 4, token.hash, true);
    if (token.ptr === undefined) token.ptr = p + 16;
    this.rememberKey(key, token);
    return p;
  }
  writeNumber(root: number, key: string, value: number, kind = 0, head = 0, count = 0): number {
    this.assertWritable();
    if (typeof key !== 'string' || typeof value !== 'number') throw new TypeError('Expected a string key and a number value');
    let n = key.length;
    if (n > 49144) return this.write('number', root, key, value, kind, head, count);
    // The scratch range exists in the initial memory. Shared-memory growth does
    // not detach these old views, so this path needs no buffer refresh.
    for (let i = 0; i < n; i++) {
      const c = key.charCodeAt(i);
      if (c > 127) {
        const bytes = encoder.encode(key); n = bytes.length;
        if (n > 49144) return this.write('number', root, key, value, kind, head, count);
        this.bytes.set(bytes, 16384); break;
      }
      this.bytes[16384 + i] = c;
    }
    this.view.setFloat64(16376, value, true);
    const next = (kind === 2 ? this.wasm.writeSortedNumber(root, n)
      : kind === 1 ? this.wasm.writeOrderedNumber(root, n, head, count)
      : this.wasm.writeMapNumber(root, n)) >>> 0;
    this.writeSize = this.view.getUint32(8, true);
    if (kind === 0 && this.keys.size < 2048 && this.keyBytes + n <= 262144 && !this.keys.has(key)) {
      this.keys.set(key, { bytes: undefined, length: n, hash: this.view.getUint32(16, true), ptr: this.view.getUint32(0, true) + 16, readRoot: -1, readValue: undefined }); this.keyBytes += n;
    }
    if (kind === 1) { this.writeHead = this.view.getUint32(4, true); this.writeCount = this.view.getUint32(12, true); }
    return next;
  }
  write(type: string, root: number, key: string, value: any, kind = 0, head = 0, count = 0): number {
    this.assertWritable();
    if (typeof key !== 'string') throw new TypeError('Map keys must be strings');
    const mode = type === 'number' ? 0 : type === 'boolean' ? 1 : 2;
    if (mode < 2 && typeof value !== type) throw new TypeError(`Expected a ${type}`);
    // Complete all possible user callbacks before using shared writer scratch.
    const v = mode === 2 ? this.prepare(type, value) : undefined;
    let token = this.keys.get(key), n = token?.length ?? key.length;
    let bytes: Uint8Array | undefined;
    if (!token) for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) > 127) { bytes = encoder.encode(key); n = bytes.length; break; }
    const valueLength = mode === 0 ? 8 : mode === 1 ? 1 : v!.length;
    if (n + valueLength > 49152) {
      const previous = kind === 1 ? this.find(root, key) : 0;
      const ordinal = previous ? this.dv.getUint32(previous + 16 + n, true) : count;
      const leaf = this.leaf(type, key, value, kind === 1 ? ordinal : undefined, v);
      const next = (kind === 2 ? this.wasm.radixInsert(root, leaf) : this.wasm.mapInsert(root, leaf)) >>> 0;
      this.writeHead = kind === 1 && !previous ? this.wasm.orderCons(head, leaf) >>> 0 : head;
      this.writeCount = kind === 1 && !previous ? count + 1 : count;
      this.writeSize = kind === 2 ? this.wasm.radixSize(next) : this.wasm.mapSize(next);
      return next;
    }
    this.refresh(); let hash = token?.hash ?? 2166136261;
    if (token?.ptr !== undefined) this.bytes.copyWithin(16384, token.ptr, token.ptr + n);
    else {
      const source = token?.bytes ?? bytes;
      hash = 2166136261;
      for (let i = 0; i < n; i++) { const c = source ? source[i] : key.charCodeAt(i); this.bytes[16384 + i] = c; hash = Math.imul(hash ^ c, 16777619); }
    }
    if (v) this.bytes.set(v, 16384 + n);
    const next = this.wasm.stagedWrite(root, n, valueLength, hash >>> 0, mode === 2 ? 0 : +value, mode, kind, head, count) >>> 0;
    this.refresh();
    this.writeHead = this.view.getUint32(4, true); this.writeSize = this.view.getUint32(8, true); this.writeCount = this.view.getUint32(12, true);
    if (!token) token = this.rememberKey(key, { bytes, length: n, hash: hash >>> 0, ptr: this.view.getUint32(0, true) + 16 });
    else if (token.ptr === undefined) token.ptr = this.view.getUint32(0, true) + 16;
    if (kind === 0 && mode === 0) { token.readRoot = next; token.readValue = value; }
    return next;
  }
  leafKey(p: number): string { return this.string(p + 16, this.dv.getUint32(p + 8, true)); }
  leafValue(type: string, p: number, prefix = 0): any {
    const dv = this.dv, ptr = p + 16 + dv.getUint32(p + 8, true) + prefix;
    if (type === 'number') return dv.getFloat64(ptr, true);
    if (type === 'boolean') return this.bytes[ptr] !== 0;
    return this.decodeAt(type, ptr, dv.getUint32(p + 12, true) - prefix);
  }
  number(root: number, key: string): number | undefined {
    const token = this.keys.get(key);
    if (token?.ptr !== undefined) {
      if (token.readRoot === root) return token.readValue;
      const value = this.wasm.mapNumber(root, token.ptr, token.length, token.hash);
      const result = !Number.isNaN(value) || this.wasm.mapFind(root, token.ptr, token.length, token.hash) ? value : undefined;
      token.readRoot = root; token.readValue = result; return result;
    }
    if (typeof key !== 'string') throw new TypeError('Map keys must be strings');
    // A cold numeric read does not allocate an interning entry. Scalar writes
    // already seed the bounded hot-key cache. Cold bulk/worker reads use a hash
    // descent followed by a complete byte comparison, including collisions.
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (c > 127) {
        const p = this.find(root, key);
        return p ? this.dv.getFloat64(p + 16 + this.dv.getUint32(p + 8, true), true) : undefined;
      }
      hash = Math.imul(hash ^ c, 16777619);
    }
    const candidate = this.wasm.mapHashCandidate(root, hash >>> 0) >>> 0;
    if (!candidate) return undefined;
    const dv = this.dv, bytes = this.bytes, bucket = dv.getUint32(candidate, true) === 2;
    const count = bucket ? dv.getUint32(candidate + 8, true) : 1;
    for (let j = 0; j < count; j++) {
      const p = bucket ? dv.getUint32(candidate + 16 + j * 4, true) : candidate;
      if (dv.getUint32(p + 8, true) !== key.length) continue;
      let same = true;
      for (let i = 0; i < key.length; i++) if (bytes[p + 16 + i] !== key.charCodeAt(i)) { same = false; break; }
      if (same) return dv.getFloat64(p + 16 + key.length, true);
    }
    return undefined;
  }

  *radixLeaves(root: number): Generator<number> {
    if (root && this.dv.getUint32(root, true) === 0xffffffff) {
      const pending: number[] = [], n = this.dv.getUint32(root + 12, true);
      for (let i = 0; i < n; i++) pending.push(this.dv.getUint32(root + 16 + i * 4, true));
      pending.sort((a, b) => this.wasm.compareLeaves(a, b));
      let i = 0;
      for (const leaf of this.radixLeaves(this.dv.getUint32(root + 4, true))) {
        while (i < n && this.wasm.compareLeaves(pending[i], leaf) < 0) yield pending[i++];
        if (i < n && this.wasm.compareLeaves(pending[i], leaf) === 0) yield pending[i++]; else yield leaf;
      }
      while (i < n) yield pending[i++]; return;
    }
    const stack = root ? [root] : [];
    while (stack.length) {
      const p = stack.pop()!, dv = this.dv;
      if (!dv.getUint32(p, true)) yield p;
      else for (let i = popcount(dv.getUint32(p + 4, true)) - 1; i >= 0; i--) stack.push(dv.getUint32(p + 16 + i * 4, true));
    }
  }
  radixFind(root: number, key: string): number {
    const token = this.key(key);
    if (token.ptr !== undefined) return this.wasm.radixFind(root, token.ptr, token.length) >>> 0;
    const bytes = token.bytes, length = token.length, dv = this.dv;
    if (root && dv.getUint32(root, true) === 0xffffffff) {
      for (let j = 0; j < dv.getUint32(root + 12, true); j++) {
        const p = dv.getUint32(root + 16 + j * 4, true);
        if (dv.getUint32(p + 4, true) !== token.hash || dv.getUint32(p + 8, true) !== length) continue;
        let same = true; for (let i = 0; i < length; i++) if (this.bytes[p + 16 + i] !== (bytes ? bytes[i] : key.charCodeAt(i))) { same = false; break; }
        if (same) { token.ptr = p + 16; return p; }
      }
      root = dv.getUint32(root + 4, true);
    }
    while (root && dv.getUint32(root, true)) {
      const position = dv.getUint32(root, true) - 3, i = position >>> 1;
      const digit = i < length ? (((bytes ? bytes[i] : key.charCodeAt(i)) >>> ((position & 1) ? 0 : 4)) & 15) + 1 : 0;
      const bitmap = dv.getUint32(root + 4, true), bit = 1 << digit;
      if (!(bitmap & bit)) return 0;
      root = dv.getUint32(root + 16 + popcount(bitmap & (bit - 1)) * 4, true);
    }
    if (!root || dv.getUint32(root + 8, true) !== length) return 0;
    for (let i = 0; i < length; i++) if (this.bytes[root + 16 + i] !== (bytes ? bytes[i] : key.charCodeAt(i))) return 0;
    token.ptr = root + 16; return root;
  }
  find(root: number, key: string): number {
    const token = this.key(key);
    if (token.ptr !== undefined) return this.wasm.mapFind(root, token.ptr, token.length, token.hash) >>> 0;
    const k = token.bytes, length = token.length, hash = token.hash, dv = this.dv, bytes = this.bytes;
    const equals = (p: number) => {
      if (dv.getUint32(p + 4, true) !== hash || dv.getUint32(p + 8, true) !== length) return false;
      for (let i = 0; i < length; i++) if (bytes[p + 16 + i] !== (k ? k[i] : key.charCodeAt(i))) return false;
      return true;
    };
    if (root && dv.getUint32(root, true) === 0xffffffff) {
      for (let j = 0; j < dv.getUint32(root + 12, true); j++) {
        const p = dv.getUint32(root + 16 + j * 4, true);
        if (equals(p)) { token.ptr = p + 16; return p; }
      }
      root = dv.getUint32(root + 4, true);
    }
    const candidate = this.wasm.mapHashCandidate(root, hash) >>> 0;
    if (!candidate) return 0;
    if (!dv.getUint32(candidate, true)) {
      if (!equals(candidate)) return 0;
      token.ptr = candidate + 16; return candidate;
    }
    const count = dv.getUint32(candidate + 8, true);
    for (let i = 0; i < count; i++) {
      const leaf = dv.getUint32(candidate + 16 + i * 4, true);
      if (equals(leaf)) { token.ptr = leaf + 16; return leaf; }
    }
    return 0;
  }

  delete(root: number, key: string): number {
    this.assertWritable();
    const leaf = this.find(root, key);
    if (!leaf) return root;
    return this.wasm.mapDelete(root, leaf + 16, this.dv.getUint32(leaf + 8, true), this.dv.getUint32(leaf + 4, true)) >>> 0;
  }
  *leaves(root: number): Generator<number> {
    // Each iterator owns its continuation. No shared stack or scratch survives yield.
    if (root && this.dv.getUint32(root, true) === 0xffffffff) {
      const n = this.dv.getUint32(root + 12, true), base = this.dv.getUint32(root + 4, true);
      for (let i = 0; i < n; i++) yield this.dv.getUint32(root + 16 + i * 4, true);
      for (const leaf of this.leaves(base)) {
        const dv = this.dv;
        if (!this.wasm.journalFind(root, leaf + 16, dv.getUint32(leaf + 8, true), dv.getUint32(leaf + 4, true))) yield leaf;
      }
      return;
    }
    const stack = root ? [root] : [];
    while (stack.length) {
      const p = stack.pop()!, dv = this.dv, tag = dv.getUint32(p, true);
      if (tag === 0) { yield p; continue; }
      const count = tag === 1 ? popcount(dv.getUint32(p + 4, true)) : dv.getUint32(p + 8, true);
      for (let i = count - 1; i >= 0; i--) stack.push(dv.getUint32(p + 16 + i * 4, true));
    }
  }
  bulk(type: string, root: number, entries: readonly (readonly [string, any])[]): number {
    this.assertWritable();
    if (!entries.length) return root;
    const latest = new Map<string, any>();
    for (const [key, value] of entries) latest.set(normalizeKey(key), value);
    if (type === 'number' || type === 'boolean') {
      const unicode = new Map<string, Uint8Array>(), length = type === 'number' ? 8 : 1;
      let total = (latest.size * 4 + 7) & ~7;
      for (const key of latest.keys()) {
        let n = key.length;
        for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) > 127) { const b = encoder.encode(key); unicode.set(key, b); n = b.length; break; }
        total += (16 + n + length + 7) & ~7;
      }
      const input = this.alloc(total), dv = this.dv, bytes = this.bytes;
      let p = input + ((latest.size * 4 + 7) & ~7), slot = input;
      for (const [key, value] of latest) {
        if (typeof value !== type) throw new TypeError(`Expected a ${type}`);
        const encoded = unicode.get(key), n = encoded?.length ?? key.length; let hash = 2166136261;
        for (let i = 0; i < n; i++) { const c = encoded ? encoded[i] : key.charCodeAt(i); bytes[p + 16 + i] = c; hash = Math.imul(hash ^ c, 16777619); }
        dv.setUint32(p, 0, true); dv.setUint32(p + 4, hash >>> 0, true); dv.setUint32(p + 8, n, true); dv.setUint32(p + 12, length, true);
        if (type === 'number') dv.setFloat64(p + 16 + n, value, true); else bytes[p + 16 + n] = value ? 1 : 0;
        dv.setUint32(slot, p, true); slot += 4; p += (16 + n + length + 7) & ~7;
      }
      return this.wasm.mapBatch(root, input, latest.size) >>> 0;
    }
    const leaves: number[] = [];
    for (const [key, value] of latest) leaves.push(this.leaf(type, key, value));
    const input = this.alloc(leaves.length * 4), dv = this.dv;
    for (let i = 0; i < leaves.length; i++) dv.setUint32(input + i * 4, leaves[i], true);
    return this.wasm.mapBatch(root, input, leaves.length) >>> 0;
  }

  encodeRange(type: string, values: readonly any[], prefix = 0, length = 0): number {
    this.assertWritable();
    const raw = type === 'number' ? values : values.map(value => this.encode(type, value));
    const input = this.alloc((length + raw.length) * 8), dv = this.dv;
    if (length) this.bytes.copyWithin(input, prefix, prefix + length * 8);
    for (let i = 0; i < raw.length; i++) {
      if (typeof raw[i] !== 'number') throw new TypeError('Expected a number');
      dv.setFloat64(input + (length + i) * 8, raw[i], true);
    }
    return input;
  }
  *blocks(root: number, reverse = false): Generator<number> {
    const stack: number[] = []; let node = root;
    const first = reverse ? 4 : 0, second = reverse ? 0 : 4;
    while (node || stack.length) {
      while (node) { stack.push(node); node = this.dv.getUint32(node + first, true); }
      node = stack.pop()!;
      const data = this.dv.getUint32(node + 16, true), length = this.dv.getUint32(node + 20, true);
      const next = this.dv.getUint32(node + second, true);
      if (reverse) for (let i = length - 1; i >= 0; i--) yield this.dv.getFloat64(data + i * 8, true);
      else for (let i = 0; i < length; i++) yield this.dv.getFloat64(data + i * 8, true);
      node = next;
    }
  }
  *vector(root: number, depth: number, start: number, count: number): Generator<number> {
    let i = start, end = start + count;
    while (i < end) {
      const leaf = this.wasm.vecLeaf(root, depth, i) >>> 0;
      const stop = Math.min(end, (Math.floor(i / 32) + 1) * 32);
      while (i < stop) { const raw = this.dv.getFloat64(leaf + (i & 31) * 8, true); i++; yield raw; }
    }
  }
}
