//! Read-only scalar and optional SIMD reductions over shared vector leaves.

use crate::memory::*;
#[cfg(target_feature = "simd128")]
use core::arch::wasm32::*;

unsafe fn span_count(p: u32, count: u32, lo: f64, hi: f64) -> u32 {
    let mut i = 0;
    #[cfg(not(target_feature = "simd128"))]
    let mut total = 0;
    #[cfg(target_feature = "simd128")]
    let mut total = {
        let lower = f64x2_splat(lo); let upper = f64x2_splat(hi);
        let mut sums = i64x2_splat(0);
        // Only load complete pairs within the snapshot's visible span.
        while count - i >= 2 {
            let values = v128_load((p + i * 8) as *const v128);
            sums = i64x2_sub(sums, v128_and(f64x2_ge(values, lower), f64x2_le(values, upper)));
            i += 2;
        }
        (i64x2_extract_lane::<0>(sums) as u32) + (i64x2_extract_lane::<1>(sums) as u32)
    };
    while i < count {
        let value = load_f64(p + i * 8);
        total += ((value >= lo) as u32) & ((value <= hi) as u32);
        i += 1;
    }
    total
}

unsafe fn tree_count(root: u32, depth: u32, mut count: u32, lo: f64, hi: f64) -> u32 {
    if depth == 0 { return span_count(root, count, lo, hi); }
    let capacity = 1u32.wrapping_shl(depth * 5);
    let mut total = 0; let mut child = 0;
    while count != 0 {
        let take = count.min(capacity);
        total += tree_count(load_u32(root + child * 4), depth - 1, take, lo, hi);
        count -= take; child += 1;
    }
    total
}

#[no_mangle]
pub unsafe extern "C" fn countInRange(root: u32, depth: u32, tail: u32, size: u32, lo: f64, hi: f64) -> u32 {
    if size == 0 || lo > hi || lo.is_nan() || hi.is_nan() { return 0; }
    let tree_size = (size - 1) & !31;
    let before = if tree_size != 0 { tree_count(root, depth, tree_size, lo, hi) } else { 0 };
    before + span_count(tail, size - tree_size, lo, hi)
}

// Spatial SIMD variants were rejected in the existing project. Preserve the
// scalar x/y path independently of the separately selected range SIMD build.
unsafe fn span_box(p: u32, values: u32, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> u32 {
    let mut total = 0; let mut i = 0;
    while i < values {
        let x = load_f64(p + i * 8); let y = load_f64(p + i * 8 + 8);
        total += ((x >= min_x) as u32) & ((x <= max_x) as u32) & ((y >= min_y) as u32) & ((y <= max_y) as u32);
        i += 2;
    }
    total
}

unsafe fn tree_box(root: u32, depth: u32, mut values: u32, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> u32 {
    if depth == 0 { return span_box(root, values, min_x, min_y, max_x, max_y); }
    let capacity = 1u32.wrapping_shl(depth * 5);
    let mut total = 0; let mut child = 0;
    while values != 0 {
        let take = values.min(capacity);
        total += tree_box(load_u32(root + child * 4), depth - 1, take, min_x, min_y, max_x, max_y);
        values -= take; child += 1;
    }
    total
}

#[no_mangle]
pub unsafe extern "C" fn countPointsInBox(root: u32, depth: u32, tail: u32, size: u32, minX: f64, minY: f64, maxX: f64, maxY: f64) -> u32 {
    if size & 1 != 0 { core::arch::wasm32::unreachable(); }
    if size == 0 || minX > maxX || minY > maxY || minX.is_nan() || minY.is_nan() || maxX.is_nan() || maxY.is_nan() { return 0; }
    let tree_size = (size - 1) & !31;
    let before = if tree_size != 0 { tree_box(root, depth, tree_size, minX, minY, maxX, maxY) } else { 0 };
    before + span_box(tail, size - tree_size, minX, minY, maxX, maxY)
}
