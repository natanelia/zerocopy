//! Persistent HAMT and radix kernels over the imported arena.
//!
//! Published records retain their existing byte layout. Only synchronous writer
//! calls touch the reserved scratch regions or scalar writer state; cold readers
//! have no allocator, mutable global, linear-memory stack object, or output copy.

#![allow(non_snake_case)]

use crate::memory::*;

const OVERLAY: u32 = 0x8000_0000;
const OVERLAY_LIMIT: u32 = 8;
const JOURNAL: u32 = 0xffff_ffff;
const JOURNAL_LIMIT: u32 = 4;
const UNKNOWN: u32 = 0xffff_ffff;
const PUBLISHED: u32 = 0x7fff_ffff;
const WRITE_FIRST: u32 = 12288;
const WRITE_SECOND: u32 = 12352;
const WRITE_VALID: u32 = 13376;
const WRITE_SIZES: u32 = 13440;
const WRITE_STAGE: u32 = 16384;

// These slots belong to the single synchronous writer, never to a reader.
// The first two words at STATE_BASE are owned by memory.rs.
const INSERTED_COUNT: u32 = 2048 + 8;
const BATCH_CHANGE: u32 = 2048 + 12;
const WRITER_INDEX_ROOT: u32 = 2048 + 16;
const WRITER_FIRST_VALID: u32 = 2048 + 20;
const WRITE_MAP_ROOT: u32 = 2048 + 24;
const WRITE_MAP_SIZE: u32 = 2048 + 28;

#[inline(always)]
unsafe fn tag(p: u32) -> u32 { load_u32(p) }

#[inline(always)]
fn pc(n: u32) -> u32 { n.count_ones() }

#[inline(always)]
unsafe fn inserted() -> u32 { state_load_u32(INSERTED_COUNT) }

#[inline(always)]
unsafe fn set_inserted(n: u32) { state_store_u32(INSERTED_COUNT, n); }

#[inline(always)]
unsafe fn overlay_previous(p: u32) -> u32 { p.wrapping_sub((tag(p) & 16383) * 4) }

#[inline(always)]
unsafe fn overlay_anchor(p: u32) -> u32 { p.wrapping_sub((load_u32(p + 8) & 65535) * 4) }

#[inline(always)]
unsafe fn overlay_child(p: u32) -> u32 {
    let distance = (tag(p) >> 14) & 127;
    if distance != 0 { p.wrapping_sub(distance * 4) } else { 0 }
}

#[inline(always)]
unsafe fn is_branch(p: u32) -> bool { (tag(p) & 3) == 1 || (tag(p) & OVERLAY) != 0 }

#[inline(always)]
unsafe fn branch_bitmap(p: u32) -> u32 {
    if tag(p) & OVERLAY != 0 { load_u32(p + 8) >> 16 } else { load_u32(p + 4) }
}

#[no_mangle]
pub unsafe extern "C" fn mapSize(mut p: u32) -> u32 {
    let mut delta: i32 = 0;
    while p != 0 && tag(p) != JOURNAL && tag(p) & OVERLAY != 0 {
        delta = delta.wrapping_add((tag(p).wrapping_shl(1) as i32) >> 26);
        p = overlay_previous(p);
    }
    let size = if p == 0 { 0 } else if tag(p) == 0 { 1 }
        else if tag(p) & 3 == 1 { tag(p) >> 2 } else { load_u32(p + 8) };
    size.wrapping_add(delta as u32)
}

#[inline]
unsafe fn hash_at(p: u32, len: u32) -> u32 {
    let mut hash: u32 = 2166136261;
    let mut i = 0;
    while i < len {
        hash = (hash ^ load_u8(p + i) as u32).wrapping_mul(16777619);
        i += 1;
    }
    hash
}

#[no_mangle]
pub unsafe extern "C" fn mapLeaf(keyLen: u32, valLen: u32) -> u32 {
    if keyLen > 0x7ffe_0000 || valLen > 0x7ffe_0000 - keyLen {
        core::arch::wasm32::unreachable();
    }
    let p = heap_end();
    let end = (p + 16 + keyLen + valLen + 3) & !3;
    ensure_capacity(end);
    set_heap_end_internal(end);
    store_u32(p, 0);
    store_u32(p + 8, keyLen);
    store_u32(p + 12, valLen);
    p
}

#[inline(always)]
unsafe fn equal_key_bytes(a: u32, b: u32, count: u32) -> bool {
    if count > 16 { return memory_compare(a, b, count) == 0; }
    if count >= 8 { return load_u64(a) == load_u64(b) && load_u64(a + count - 8) == load_u64(b + count - 8); }
    if count >= 4 { return load_u32(a) == load_u32(b) && load_u32(a + count - 4) == load_u32(b + count - 4); }
    if count >= 2 { return load_u16(a) == load_u16(b) && load_u8(a + count - 1) == load_u8(b + count - 1); }
    count == 0 || load_u8(a) == load_u8(b)
}

#[inline(always)]
unsafe fn same_key(a: u32, b: u32) -> bool {
    let n = load_u32(a + 8);
    load_u32(a + 4) == load_u32(b + 4) && n == load_u32(b + 8)
        && equal_key_bytes(a + 16, b + 16, n)
}

#[inline]
unsafe fn branch(bitmap: u32, size: u32) -> u32 {
    let p = heap_end();
    let end = p + 8 + pc(bitmap) * 4;
    ensure_capacity(end);
    set_heap_end_internal(end);
    store_u32(p, (size << 2) | 1);
    store_u32(p + 4, bitmap);
    p
}

#[inline]
unsafe fn bucket(hash: u32, count: u32) -> u32 {
    let p = alloc(16 + count * 4);
    store_u32(p, 2);
    store_u32(p + 4, hash);
    store_u32(p + 8, count);
    store_u32(p + 12, 0);
    p
}

