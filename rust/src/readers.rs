//! Scratch-free hash and text kernels. Query data stays in numeric arguments.

use crate::maps::mapChild;
use crate::memory::*;

#[no_mangle]
pub unsafe extern "C" fn mapHashCandidateFrom(mut root: u32, hash: u32, mut shift: u32) -> u32 {
    while root != 0 {
        let kind = load_u32(root);
        if kind == 0 || kind == 2 { return if load_u32(root + 4) == hash { root } else { 0 }; }
        root = mapChild(root, hash.wrapping_shr(shift) & 15);
        shift += 4;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn mapHashCandidate(root: u32, hash: u32) -> u32 {
    mapHashCandidateFrom(root, hash, 0)
}

#[no_mangle]
pub unsafe extern "C" fn mapHashPrefix(mut root: u32, hash: u32, bits: u32) -> u32 {
    let mut shift = 0;
    while shift < bits && root != 0 {
        let kind = load_u32(root);
        if kind == 0 || kind == 2 { break; }
        root = mapChild(root, hash.wrapping_shr(shift) & 15);
        shift += 4;
    }
    root
}

#[inline(always)]
fn hash_part(mut hash: u32, mut word: u32, count: u32) -> u32 {
    let mut i = 0;
    while i < count {
        hash = (hash ^ (word & 255)).wrapping_mul(16777619);
        word >>= 8;
        i += 1;
    }
    hash
}

#[inline(always)]
unsafe fn matches_packed8(pointer: u32, count: u32, lo: u32, hi: u32) -> bool {
    let word = (lo as u64) | ((hi as u64) << 32);
    if count == 8 { return load_u64(pointer) == word; }
    if count >= 4 {
        return load_u32(pointer) == lo
            && load_u32(pointer + count - 4) == (word >> ((count - 4) * 8)) as u32;
    }
    if count >= 2 {
        return load_u16(pointer) as u32 == (lo & 65535)
            && load_u8(pointer + count - 1) as u32 == ((lo >> ((count - 1) * 8)) & 255);
    }
    count == 0 || load_u8(pointer) as u32 == (lo & 255)
}

#[inline(always)]
unsafe fn matches_packed16(leaf: u32, length: u32, q0: u32, q1: u32, q2: u32, q3: u32) -> bool {
    if load_u32(leaf + 8) != length { return false; }
    if length > 8 {
        matches_packed8(leaf + 16, 8, q0, q1)
            && matches_packed8(leaf + 24, length - 8, q2, q3)
    } else { matches_packed8(leaf + 16, length, q0, q1) }
}

/// Hash and compare a 0..16-byte key passed entirely in scalar arguments.
/// This reader never stages bytes in the shared arena. Every comparison stays
/// inside the published key, including short keys at the end of a memory page.
#[no_mangle]
pub unsafe extern "C" fn mapFindAscii16(mut root: u32, length: u32, q0: u32, q1: u32, q2: u32, q3: u32) -> u32 {
    if length > 16 { return 0; }
    let mut hash = hash_part(2166136261, q0, length.min(4));
    if length > 4 { hash = hash_part(hash, q1, (length - 4).min(4)); }
    if length > 8 { hash = hash_part(hash, q2, (length - 8).min(4)); }
    if length > 12 { hash = hash_part(hash, q3, length - 12); }
    if root != 0 && load_u32(root) == 0xffff_ffff {
        let mut i = 0;
        let count = load_u32(root + 12);
        while i < count {
            let leaf = load_u32(root + 16 + i * 4);
            if load_u32(leaf + 4) == hash && matches_packed16(leaf, length, q0, q1, q2, q3) { return leaf; }
            i += 1;
        }
        root = load_u32(root + 4);
    }
    let candidate = mapHashCandidate(root, hash);
    if candidate == 0 { return 0; }
    if load_u32(candidate) != 2 {
        return if matches_packed16(candidate, length, q0, q1, q2, q3) { candidate } else { 0 };
    }
    let mut i = 0;
    let count = load_u32(candidate + 8);
    while i < count {
        let leaf = load_u32(candidate + 16 + i * 4);
        if matches_packed16(leaf, length, q0, q1, q2, q3) { return leaf; }
        i += 1;
    }
    0
}

const ONES: u64 = 0x0101010101010101;
const HIGH: u64 = 0x8080808080808080;

#[inline(always)]
unsafe fn short_word(pointer: u32, count: u32) -> u64 {
    let mut result = 0u64;
    let mut i = 0;
    while i < count {
        result |= (load_u8(pointer + i) as u64).wrapping_shl(i * 8);
        i += 1;
    }
    result
}

#[inline(always)]
unsafe fn matches_at(pointer: u32, end: u32, size: u32, lo: u64, hi: u64, mask_lo: u64, mask_hi: u64, keep_lo: u64, keep_hi: u64) -> bool {
    let first = if pointer + 8 <= end { load_u64(pointer) } else { short_word(pointer, size) };
    if ((first | mask_lo) & keep_lo) != lo { return false; }
    if size <= 8 { return true; }
    let last = if pointer + 16 <= end { load_u64(pointer + 8) } else { short_word(pointer + 8, size - 8) };
    ((last | mask_hi) & keep_hi) == hi
}

/// A 1..16-byte query; -1 requests the exact Unicode casing fallback.
/// All loads stay inside the published string span. Nothing is allocated or written.
#[no_mangle]
pub unsafe extern "C" fn textContains16(raw: u32, size: u32, q0: u32, q1: u32, q2: u32, q3: u32, m0: u32, m1: u32, m2: u32, m3: u32, insensitive: u32) -> i32 {
    if size == 0 || size > 16 { return -1; }
    let length = load_u32(raw); let start = raw + 4; let end = start + length;
    let lo = (q0 as u64) | ((q1 as u64) << 32);
    let hi = (q2 as u64) | ((q3 as u64) << 32);
    let mask_lo = (m0 as u64) | ((m1 as u64) << 32);
    let mask_hi = (m2 as u64) | ((m3 as u64) << 32);
    let keep_lo = if size >= 8 { u64::MAX } else { (1u64 << (size * 8)) - 1 };
    let keep_hi = if size >= 16 { u64::MAX } else if size > 8 { (1u64 << ((size - 8) * 8)) - 1 } else { 0 };
    let first = ((q0 & 255) as u64) * ONES;
    let fold = ((m0 & 255) as u64) * ONES;
    let mut pointer = start; let mut seen = 0u64;
    if length >= size {
        let limit = end - size + 1;
        while pointer + 8 <= limit {
            let word = load_u64(pointer); seen |= word;
            let different = (word | fold) ^ first;
            let mut positions = different.wrapping_sub(ONES) & !different & HIGH;
            while positions != 0 {
                let offset = positions.trailing_zeros() >> 3;
                if matches_at(pointer + offset, end, size, lo, hi, mask_lo, mask_hi, keep_lo, keep_hi) { return 1; }
                positions &= positions - 1;
            }
            pointer += 8;
        }
        while pointer < limit {
            let code = load_u8(pointer) as u32; seen |= code as u64;
            if (code | (m0 & 255)) == (q0 & 255) && matches_at(pointer, end, size, lo, hi, mask_lo, mask_hi, keep_lo, keep_hi) { return 1; }
            pointer += 1;
        }
    }
    if insensitive != 0 {
        while pointer + 8 <= end { seen |= load_u64(pointer); pointer += 8; }
        while pointer < end { seen |= load_u8(pointer) as u64; pointer += 1; }
        if seen & HIGH != 0 { return -1; }
    }
    0
}

/// Result bits 0..15 mark matches; bits 16..31 mark Unicode fallback rows.
#[no_mangle]
pub unsafe extern "C" fn textContainsBlock16(address: u32, count: u32, size: u32, q0: u32, q1: u32, q2: u32, q3: u32, m0: u32, m1: u32, m2: u32, m3: u32, insensitive: u32) -> u32 {
    if count == 0 || count > 16 || size == 0 || size > 16 { return 0; }
    let mut flags = 0; let mut i = 0;
    while i < count {
        let raw = load_f64(address + i * 8) as u32;
        let result = textContains16(raw, size, q0, q1, q2, q3, m0, m1, m2, m3, insensitive);
        if result > 0 { flags |= 1 << i; }
        else if result < 0 { flags |= 1 << (i + 16); }
        i += 1;
    }
    flags
}
