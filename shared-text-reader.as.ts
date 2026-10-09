// Scratch-free substring reader. Query words are parameters, never stored in
// the owner's memory. A negative return requests exact Unicode JS fallback.
const ONES: u64 = 0x0101010101010101;
const HIGH: u64 = 0x8080808080808080;

@inline
function shortWord(pointer: u32, count: u32): u64 {
  let result: u64 = 0;
  for (let i: u32 = 0; i < count; i++) result |= <u64>load<u8>(pointer + i) << (i * 8);
  return result;
}

@inline
function matchesAt(pointer: u32, end: u32, size: u32, lo: u64, hi: u64, maskLo: u64, maskHi: u64, keepLo: u64, keepHi: u64): bool {
  const first = pointer + 8 <= end ? load<u64>(pointer) : shortWord(pointer, size);
  if (((first | maskLo) & keepLo) != lo) return false;
  if (size <= 8) return true;
  const last = pointer + 16 <= end ? load<u64>(pointer + 8) : shortWord(pointer + 8, size - 8);
  return ((last | maskHi) & keepHi) == hi;
}

/** Test a 1..16-byte needle using packed parameters and word-level candidate
 * detection. No allocation, scratch write, or read beyond this string occurs.
 * Returns 1 for a match, 0 for a final miss, -1 when Unicode casing is needed.
 */
export function textContains16(raw: u32, size: u32, q0: u32, q1: u32, q2: u32, q3: u32, m0: u32, m1: u32, m2: u32, m3: u32, insensitive: bool): i32 {
  if (!size || size > 16) return -1;
  const length = load<u32>(raw), start = raw + 4, end = start + length;
  const lo = <u64>q0 | (<u64>q1 << 32), hi = <u64>q2 | (<u64>q3 << 32);
  const maskLo = <u64>m0 | (<u64>m1 << 32), maskHi = <u64>m2 | (<u64>m3 << 32);
  const keepLo: u64 = size >= 8 ? 0xffffffffffffffff : (<u64>1 << (size * 8)) - 1;
  const keepHi: u64 = size >= 16 ? 0xffffffffffffffff : size > 8 ? (<u64>1 << ((size - 8) * 8)) - 1 : 0;
  const first = <u64>(q0 & 255) * ONES, fold = <u64>(m0 & 255) * ONES;
  let pointer = start, seen: u64 = 0;
  if (length >= size) {
    const limit = end - size + 1;
    let last: u64 = 0, lastFold: u64 = 0;
    if (size > 1 && pointer + 8 <= limit) {
      const shift = ((size - 1) & 7) * 8;
      last = (((size > 8 ? hi : lo) >> shift) & 255) * ONES;
      lastFold = (((size > 8 ? maskHi : maskLo) >> shift) & 255) * ONES;
    }
    for (; pointer + 8 <= limit; pointer += 8) {
      const word = load<u64>(pointer); seen |= word;
      const different = (word | fold) ^ first;
      // Borrow may also mark a neighboring byte, but cannot lose a candidate.
      // Each marked start is verified against the complete query words below.
      let positions = (different - ONES) & ~different & HIGH;
      if (size > 1 && (positions & (positions - 1)) != 0) {
        // Filter only multiple candidates to amortize the extra word test.
        // The loop bound proves pointer + size - 1 + 8 <= end.
        const tail = (load<u64>(pointer + size - 1) | lastFold) ^ last;
        positions &= (tail - ONES) & ~tail & HIGH;
      }
      while (positions) {
        const offset = <u32>(ctz<u64>(positions) >> 3);
        if (matchesAt(pointer + offset, end, size, lo, hi, maskLo, maskHi, keepLo, keepHi)) return 1;
        positions &= positions - 1;
      }
    }
    for (; pointer < limit; pointer++) {
      const code = load<u8>(pointer); seen |= code;
      if ((code | (m0 & 255)) == (q0 & 255) && matchesAt(pointer, end, size, lo, hi, maskLo, maskHi, keepLo, keepHi)) return 1;
    }
  }
  if (insensitive) {
    for (; pointer + 8 <= end; pointer += 8) seen |= load<u64>(pointer);
    for (; pointer < end; pointer++) seen |= load<u8>(pointer);
    if (seen & HIGH) return -1;
  }
  return 0;
}

/** Test at most 16 raw string addresses in an immutable vector leaf.
 * One bit per row marks a match, plus one bit per row for Unicode fallback.
 * This amortizes JS/WASM entry without a result buffer or shared-memory writes.
 */
export function textContainsBlock16(address: u32, count: u32, size: u32, q0: u32, q1: u32, q2: u32, q3: u32, m0: u32, m1: u32, m2: u32, m3: u32, insensitive: bool): u32 {
  if (!count || count > 16 || !size || size > 16) return 0;
  let flags: u32 = 0;
  for (let i: u32 = 0; i < count; i++) {
    const raw = <u32>load<f64>(address + i * 8);
    const result = textContains16(raw, size, q0, q1, q2, q3, m0, m1, m2, m3, insensitive);
    if (result > 0) flags |= <u32>1 << i;
    else if (result < 0) flags |= <u32>1 << (i + 16);
  }
  return flags;
}