#[inline(always)]
unsafe fn branch_child(mut p: u32, digit: u32) -> u32 {
    if tag(p) & OVERLAY != 0 {
        let depth = (tag(p) >> 21) & 15;
        let x = load_u32(p + 4) ^ digit.wrapping_mul(0x1111_1111);
        let matches = x.wrapping_sub(0x1111_1111) & !x & 0x8888_8888
            & u32::MAX.wrapping_shr((8u32.wrapping_sub(depth)) * 4);
        if matches != 0 {
            let mut steps = matches.trailing_zeros() >> 2;
            while steps != 0 { p = overlay_previous(p); steps -= 1; }
            return overlay_child(p);
        }
        p = overlay_anchor(p);
    }
    let bitmap = load_u32(p + 4);
    let bit = 1u32.wrapping_shl(digit);
    if bitmap & bit != 0 { load_u32(p + 8 + pc(bitmap & bit.wrapping_sub(1)) * 4) } else { 0 }
}

unsafe fn full_branch(root: u32, bitmap: u32, mut delta: i32, digit: u32, child: u32) -> u32 {
    let mut base = root;
    let mut n = 0;
    while tag(base) & OVERLAY != 0 {
        delta = delta.wrapping_add((tag(base).wrapping_shl(1) as i32) >> 26);
        store_u32(4096 + n * 4, base);
        n += 1;
        base = overlay_previous(base);
    }
    let p = branch(bitmap, (tag(base) >> 2).wrapping_add(delta as u32));
    let original = load_u32(base + 4);
    if bitmap == 65535 && original == bitmap {
        copy_words(p + 8, base + 8, 64);
        while n != 0 {
            n -= 1;
            let patch = load_u32(4096 + n * 4);
            store_u32(p + 8 + (load_u32(patch + 4) & 15) * 4, overlay_child(patch));
        }
        store_u32(p + 8 + digit * 4, child);
        return p;
    }
    let mut bits = original;
    let mut pos = 0;
    while bits != 0 {
        let d = bits.trailing_zeros();
        store_u32(4224 + d * 4, load_u32(base + 8 + pos * 4));
        pos += 1;
        bits &= bits - 1;
    }
    while n != 0 {
        n -= 1;
        let patch = load_u32(4096 + n * 4);
        store_u32(4224 + (load_u32(patch + 4) & 15) * 4, overlay_child(patch));
    }
    store_u32(4224 + digit * 4, child);
    bits = bitmap;
    pos = 0;
    while bits != 0 {
        let d = bits.trailing_zeros();
        store_u32(p + 8 + pos * 4, load_u32(4224 + d * 4));
        pos += 1;
        bits &= bits - 1;
    }
    p
}

#[inline(always)]
unsafe fn try_overlay(mut root: u32, bitmap: u32, mut delta: i32, digit: u32, child: u32) -> u32 {
    let mut depth = if tag(root) & OVERLAY != 0 { (tag(root) >> 21) & 15 } else { 0 };
    if tag(root) & OVERLAY != 0 && load_u32(root + 4) & 15 == digit {
        let combined = ((tag(root).wrapping_shl(1) as i32) >> 26).wrapping_add(delta);
        if combined >= -32 && combined <= 31 {
            delta = combined;
            root = overlay_previous(root);
            depth -= 1;
        }
    }
    if depth < OVERLAY_LIMIT {
        let anchor = if tag(root) & OVERLAY != 0 { overlay_anchor(root) } else { root };
        let digits = (if tag(root) & OVERLAY != 0 { load_u32(root + 4) } else { 0 }).wrapping_shl(4) | digit;
        let p = heap_end();
        if p.wrapping_sub(anchor) > 262140 || p.wrapping_sub(root) > 65532
            || (child != 0 && p.wrapping_sub(child) > 508) { return 0; }
        let end = p + 12;
        ensure_capacity(end);
        set_heap_end_internal(end);
        let child_distance = if child != 0 { ((p - child) >> 2) << 14 } else { 0 };
        store_u32(p, OVERLAY | (((delta as u32) & 63) << 25) | ((depth + 1) << 21)
            | child_distance | ((p - root) >> 2));
        store_u32(p + 4, digits);
        store_u32(p + 8, ((p - anchor) >> 2) | (bitmap << 16));
        return p;
    }
    0
}

unsafe fn replace_child(root: u32, bitmap: u32, delta: i32, digit: u32, child: u32, mark: u32) -> u32 {
    if root >= mark {
        if tag(root) & OVERLAY == 0 && load_u32(root + 4) == bitmap {
            store_u32(root + 8 + pc(bitmap & 1u32.wrapping_shl(digit).wrapping_sub(1)) * 4, child);
            store_u32(root, tag(root).wrapping_add(delta.wrapping_shl(2) as u32));
            return root;
        }
    } else {
        let patch = try_overlay(root, bitmap, delta, digit, child);
        if patch != 0 { return patch; }
    }
    full_branch(root, bitmap, delta, digit, child)
}

unsafe fn replace_known(root: u32, bitmap: u32, delta: i32, digit: u32, child: u32, size: u32, lanes: u32) -> u32 {
    let patch = try_overlay(root, bitmap, delta, digit, child);
    if patch != 0 { return patch; }
    let p = branch(bitmap, size);
    if bitmap == 65535 { copy_words(p + 8, lanes, 64); }
    else {
        let mut bits = bitmap;
        let mut position = 0;
        while bits != 0 {
            let d = bits.trailing_zeros();
            store_u32(p + 8 + position * 4, load_u32(lanes + d * 4));
            position += 1;
            bits &= bits - 1;
        }
    }
    p
}

