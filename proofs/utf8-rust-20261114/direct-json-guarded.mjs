/**
 * EXPERIMENT ONLY: guarded-assignment variant of the direct UTF-8 reader.
 * Based on proofs/shared-bytes-20261113/direct-json.mjs; not production code.
 *
 * Reads structure and numbers without a complete intermediate JSON string.
 * Native JS strings are still created for property names and string values.
 * Input must be valid UTF-8 (as emitted by JSON.stringify + TextEncoder).
 * This is not a validated decoder for arbitrary/untrusted byte streams.
 *
 * The iterative container stack avoids recursive JS calls. Freeze is fused
 * into container completion, so no second traversal or Object.values arrays
 * are needed. No key/value cache is retained between documents.
 */

const nativeDecode = TextDecoder.prototype.decode;
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const supportsShared = (() => {
  try {
    nativeDecode.call(decoder, new Uint8Array(new SharedArrayBuffer(1)));
    return true;
  } catch { return false; }
})();
const MAX_SCRATCH = 65536;
let scratch;

function text(bytes, start, end) {
  const length = end - start;
  if (!length) return '';
  // Most property names and short value strings fit this path.
  if (length <= 32) {
    let result = '';
    for (let i = start; i < end; i++) {
      const byte = bytes[i];
      if (byte > 127) return utf8(bytes, start, end);
      result += String.fromCharCode(byte);
    }
    return result;
  }
  return utf8(bytes, start, end);
}

function utf8(bytes, start, end) {
  const view = bytes.subarray(start, end);
  if (supportsShared || !(bytes.buffer instanceof SharedArrayBuffer)) {
    return nativeDecode.call(decoder, view);
  }
  if (view.length > MAX_SCRATCH) return nativeDecode.call(decoder, view.slice());
  scratch ??= new Uint8Array(MAX_SCRATCH);
  scratch.set(view);
  return nativeDecode.call(decoder, scratch.subarray(0, view.length));
}

function ascii(bytes, start, end) {
  let result = '';
  for (let i = start; i < end; i++) result += String.fromCharCode(bytes[i]);
  return result;
}

function hex(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}

class Parser {
  constructor(bytes, freeze) {
    this.bytes = bytes;
    this.end = bytes.length;
    this.pos = 0;
    this.freeze = freeze;
    this.stack = [];
    // Reuse the descriptor rather than allocate one for every object property.
    // Defining own properties preserves JSON.parse semantics even when a key
    // shadows '__proto__', a getter, or a setter on Object.prototype.
    this.property = { value: undefined, writable: true, enumerable: true, configurable: true };
  }

  fail() { throw new SyntaxError(`Invalid JSON at byte ${this.pos}`); }

  space() {
    const bytes = this.bytes;
    let p = this.pos;
    while (p < this.end) {
      const c = bytes[p];
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      p++;
    }
    this.pos = p;
  }

  string() {
    const bytes = this.bytes;
    let p = this.pos + 1, start = p, result = '';
    while (p < this.end) {
      const c = bytes[p++];
      if (c === 34) {
        this.pos = p;
        return result + text(bytes, start, p - 1);
      }
      if (c < 32) { this.pos = p - 1; this.fail(); }
      if (c !== 92) continue;
      result += text(bytes, start, p - 1);
      const escape = bytes[p++];
      switch (escape) {
        case 34: result += '"'; break;
        case 92: result += '\\'; break;
        case 47: result += '/'; break;
        case 98: result += '\b'; break;
        case 102: result += '\f'; break;
        case 110: result += '\n'; break;
        case 114: result += '\r'; break;
        case 116: result += '\t'; break;
        case 117: {
          if (p + 4 > this.end) { this.pos = p; this.fail(); }
          let code = 0;
          for (let n = 0; n < 4; n++) {
            const digit = hex(bytes[p++]);
            if (digit < 0) { this.pos = p - 1; this.fail(); }
            code = code * 16 + digit;
          }
          // Deliberately preserve individual UTF-16 code units: JSON escapes
          // can represent lone surrogates, unlike UTF-8 encoded scalar values.
          result += String.fromCharCode(code);
          break;
        }
        default: this.pos = p - 1; this.fail();
      }
      start = p;
    }
    this.pos = p; this.fail();
  }

