import type { Arena } from './arena';

/** Literal substring search. Case-insensitive mode uses JavaScript toLowerCase,
 * not locale-sensitive collation, regex matching, or Unicode normalization. */
export interface TextSearchOptions {
  readonly caseSensitive?: boolean;
}

/** Compile a predicate over immutable, length-prefixed UTF-8 string addresses.
 * Only query-sized state is allocated. No decoded dataset or result cache is kept.
 * @internal */
export function compileStringSearch(arena: Arena, term: string, options: TextSearchOptions = {}): (raw: number) => boolean {
  if (typeof term !== 'string') throw new TypeError('Search text must be a string');
  if (options === null || typeof options !== 'object') throw new TypeError('Expected text search options');
  const sensitive = options.caseSensitive ?? true;
  if (typeof sensitive !== 'boolean') throw new TypeError('caseSensitive must be a boolean');
  const query = sensitive ? term : term.toLowerCase();
  if (!query.length) return () => true;
  const fallback = sensitive
    ? (raw: number) => (arena.decode('string', raw) as string).includes(query)
    : (raw: number) => (arena.decode('string', raw) as string).toLowerCase().includes(query);
  // UTF-16 substring semantics include isolated halves of a surrogate pair.
  // A byte search cannot represent those needles. Unicode lowercase conversion
  // can also expand characters or depend on context; defer it to the JS engine.
  for (let i = 0; i < query.length; i++) {
    const code = query.charCodeAt(i);
    if (!sensitive && code > 127) return fallback;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = query.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fallback;
    } else if (code >= 0xdc00 && code <= 0xdfff) return fallback;
  }
  const needle = new TextEncoder().encode(query);
  const bytes = arena.buf, view = arena.dv;
  const length = needle.length;
  // Short queries stay in WASM for the whole byte scan. Repeated JS accesses
  // to shared bytes are disproportionately costly in some browser engines.
  // Packed query words are call arguments, never shared allocator scratch.
  if (length <= 16) {
    const packed = new Uint32Array(4), masks = new Uint32Array(4);
    for (let i = 0; i < length; i++) {
      const code = needle[i], shift = (i & 3) * 8;
      packed[i >>> 2] |= code << shift;
      if (!sensitive && code >= 97 && code <= 122) masks[i >>> 2] |= 32 << shift;
    }
    const [q0,q1,q2,q3] = packed, [m0,m1,m2,m3] = masks;
    const scan = arena.wasm.textContains16;
    return raw => {
      const result = scan(raw, length, q0,q1,q2,q3, m0,m1,m2,m3, !sensitive);
      return result < 0 ? fallback(raw) : result !== 0;
    };
  }
  // A bounded Horspool search skips impossible starts. Compare four bytes at a
  // time against masks derived from the query: only its ASCII letters may fold.
  if (length <= 32) {
    const shifts = new Uint8Array(256); shifts.fill(length);
    const mask = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const code = needle[i];
      if (!sensitive && code >= 97 && code <= 122) mask[i] = 32;
      if (i < length - 1) {
        shifts[code] = length - 1 - i;
        if (mask[i]) shifts[code - 32] = length - 1 - i;
      }
    }
    const words = length >>> 2, matchWords = new Int32Array(words), maskWords = new Int32Array(words);
    for (let i = 0; i < words; i++) {
      const j = i * 4;
      matchWords[i] = needle[j] | needle[j+1] << 8 | needle[j+2] << 16 | needle[j+3] << 24;
      maskWords[i] = mask[j] | mask[j+1] << 8 | mask[j+2] << 16 | mask[j+3] << 24;
    }
    const last = length - 1, lastByte = needle[last], lastMask = mask[last];
    return raw => {
      const start = raw + 4, end = start + view.getUint32(raw, true);
      for (let p = start + last; p < end;) {
        const code = bytes[p];
        if ((code | lastMask) === lastByte) {
          const first = p - last;
          let w = 0;
          while (w < words && ((view.getUint32(first + w * 4, true) | maskWords[w]) === matchWords[w])) w++;
          if (w === words) {
            let j = words * 4;
            while (j < last && (bytes[first+j] | mask[j]) === needle[j]) j++;
            if (j >= last) return true;
          }
        }
        p += shifts[code];
      }
      // Skips can cross Unicode bytes. Only an all-ASCII negative is final in
      // insensitive mode; otherwise use the exact Unicode reference operation.
      if (!sensitive) {
        let p = start;
        for (; p + 16 <= end; p += 16) {
          if ((view.getUint32(p) | view.getUint32(p+4) | view.getUint32(p+8) | view.getUint32(p+12)) & 0x80808080) return fallback(raw);
        }
        for (; p < end; p++) if (bytes[p] > 127) return fallback(raw);
      }
      return false;
    };
  }
  // KMP bounds long-needle search at O(string bytes + query bytes), without
  // query-length limits or quadratic work for repeated prefixes.
  const prefix = new Uint32Array(length);
  for (let i = 1, j = 0; i < length; i++) {
    while (j && needle[i] !== needle[j]) j = prefix[j - 1];
    if (needle[i] === needle[j]) j++;
    prefix[i] = j;
  }
  return raw => {
    const end = raw + 4 + view.getUint32(raw, true);
    let j = 0;
    for (let p = raw + 4; p < end; p++) {
      let code = bytes[p];
      if (!sensitive) {
        if (code > 127) return fallback(raw);
        if (code >= 65 && code <= 90) code += 32;
      }
      while (j && code !== needle[j]) j = prefix[j - 1];
      if (code === needle[j] && ++j === length) return true;
    }
    return false;
  };
}