unsafe fn merge_hashed(a: u32, b: u32, shift: u32) -> u32 {
    let ai = load_u32(a + 4).wrapping_shr(shift) & 15;
    let bi = load_u32(b + 4).wrapping_shr(shift) & 15;
    let p = branch((1 << ai) | (1 << bi), mapSize(a) + mapSize(b));
    if ai == bi { store_u32(p + 8, merge_hashed(a, b, shift + 4)); }
    else {
        store_u32(p + 8, if ai < bi { a } else { b });
        store_u32(p + 12, if ai < bi { b } else { a });
    }
    p
}

unsafe fn insert_at(root: u32, leaf: u32, shift: u32, delta: u32, mark: u32) -> u32 {
    if root == 0 { set_inserted(1); return leaf; }
    let kind = tag(root);
    if !is_branch(root) {
        if load_u32(root + 4) != load_u32(leaf + 4) {
            set_inserted(1);
            return merge_hashed(root, leaf, shift);
        }
        if kind == 0 {
            if delta == 0 || (delta == UNKNOWN && same_key(root, leaf)) { set_inserted(0); return leaf; }
            set_inserted(1);
            let p = bucket(load_u32(leaf + 4), 2);
            store_u32(p + 16, root);
            store_u32(p + 20, leaf);
            return p;
        }
        let count = mapSize(root);
        let mut position = count;
        if delta != 1 {
            let mut i = 0;
            while i < count {
                if same_key(load_u32(root + 16 + i * 4), leaf) { position = i; break; }
                i += 1;
            }
        }
        set_inserted((position == count) as u32);
        let p = bucket(load_u32(leaf + 4), count + inserted());
        copy_words(p + 16, root + 16, count * 4);
        store_u32(p + 16 + position * 4, leaf);
        return p;
    }
    let digit = load_u32(leaf + 4).wrapping_shr(shift) & 15;
    let bitmap = branch_bitmap(root);
    let old = branch_child(root, digit);
    let child = insert_at(old, leaf, shift + 4, delta, mark);
    replace_child(root, bitmap | (1 << digit), inserted() as i32, digit, child, mark)
}

#[no_mangle]
pub unsafe extern "C" fn mapInsert(root: u32, leaf: u32) -> u32 {
    insert_at(materialize_journal(root, 0), leaf, 0, UNKNOWN, PUBLISHED)
}

unsafe fn map_insert_indexed(root: u32, leaf: u32, known: u32, root_size: u32) -> u32 {
    if root == 0 || tag(root) == JOURNAL || !is_branch(root) {
        state_store_u32(WRITER_INDEX_ROOT, 0);
        return insert_at(materialize_journal(root, 0), leaf, 0, known, PUBLISHED);
    }
    if state_load_u32(WRITER_INDEX_ROOT) != root {
        state_store_u32(WRITER_INDEX_ROOT, root);
        state_store_u32(WRITER_FIRST_VALID, 0);
    }
    // Invalidate the directory before an allocation can trap.
    state_store_u32(WRITER_INDEX_ROOT, 0);
    let hash = load_u32(leaf + 4);
    let first = hash & 15;
    let bit = 1 << first;
    let valid = state_load_u32(WRITER_FIRST_VALID) & bit;
    let old = if valid != 0 { load_u32(WRITE_FIRST + first * 4) } else { branch_child(root, first) };
    let old_size = if valid != 0 { load_u32(WRITE_SIZES + first * 4) } else { mapSize(old) };
    let child;
    if old != 0 && is_branch(old) {
        let digit = (hash >> 4) & 15;
        let b = 1 << digit;
        let pos = WRITE_SECOND + (first * 16 + digit) * 4;
        let mask = if valid != 0 { load_u32(WRITE_VALID + first * 4) } else { 0 };
        let previous = if mask & b != 0 { load_u32(pos) } else { branch_child(old, digit) };
        let next = insert_at(previous, leaf, 8, known, PUBLISHED);
        let bitmap = branch_bitmap(old) | b;
        let next_mask = mask | b;
        store_u32(pos, next);
        store_u32(WRITE_VALID + first * 4, next_mask);
        child = if next_mask & bitmap == bitmap {
            replace_known(old, bitmap, inserted() as i32, digit, next, old_size + inserted(), WRITE_SECOND + first * 64)
        } else { replace_child(old, bitmap, inserted() as i32, digit, next, PUBLISHED) };
    } else {
        child = insert_at(old, leaf, 4, known, PUBLISHED);
        store_u32(WRITE_VALID + first * 4, 0);
    }
    store_u32(WRITE_FIRST + first * 4, child);
    let first_valid = state_load_u32(WRITER_FIRST_VALID) | bit;
    state_store_u32(WRITER_FIRST_VALID, first_valid);
    store_u32(WRITE_SIZES + first * 4, old_size + inserted());
    let bitmap = branch_bitmap(root) | bit;
    let next = if first_valid & bitmap == bitmap && root_size != UNKNOWN {
        replace_known(root, bitmap, inserted() as i32, first, child, root_size + inserted(), WRITE_FIRST)
    } else { replace_child(root, bitmap, inserted() as i32, first, child, PUBLISHED) };
    state_store_u32(WRITER_INDEX_ROOT, next);
    next
}