  number() {
    const bytes = this.bytes, start = this.pos;
    let p = start, negative = false, n = 0, exact = true;
    if (bytes[p] === 45) { negative = true; p++; }
    if (bytes[p] === 48) p++;
    else {
      if (!(bytes[p] >= 49 && bytes[p] <= 57)) { this.pos = p; this.fail(); }
      do {
        n = n * 10 + (bytes[p++] - 48);
        if (n > Number.MAX_SAFE_INTEGER) exact = false;
      } while (bytes[p] >= 48 && bytes[p] <= 57);
    }
    if (bytes[p] === 46) {
      exact = false; p++;
      if (!(bytes[p] >= 48 && bytes[p] <= 57)) { this.pos = p; this.fail(); }
      do { p++; } while (bytes[p] >= 48 && bytes[p] <= 57);
    }
    if (bytes[p] === 69 || bytes[p] === 101) {
      exact = false; p++;
      if (bytes[p] === 43 || bytes[p] === 45) p++;
      if (!(bytes[p] >= 48 && bytes[p] <= 57)) { this.pos = p; this.fail(); }
      do { p++; } while (bytes[p] >= 48 && bytes[p] <= 57);
    }
    this.pos = p;
    return exact ? (negative ? -n : n) : Number(ascii(bytes, start, p));
  }

  value() {
    this.space();
    const bytes = this.bytes, c = bytes[this.pos];
    if (c === 34) return this.string();
    if (c === 123 || c === 91) {
      this.pos++;
      const array = c === 91, value = array ? [] : {};
      // Ordinary objects have the immutable Object.prototype chain. Arrays can
      // have an altered prototype chain; avoid `in` altogether in that case so
      // an exotic Proxy prototype cannot observe the property existence test.
      const canAssign = !array || Object.getPrototypeOf(Array.prototype) === Object.prototype;
      this.stack.push({ value, array, first: true, index: 0, canAssign });
      return value;
    }
    if (c === 116 && bytes[this.pos + 1] === 114 && bytes[this.pos + 2] === 117 && bytes[this.pos + 3] === 101) {
      this.pos += 4; return true;
    }
    if (c === 102 && bytes[this.pos + 1] === 97 && bytes[this.pos + 2] === 108 && bytes[this.pos + 3] === 115 && bytes[this.pos + 4] === 101) {
      this.pos += 5; return false;
    }
    if (c === 110 && bytes[this.pos + 1] === 117 && bytes[this.pos + 2] === 108 && bytes[this.pos + 3] === 108) {
      this.pos += 4; return null;
    }
    if (c === 45 || (c >= 48 && c <= 57)) return this.number();
    this.fail();
  }

  parse() {
    const result = this.value(), bytes = this.bytes;
    while (this.stack.length) {
      const frame = this.stack[this.stack.length - 1];
      this.space();
      const closing = frame.array ? 93 : 125;
      if (bytes[this.pos] === closing) {
        this.pos++;
        if (this.freeze) Object.freeze(frame.value);
        this.stack.pop();
        continue;
      }
      if (!frame.first) {
        if (bytes[this.pos++] !== 44) this.fail();
        this.space();
        if (bytes[this.pos] === closing) this.fail();
      }
      frame.first = false;
      let key;
      if (frame.array) key = frame.index++;
      else {
        if (bytes[this.pos] !== 34) this.fail();
        key = this.string();
        this.space();
        if (bytes[this.pos++] !== 58) this.fail();
      }
      const child = this.value();
      // Assignment is safe only when a normal prototype chain has no key.
      // Existing/inherited names (including __proto__, setters and read-only
      // properties) keep CreateDataProperty-like own-property semantics.
      if (frame.canAssign && !(key in frame.value)) {
        frame.value[key] = child;
      } else {
        this.property.value = child;
        Object.defineProperty(frame.value, key, this.property);
      }
    }
    this.space();
    if (this.pos !== this.end) this.fail();
    return result;
  }
}

/** Parse and deeply freeze all containers; compatible result shape with Arena.decode. */
export function parseUtf8JSON(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
  return new Parser(bytes, options.freeze !== false).parse();
}

/** Parse only, for comparing conversion/parse costs separately from deep freeze. */
export function parseUtf8JSONPlain(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
  return new Parser(bytes, false).parse();
}

export const directJSONMetadata = Object.freeze({
  experimentalGuardedAssignment: true,
  exoticArrayPrototypeUsesDefineProperty: true,
  fullDocumentString: false,
  input: 'valid UTF-8 JSON; intended for immutable JSON.stringify-produced bytes',
  freezesOnContainerClose: true,
  recursiveCalls: false,
  retainedDecodeScratchMaximum: MAX_SCRATCH,
  crossDocumentObjectCache: false,
  crossDocumentKeyCache: false,
  supportsSharedTextDecoderInput: supportsShared,
});
