//! Persistent scalar collections over the existing arena layout.
//! Only writers allocate or copy paths; read kernels use scalar Wasm locals.

use crate::memory::*;

#[no_mangle]
pub unsafe extern "C" fn vecLeaf(mut root: u32, depth: u32, index: u32) -> u32 {
    let mut level = depth;
    while level > 0 {
        root = load_u32(root + (index.wrapping_shr(level * 5) & 31) * 4);
        level -= 1;
    }
    root
}

#[no_mangle]
pub unsafe extern "C" fn vecGet(root: u32, depth: u32, index: u32) -> f64 {
    load_f64(vecLeaf(root, depth, index) + (index & 31) * 8)
}

unsafe fn vec_set_at(root: u32, depth: u32, index: u32, value: f64) -> u32 {
    let bytes = if depth != 0 { 128 } else { 256 };
    let p = alloc(bytes);
    if root != 0 { copy_bytes(p, root, bytes); } else { fill_zero(p, bytes); }
    if depth == 0 {
        store_f64(p + (index & 31) * 8, value);
    } else {
        let off = (index.wrapping_shr(depth * 5) & 31) * 4;
        let child = if root != 0 { load_u32(root + off) } else { 0 };
        store_u32(p + off, vec_set_at(child, depth - 1, index, value));
    }
    p
}

#[no_mangle]
pub unsafe extern "C" fn vecSet(root: u32, depth: u32, index: u32, value: f64) -> u32 {
    vec_set_at(root, depth, index, value)
}

unsafe fn vec_set_range(root: u32, depth: u32, input: u32, first: u32, end: u32) -> u32 {
    let bytes = if depth != 0 { 128 } else { 256 };
    let p = alloc(bytes);
    if root != 0 { copy_bytes(p, root, bytes); } else { fill_zero(p, bytes); }
    if depth == 0 {
        let mut i = first;
        while i < end {
            let entry = input + i * 12;
            store_f64(p + (load_u32(entry) & 31) * 8, load_f64(entry + 4));
            i += 1;
        }
    } else {
        let shift = depth * 5;
        let mut first_child = first;
        while first_child < end {
            let slot = load_u32(input + first_child * 12).wrapping_shr(shift) & 31;
            let mut last_child = first_child + 1;
            while last_child < end && (load_u32(input + last_child * 12).wrapping_shr(shift) & 31) == slot {
                last_child += 1;
            }
            let child = if root != 0 { load_u32(root + slot * 4) } else { 0 };
            store_u32(p + slot * 4, vec_set_range(child, depth - 1, input, first_child, last_child));
            first_child = last_child;
        }
    }
    p
}

#[no_mangle]
pub unsafe extern "C" fn vecSetMany(root: u32, depth: u32, input: u32, count: u32) -> u32 {
    if count != 0 { vec_set_range(root, depth, input, 0, count) } else { root }
}

#[no_mangle]
pub unsafe extern "C" fn tailSetMany(tail: u32, length: u32, input: u32, count: u32) -> u32 {
    if count == 0 { return tail; }
    let p = alloc(length * 8);
    copy_bytes(p, tail, length * 8);
    let mut i = 0;
    while i < count {
        let entry = input + i * 12;
        store_f64(p + (load_u32(entry) & 31) * 8, load_f64(entry + 4));
        i += 1;
    }
    p
}

#[inline(always)] unsafe fn sl(p: u32) -> u32 { if p != 0 { load_u32(p) } else { 0 } }
#[inline(always)] unsafe fn sr(p: u32) -> u32 { if p != 0 { load_u32(p + 4) } else { 0 } }
#[inline(always)] unsafe fn seq_size(p: u32) -> u32 { if p != 0 { load_u32(p + 8) } else { 0 } }
#[inline(always)] unsafe fn sh(p: u32) -> u32 { if p != 0 { load_u32(p + 12) } else { 0 } }

#[no_mangle]
pub unsafe extern "C" fn cons(next: u32, value: f64) -> u32 {
    let p = alloc(16);
    store_u32(p, next); store_u32(p + 4, 0); store_f64(p + 8, value);
    p
}

#[inline(always)] unsafe fn hr(p: u32) -> u32 { if p != 0 { load_u32(p + 24) } else { 0 } }
#[inline(always)] unsafe fn hs(p: u32) -> u32 { if p != 0 { load_u32(p + 28) } else { 0 } }