#[no_mangle]
pub unsafe extern "C" fn mapFind(mut root: u32, key: u32, len: u32, hash: u32) -> u32 {
    if root != 0 && tag(root) == JOURNAL {
        let p = journalFind(root, key, len, hash);
        if p != 0 { return p; }
        root = load_u32(root + 4);
    }
    let mut shift = 0;
    while root != 0 {
        let kind = tag(root);
        if kind == 0 {
            return if load_u32(root + 4) == hash && load_u32(root + 8) == len
                && memory_compare(root + 16, key, len) == 0 { root } else { 0 };
        }
        if kind == 2 {
            if load_u32(root + 4) != hash { return 0; }
            let count = mapSize(root);
            let mut i = 0;
            while i < count {
                let leaf = load_u32(root + 16 + i * 4);
                if load_u32(leaf + 8) == len && memory_compare(leaf + 16, key, len) == 0 { return leaf; }
                i += 1;
            }
            return 0;
        }
        root = branch_child(root, hash.wrapping_shr(shift) & 15);
        shift += 4;
    }
    0
}

unsafe fn delete_at(root: u32, key: u32, len: u32, hash: u32, shift: u32) -> u32 {
    if root == 0 { return 0; }
    let kind = tag(root);
    if kind == 0 { return if mapFind(root, key, len, hash) != 0 { 0 } else { root }; }
    if kind == 2 {
        let count = mapSize(root);
        let mut pos = count;
        let mut i = 0;
        while i < count {
            if mapFind(load_u32(root + 16 + i * 4), key, len, hash) != 0 { pos = i; break; }
            i += 1;
        }
        if pos == count { return root; }
        if count == 2 { return load_u32(root + 16 + (1 - pos) * 4); }
        let p = bucket(hash, count - 1);
        copy_words(p + 16, root + 16, pos * 4);
        copy_words(p + 16 + pos * 4, root + 20 + pos * 4, (count - pos - 1) * 4);
        return p;
    }
    let bitmap = branch_bitmap(root);
    let digit = hash.wrapping_shr(shift) & 15;
    let bit = 1 << digit;
    if bitmap & bit == 0 { return root; }
    let old = branch_child(root, digit);
    let child = delete_at(old, key, len, hash, shift + 4);
    if old == child { return root; }
    let next_bitmap = if child != 0 { bitmap } else { bitmap & !bit };
    if next_bitmap == 0 { return 0; }
    if pc(next_bitmap) == 1 {
        let remaining = if child != 0 { child } else { branch_child(root, next_bitmap.trailing_zeros()) };
        if !is_branch(remaining) { return remaining; }
    }
    replace_child(root, next_bitmap, -1, digit, child, PUBLISHED)
}

#[no_mangle]
pub unsafe extern "C" fn mapDelete(root: u32, key: u32, len: u32, hash: u32) -> u32 {
    delete_at(materialize_journal(root, 0), key, len, hash, 0)
}

unsafe fn delete_leaf_at(root: u32, leaf: u32, hash: u32, shift: u32) -> u32 {
    if root == 0 { return 0; }
    if tag(root) == 0 { return if root == leaf { 0 } else { root }; }
    if tag(root) == 2 {
        let count = load_u32(root + 8);
        let mut pos = count;
        let mut i = 0;
        while i < count {
            if load_u32(root + 16 + i * 4) == leaf { pos = i; break; }
            i += 1;
        }
        if pos == count { return root; }
        if count == 2 { return load_u32(root + 16 + (1 - pos) * 4); }
        let p = bucket(hash, count - 1);
        copy_words(p + 16, root + 16, pos * 4);
        copy_words(p + 16 + pos * 4, root + 20 + pos * 4, (count - pos - 1) * 4);
        return p;
    }
    let bitmap = branch_bitmap(root);
    let digit = hash.wrapping_shr(shift) & 15;
    let bit = 1 << digit;
    if bitmap & bit == 0 { return root; }
    let old = branch_child(root, digit);
    let child = delete_leaf_at(old, leaf, hash, shift + 4);
    if old == child { return root; }
    let next_bitmap = if child != 0 { bitmap } else { bitmap & !bit };
    if next_bitmap == 0 { return 0; }
    if pc(next_bitmap) == 1 {
        let remaining = if child != 0 { child } else { branch_child(root, next_bitmap.trailing_zeros()) };
        if !is_branch(remaining) { return remaining; }
    }
    replace_child(root, next_bitmap, -1, digit, child, PUBLISHED)
}

#[no_mangle]
pub unsafe extern "C" fn mapDeleteBytes(root: u32, length: u32) -> u32 {
    let hash = hash_at(WRITE_STAGE, length);
    if root != 0 && tag(root) == JOURNAL && mapFind(root, WRITE_STAGE, length, hash) == 0 { return root; }
    delete_at(materialize_journal(root, 0), WRITE_STAGE, length, hash, 0)
}

#[no_mangle]
pub unsafe extern "C" fn mapDeleteLeaf(root: u32, leaf: u32) -> u32 {
    if leaf != 0 { delete_leaf_at(materialize_journal(root, 0), leaf, load_u32(leaf + 4), 0) } else { root }
}

#[inline(always)]
unsafe fn child_at(root: u32, digit: u32, shift: u32) -> u32 {
    if root == 0 { return 0; }
    if !is_branch(root) { return if load_u32(root + 4).wrapping_shr(shift) & 15 == digit { root } else { 0 }; }
    branch_child(root, digit)
}

#[no_mangle]
pub unsafe extern "C" fn mapChild(root: u32, digit: u32) -> u32 { branch_child(root, digit) }

