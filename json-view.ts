import type { Arena } from './arena';
import { decodeUtf8 } from './utf8';
import { freezeJSON } from './freeze-json';

export type JsonScalar = string | number | boolean | null;
export type JsonViewValue = JsonScalar | JsonView;
export type JsonViewType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function space(bytes: Uint8Array, ptr: number, end: number): number {
  while (ptr < end) {
    const c = bytes[ptr];
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    ptr++;
  }
  return ptr;
}
function hex(c: number): number {
  return c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
}

/** Compare a selected JSON string to JS UTF-16 without decoding/allocating it. */
function stringEquals(bytes: Uint8Array, ptr: number, end: number, expected: string): boolean {
  if (bytes[ptr] !== 34) return false;
  let index = 0;
  for (let p = ptr + 1; p < end;) {
    let c = bytes[p++];
    if (c === 34) return index === expected.length;
    if (c === 92) {
      if (p >= end) return false;
      c = bytes[p++];
      if (c === 117) {
        if (p + 4 > end) return false;
        const a = hex(bytes[p++]), b = hex(bytes[p++]), d = hex(bytes[p++]), e = hex(bytes[p++]);
        if ((a | b | d | e) < 0) return false;
        c = (a << 12) | (b << 8) | (d << 4) | e;
      } else if (c === 98) c = 8;
      else if (c === 102) c = 12;
      else if (c === 110) c = 10;
      else if (c === 114) c = 13;
      else if (c === 116) c = 9;
      else if (c !== 34 && c !== 47 && c !== 92) return false;
    } else if (c >= 192) {
      if (c < 224) {
        if (p >= end) return false;
        c = ((c & 31) << 6) | (bytes[p++] & 63);
      } else if (c < 240) {
        if (p + 2 > end) return false;
        c = ((c & 15) << 12) | ((bytes[p++] & 63) << 6) | (bytes[p++] & 63);
      } else {
        if (p + 3 > end) return false;
        c = ((c & 7) << 18) | ((bytes[p++] & 63) << 12) | ((bytes[p++] & 63) << 6) | (bytes[p++] & 63);
        c -= 65536;
        if (expected.charCodeAt(index++) !== (0xd800 | (c >> 10))) return false;
        c = 0xdc00 | (c & 1023);
      }
    }
    if (expected.charCodeAt(index++) !== c) return false;
  }
  return false;
}

// After a long rewind, remember one offset per stride. Thin the offsets as
// the explored prefix grows. Even a very large array keeps at most 256 entries.
const FIRST_STRIDE = 32;
const MAX_OFFSETS = 256;
interface ArrayCursor {
  index: number;
  pointer: number;
  checkpoints?: { offsets: number[]; stride: number };
}

/**
 * A read-only view of one immutable JSON record or nested container.
 *
 * Field/index reads use the existing shared bytes. Containers stay as views;
 * only requested scalar strings/numbers are converted to JavaScript values.
 * There is no full-record decode, object tree, decoded-value cache, or freeze.
 *
 * Use SharedMap/SharedList.getView() rather than constructing ranges yourself.
 * The internal constructor expects complete, valid writer-produced JSON with
 * JSON.stringify's unique object keys. It bounds every read to its record.
 */
export class JsonView {
  readonly #arena: Arena;
  readonly #start: number;
  readonly #bound: number;
  #end: number | undefined;
  #arrayCursor: ArrayCursor | undefined;

  /** @internal A retained arena keeps the published record alive. */
  constructor(arena: Arena, pointer: number, length: number) {
    const bytes = arena.buf;
    if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 65536 || length <= 0
      || pointer + length > bytes.byteLength || pointer + length > 0x7fff0000) {
      throw new RangeError('Invalid JSON view range');
    }
    this.#arena = arena;
    this.#bound = pointer + length;
    this.#start = space(bytes, pointer, this.#bound);
    if (this.#start === this.#bound) throw new SyntaxError('Empty JSON view');
    // A complete record already carries its exact byte length. Avoid scanning
    // its JSON again for byteLength or explicit whole-record materialization.
    let end = this.#bound;
    while (end > this.#start) {
      const c = bytes[end - 1];
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      end--;
    }
    this.#end = end;
  }