unsafe fn hn(priority: f64, value: f64, mut left: u32, mut right: u32) -> u32 {
    if hr(left) < hr(right) { let t = left; left = right; right = t; }
    let p = alloc(32);
    store_f64(p, priority); store_f64(p + 8, value);
    store_u32(p + 16, left); store_u32(p + 20, right);
    store_u32(p + 24, hr(right) + 1); store_u32(p + 28, hs(left) + hs(right) + 1);
    p
}

unsafe fn heap_merge(mut a: u32, mut b: u32, is_max: bool) -> u32 {
    if a == 0 { return b; }
    if b == 0 { return a; }
    let ap = load_f64(a); let bp = load_f64(b);
    if if is_max { bp > ap } else { bp < ap } { let t = a; a = b; b = t; }
    hn(load_f64(a), load_f64(a + 8), load_u32(a + 16), heap_merge(load_u32(a + 20), b, is_max))
}

#[no_mangle]
pub unsafe extern "C" fn heapInsert(root: u32, priority: f64, value: f64, isMax: u32) -> u32 {
    if root == 0 { return hn(priority, value, 0, 0); }
    let rp = load_f64(root);
    // Fuse singleton allocation with promotion: do not copy the fresh node.
    if if isMax != 0 { priority > rp } else { priority < rp } { return hn(priority, value, 0, root); }
    hn(rp, load_f64(root + 8), load_u32(root + 16), heapInsert(load_u32(root + 20), priority, value, isMax))
}

#[no_mangle]
pub unsafe extern "C" fn heapPop(root: u32, isMax: u32) -> u32 {
    if root != 0 { heap_merge(load_u32(root + 16), load_u32(root + 20), isMax != 0) } else { 0 }
}

#[no_mangle]
pub unsafe extern "C" fn tailAppend(tail: u32, length: u32, value: f64) -> u32 {
    if length != 0 && tail + length * 8 == heap_end() {
        let p = alloc(8); store_f64(p, value); return tail;
    }
    let p = alloc((length + 1) * 8);
    if length != 0 { copy_bytes(p, tail, length * 8); }
    store_f64(p + length * 8, value);
    p
}

#[no_mangle]
pub unsafe extern "C" fn tailSet(tail: u32, length: u32, index: u32, value: f64) -> u32 {
    let p = alloc(length * 8); copy_bytes(p, tail, length * 8);
    store_f64(p + index * 8, value); p
}

#[no_mangle]
pub unsafe extern "C" fn tailInsert(tail: u32, length: u32, index: u32, value: f64) -> u32 {
    if index == length { return tailAppend(tail, length, value); }
    let p = alloc((length + 1) * 8);
    copy_bytes(p, tail, index * 8); store_f64(p + index * 8, value);
    copy_bytes(p + (index + 1) * 8, tail + index * 8, (length - index) * 8);
    p
}

#[no_mangle]
pub unsafe extern "C" fn tailRemove(tail: u32, length: u32, index: u32) -> u32 {
    if length == 1 { return 0; }
    if index == 0 { return tail + 8; }
    if index == length - 1 { return tail; }
    let p = alloc((length - 1) * 8);
    copy_bytes(p, tail, index * 8);
    copy_bytes(p + index * 8, tail + (index + 1) * 8, (length - index - 1) * 8);
    p
}

unsafe fn link_range(root: u32, depth: u32, base: u32, start: u32, end: u32, input: u32, origin: u32) -> u32 {
    if depth == 0 { return input + (base - origin) * 8; }
    let p = alloc(128);
    if root != 0 { copy_bytes(p, root, 128); } else { fill_zero(p, 128); }
    let span = 1u32.wrapping_shl(depth * 5);
    let first = (start - base) / span; let last = (end - 1 - base) / span;
    let mut i = first;
    while i <= last {
        let b = base + i * span;
        let lo = start.max(b); let hi = end.min(b + span);
        let child = if root != 0 { load_u32(root + i * 4) } else { 0 };
        store_u32(p + i * 4, link_range(child, depth - 1, b, lo, hi, input, origin));
        i += 1;
    }
    p
}

#[no_mangle]
pub unsafe extern "C" fn vecLink(mut root: u32, mut depth: u32, newDepth: u32, start: u32, input: u32, count: u32) -> u32 {
    if count == 0 { return root; }
    if root != 0 {
        while depth < newDepth {
            let p = alloc(128); fill_zero(p, 128); store_u32(p, root);
            root = p; depth += 1;
        }
    }
    link_range(root, newDepth, 0, start, start + count, input, start)
}

