//! Bounds kernels: temporary values are scalar locals. Result slots below are
//! compiler placeholders rewritten into per-instance Wasm globals at build.

use crate::memory::*;

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
    let mut lx = f64::INFINITY; let mut ly = f64::INFINITY;
    let mut hx = f64::NEG_INFINITY; let mut hy = f64::NEG_INFINITY;
    let mut base = 0;
    while base < size {
        let p = xyLeaf(root, depth, tail, size, base);
        let end = p + 32u32.min(size - base) * 8;
        let mut q = p;
        while q < end {
            let x = load_f64(q); let y = load_f64(q + 8);
            // Strict comparisons ignore NaN axes and retain first signed zeros.
            if x < lx { lx = x; }
            if y < ly { ly = y; }
            if x > hx { hx = x; }
            if y > hy { hy = y; }
            q += 16;
        }
        base += 32;
    }
    state_store_f64(MIN_X, lx); state_store_f64(MIN_Y, ly);
    state_store_f64(MAX_X, hx); state_store_f64(MAX_Y, hy);
}