  get type(): JsonViewType {
    switch (this.#arena.buf[this.#start]) {
      case 123: return 'object';
      case 91: return 'array';
      case 34: return 'string';
      case 116: case 102: return 'boolean';
      case 110: return 'null';
      default: return 'number';
    }
  }

  /** Byte length of this value only; computed lazily for nested containers. */
  get byteLength(): number { return this.#valueEnd() - this.#start; }

  /** Root scalars become JS scalars; an object/array returns this same view. */
  value(): JsonViewValue { return this.#read(this.#start, true); }

  /** Read an own object field. Missing fields and nonobjects return undefined. */
  get(key: string): JsonViewValue | undefined {
    const pointer = this.#field(key);
    return pointer ? this.#read(pointer) : undefined;
  }

  /** Test an own field without materializing its value. */
  has(key: string): boolean { return this.#field(key) !== 0; }

  /** Read a zero-based array index; invalid/out-of-range indices return undefined. */
  at(index: number): JsonViewValue | undefined {
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) return undefined;
    const cursor = this.#arrayCursor;
    // A successful cursor already establishes that this immutable value is an array.
    if (!cursor && this.#arena.buf[this.#start] !== 91) return undefined;
    // Published JSON never moves. Forward reads can resume from the previous
    // element instead of scanning every earlier element again. The cursor is
    // local to this view. Build sparse offsets only after an expensive rewind.
    const wasm = this.#arena.wasm;
    let pointer: number;
    if (cursor && index >= cursor.index && (index - cursor.index <= FIRST_STRIDE || !cursor.checkpoints)) {
      pointer = index === cursor.index ? cursor.pointer
        : wasm.jsonArrayAtFrom(cursor.pointer, this.#bound, index - cursor.index) >>> 0;
    } else if (cursor && index >= FIRST_STRIDE) {
      pointer = this.#seek(cursor, index);
    } else pointer = wasm.jsonArrayAt(this.#start, this.#bound, index) >>> 0;
    if (!pointer) return undefined;
    if (cursor) { cursor.index = index; cursor.pointer = pointer; }
    else this.#arrayCursor = { index, pointer, checkpoints: undefined };
    return this.#read(pointer);
  }

  #seek(cursor: ArrayCursor, index: number): number {
    const wasm = this.#arena.wasm;
    const checkpoints = cursor.checkpoints ??= {
      offsets: [wasm.jsonArrayAt(this.#start, this.#bound, 0) >>> 0], stride: FIRST_STRIDE,
    };
    const offsets = checkpoints.offsets;
    let stride = checkpoints.stride;
    while (offsets.length * stride <= index) {
      const previous = offsets[offsets.length - 1]!;
      const next = wasm.jsonArrayAtFrom(previous, this.#bound, stride) >>> 0;
      if (!next) return 0;
      if (offsets.length === MAX_OFFSETS) {
        for (let i = 1; i < MAX_OFFSETS / 2; i++) offsets[i] = offsets[2 * i]!;
        offsets.length = MAX_OFFSETS / 2;
        stride *= 2;
        checkpoints.stride = stride;
      }
      offsets.push(next);
    }
    const block = Math.floor(index / stride), anchor = block * stride;
    const useCursor = cursor.index > anchor && cursor.index <= index;
    const pointer = useCursor ? cursor.pointer : offsets[block]!;
    const distance = index - (useCursor ? cursor.index : anchor);
    return distance ? wasm.jsonArrayAtFrom(pointer, this.#bound, distance) >>> 0 : pointer;
  }

  /** Strict scalar equality; string predicates do not create a JS value string. */
  equals(key: string, expected: JsonScalar): boolean {
    const pointer = this.#field(key);
    if (!pointer) return false;
    const bytes = this.#arena.buf;
    if (typeof expected === 'string') return stringEquals(bytes, pointer, this.#bound, expected);
    if (expected === null) return bytes[pointer] === 110;
    if (typeof expected === 'boolean') return bytes[pointer] === (expected ? 116 : 102);
    if (typeof expected !== 'number') throw new TypeError('Expected a JSON scalar');
    const first = bytes[pointer];
    return (first === 45 || first >= 48 && first <= 57) && this.#number(pointer) === expected;
  }

  /**
   * Explicitly allocate a fresh detached JS value. It is mutable by default:
   * changing it cannot affect the shared record or subsequent reads. No cache.
   */
  toObject(options: { freeze?: boolean } = {}): any {
    const bytes = this.#arena.buf;
    const value = JSON.parse(decodeUtf8(decoder, bytes.subarray(this.#start, this.#valueEnd())));
    return options.freeze === true ? freezeJSON(value) : value;
  }

  /** JSON.stringify(view) explicitly materializes the selected value. */
  toJSON(): any { return this.toObject(); }

  #valueEnd(): number {
    if (this.#end !== undefined) return this.#end;
    const end = this.#arena.wasm.jsonValueEnd(this.#start, this.#bound) >>> 0;
    if (end <= this.#start || end > this.#bound) throw new SyntaxError('Invalid JSON view');
    return this.#end = end;
  }

  #field(key: string): number {
    if (typeof key !== 'string') throw new TypeError('JSON field names must be strings');
    let bytes = this.#arena.buf;
    if (bytes[this.#start] !== 123) return 0;
    const wasm = this.#arena.wasm;
    if (key.length <= 8) {
      let lo = 0, hi = 0, ascii = true;
      for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        if (c > 127) { ascii = false; break; }
        if (i < 4) lo |= c << (i * 8); else hi |= c << ((i - 4) * 8);
      }
      if (ascii) return wasm.jsonFieldAscii8(this.#start, this.#bound, key.length, lo, hi) >>> 0;
    }
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    let cursor = this.#start;
    while (cursor < this.#bound) {
      const candidate = wasm.jsonFieldCandidate(cursor, this.#bound, hash >>> 0) >>> 0;
      if (!candidate) return 0;
      const keyEnd = wasm.jsonValueEnd(candidate, this.#bound) >>> 0;
      if (keyEnd <= candidate || keyEnd > this.#bound) throw new SyntaxError('Invalid JSON key');
      bytes = this.#arena.buf;
      let value = space(bytes, keyEnd, this.#bound);
      if (bytes[value] !== 58) throw new SyntaxError('Invalid JSON member');
      value = space(bytes, value + 1, this.#bound);
      if (value >= this.#bound) throw new SyntaxError('Missing JSON value');
      if (stringEquals(bytes, candidate, keyEnd, key)) return value;
      // A matching hash is only a candidate, never an equality decision.
      cursor = wasm.jsonValueEnd(value, this.#bound) >>> 0;
      if (cursor <= value || cursor > this.#bound) throw new SyntaxError('Invalid JSON member');
      cursor = space(bytes, cursor, this.#bound);
      if (bytes[cursor] !== 44) return 0;
      cursor = space(bytes, cursor + 1, this.#bound);
    }
    return 0;
  }

  #number(pointer: number): number {
    const integer = this.#arena.wasm.jsonInteger(pointer, this.#bound);
    if (!Number.isNaN(integer)) return integer;
    const end = this.#arena.wasm.jsonValueEnd(pointer, this.#bound) >>> 0;
    if (end <= pointer || end > this.#bound) throw new SyntaxError('Invalid JSON number');
    // Only the requested number token is converted. Native Number supplies
    // exact JS rounding for decimals, exponents, overflow and unsafe integers.
    return Number(decodeUtf8(decoder, this.#arena.buf.subarray(pointer, end)));
  }

  #read(pointer: number, root = false): JsonViewValue {
    const bytes = this.#arena.buf;
    switch (bytes[pointer]) {
      case 123: case 91: {
        if (root) return this;
        const nested = new JsonView(this.#arena, pointer, this.#bound - pointer);
        // Field selection returns a start without rescanning the subtree. Its
        // enclosing bound can include siblings; find the actual end only when
        // byteLength or materialization needs it.
        nested.#end = undefined;
        return nested;
      }
      case 116: return true;
      case 102: return false;
      case 110: return null;
      case 34: {
        const result = this.#arena.wasm.jsonStringEnd(pointer, this.#bound);
        const end = result < 0 ? -result : result;
        if (end <= pointer || end > this.#bound) throw new SyntaxError('Invalid JSON string');
        // Ordinary strings need only their final JS string. Native JSON
        // unescaping is reserved for strings that actually contain escapes.
        return result < 0
          ? JSON.parse(decodeUtf8(decoder, bytes.subarray(pointer, end)))
          : decodeUtf8(decoder, bytes.subarray(pointer + 1, end - 1));
      }
      default: return this.#number(pointer);
    }
  }
}
