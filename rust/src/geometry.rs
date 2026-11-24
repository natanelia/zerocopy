//! Bounds kernels: temporary values are scalar locals. Result slots below are
//! compiler placeholders rewritten into per-instance Wasm globals at build.

use crate::memory::*;

// Aligned published vector spans need no per-coordinate null branch. Volatile
// raw reads also retain the legacy aligned address-zero direct-call behavior.
#[inline(always)]
unsafe fn load_aligned_f64(p: u32) -> f64 {
    core::ptr::read_volatile(core::ptr::without_provenance::<f64>(p as usize))
}

const MIN_X: u32 = 2112;
const MIN_Y: u32 = 2120;
const MAX_X: u32 = 2128;
const MAX_Y: u32 = 2136;

#[no_mangle]
pub unsafe extern "C" fn bboxMinX() -> f64 { state_load_f64(MIN_X) }
#[no_mangle]
pub unsafe extern "C" fn bboxMinY() -> f64 { state_load_f64(MIN_Y) }
#[no_mangle]
pub unsafe extern "C" fn bboxMaxX() -> f64 { state_load_f64(MAX_X) }
#[no_mangle]
pub unsafe extern "C" fn bboxMaxY() -> f64 { state_load_f64(MAX_Y) }

#[no_mangle]
pub unsafe extern "C" fn xyLeaf(root: u32, depth: u32, tail: u32, size: u32, index: u32) -> u32 {
    if index >= (size.wrapping_sub(1) & !31) { return tail; }
    let mut node = root; let mut d = depth;
    while d > 0 {
        node = load_u32(node + (index.wrapping_shr(d * 5) & 31) * 4);
        d -= 1;
    }
    node
}

#[no_mangle]
pub unsafe extern "C" fn bboxXY(root: u32, depth: u32, tail: u32, size: u32) {
    if size & 1 != 0 { core::arch::wasm32::unreachable(); }
    bbox_range(root, depth, tail, size, 0, size);
}

#[no_mangle]
pub unsafe extern "C" fn bboxXYRange(root: u32, depth: u32, tail: u32, size: u32, start: u32, end: u32) {
    if (size | start | end) & 1 != 0 || start > end || end > size {
        core::arch::wasm32::unreachable();
    }
    bbox_range(root, depth, tail, size, start, end);
}

#[inline(always)]
unsafe fn bbox_range(root: u32, depth: u32, tail: u32, size: u32, start: u32, end: u32) {
    let mut lx = f64::INFINITY; let mut ly = f64::INFINITY;
    let mut hx = f64::NEG_INFINITY; let mut hy = f64::NEG_INFINITY;
    let mut first_offset = (start & 31) * 8;
    let mut base = if start == end { end } else { start & !31 };
    while base < end {
        let p = xyLeaf(root, depth, tail, size, base);
        let stop = p + 32u32.min(end - base) * 8;
        let mut q = p + first_offset;
        // Test alignment once per leaf. Preserve unaligned direct ABI inputs
        // through the general loader; ordinary published vectors are aligned.
        if p & 7 == 0 {
            while q < stop {
                let x = load_aligned_f64(q); let y = load_aligned_f64(q + 8);
                // Strict comparisons ignore NaN axes and retain first signed zeros.
                if x < lx { lx = x; }
                if y < ly { ly = y; }
                if x > hx { hx = x; }
                if y > hy { hy = y; }
                q += 16;
            }
        } else {
            while q < stop {
                let x = load_f64(q); let y = load_f64(q + 8);
                // Strict comparisons ignore NaN axes and retain first signed zeros.
                if x < lx { lx = x; }
                if y < ly { ly = y; }
                if x > hx { hx = x; }
                if y > hy { hy = y; }
                q += 16;
            }
        }
        first_offset = 0;
        base += 32;
    }
    state_store_f64(MIN_X, lx); state_store_f64(MIN_Y, ly);
    state_store_f64(MAX_X, hx); state_store_f64(MAX_Y, hy);
}