unsafe fn batch_at(mut old: u32, input: u32, count: u32, shift: u32, mark: u32) -> u32 {
    if count == 0 { state_store_u32(BATCH_CHANGE, 0); return old; }
    if count <= 4 {
        let mut added = 0;
        let mut i = 0;
        while i < count {
            old = insert_at(old, load_u32(input + i * 4), shift, UNKNOWN, mark);
            added += inserted();
            i += 1;
        }
        state_store_u32(BATCH_CHANGE, added);
        return old;
    }
    if shift >= 32 {
        if old == 0 {
            let p = bucket(load_u32(load_u32(input) + 4), count);
            copy_words(p + 16, input, count * 4);
            state_store_u32(BATCH_CHANGE, count);
            return p;
        }
        let mut added = 0;
        let mut i = 0;
        while i < count {
            old = insert_at(old, load_u32(input + i * 4), shift, UNKNOWN, mark);
            added += inserted();
            i += 1;
        }
        state_store_u32(BATCH_CHANGE, added);
        return old;
    }
    let frame = 8192 + (shift / 4) * 256;
    fill_zero(frame, 256);
    let mut i = 0;
    while i < count {
        let digit = load_u32(load_u32(input + i * 4) + 4).wrapping_shr(shift) & 15;
        store_u32(frame + digit * 4, load_u32(frame + digit * 4) + 1);
        i += 1;
    }
    let mut offset = 0;
    let mut digit = 0;
    while digit < 16 {
        store_u32(frame + 128 + digit * 4, offset);
        offset += load_u32(frame + digit * 4);
        digit += 1;
    }
    let mut start = 0;
    digit = 0;
    while digit < 16 {
        let end = start + load_u32(frame + digit * 4);
        let cursor = frame + 128 + digit * 4;
        while load_u32(cursor) < end {
            let pos = load_u32(cursor);
            let leaf = load_u32(input + pos * 4);
            let target = load_u32(leaf + 4).wrapping_shr(shift) & 15;
            if target == digit { store_u32(cursor, pos + 1); }
            else {
                let target_cursor = frame + 128 + target * 4;
                let dest = load_u32(target_cursor);
                store_u32(input + pos * 4, load_u32(input + dest * 4));
                store_u32(input + dest * 4, leaf);
                store_u32(target_cursor, dest + 1);
            }
        }
        start = end;
        digit += 1;
    }
    let mut bitmap = 0;
    let mut children = 0;
    let mut added = 0;
    let size = mapSize(old);
    start = 0;
    digit = 0;
    while digit < 16 {
        let n = load_u32(frame + digit * 4);
        let child = batch_at(child_at(old, digit, shift), input + start * 4, n, shift + 4, mark);
        added += state_load_u32(BATCH_CHANGE);
        if child != 0 {
            bitmap |= 1 << digit;
            store_u32(frame + 128 + children * 4, child);
            children += 1;
        }
        start += n;
        digit += 1;
    }
    let p = branch(bitmap, size + added);
    copy_words(p + 8, frame + 128, children * 4);
    state_store_u32(BATCH_CHANGE, added);
    p
}

#[no_mangle]
pub unsafe extern "C" fn mapBatch(old: u32, input: u32, count: u32) -> u32 {
    let old = materialize_journal(old, 0);
    batch_at(old, input, count, 0, heap_end())
}

// The input consists of distinct live leaves from the original snapshot.
// Partition once per affected prefix; untouched children retain their pointers.
unsafe fn delete_batch_at(old: u32, input: u32, count: u32, shift: u32) -> u32 {
    if old == 0 || count == 0 { state_store_u32(BATCH_CHANGE, 0); return old; }
    let size = mapSize(old);
    if count == size {
        state_store_u32(BATCH_CHANGE, count);
        return 0;
    }
    if count <= 4 || shift >= 32 || !is_branch(old) {
        let mut next = old;
        let mut removed = 0;
        let mut i = 0;
        while i < count {
            let leaf = load_u32(input + i * 4);
            let result = delete_leaf_at(next, leaf, load_u32(leaf + 4), shift);
            if result != next { removed += 1; next = result; }
            i += 1;
        }
        state_store_u32(BATCH_CHANGE, removed);
        return next;
    }

    // Same per-depth writer scratch as mapBatch. Recursive calls use the
    // next frame; full_branch uses its separate scratch region.
    let frame = 8192 + (shift / 4) * 256;
    fill_zero(frame, 256);
    let mut i = 0;
    while i < count {
        let digit = load_u32(load_u32(input + i * 4) + 4).wrapping_shr(shift) & 15;
        store_u32(frame + digit * 4, load_u32(frame + digit * 4) + 1);
        i += 1;
    }
    let mut offset = 0;
    let mut digit = 0;
    while digit < 16 {
        store_u32(frame + 128 + digit * 4, offset);
        offset += load_u32(frame + digit * 4);
        digit += 1;
    }
    let mut start = 0;
    digit = 0;
    while digit < 16 {
        let end = start + load_u32(frame + digit * 4);
        let cursor = frame + 128 + digit * 4;
        while load_u32(cursor) < end {
            let pos = load_u32(cursor);
            let leaf = load_u32(input + pos * 4);
            let target = load_u32(leaf + 4).wrapping_shr(shift) & 15;
            if target == digit { store_u32(cursor, pos + 1); }
            else {
                let target_cursor = frame + 128 + target * 4;
                let dest = load_u32(target_cursor);
                store_u32(input + pos * 4, load_u32(input + dest * 4));
                store_u32(input + dest * 4, leaf);
                store_u32(target_cursor, dest + 1);
            }
        }
        start = end;
        digit += 1;
    }

    let mut bitmap = 0;
    let mut children = 0;
    let mut removed = 0;
    let mut last_child = 0;
    start = 0;
    digit = 0;
    while digit < 16 {
        let n = load_u32(frame + digit * 4);
        let previous = branch_child(old, digit);
        let child = if n != 0 {
            let result = delete_batch_at(previous, input + start * 4, n, shift + 4);
            removed += state_load_u32(BATCH_CHANGE);
            result
        } else { previous };
        if child != 0 {
            bitmap |= 1 << digit;
            store_u32(frame + 128 + children * 4, child);
            children += 1;
            last_child = child;
        }
        start += n;
        digit += 1;
    }
    state_store_u32(BATCH_CHANGE, removed);
    if removed == 0 { return old; }
    if bitmap == 0 { return 0; }
    if children == 1 && !is_branch(last_child) { return last_child; }
    let result = branch(bitmap, size - removed);
    copy_words(result + 8, frame + 128, children * 4);
    result
}

