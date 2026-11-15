//! Raw imported-memory access. No allocator, Rust object graph or host bindings.
//!
//! Published records are immutable. Callers validate/own the byte ranges passed
//! to kernels. Writers only change fresh records and their reserved scratch.
//! The fixed STATE addresses below are compiler placeholders, rewritten into
//! instance-local Wasm globals by the mandatory, fail-closed build step.

use core::arch::wasm32::{memory_grow, memory_size, unreachable};
use core::ptr;

pub const STATE_BASE: u32 = 2048;
pub const HEAP_START: u32 = 65536;
pub const MAX_END: u32 = 0x7fff0000;

// The legacy direct-reader ABI stages a key at address zero. Volatile access
// explicitly permits address zero outside Rust allocations; ordinary Rust
// pointer reads do not. Other addresses use unaligned scalar operations.
// There are no Rust allocations in the imported arena. Volatile is NOT a
// synchronization mechanism; published bytes cannot change during a read.
macro_rules! access {
    ($load:ident, $store:ident, $ty:ty) => {
        #[inline(always)]
        pub unsafe fn $load(p: u32) -> $ty {
            if p == 0 { ptr::read_volatile(ptr::without_provenance::<$ty>(0)) }
            else { ptr::read_unaligned(ptr::with_exposed_provenance::<$ty>(p as usize)) }
        }
        #[inline(always)]
        pub unsafe fn $store(p: u32, value: $ty) {
            if p == 0 { ptr::write_volatile(ptr::without_provenance_mut::<$ty>(0), value); }
            else { ptr::write_unaligned(ptr::with_exposed_provenance_mut::<$ty>(p as usize), value); }
        }
    };
}
// Byte alignment is always valid, including the legacy key at offset zero.
// One volatile scalar operation avoids a null check in every scanned byte.
#[inline(always)]
pub unsafe fn load_u8(p: u32) -> u8 { ptr::read_volatile(ptr::without_provenance::<u8>(p as usize)) }
#[inline(always)]
pub unsafe fn store_u8(p: u32, value: u8) { ptr::write_volatile(ptr::without_provenance_mut::<u8>(p as usize), value); }
access!(load_u16, store_u16, u16);
access!(load_u32, store_u32, u32);
access!(load_u64, store_u64, u64);
access!(load_f64, store_f64, f64);

// Volatile placeholders keep distinct state slots visible to the build-time
// promotion pass. The shipped instructions are global.get/global.set, not
// memory accesses, so this adds no runtime volatile/shared-state cost.
#[inline(always)]
pub unsafe fn state_load_u32(p: u32) -> u32 { ptr::read_volatile(ptr::without_provenance::<u32>(p as usize)) }
#[inline(always)]
pub unsafe fn state_store_u32(p: u32, value: u32) { ptr::write_volatile(ptr::without_provenance_mut::<u32>(p as usize), value); }
#[inline(always)]
pub unsafe fn state_load_f64(p: u32) -> f64 { ptr::read_volatile(ptr::without_provenance::<f64>(p as usize)) }
#[inline(always)]
pub unsafe fn state_store_f64(p: u32, value: f64) { ptr::write_volatile(ptr::without_provenance_mut::<f64>(p as usize), value); }

#[inline(always)]
pub unsafe fn heap_end() -> u32 {
    let end = state_load_u32(STATE_BASE);
    // The promoted global starts at HEAP_START. setHeapEnd and every allocator
    // update enforce this range. Exposing that invariant to LLVM removes null
    // branches from fresh-record writes without weakening the legacy zero ABI.
    core::hint::assert_unchecked(end >= HEAP_START && end <= MAX_END);
    end
}
#[inline(always)]
pub unsafe fn set_heap_end_internal(end: u32) { state_store_u32(STATE_BASE, end); }

#[inline(always)]
pub unsafe fn ensure_capacity(end: u32) {
    if end <= state_load_u32(STATE_BASE + 4) { return; }
    if end > MAX_END { unreachable(); }
    let pages = (end + 65535) >> 16;
    let current = memory_size::<0>() as u32;
    if pages > current && memory_grow::<0>((pages - current) as usize) == usize::MAX { unreachable(); }
    state_store_u32(STATE_BASE + 4, (memory_size::<0>() as u32).min(32767) << 16);
}

#[cfg(feature = "collections")]
#[no_mangle]
pub unsafe extern "C" fn getHeapEnd() -> u32 { heap_end() }

#[cfg(feature = "collections")]
#[no_mangle]
pub unsafe extern "C" fn setHeapEnd(end: u32) {
    if end < HEAP_START || end > MAX_END || (end as u64) > ((memory_size::<0>() as u64) << 16) { unreachable(); }
    set_heap_end_internal(end);
}

#[cfg(feature = "collections")]
#[no_mangle]
pub unsafe extern "C" fn alloc(bytes: u32) -> u32 {
    if bytes > MAX_END { unreachable(); }
    let p = (heap_end() + 7) & !7;
    let end = (p + bytes + 7) & !7;
    ensure_capacity(end);
    set_heap_end_internal(end);
    p
}

#[inline(always)]
pub unsafe fn copy_words(to: u32, from: u32, bytes: u32) {
    let mut i = 0;
    while i + 8 <= bytes { store_u64(to + i, load_u64(from + i)); i += 8; }
    if i < bytes { store_u32(to + i, load_u32(from + i)); }
}

#[inline(always)]
pub unsafe fn copy_bytes(to: u32, from: u32, count: u32) {
    if count == 0 || to == from { return; }
    if count > 32 && to != 0 && from != 0 {
        ptr::copy(ptr::with_exposed_provenance::<u8>(from as usize), ptr::with_exposed_provenance_mut::<u8>(to as usize), count as usize);
        return;
    }
    // Short record copies are disjoint in the collection kernels.
    let mut i = 0;
    while i + 8 <= count { store_u64(to + i, load_u64(from + i)); i += 8; }
    if i + 4 <= count { store_u32(to + i, load_u32(from + i)); i += 4; }
    if i + 2 <= count { store_u16(to + i, load_u16(from + i)); i += 2; }
    if i < count { store_u8(to + i, load_u8(from + i)); }
}

#[inline(always)]
pub unsafe fn fill_zero(p: u32, bytes: u32) {
    if bytes != 0 { ptr::write_bytes(ptr::with_exposed_provenance_mut::<u8>(p as usize), 0, bytes as usize); }
}

#[inline(always)]
pub unsafe fn memory_compare(a: u32, b: u32, length: u32) -> i32 {
    let mut i = 0;
    // Skip equal words without reading beyond either key. A differing word is
    // resolved bytewise so the signed lexical result matches memory.compare.
    while length - i >= 8 {
        if load_u64(a + i) != load_u64(b + i) { break; }
        i += 8;
    }
    while i < length {
        let difference = load_u8(a + i) as i32 - load_u8(b + i) as i32;
        if difference != 0 { return difference; }
        i += 1;
    }
    0
}