#[inline(always)] unsafe fn bd(p: u32) -> u32 { load_u32(p + 16) }
#[inline(always)] unsafe fn bn(p: u32) -> u32 { load_u32(p + 20) }

unsafe fn bnode(left: u32, data: u32, length: u32, right: u32) -> u32 {
    let p = alloc(24); store_u32(p, left); store_u32(p + 4, right);
    store_u32(p + 8, seq_size(left) + length + seq_size(right));
    store_u32(p + 12, sh(left).max(sh(right)) + 1);
    store_u32(p + 16, data); store_u32(p + 20, length); p
}

unsafe fn bbal(left: u32, data: u32, length: u32, right: u32) -> u32 {
    if sh(left) > sh(right) + 1 {
        let ll = sl(left); let lr = sr(left);
        if sh(ll) >= sh(lr) { return bnode(ll, bd(left), bn(left), bnode(lr, data, length, right)); }
        return bnode(bnode(ll, bd(left), bn(left), sl(lr)), bd(lr), bn(lr), bnode(sr(lr), data, length, right));
    }
    if sh(right) > sh(left) + 1 {
        let rl = sl(right); let rr = sr(right);
        if sh(rr) >= sh(rl) { return bnode(bnode(left, data, length, rl), bd(right), bn(right), rr); }
        return bnode(bnode(left, data, length, sl(rl)), bd(rl), bn(rl), bnode(sr(rl), bd(right), bn(right), rr));
    }
    bnode(left, data, length, right)
}

#[no_mangle]
pub unsafe extern "C" fn blockAppend(root: u32, data: u32, length: u32) -> u32 {
    if root != 0 { bbal(sl(root), bd(root), bn(root), blockAppend(sr(root), data, length)) }
    else { bnode(0, data, length, 0) }
}

unsafe fn block_prepend(root: u32, data: u32, length: u32) -> u32 {
    if root != 0 { bbal(block_prepend(sl(root), data, length), bd(root), bn(root), sr(root)) }
    else { bnode(0, data, length, 0) }
}

#[no_mangle]
pub unsafe extern "C" fn blockGet(mut root: u32, mut index: u32) -> f64 {
    while root != 0 {
        let before = seq_size(sl(root)); let count = bn(root);
        if index < before { root = sl(root); }
        else if index >= before + count { index -= before + count; root = sr(root); }
        else { return load_f64(bd(root) + (index - before) * 8); }
    }
    core::arch::wasm32::unreachable()
}

#[no_mangle]
pub unsafe extern "C" fn blockInsert(root: u32, index: u32, value: f64) -> u32 {
    if root == 0 { return bnode(0, tailAppend(0, 0, value), 1, 0); }
    let left = sl(root); let right = sr(root); let before = seq_size(left);
    let length = bn(root); let data = bd(root);
    if index < before { return bbal(blockInsert(left, index, value), data, length, right); }
    if index > before + length { return bbal(left, data, length, blockInsert(right, index - before - length, value)); }
    let p = tailInsert(data, length, index - before, value);
    if length < 32 { return bnode(left, p, length + 1, right); }
    bbal(left, p, 16, block_prepend(right, p + 128, 17))
}

unsafe fn drop_first_block(root: u32) -> u32 {
    if sl(root) != 0 { bbal(drop_first_block(sl(root)), bd(root), bn(root), sr(root)) }
    else { sr(root) }
}

#[no_mangle]
pub unsafe extern "C" fn blockDelete(root: u32, index: u32) -> u32 {
    let left = sl(root); let right = sr(root); let before = seq_size(left);
    let length = bn(root); let data = bd(root);
    if index < before { return bbal(blockDelete(left, index), data, length, right); }
    if index >= before + length { return bbal(left, data, length, blockDelete(right, index - before - length)); }
    if length > 1 { return bnode(left, tailRemove(data, length, index - before), length - 1, right); }
    if left == 0 { return right; }
    if right == 0 { return left; }
    let mut first = right;
    while sl(first) != 0 { first = sl(first); }
    bbal(left, bd(first), bn(first), drop_first_block(right))
}

unsafe fn block_build_range(input: u32, first: u32, end: u32) -> u32 {
    if first == end { return 0; }
    let mid = first + ((end - first) >> 1);
    bnode(block_build_range(input, first, mid), input + mid * 256, 32, block_build_range(input, mid + 1, end))
}

#[no_mangle]
pub unsafe extern "C" fn blockBuild(input: u32, blocks: u32) -> u32 {
    block_build_range(input, 0, blocks)
}