#[no_mangle]
pub unsafe extern "C" fn mapDeleteBatch(old: u32, input: u32, count: u32) -> u32 {
    delete_batch_at(materialize_journal(old, 0), input, count, 0)
}

// Legacy scratch ABI. getInfo is intentionally writer-scratch-using; TS cold
// readers use mapFind/mapChild/hash candidates instead.
#[no_mangle]
pub extern "C" fn keyBuf() -> u32 { 0 }

#[no_mangle]
pub extern "C" fn batchBuf() -> u32 { 1024 }

#[no_mangle]
pub unsafe extern "C" fn getInfo(root: u32, len: u32) -> u32 {
    let p = mapFind(root, 0, len, hash_at(0, len));
    if p != 0 {
        store_u32(1024, load_u32(p + 8));
        store_u32(1028, load_u32(p + 12));
        store_u32(1032, p + 16);
    }
    p
}

#[no_mangle]
pub unsafe extern "C" fn mapNumber(root: u32, key: u32, len: u32, hash: u32) -> f64 {
    let p = mapFind(root, key, len, hash);
    if p != 0 { load_f64(p + 16 + len) } else { f64::NAN }
}

#[no_mangle]
pub unsafe extern "C" fn orderCons(previous: u32, leaf: u32) -> u32 {
    let p = alloc(8);
    store_u32(p, previous);
    store_u32(p + 4, leaf);
    p
}

#[no_mangle]
pub unsafe extern "C" fn radixSize(root: u32) -> u32 {
    if root == 0 { 0 } else if tag(root) != 0 { load_u32(root + 8) } else { 1 }
}

#[inline(always)]
unsafe fn rdigit(key: u32, len: u32, position: u32) -> u32 {
    let i = position >> 1;
    let shift = if position & 1 != 0 { 0 } else { 4 };
    if i < len { ((load_u8(key + i) as u32 >> shift) & 15) + 1 } else { 0 }
}

#[inline(always)]
unsafe fn representative(root: u32) -> u32 { if tag(root) != 0 { load_u32(root + 12) } else { root } }

unsafe fn radix_branch(position: u32, bitmap: u32, size: u32, rep: u32) -> u32 {
    let p = alloc(16 + pc(bitmap) * 4);
    store_u32(p, position + 3);
    store_u32(p + 4, bitmap);
    store_u32(p + 8, size);
    store_u32(p + 12, rep);
    p
}

unsafe fn radix_candidate(mut root: u32, key: u32, len: u32) -> u32 {
    while root != 0 && tag(root) != 0 {
        let bitmap = load_u32(root + 4);
        let bit = 1 << rdigit(key, len, tag(root) - 3);
        if bitmap & bit == 0 { return load_u32(root + 12); }
        root = load_u32(root + 16 + pc(bitmap & (bit - 1)) * 4);
    }
    root
}

#[no_mangle]
pub unsafe extern "C" fn radixFind(mut root: u32, key: u32, len: u32) -> u32 {
    if root != 0 && tag(root) == JOURNAL {
        let p = journalFind(root, key, len, hash_at(key, len));
        if p != 0 { return p; }
        root = load_u32(root + 4);
    }
    let p = radix_candidate(root, key, len);
    if p != 0 && load_u32(p + 8) == len && memory_compare(p + 16, key, len) == 0 { p } else { 0 }
}

unsafe fn radix_splice(root: u32, leaf: u32, critical: u32, mark: u32) -> u32 {
    if root == 0 { return leaf; }
    let kind = tag(root);
    if kind == 0 || kind - 3 > critical {
        if critical == UNKNOWN { return leaf; }
        let rep = representative(root);
        let a = rdigit(rep + 16, load_u32(rep + 8), critical);
        let b = rdigit(leaf + 16, load_u32(leaf + 8), critical);
        let p = radix_branch(critical, (1 << a) | (1 << b), radixSize(root) + 1, leaf);
        store_u32(p + 16, if a < b { root } else { leaf });
        store_u32(p + 20, if a < b { leaf } else { root });
        return p;
    }
    let position = kind - 3;
    let bitmap = load_u32(root + 4);
    let bit = 1 << rdigit(leaf + 16, load_u32(leaf + 8), position);
    let offset = pc(bitmap & (bit - 1));
    let count = pc(bitmap);
    let exists = (bitmap & bit != 0) as u32;
    let old = if exists != 0 { load_u32(root + 16 + offset * 4) } else { 0 };
    let old_size = radixSize(old);
    let child = radix_splice(old, leaf, critical, mark);
    if root >= mark && exists != 0 {
        store_u32(root + 8, radixSize(root) - old_size + radixSize(child));
        store_u32(root + 12, leaf);
        store_u32(root + 16 + offset * 4, child);
        return root;
    }
    if exists != 0 {
        let p = alloc(16 + count * 4);
        copy_words(p, root, 16 + count * 4);
        store_u32(p + 8, radixSize(root) - old_size + radixSize(child));
        store_u32(p + 12, leaf);
        store_u32(p + 16 + offset * 4, child);
        return p;
    }
    let p = radix_branch(position, bitmap | bit, radixSize(root) - old_size + radixSize(child), leaf);
    copy_words(p + 16, root + 16, offset * 4);
    store_u32(p + 16 + offset * 4, child);
    copy_words(p + 20 + offset * 4, root + 16 + (offset + exists) * 4, (count - offset - exists) * 4);
    p
}

