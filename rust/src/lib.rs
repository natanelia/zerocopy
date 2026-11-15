#![no_std]
#![allow(non_snake_case, dead_code)]

mod memory;
#[cfg(feature = "collections")]
mod maps;
#[cfg(feature = "collections")]
mod collections;
#[cfg(feature = "collections")]
mod readers;
#[cfg(feature = "json-views")]
mod json;
#[cfg(feature = "numeric")]
mod numeric;
#[cfg(feature = "geometry")]
mod geometry;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
