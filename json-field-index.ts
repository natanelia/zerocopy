import type { Arena } from './arena';

export function space(bytes: Uint8Array, ptr: number, end: number): number {
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
export function stringEquals(bytes: Uint8Array, ptr: number, end: number, expected: string): boolean {
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

// Field names repeat across records. Prepare their WASM arguments once, and
// cache only offsets into this arena's immutable JSON, including zero for a miss.
type FieldSelector =
  | { kind: 'ascii'; lo: number; hi: number }
  | { kind: 'hash'; hash: number };

function prepare(key: string): FieldSelector {
  if (key.length <= 8) {
    let lo = 0, hi = 0, i = 0;
    for (; i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (c > 127) break;
      if (i < 4) lo |= c << (8 * i);
      else hi |= c << (8 * (i - 4));
    }
    if (i === key.length) return { kind: 'ascii', lo, hi };
  }
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return { kind: 'hash', hash: hash >>> 0 };
}

function findField(arena: Arena, bytes: Uint8Array, start: number, bound: number, key: string, selector: FieldSelector): number {
  const wasm = arena.wasm;
  if (selector.kind === 'ascii') return wasm.jsonFieldAscii8(start, bound, key.length, selector.lo, selector.hi) >>> 0;
  let cursor = start;
  while (cursor < bound) {
    const candidate = wasm.jsonFieldCandidate(cursor, bound, selector.hash) >>> 0;
    if (!candidate) return 0;
    const keyEnd = wasm.jsonValueEnd(candidate, bound) >>> 0;
    if (keyEnd <= candidate || keyEnd > bound) throw new SyntaxError('Invalid JSON key');
    let value = space(bytes, keyEnd, bound);
    if (bytes[value] !== 58) throw new SyntaxError('Invalid JSON member');
    value = space(bytes, value + 1, bound);
    if (value >= bound) throw new SyntaxError('Missing JSON value');
    if (stringEquals(bytes, candidate, keyEnd, key)) return value;
    // A matching hash is only a candidate, never an equality decision.
    cursor = wasm.jsonValueEnd(value, bound) >>> 0;
    if (cursor <= value || cursor > bound) throw new SyntaxError('Invalid JSON member');
    cursor = space(bytes, cursor, bound);
    if (bytes[cursor] !== 44) return 0;
    cursor = space(bytes, cursor + 1, bound);
  }
  return 0;
}

interface IndexedField {
  readonly selector: FieldSelector;
  readonly offsets: Map<number, number>;
}

// One small numeric map per field name, shared across views in this arena.
// Its keys are object addresses. Each value packs two unsigned 16-bit offsets:
// the enclosing length (which must also match), and the value offset (0 = miss).
export class JsonFieldIndex {
  private readonly fields = new Map<string, IndexedField>();
  private entries = 0;

  find(arena: Arena, bytes: Uint8Array, start: number, bound: number, key: string): number {
    let field = this.fields.get(key);
    if (!field) {
      const selector = prepare(key);
      // A new name in a tiny record is cheaper to scan than to index.
      if (bound - start < 32 || this.fields.size >= 64 || key.length > 64) return findField(arena, bytes, start, bound, key, selector);
      field = { selector, offsets: new Map() };
      this.fields.set(key, field);
    }
    const length = bound - start;
    if (length > 65535) return findField(arena, bytes, start, bound, key, field.selector);
    const cached = field.offsets.get(start);
    if (cached !== undefined && (cached >>> 16) === length) {
      const relative = cached & 65535;
      return relative ? start + relative : 0;
    }
    const pointer = findField(arena, bytes, start, bound, key, field.selector);
    if (cached !== undefined || (this.entries < 8192 && field.offsets.size < 2048)) {
      field.offsets.set(start, (length << 16) | (pointer ? pointer - start : 0));
      if (cached === undefined) this.entries++;
    }
    return pointer;
  }
}