unsafe fn radix_insert_owned(root: u32, leaf: u32, mark: u32) -> u32 {
    if root == 0 { return leaf; }
    let len = load_u32(leaf + 8);
    let old = radix_candidate(root, leaf + 16, len);
    let old_len = load_u32(old + 8);
    let limit = len.min(old_len);
    let mut i = 0;
    while i + 8 <= limit && load_u64(leaf + 16 + i) == load_u64(old + 16 + i) { i += 8; }
    while i < limit && load_u8(leaf + 16 + i) == load_u8(old + 16 + i) { i += 1; }
    if i == limit && len == old_len { return radix_splice(root, leaf, UNKNOWN, mark); }
    let critical = i * 2 + (i < limit && (load_u8(leaf + 16 + i) >> 4) == (load_u8(old + 16 + i) >> 4)) as u32;
    radix_splice(root, leaf, critical, mark)
}

#[no_mangle]
pub unsafe extern "C" fn radixInsert(root: u32, leaf: u32) -> u32 { journal_insert(root, leaf, 2, UNKNOWN) }

unsafe fn radix_remove(root: u32, key: u32, len: u32) -> u32 {
    let kind = tag(root);
    if kind == 0 {
        return if load_u32(root + 8) == len && memory_compare(root + 16, key, len) == 0 { 0 } else { root };
    }
    let bitmap = load_u32(root + 4);
    let bit = 1 << rdigit(key, len, kind - 3);
    if bitmap & bit == 0 { return root; }
    let offset = pc(bitmap & (bit - 1));
    let count = pc(bitmap);
    let old = load_u32(root + 16 + offset * 4);
    let child = radix_remove(old, key, len);
    if old == child { return root; }
    if child == 0 && count == 2 { return load_u32(root + 16 + (1 - offset) * 4); }
    let p = radix_branch(kind - 3, if child != 0 { bitmap } else { bitmap & !bit }, radixSize(root) - 1, 0);
    copy_words(p + 16, root + 16, offset * 4);
    if child != 0 { store_u32(p + 16 + offset * 4, child); }
    copy_words(p + 16 + (offset + (child != 0) as u32) * 4, root + 20 + offset * 4, (count - offset - 1) * 4);
    store_u32(p + 12, representative(load_u32(p + 16)));
    p
}

#[no_mangle]
pub unsafe extern "C" fn radixDelete(root: u32, key: u32, len: u32) -> u32 {
    let root = materialize_journal(root, 2);
    if root != 0 { radix_remove(root, key, len) } else { 0 }
}

#[inline(always)]
unsafe fn staged_write(root: u32, keyLen: u32, valueLen: u32, hash: u32, value: f64, mode: u32, kind: u32, order: u32, ordinal: u32) -> u32 {
    let previous = if kind == 1 { mapFind(root, WRITE_STAGE, keyLen, hash) } else { 0 };
    let prefix = if kind == 1 { 4 } else { 0 };
    let position = if previous != 0 { load_u32(previous + 16 + keyLen) } else { ordinal };
    let leaf = mapLeaf(keyLen, valueLen + prefix);
    store_u32(leaf + 4, hash);
    if mode == 2 && prefix == 0 { copy_bytes(leaf + 16, WRITE_STAGE, keyLen + valueLen); }
    else if mode == 0 && keyLen <= 8 { store_u64(leaf + 16, load_u64(WRITE_STAGE)); }
    else { copy_bytes(leaf + 16, WRITE_STAGE, keyLen); }
    let destination = leaf + 16 + keyLen;
    if prefix != 0 { store_u32(destination, position); }
    if mode == 0 { store_f64(destination + prefix, value); }
    // AssemblyScript truncates/saturates to u32, then stores the low byte.
    else if mode == 1 { store_u8(destination + prefix, (value as u32) as u8); }
    else if prefix != 0 { copy_bytes(destination + prefix, WRITE_STAGE + keyLen, valueLen); }
    let old_size = if kind == 2 { 0 }
        else if root == state_load_u32(WRITE_MAP_ROOT) { state_load_u32(WRITE_MAP_SIZE) }
        else { mapSize(root) };
    let next = if kind == 2 { radixInsert(root, leaf) }
        else if kind == 1 { map_insert_indexed(root, leaf, if previous != 0 { 0 } else { 1 }, old_size) }
        else { map_insert_indexed(root, leaf, UNKNOWN, old_size) };
    store_u32(0, leaf);
    store_u32(16, hash);
    store_u32(4, if kind == 1 && previous == 0 { orderCons(order, leaf) } else { order });
    let next_size = if kind == 2 { radixSize(next) } else { old_size + inserted() };
    if kind != 2 {
        state_store_u32(WRITE_MAP_ROOT, next);
        state_store_u32(WRITE_MAP_SIZE, next_size);
    }
    store_u32(8, next_size);
    store_u32(12, if kind == 1 && previous == 0 { ordinal + 1 } else { ordinal });
    next
}

#[no_mangle]
pub unsafe extern "C" fn stagedWrite(root: u32, keyLen: u32, valueLen: u32, hash: u32, value: f64, mode: u32, kind: u32, order: u32, ordinal: u32) -> u32 {
    staged_write(root, keyLen, valueLen, hash, value, mode, kind, order, ordinal)
}

#[no_mangle]
pub unsafe extern "C" fn journalFind(root: u32, key: u32, len: u32, hash: u32) -> u32 {
    let count = load_u32(root + 12);
    let mut i = 0;
    while i < count {
        let leaf = load_u32(root + 16 + i * 4);
        if load_u32(leaf + 4) == hash && load_u32(leaf + 8) == len
            && memory_compare(leaf + 16, key, len) == 0 { return leaf; }
        i += 1;
    }
    0
}

