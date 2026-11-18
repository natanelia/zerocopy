//! Read-only selectors over JSON.stringify-produced UTF-8 records.
//!
//! No allocator, stack scratch, writes, host callbacks, or temporary strings.
//! Values remain in the caller's immutable arena. These are bounded selectors,
//! not a complete validator for arbitrary JSON or malformed UTF-8.
use crate::memory::{load_u8, load_u64};

#[inline(always)]
unsafe fn space(mut p: u32, end: u32) -> u32 {
    while p < end {
        let c = load_u8(p);
        if c != 32 && c != 9 && c != 10 && c != 13 { break; }
        p += 1;
    }
    p
}

#[inline(always)]
unsafe fn string_marker(mut p: u32, end: u32) -> u32 {
    const ONES: u64 = 0x0101010101010101;
    const HIGH: u64 = 0x8080808080808080;
    while end - p >= 8 {
        let word = load_u64(p);
        let quote = word ^ 0x2222222222222222;
        let slash = word ^ 0x5c5c5c5c5c5c5c5c;
        let markers = ((quote.wrapping_sub(ONES) & !quote)
            | (slash.wrapping_sub(ONES) & !slash)) & HIGH;
        // A borrow may also mark a later byte; the first marked byte is exact.
        // WASM words are little-endian, including unaligned loads.
        if markers != 0 { return p + (markers.trailing_zeros() >> 3); }
        p += 8;
    }
    while p < end {
        let c = load_u8(p);
        if c == 34 || c == 92 { break; }
        p += 1;
    }
    p
}

#[inline(always)]
unsafe fn string_end(start: u32, end: u32) -> u32 {
    let mut p = start + 1;
    while p < end {
        let c = load_u8(p);
        p += 1;
        if c == 34 { return p; }
        if c == 92 {
            if p == end { return 0; }
            p += 1;
        }
    }
    0
}

/// Selected strings without escapes can decode their inner UTF-8 directly.
/// A negative end marks escapes; zero is invalid. Arena offsets stay below
/// 2 GiB, so both the boundary and this flag fit one scalar i32 result.
#[no_mangle]
pub unsafe extern "C" fn jsonStringEnd(start: u32, end: u32) -> i32 {
    if start >= end || load_u8(start) != 34 { return 0; }
    let p = string_marker(start + 1, end);
    if p == end { return 0; }
    if load_u8(p) == 34 { return (p + 1) as i32; }
    if p + 1 == end { return 0; }
    // Once escapes occur, preserve the scalar loop. Dense escaped text makes
    // too little progress per word to benefit from another word comparison.
    -(string_end(p + 1, end) as i32)
}

/// End of one selected value, excluding trailing whitespace. Zero is invalid.
#[no_mangle]
pub unsafe extern "C" fn jsonValueEnd(start: u32, end: u32) -> u32 {
    let start = space(start, end);
    if start >= end { return 0; }
    let first = load_u8(start);
    if first == 34 { return string_end(start, end); }
    if first == 123 || first == 91 {
        let mut depth = 1u32;
        let mut p = start + 1;
        while p < end {
            let c = load_u8(p);
            if c == 34 {
                p = string_end(p, end);
                if p == 0 { return 0; }
                continue;
            }
            p += 1;
            if c == 123 || c == 91 { depth += 1; }
            else if c == 125 || c == 93 {
                depth -= 1;
                if depth == 0 { return p; }
            }
        }
        return 0;
    }
    let mut p = start;
    while p < end {
        let c = load_u8(p);
        if c == 44 || c == 125 || c == 93 || c == 32 || c == 9 || c == 10 || c == 13 { break; }
        p += 1;
    }
    if p == start { 0 } else { p }
}

#[inline(always)]
fn hex(c: u8) -> u32 {
    if c >= 48 && c <= 57 { (c - 48) as u32 }
    else if c >= 65 && c <= 70 { (c - 55) as u32 }
    else if c >= 97 && c <= 102 { (c - 87) as u32 }
    else { 0xffff }
}

#[inline(always)]
unsafe fn escape_code(p: u32, end: u32) -> u32 {
    if p >= end { return 0xffff_ffff; }
    match load_u8(p) {
        34 => 34, 47 => 47, 92 => 92,
        98 => 8, 102 => 12, 110 => 10, 114 => 13, 116 => 9,
        117 => {
            if end - p < 5 { return 0xffff_ffff; }
            let a = hex(load_u8(p + 1));
            let b = hex(load_u8(p + 2));
            let c = hex(load_u8(p + 3));
            let d = hex(load_u8(p + 4));
            if (a | b | c | d) > 15 { return 0xffff_ffff; }
            (a << 12) | (b << 8) | (c << 4) | d
        }
        _ => 0xffff_ffff,
    }
}

#[inline(always)]
unsafe fn ascii_key(start: u32, end: u32, length: u32, lo: u32, hi: u32) -> bool {
    let mut p = start + 1;
    let mut index = 0u32;
    while p < end {
        let mut c = load_u8(p) as u32;
        p += 1;
        if c == 34 { return index == length; }
        if c == 92 {
            c = escape_code(p, end);
            if c == 0xffff_ffff { return false; }
            p += if load_u8(p) == 117 { 5 } else { 1 };
        }
        if index >= length || c > 127 { return false; }
        let word = if index < 4 { lo } else { hi };
        if c != ((word >> ((index & 3) * 8)) & 255) { return false; }
        index += 1;
    }
    false
}

