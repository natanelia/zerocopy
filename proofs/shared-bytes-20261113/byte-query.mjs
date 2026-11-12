/**
 * EXPERIMENT ONLY: predicates over the exact UTF-8 records ZeroCopy writes with
 * JSON.stringify(value), with no replacer or indentation. Reads immutable input;
 * retains only compiled query state, and does not cache decoded records.
 *
 * This is not a parser/validator for untrusted bytes. The outer object's keys
 * must have JSON.stringify's canonical spelling and be unique. JSON.rawJSON
 * scalar values ARE supported, including alternate escapes/number spellings.
 * Arbitrary hand-written JSON (duplicate keys, whitespace, alternate key
 * escapes) is outside this prototype's contract. Arrays/primitives have no
 * eligible top-level object fields. start/end are byte offsets; end is exclusive.
 */

const encoder = new TextEncoder();
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function equalBytes(bytes, start, end, token) {
  if (end - start !== token.length) return false;
  for (let i = 0; i < token.length; i++) if (bytes[start + i] !== token[i]) return false;
  return true;
}

function stringEnd(bytes, start, end) {
  for (let p = start + 1; p < end; p++) {
    const c = bytes[p];
    if (c === 34) return p + 1;
    if (c === 92) p++;
  }
  return end;
}

function valueEnd(bytes, start, end) {
  const first = bytes[start];
  if (first === 34) return stringEnd(bytes, start, end);
  if (first === 123 || first === 91) {
    let depth = 1;
    for (let p = start + 1; p < end; p++) {
      const c = bytes[p];
      if (c === 34) p = stringEnd(bytes, p, end) - 1;
      else if (c === 123 || c === 91) depth++;
      else if ((c === 125 || c === 93) && --depth === 0) return p + 1;
    }
    return end;
  }
  let p = start;
  while (p < end && bytes[p] !== 44 && bytes[p] !== 125 && bytes[p] !== 93) p++;
  return p;
}

function fieldStart(bytes, start, end, keyToken) {
  if (bytes[start] !== 123) return -1;
  let p = start + 1;
  while (p < end && bytes[p] !== 125) {
    const keyStart = p;
    const keyEnd = stringEnd(bytes, p, end);
    p = keyEnd + 1; // canonical key is immediately followed by ':'
    if (equalBytes(bytes, keyStart, keyEnd, keyToken)) return p;
    p = valueEnd(bytes, p, end);
    if (bytes[p] !== 44) return -1;
    p++;
  }
  return -1;
}

function hexDigit(c) {
  return c <= 57 ? c - 48 : (c | 32) - 87;
}

// Compare the semantic string as UTF-16 units; no value string is constructed.
// Needed for JSON.rawJSON('"\\u0061"'), escaped surrogates, and alternate forms.
function equalString(bytes, start, end, expected) {
  if (bytes[start] !== 34) return false;
  let index = 0;
  for (let p = start + 1; p < end; p++) {
    let c = bytes[p];
    if (c === 34) return index === expected.length;
    if (c === 92) {
      c = bytes[++p];
      if (c === 117) {
        c = (hexDigit(bytes[p + 1]) << 12) | (hexDigit(bytes[p + 2]) << 8)
          | (hexDigit(bytes[p + 3]) << 4) | hexDigit(bytes[p + 4]);
        p += 4;
      } else if (c === 98) c = 8;
      else if (c === 102) c = 12;
      else if (c === 110) c = 10;
      else if (c === 114) c = 13;
      else if (c === 116) c = 9;
    } else if (c >= 0xc0) {
      if (c < 0xe0) c = ((c & 31) << 6) | (bytes[++p] & 63);
      else if (c < 0xf0) c = ((c & 15) << 12) | ((bytes[++p] & 63) << 6) | (bytes[++p] & 63);
      else c = ((c & 7) << 18) | ((bytes[++p] & 63) << 12) | ((bytes[++p] & 63) << 6) | (bytes[++p] & 63);
      if (c > 0xffff) {
        c -= 0x10000;
        if (expected.charCodeAt(index++) !== 0xd800 + (c >>> 10)) return false;
        c = 0xdc00 + (c & 1023);
      }
    }
    if (expected.charCodeAt(index++) !== c) return false;
  }
  return false;
}

// Safe integers need no string. Let native Number perform correctly rounded
// conversion for decimals, exponents and integers outside the safe range.
function numberValue(bytes, start, end) {
  let p = start;
  const negative = bytes[p] === 45;
  if (negative) p++;
  if (bytes[p] < 48 || bytes[p] > 57) return undefined;
  let n = 0;
  for (; p < end; p++) {
    const c = bytes[p];
    if (c < 48 || c > 57) break;
    n = n * 10 + (c - 48);
    if (n > MAX_SAFE) break;
  }
  if (p === end) return negative ? -n : n;
  let text = '';
  for (p = start; p < end; p++) text += String.fromCharCode(bytes[p]);
  return Number(text);
}

function compileField(field) {
  if (typeof field !== 'string') throw new TypeError('Expected a string field name');
  return encoder.encode(JSON.stringify(field));
}

/** Test strict equality of one own top-level scalar field. Missing is false. */
export function compileJsonFieldEquals(field, expected) {
  const key = compileField(field);
  const kind = typeof expected;
  if (expected !== null && kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
    throw new TypeError('Expected a JSON scalar: string, number, boolean, or null');
  }
  if (kind === 'number' && Number.isNaN(expected)) return () => false;
  const token = encoder.encode(JSON.stringify(expected));
  return (bytes, start = 0, end = bytes.length) => {
    const p = fieldStart(bytes, start, end, key);
    if (p < 0) return false;
    const stop = valueEnd(bytes, p, end);
    if (kind === 'number') {
      if (bytes[p] !== 45 && (bytes[p] < 48 || bytes[p] > 57)) return false;
      if (Number.isFinite(expected) && equalBytes(bytes, p, stop, token)) return true;
      return numberValue(bytes, p, stop) === expected;
    }
    if (equalBytes(bytes, p, stop, token)) return true;
    return kind === 'string' && equalString(bytes, p, stop, expected);
  };
}

/** Project just a numeric field; non-number/missing fields return undefined. */
export function compileJsonNumberField(field) {
  const key = compileField(field);
  return (bytes, start = 0, end = bytes.length) => {
    const p = fieldStart(bytes, start, end, key);
    if (p < 0) return undefined;
    return numberValue(bytes, p, valueEnd(bytes, p, end));
  };
}

/** Test a numeric field in an inclusive interval. Neither bound coerces strings. */
export function compileJsonFieldNumberRange(field, minimum, maximum) {
  if (typeof minimum !== 'number' || typeof maximum !== 'number'
      || Number.isNaN(minimum) || Number.isNaN(maximum) || minimum > maximum) {
    throw new TypeError('Expected ordered numeric bounds');
  }
  const read = compileJsonNumberField(field);
  return (bytes, start = 0, end = bytes.length) => {
    const n = read(bytes, start, end);
    return n !== undefined && n >= minimum && n <= maximum;
  };
}