unsafe fn fold_journal(mut base: u32, input: u32, count: u32, kind: u32) -> u32 {
    if kind != 2 { return batch_at(base, input, count, 0, PUBLISHED); }
    let mark = heap_end();
    let mut i = 0;
    while i < count {
        base = radix_insert_owned(base, load_u32(input + i * 4), mark);
        i += 1;
    }
    base
}

unsafe fn materialize_journal(root: u32, kind: u32) -> u32 {
    if root == 0 || tag(root) != JOURNAL { return root; }
    let count = load_u32(root + 12);
    copy_words(1024, root + 16, count * 4);
    fold_journal(load_u32(root + 4), 1024, count, kind)
}

unsafe fn journal_insert(root: u32, leaf: u32, kind: u32, known: u32) -> u32 {
    if root == 0 { return leaf; }
    let pending = tag(root) == JOURNAL;
    let count = if pending { load_u32(root + 12) } else { 0 };
    let base = if pending { load_u32(root + 4) } else { root };
    let mut position = count;
    let mut i = 0;
    while i < count {
        if same_key(load_u32(root + 16 + i * 4), leaf) { position = i; break; }
        i += 1;
    }
    if count == JOURNAL_LIMIT && position == count {
        copy_words(1024, root + 16, count * 4);
        store_u32(1024 + count * 4, leaf);
        return fold_journal(base, 1024, count + 1, kind);
    }
    let exists = if known != UNKNOWN { known != 0 } else {
        position < count || (if kind == 2 { radixFind(base, leaf + 16, load_u32(leaf + 8)) }
            else { mapFind(base, leaf + 16, load_u32(leaf + 8), load_u32(leaf + 4)) }) != 0
    };
    let next_count = count + (position == count) as u32;
    let p = alloc(16 + next_count * 4);
    store_u32(p, JOURNAL);
    store_u32(p + 4, base);
    store_u32(p + 8, (if kind == 2 { radixSize(root) } else { mapSize(root) }) + (!exists) as u32);
    store_u32(p + 12, next_count);
    if count != 0 { copy_words(p + 16, root + 16, count * 4); }
    store_u32(p + 16 + position * 4, leaf);
    p
}

#[no_mangle]
pub unsafe extern "C" fn compareLeaves(a: u32, b: u32) -> i32 {
    let an = load_u32(a + 8);
    let bn = load_u32(b + 8);
    let cmp = memory_compare(a + 16, b + 16, an.min(bn));
    if cmp != 0 { cmp } else if an < bn { -1 } else if an > bn { 1 } else { 0 }
}

#[no_mangle]
pub unsafe extern "C" fn writeMapNumber(root: u32, len: u32) -> u32 {
    staged_write(root, len, 8, hash_at(WRITE_STAGE, len), load_f64(WRITE_STAGE - 8), 0, 0, 0, 0)
}

#[no_mangle]
pub unsafe extern "C" fn writeSortedNumber(root: u32, len: u32) -> u32 {
    staged_write(root, len, 8, hash_at(WRITE_STAGE, len), load_f64(WRITE_STAGE - 8), 0, 2, 0, 0)
}

#[no_mangle]
pub unsafe extern "C" fn writeOrderedNumber(root: u32, len: u32, head: u32, count: u32) -> u32 {
    staged_write(root, len, 8, hash_at(WRITE_STAGE, len), load_f64(WRITE_STAGE - 8), 0, 1, head, count)
}

#[inline(always)]
unsafe fn map_set_staged(root: u32, keyLen: u32, valueLen: u32, numeric: bool, size: u32) -> u32 {
    let leaf = mapLeaf(keyLen, valueLen);
    store_u32(leaf + 4, hash_at(WRITE_STAGE, keyLen));
    if numeric {
        copy_bytes(leaf + 16, WRITE_STAGE, keyLen);
        store_f64(leaf + 16 + keyLen, load_f64(WRITE_STAGE - 8));
    } else { copy_bytes(leaf + 16, WRITE_STAGE, keyLen + valueLen); }
    let next = map_insert_indexed(root, leaf, UNKNOWN, size);
    next | (inserted() << 31)
}

#[no_mangle]
pub unsafe extern "C" fn mapSetNumber(root: u32, keyLen: u32, size: u32) -> u32 {
    map_set_staged(root, keyLen, 8, true, size)
}

#[no_mangle]
pub unsafe extern "C" fn mapSetBytes(root: u32, keyLen: u32, valueLen: u32, size: u32) -> u32 {
    map_set_staged(root, keyLen, valueLen, false, size)
}

#[no_mangle]
pub unsafe extern "C" fn radixBuild(input: u32, count: u32) -> u32 {
    let mark = heap_end();
    let mut root = 0;
    let mut i = 0;
    while i < count {
        root = radix_insert_owned(root, load_u32(input + i * 4), mark);
        i += 1;
    }
    root
}

#[no_mangle]
pub unsafe extern "C" fn writeMapBytes(root: u32, keyLen: u32, valueLen: u32) -> u32 {
    staged_write(root, keyLen, valueLen, hash_at(WRITE_STAGE, keyLen), 0.0, 2, 0, 0, 0)
}

#[no_mangle]
pub unsafe extern "C" fn writeOrderedBytes(root: u32, keyLen: u32, valueLen: u32, head: u32, count: u32) -> u32 {
    staged_write(root, keyLen, valueLen, hash_at(WRITE_STAGE, keyLen), 0.0, 2, 1, head, count)
}

#[no_mangle]
pub unsafe extern "C" fn writeSortedBytes(root: u32, keyLen: u32, valueLen: u32) -> u32 {
    staged_write(root, keyLen, valueLen, hash_at(WRITE_STAGE, keyLen), 0.0, 2, 2, 0, 0)
}