#[inline(always)]
fn append_hash(h: u32, code: u32) -> u32 { (h ^ code).wrapping_mul(16777619) }

/// Hash semantic UTF-16 units, including escaped lone surrogates. Valid input
/// is guaranteed by the writer; structural bounds are still checked here.
#[inline(always)]
unsafe fn key_hash(start: u32, end: u32) -> u32 {
    let mut h = 2166136261u32;
    let mut p = start + 1;
    while p < end {
        let mut c = load_u8(p) as u32;
        p += 1;
        if c == 34 { return h; }
        if c == 92 {
            c = escape_code(p, end);
            if c == 0xffff_ffff { return h; }
            p += if load_u8(p) == 117 { 5 } else { 1 };
        } else if c >= 192 {
            if c < 224 {
                if p >= end { return h; }
                c = ((c & 31) << 6) | ((load_u8(p) as u32) & 63);
                p += 1;
            } else if c < 240 {
                if end - p < 2 { return h; }
                c = ((c & 15) << 12) | (((load_u8(p) as u32) & 63) << 6) | ((load_u8(p + 1) as u32) & 63);
                p += 2;
            } else {
                if end - p < 3 { return h; }
                c = ((c & 7) << 18) | (((load_u8(p) as u32) & 63) << 12)
                    | (((load_u8(p + 1) as u32) & 63) << 6) | ((load_u8(p + 2) as u32) & 63);
                p += 3;
                c = c.wrapping_sub(65536);
                h = append_hash(h, 0xd800 | (c >> 10));
                c = 0xdc00 | (c & 1023);
            }
        }
        h = append_hash(h, c);
    }
    h
}

#[inline(always)]
unsafe fn after_key(key_end: u32, end: u32) -> u32 {
    if key_end == 0 { return 0; }
    let p = space(key_end, end);
    if p >= end || load_u8(p) != 58 { return 0; }
    let value = space(p + 1, end);
    if value < end { value } else { 0 }
}

/// Exact matching for the common <=8-ASCII-code-unit field names. The key is
/// carried in scalar arguments, with no encoded key allocation or shared copy.
#[no_mangle]
pub unsafe extern "C" fn jsonFieldAscii8(start: u32, end: u32, length: u32, lo: u32, hi: u32) -> u32 {
    if length > 8 || start >= end || load_u8(start) != 123 { return 0; }
    let mut p = space(start + 1, end);
    while p < end && load_u8(p) == 34 {
        let key_end = string_end(p, end);
        let value = after_key(key_end, end);
        if value == 0 { return 0; }
        if ascii_key(p, key_end, length, lo, hi) { return value; }
        p = jsonValueEnd(value, end);
        if p == 0 { return 0; }
        p = space(p, end);
        if p >= end || load_u8(p) != 44 { return 0; }
        p = space(p + 1, end);
    }
    0
}

/// Locate a hash candidate; caller MUST compare the actual key. `start` may
/// be an opening object brace or the first key after an already-scanned value.
/// Returning the key offset avoids i64/BigInt conversions and shared results.
#[no_mangle]
pub unsafe extern "C" fn jsonFieldCandidate(start: u32, end: u32, hash: u32) -> u32 {
    let mut p = space(start, end);
    if p < end && load_u8(p) == 123 { p = space(p + 1, end); }
    while p < end && load_u8(p) == 34 {
        let key_end = string_end(p, end);
        if key_end == 0 { return 0; }
        if key_hash(p, key_end) == hash { return p; }
        let value = after_key(key_end, end);
        if value == 0 { return 0; }
        p = jsonValueEnd(value, end);
        if p == 0 { return 0; }
        p = space(p, end);
        if p >= end || load_u8(p) != 44 { return 0; }
        p = space(p + 1, end);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn jsonArrayAt(start: u32, end: u32, mut index: u32) -> u32 {
    if start >= end || load_u8(start) != 91 { return 0; }
    let mut p = space(start + 1, end);
    while p < end && load_u8(p) != 93 {
        if index == 0 { return p; }
        index -= 1;
        p = jsonValueEnd(p, end);
        if p == 0 { return 0; }
        p = space(p, end);
        if p >= end || load_u8(p) != 44 { return 0; }
        p = space(p + 1, end);
    }
    0
}

/// Safe integers need no selected-token string. NaN requests the exact native
/// Number fallback for decimal/exponent/large-integer spellings; valid JSON
/// cannot itself contain a NaN value. Preserve the sign of integer zero.
#[no_mangle]
pub unsafe extern "C" fn jsonInteger(start: u32, end: u32) -> f64 {
    if start >= end { return f64::NAN; }
    let negative = load_u8(start) == 45;
    let mut p = start + if negative { 1 } else { 0 };
    let digits = p;
    let mut value = 0.0f64;
    while p < end {
        let c = load_u8(p);
        if c < 48 || c > 57 { break; }
        value = value * 10.0 + (c - 48) as f64;
        if value > 9007199254740991.0 { return f64::NAN; }
        p += 1;
    }
    if p == digits { return f64::NAN; }
    if p < end {
        let c = load_u8(p);
        if c != 44 && c != 125 && c != 93 && c != 32 && c != 9 && c != 10 && c != 13 { return f64::NAN; }
    }
    if negative { -value } else { value }
}
