// Immutable node engines. Only fresh allocations and private build scratch are written.
// Bytes below HEAP_START are writer scratch, never part of a published snapshot.
const HEAP_START: u32 = 65536;
let heapEnd: u32 = HEAP_START;
let capacity: u32 = min(<u32>memory.size(), 32767) << 16;
export function getHeapEnd(): u32 { return heapEnd; }
export function setHeapEnd(end: u32): void {
  if (end < HEAP_START || end > 0x7fff0000 || <u64>end > (<u64>memory.size() << 16)) unreachable();
  heapEnd = end;
}
function growTo(end: u32): void {
  if (end > 0x7fff0000) unreachable();
  const pages = (end + 65535) >> 16, current = <u32>memory.size();
  if (pages > current && memory.grow(pages - current) < 0) unreachable();
  capacity = min(<u32>memory.size(), 32767) << 16;
}
export function alloc(bytes: u32): u32 {
  // Both operands are <= 0x7fff0000, so addition plus alignment cannot wrap.
  // Page queries and 64-bit limit checks stay off the common allocation path.
  if (bytes > 0x7fff0000) unreachable();
  const p = (heapEnd + 7) & ~7, end = (p + bytes + 7) & ~7;
  if (end > capacity) growTo(end);
  heapEnd = end; return p;
}

// Pointer-array copies are short, aligned, and non-overlapping. Word loads
// avoid the shared-memory bulk-copy runtime path for these small node arrays.
@inline function copyWords(to: u32, from: u32, bytes: u32): void {
  let i: u32 = 0;
  while (i + 8 <= bytes) { store<u64>(to + i, load<u64>(from + i)); i += 8; }
  if (i < bytes) store<u32>(to + i, load<u32>(from + i));
}

// Short unaligned UTF-8 records do not need the shared bulk-copy helper.
@inline function copyBytes(to: u32, from: u32, count: u32): void {
  if (count > 32) { memory.copy(to, from, count); return; }
  let i: u32 = 0;
  while (i + 8 <= count) { store<u64>(to + i, load<u64>(from + i)); i += 8; }
  if (i + 4 <= count) { store<u32>(to + i, load<u32>(from + i)); i += 4; }
  if (i + 2 <= count) { store<u16>(to + i, load<u16>(from + i)); i += 2; }
  if (i < count) store<u8>(to + i, load<u8>(from + i));
}

// HAMT: leaf [0,hash,keyLen,valLen,key...,value...];
// branch [(size << 2) | 1, bitmap, children...], with a compact 8-byte header;
// collision [2,hash,count,unused,leaves...]. Map records have 4-byte alignment.
@inline function tag(p: u32): u32 { return load<u32>(p); }
export function mapSize(p: u32): u32 {
  let delta: i32 = 0;
  while (p && tag(p) != 0xffffffff && (tag(p) & OVERLAY)) {
    delta += <i32>(tag(p) << 1) >> 26;
    p = overlayPrevious(p);
  }
  return (p ? (tag(p) == 0 ? 1 : (tag(p) & 3) == 1 ? tag(p) >> 2 : load<u32>(p + 8)) : 0) + delta;
}
@inline function pc(n: u32): u32 { return <u32>popcnt(n); }
function hashAt(p: u32, len: u32): u32 {
  let h: u32 = 2166136261;
  for (let i: u32 = 0; i < len; i++) h = (h ^ load<u8>(p + i)) * 16777619;
  return h;
}
export function mapLeaf(keyLen: u32, valLen: u32): u32 {
  if (keyLen > 0x7ffe0000 || valLen > 0x7ffe0000 - keyLen) unreachable();
  // Map records require only u32 alignment. Values already use unaligned loads.
  const p = heapEnd, end = (p + 16 + keyLen + valLen + 3) & ~3;
  if (end > capacity) growTo(end);
  heapEnd = end;
  store<u32>(p, 0); store<u32>(p + 8, keyLen); store<u32>(p + 12, valLen);
  return p;
}
// Overlapping first/last words cover short keys exactly, without reading past
// either key. Keep the bulk comparison for long keys and all collision cases.
@inline function equalKeyBytes(a: u32, b: u32, count: u32): bool {
  if (count > 16) return memory.compare(a, b, count) == 0;
  if (count >= 8) return load<u64>(a) == load<u64>(b) && load<u64>(a + count - 8) == load<u64>(b + count - 8);
  if (count >= 4) return load<u32>(a) == load<u32>(b) && load<u32>(a + count - 4) == load<u32>(b + count - 4);
  if (count >= 2) return load<u16>(a) == load<u16>(b) && load<u8>(a + count - 1) == load<u8>(b + count - 1);
  return !count || load<u8>(a) == load<u8>(b);
}
@inline function sameKey(a: u32, b: u32): bool {
  const n = load<u32>(a + 8);
  return load<u32>(a + 4) == load<u32>(b + 4) && n == load<u32>(b + 8) && equalKeyBytes(a + 16, b + 16, n);
}
function branch(bitmap: u32, size: u32): u32 {
  const p = heapEnd, end = p + 8 + pc(bitmap) * 4;
  if (end > capacity) growTo(end);
  heapEnd = end;
  store<u32>(p, (size << 2) | 1); store<u32>(p + 4, bitmap); return p;
}
function bucket(hash: u32, count: u32): u32 {
  const p = alloc(16 + count * 4);
  store<u32>(p, 2); store<u32>(p + 4, hash); store<u32>(p + 8, count); store<u32>(p + 12, 0);
  return p;
}

// Persistent 12-byte branch patch. No published bytes change.
// tag: [overlay:1, signed size delta:6, chain depth:4,
//       child distance:7, previous distance:14]. Distances count u32 words.
// Next: eight changed digits, newest in the low nibble. Last: [anchor:16,
// final bitmap:16]. A zero child distance denotes deletion. An offset that
// does not fit causes materialization, never truncation.
const OVERLAY: u32 = 0x80000000;
const OVERLAY_LIMIT: u32 = 8;
@inline function overlayPrevious(p: u32): u32 { return p - (tag(p) & 16383) * 4; }
@inline function overlayAnchor(p: u32): u32 { return p - (load<u32>(p + 8) & 65535) * 4; }
@inline function overlayChild(p: u32): u32 {
  const distance = (tag(p) >> 14) & 127; return distance ? p - distance * 4 : 0;
}
@inline function isBranch(p: u32): bool { return (tag(p) & 3) == 1 || (tag(p) & OVERLAY) != 0; }
@inline function branchBitmap(p: u32): u32 { return tag(p) & OVERLAY ? load<u32>(p + 8) >> 16 : load<u32>(p + 4); }
@inline function branchChild(p: u32, digit: u32): u32 {
  if (tag(p) & OVERLAY) {
    const t = tag(p), depth = (t >> 21) & 15;
    const x = load<u32>(p + 4) ^ (digit * 0x11111111);
    // The lowest zero nibble is the newest matching change. Borrow can mark
    // higher nibbles too, but cannot precede the first real zero nibble.
    const matches = (x - 0x11111111) & ~x & 0x88888888 & (0xffffffff >> ((8 - depth) * 4));
    if (matches) {
      let steps = <u32>ctz(matches) >> 2;
      while (steps) { p = overlayPrevious(p); steps--; }
      return overlayChild(p);
    }
    p = overlayAnchor(p);
  }
  const bitmap = load<u32>(p + 4), bit: u32 = 1 << digit;
  return bitmap & bit ? load<u32>(p + 8 + pc(bitmap & (bit - 1)) * 4) : 0;
}
// Flatten a short overlay chain once. Full branches use one contiguous copy.
// Scratch is private to this synchronous writer; no callback can observe it.
function fullBranch(root: u32, bitmap: u32, delta: i32, digit: u32, child: u32): u32 {
  let base = root, n: u32 = 0;
  // Resolve size and collect the edits in one pass over the immutable chain.
  while (tag(base) & OVERLAY) {
    delta += <i32>(tag(base) << 1) >> 26;
    store<u32>(4096 + n++ * 4, base); base = overlayPrevious(base);
  }
  const p = branch(bitmap, (tag(base) >> 2) + delta), original = load<u32>(base + 4);
  if (bitmap == 65535 && original == bitmap) {
    copyWords(p + 8, base + 8, 64);
    while (n) { const patch = load<u32>(4096 + --n * 4); store<u32>(p + 8 + (load<u32>(patch + 4) & 15) * 4, overlayChild(patch)); }
    store<u32>(p + 8 + digit * 4, child); return p;
  }
  // Expand only the valid lanes. An output bit can originate in the base, an
  // overlay, or this update; every lane read below has been initialized here.
  let bits = original, pos: u32 = 0;
  while (bits) { const d = <u32>ctz(bits); store<u32>(4224 + d * 4, load<u32>(base + 8 + pos++ * 4)); bits &= bits - 1; }
  while (n) { const patch = load<u32>(4096 + --n * 4); store<u32>(4224 + (load<u32>(patch + 4) & 15) * 4, overlayChild(patch)); }
  store<u32>(4224 + digit * 4, child); bits = bitmap; pos = 0;
  while (bits) { const d = <u32>ctz(bits); store<u32>(p + 8 + pos++ * 4, load<u32>(4224 + d * 4)); bits &= bits - 1; }
  return p;
}
// Try a compact immutable patch. Failure leaves the original branch unchanged.
@inline function tryOverlay(root: u32, bitmap: u32, delta: i32, digit: u32, child: u32): u32 {
  let depth = tag(root) & OVERLAY ? ((tag(root) >> 21) & 15) : 0;
  if ((tag(root) & OVERLAY) && (load<u32>(root + 4) & 15) == digit) {
    const combined = (<i32>(tag(root) << 1) >> 26) + delta;
    if (combined >= -32 && combined <= 31) { delta = combined; root = overlayPrevious(root); depth--; }
  }
  if (depth < OVERLAY_LIMIT) {
    const anchor = tag(root) & OVERLAY ? overlayAnchor(root) : root;
    const digits = ((tag(root) & OVERLAY ? load<u32>(root + 4) : 0) << 4) | digit;
    const p = heapEnd;
    if (p - anchor > 262140 || p - root > 65532 || (child != 0 && p - child > 508)) {
      return 0;
    }
    const end = p + 12;
    if (end > capacity) growTo(end);
    heapEnd = end;
    store<u32>(p, OVERLAY | ((<u32>delta & 63) << 25) | ((depth + 1) << 21) | (child ? ((p - child) >> 2) << 14 : 0) | ((p - root) >> 2));
    store<u32>(p + 4, digits);
    store<u32>(p + 8, ((p - anchor) >> 2) | (bitmap << 16));
    return p;
  }
  return 0;
}

function replaceChild(root: u32, bitmap: u32, delta: i32, digit: u32, child: u32, mark: u32 = 0x7fffffff): u32 {
  if (root >= mark) {
    if (!(tag(root) & OVERLAY) && load<u32>(root + 4) == bitmap) {
      store<u32>(root + 8 + pc(bitmap & ((1 << digit) - 1)) * 4, child);
      store<u32>(root, tag(root) + (delta << 2)); return root;
    }
  } else {
    const patch = tryOverlay(root, bitmap, delta, digit, child);
    if (patch) return patch;
  }
  return fullBranch(root, bitmap, delta, digit, child);
}
// A current writer directory already contains the fully resolved child lanes.
// Copy those lanes rather than walking eight old patch records a second time.
function replaceKnown(root: u32, bitmap: u32, delta: i32, digit: u32, child: u32, size: u32, lanes: u32): u32 {
  const patch = tryOverlay(root, bitmap, delta, digit, child);
  if (patch) return patch;
  const p = branch(bitmap, size);
  if (bitmap == 65535) copyWords(p + 8, lanes, 64);
  else {
    let bits = bitmap, position: u32 = 0;
    while (bits) { const d = <u32>ctz(bits); store<u32>(p + 8 + position++ * 4, load<u32>(lanes + d * 4)); bits &= bits - 1; }
  }
  return p;
}

function mergeHashed(a: u32, b: u32, shift: u32): u32 {
  const ai = (load<u32>(a + 4) >> shift) & 15;
  const bi = (load<u32>(b + 4) >> shift) & 15;
  const p = branch((1 << ai) | (1 << bi), mapSize(a) + mapSize(b));
  if (ai == bi) store<u32>(p + 8, mergeHashed(a, b, shift + 4));
  else {
    store<u32>(p + 8, ai < bi ? a : b);
    store<u32>(p + 12, ai < bi ? b : a);
  }
  return p;
}
// Private result of a synchronous insertion, not a field in a published node.
let insertedCount: u32 = 0;
function insertAt(root: u32, leaf: u32, shift: u32, delta: u32 = 0xffffffff, mark: u32 = 0x7fffffff): u32 {
  if (!root) { insertedCount = 1; return leaf; }
  const kind = tag(root);
  if (!isBranch(root)) {
    if (load<u32>(root + 4) != load<u32>(leaf + 4)) { insertedCount = 1; return mergeHashed(root, leaf, shift); }
    if (kind == 0) {
      if (delta == 0 || (delta == 0xffffffff && sameKey(root, leaf))) { insertedCount = 0; return leaf; }
      insertedCount = 1;
      const p = bucket(load<u32>(leaf + 4), 2);
      store<u32>(p + 16, root); store<u32>(p + 20, leaf);
      return p;
    }
    const count = mapSize(root);
    let position = count;
    if (delta != 1) for (let i: u32 = 0; i < count; i++) if (sameKey(load<u32>(root + 16 + i * 4), leaf)) { position = i; break; }
    insertedCount = position == count ? 1 : 0;
    const p = bucket(load<u32>(leaf + 4), count + insertedCount);
    copyWords(p + 16, root + 16, count * 4);
    store<u32>(p + 16 + position * 4, leaf);
    return p;
  }
  const digit = (load<u32>(leaf + 4) >> shift) & 15;
  const bitmap = branchBitmap(root), old = branchChild(root, digit);
  const child = insertAt(old, leaf, shift + 4, delta, mark);
  return replaceChild(root, bitmap | (1 << digit), <i32>insertedCount, digit, child, mark);
}
export function mapInsert(root: u32, leaf: u32): u32 { return insertAt(materializeJournal(root, 0), leaf, 0); }

// Private, bounded writer index for the first two hash digits. A published
// root never points here. Each cached lane is valid only for writerIndexRoot;
// advancing from that exact root preserves all untouched lanes. Forks and
// interleaved maps reset the validity masks before using this scratch.
const WRITE_FIRST: u32 = 12288; // 16 child pointers
const WRITE_SECOND: u32 = 12352; // 256 child pointers
const WRITE_VALID: u32 = 13376; // 16 second-level validity masks
const WRITE_SIZES: u32 = 13440; // 16 current subtree sizes
let writerIndexRoot: u32 = 0;
let writerFirstValid: u32 = 0;
function mapInsertIndexed(root: u32, leaf: u32, known: u32 = 0xffffffff, rootSize: u32 = 0xffffffff): u32 {
  if (!root || tag(root) == JOURNAL || !isBranch(root)) {
    writerIndexRoot = 0;
    return insertAt(materializeJournal(root, 0), leaf, 0, known);
  }
  if (writerIndexRoot != root) {
    writerIndexRoot = root; writerFirstValid = 0;
  }
  writerIndexRoot = 0; // Invalidate scratch if any later allocation throws.
  const hash = load<u32>(leaf + 4), first = hash & 15, bit = <u32>1 << first;
  const valid = writerFirstValid & bit;
  const old = valid ? load<u32>(WRITE_FIRST + first * 4) : branchChild(root, first);
  const oldSize = valid ? load<u32>(WRITE_SIZES + first * 4) : mapSize(old);
  let child: u32;
  if (old && isBranch(old)) {
    const digit = (hash >> 4) & 15, b = <u32>1 << digit;
    const pos = WRITE_SECOND + (first * 16 + digit) * 4;
    const mask = valid ? load<u32>(WRITE_VALID + first * 4) : 0;
    const previous = mask & b ? load<u32>(pos) : branchChild(old, digit);
    const next = insertAt(previous, leaf, 8, known);
    const bitmap = branchBitmap(old) | b, nextMask = mask | b;
    store<u32>(pos, next); store<u32>(WRITE_VALID + first * 4, nextMask);
    child = (nextMask & bitmap) == bitmap
      ? replaceKnown(old, bitmap, <i32>insertedCount, digit, next, oldSize + insertedCount, WRITE_SECOND + first * 64)
      : replaceChild(old, bitmap, <i32>insertedCount, digit, next);
  } else {
    child = insertAt(old, leaf, 4, known);
    store<u32>(WRITE_VALID + first * 4, 0);
  }
  store<u32>(WRITE_FIRST + first * 4, child); writerFirstValid |= bit;
  store<u32>(WRITE_SIZES + first * 4, oldSize + insertedCount);
  const bitmap = branchBitmap(root) | bit;
  const next = (writerFirstValid & bitmap) == bitmap && rootSize != 0xffffffff
    ? replaceKnown(root, bitmap, <i32>insertedCount, first, child, rootSize + insertedCount, WRITE_FIRST)
    : replaceChild(root, bitmap, <i32>insertedCount, first, child);
  writerIndexRoot = next; return next;
}

export function mapFind(root: u32, key: u32, len: u32, hash: u32): u32 {
  if (root && tag(root) == JOURNAL) {
    const p = journalFind(root, key, len, hash); if (p) return p;
    root = load<u32>(root + 4);
  }
  let shift: u32 = 0;
  while (root) {
    const kind = tag(root);
    if (kind == 0) return load<u32>(root + 4) == hash && load<u32>(root + 8) == len && memory.compare(root + 16, key, len) == 0 ? root : 0;
    if (kind == 2) {
      if (load<u32>(root + 4) != hash) return 0;
      const count = mapSize(root);
      for (let i: u32 = 0; i < count; i++) {
        const leaf = load<u32>(root + 16 + i * 4);
        if (load<u32>(leaf + 8) == len && memory.compare(leaf + 16, key, len) == 0) return leaf;
      }
      return 0;
    }
    const digit = (hash >> shift) & 15;
    root = branchChild(root, digit);
    shift += 4;
  }
  return 0;
}
function deleteAt(root: u32, key: u32, len: u32, hash: u32, shift: u32): u32 {
  if (!root) return 0;
  const kind = tag(root);
  if (kind == 0) return mapFind(root, key, len, hash) ? 0 : root;
  if (kind == 2) {
    const count = mapSize(root);
    let pos = count;
    for (let i: u32 = 0; i < count; i++) if (mapFind(load<u32>(root + 16 + i * 4), key, len, hash)) { pos = i; break; }
    if (pos == count) return root;
    if (count == 2) return load<u32>(root + 16 + (1 - pos) * 4);
    const p = bucket(hash, count - 1);
    copyWords(p + 16, root + 16, pos * 4);
    copyWords(p + 16 + pos * 4, root + 20 + pos * 4, (count - pos - 1) * 4);
    return p;
  }
  const bitmap = branchBitmap(root), digit = (hash >> shift) & 15, bit: u32 = 1 << digit;
  if (!(bitmap & bit)) return root;
  const old = branchChild(root, digit), child = deleteAt(old, key, len, hash, shift + 4);
  if (old == child) return root;
  const nextBitmap = child ? bitmap : bitmap & ~bit;
  if (!nextBitmap) return 0;
  if (pc(nextBitmap) == 1) {
    const remaining = child ? child : branchChild(root, <u32>ctz(nextBitmap));
    if (!isBranch(remaining)) return remaining;
  }
  return replaceChild(root, nextBitmap, -1, digit, child);
}
export function mapDelete(root: u32, key: u32, len: u32, hash: u32): u32 { return deleteAt(materializeJournal(root, 0), key, len, hash, 0); }

// The caller already resolved a complete key to an immutable leaf. Reuse that
// identity instead of checking its key again at the end of the copied path.
function deleteLeafAt(root: u32, leaf: u32, hash: u32, shift: u32): u32 {
  if (!root) return 0;
  if (tag(root) == 0) return root == leaf ? 0 : root;
  if (tag(root) == 2) {
    const count = load<u32>(root + 8); let pos = count;
    for (let i: u32 = 0; i < count; i++) if (load<u32>(root + 16 + i * 4) == leaf) { pos = i; break; }
    if (pos == count) return root;
    if (count == 2) return load<u32>(root + 16 + (1 - pos) * 4);
    const p = bucket(hash, count - 1);
    copyWords(p + 16, root + 16, pos * 4);
    copyWords(p + 16 + pos * 4, root + 20 + pos * 4, (count - pos - 1) * 4); return p;
  }
  const bitmap = branchBitmap(root), digit = (hash >> shift) & 15, bit: u32 = 1 << digit;
  if (!(bitmap & bit)) return root;
  const old = branchChild(root, digit), child = deleteLeafAt(old, leaf, hash, shift + 4);
  if (old == child) return root;
  const nextBitmap = child ? bitmap : bitmap & ~bit;
  if (!nextBitmap) return 0;
  if (pc(nextBitmap) == 1) {
    const remaining = child ? child : branchChild(root, <u32>ctz(nextBitmap));
    if (!isBranch(remaining)) return remaining;
  }
  return replaceChild(root, nextBitmap, -1, digit, child);
}
// Keys are staged in writer-only scratch. This removes the preliminary lookup
// and leaves both cache state and published bytes unchanged on a missing key.
export function mapDeleteBytes(root: u32, length: u32): u32 {
  const hash = hashAt(16384, length);
  if (root && tag(root) == JOURNAL && !mapFind(root, 16384, length, hash)) return root;
  return deleteAt(materializeJournal(root, 0), 16384, length, hash, 0);
}
export function mapDeleteLeaf(root: u32, leaf: u32): u32 {
  return leaf ? deleteLeafAt(materializeJournal(root, 0), leaf, load<u32>(leaf + 4), 0) : root;
}


// Prefix-fused batch update. Partition the private input array by the next
// 4-bit digit with an in-place American-flag pass, then merge directly into the
// old trie. There is no JS sort, intermediate patch trie, or mutable owner epoch.
@inline function childAt(root: u32, digit: u32, shift: u32): u32 {
  if (!root) return 0;
  if (!isBranch(root)) return ((load<u32>(root + 4) >> shift) & 15) == digit ? root : 0;
  return branchChild(root, digit);
}
@inline export function mapChild(root: u32, digit: u32): u32 { return branchChild(root, digit); }

// Private result of a synchronous recursive batch. Every path assigns it.
let batchChange: u32 = 0;
function batchAt(old: u32, input: u32, count: u32, shift: u32, mark: u32 = 0x7fffffff): u32 {
  if (!count) { batchChange = 0; return old; }
  if (count <= 4) {
    let added: u32 = 0;
    for (let i: u32 = 0; i < count; i++) { old = insertAt(old, load<u32>(input + i * 4), shift, 0xffffffff, mark); added += insertedCount; }
    batchChange = added; return old;
  }
  if (shift >= 32) {
    if (!old) {
      const p = bucket(load<u32>(load<u32>(input) + 4), count);
      copyWords(p + 16, input, count * 4); batchChange = count; return p;
    }
    // Exact full-hash collisions require full-key comparisons. Correctness does
    // not depend on hash uniqueness; this rare path can be quadratic in count.
    let added: u32 = 0;
    for (let i: u32 = 0; i < count; i++) { old = insertAt(old, load<u32>(input + i * 4), shift, 0xffffffff, mark); added += insertedCount; }
    batchChange = added; return old;
  }
  // Per-depth counts and cursors. Only this synchronous writer uses the scratch.
  const frame: u32 = 8192 + (shift / 4) * 256;
  memory.fill(frame, 0, 256);
  for (let i: u32 = 0; i < count; i++) {
    const digit = (load<u32>(load<u32>(input + i * 4) + 4) >> shift) & 15;
    store<u32>(frame + digit * 4, load<u32>(frame + digit * 4) + 1);
  }
  let offset: u32 = 0;
  for (let digit: u32 = 0; digit < 16; digit++) {
    store<u32>(frame + 128 + digit * 4, offset);
    offset += load<u32>(frame + digit * 4);
  }
  let start: u32 = 0;
  for (let digit: u32 = 0; digit < 16; digit++) {
    const end = start + load<u32>(frame + digit * 4), cursor = frame + 128 + digit * 4;
    while (load<u32>(cursor) < end) {
      const pos = load<u32>(cursor), leaf = load<u32>(input + pos * 4);
      const target = (load<u32>(leaf + 4) >> shift) & 15;
      if (target == digit) store<u32>(cursor, pos + 1);
      else {
        const targetCursor = frame + 128 + target * 4, dest = load<u32>(targetCursor);
        store<u32>(input + pos * 4, load<u32>(input + dest * 4));
        store<u32>(input + dest * 4, leaf); store<u32>(targetCursor, dest + 1);
      }
    }
    start = end;
  }
  let bitmap: u32 = 0, children: u32 = 0, added: u32 = 0;
  const size = mapSize(old);
  start = 0;
  for (let digit: u32 = 0; digit < 16; digit++) {
    const n = load<u32>(frame + digit * 4);
    const child = batchAt(childAt(old, digit, shift), input + start * 4, n, shift + 4, mark);
    added += batchChange;
    if (child) {
      bitmap |= 1 << digit;
      store<u32>(frame + 128 + children++ * 4, child);
    }
    start += n;
  }
  const p = branch(bitmap, size + added);
  copyWords(p + 8, frame + 128, children * 4); batchChange = added; return p;
}
export function mapBatch(old: u32, input: u32, count: u32): u32 {
  old = materializeJournal(old, 0);
  return batchAt(old, input, count, 0, heapEnd);
}

// Legacy read-only WASM ABI for existing direct-reader examples. Do not use the
// scratch-writing getInfo API concurrently on one memory; the TS reader is scratch-free.
export function keyBuf(): u32 { return 0; }
export function batchBuf(): u32 { return 1024; }
export function getInfo(root: u32, len: u32): u32 {
  const p = mapFind(root, 0, len, hashAt(0, len));
  if (p) { store<u32>(1024, load<u32>(p + 8)); store<u32>(1028, load<u32>(p + 12)); store<u32>(1032, p + 16); }
  return p;
}

// Dense persistent vector: 32 f64 values per leaf, 32 u32 pointers per branch.
export function vecLeaf(root: u32, depth: u32, index: u32): u32 {
  for (let level = depth; level > 0; level--) root = load<u32>(root + ((index >> (level * 5)) & 31) * 4);
  return root;
}
export function vecGet(root: u32, depth: u32, index: u32): f64 { return load<f64>(vecLeaf(root, depth, index) + (index & 31) * 8); }
function vecSetAt(root: u32, depth: u32, index: u32, value: f64): u32 {
  const bytes: u32 = depth ? 128 : 256;
  const p = alloc(bytes);
  if (root) memory.copy(p, root, bytes); else memory.fill(p, 0, bytes);
  if (!depth) store<f64>(p + (index & 31) * 8, value);
  else {
    const off = ((index >> (depth * 5)) & 31) * 4;
    store<u32>(p + off, vecSetAt(root ? load<u32>(root + off) : 0, depth - 1, index, value));
  }
  return p;
}
export function vecSet(root: u32, depth: u32, index: u32, value: f64): u32 { return vecSetAt(root, depth, index, value); }
// Shared accessors for the immutable block sequence tree.
@inline function sl(p: u32): u32 { return p ? load<u32>(p) : 0; }
@inline function sr(p: u32): u32 { return p ? load<u32>(p + 4) : 0; }
function seqSize(p: u32): u32 { return p ? load<u32>(p + 8) : 0; }
@inline function sh(p: u32): u32 { return p ? load<u32>(p + 12) : 0; }

// Immutable cons stack [next:u32,pad:u32,value:f64].
export function cons(next: u32, value: f64): u32 {
  const p = alloc(16); store<u32>(p, next); store<u32>(p + 4, 0); store<f64>(p + 8, value); return p;
}

// Persistent leftist heap. Numeric values are inline, never boxed in blob allocations.
// [priority:f64,value:f64,left:u32,right:u32,rank:u32,size:u32].
@inline function hr(p: u32): u32 { return p ? load<u32>(p + 24) : 0; }
@inline function hs(p: u32): u32 { return p ? load<u32>(p + 28) : 0; }
function hn(priority: f64, value: f64, left: u32, right: u32): u32 {
  if (hr(left) < hr(right)) { const t = left; left = right; right = t; }
  const p = alloc(32); store<f64>(p, priority); store<f64>(p + 8, value);
  store<u32>(p + 16, left); store<u32>(p + 20, right); store<u32>(p + 24, hr(right) + 1); store<u32>(p + 28, hs(left) + hs(right) + 1); return p;
}
function heapMerge(a: u32, b: u32, isMax: bool): u32 {
  if (!a) return b; if (!b) return a;
  const ap = load<f64>(a), bp = load<f64>(b);
  if (isMax ? bp > ap : bp < ap) { const t = a; a = b; b = t; }
  return hn(load<f64>(a), load<f64>(a + 8), load<u32>(a + 16), heapMerge(load<u32>(a + 20), b, isMax));
}
export function heapInsert(root: u32, priority: f64, value: f64, isMax: bool): u32 {
  return heapMerge(root, hn(priority, value, 0, 0), isMax);
}
export function heapPop(root: u32, isMax: bool): u32 { return root ? heapMerge(load<u32>(root + 16), load<u32>(root + 20), isMax) : 0; }


// Extend a tail only at the allocation frontier. Bytes below heapEnd are never
// rewritten. A fork or an intervening allocation copies the visible prefix.
export function tailAppend(tail: u32, length: u32, value: f64): u32 {
  if (length && tail + length * 8 == heapEnd) {
    const p = alloc(8); store<f64>(p, value); return tail;
  }
  const p = alloc((length + 1) * 8);
  if (length) memory.copy(p, tail, length * 8);
  store<f64>(p + length * 8, value); return p;
}
export function tailSet(tail: u32, length: u32, index: u32, value: f64): u32 {
  const p = alloc(length * 8); memory.copy(p, tail, length * 8);
  store<f64>(p + index * 8, value); return p;
}
export function tailInsert(tail: u32, length: u32, index: u32, value: f64): u32 {
  if (index == length) return tailAppend(tail, length, value);
  const p = alloc((length + 1) * 8);
  memory.copy(p, tail, index * 8); store<f64>(p + index * 8, value);
  memory.copy(p + (index + 1) * 8, tail + index * 8, (length - index) * 8); return p;
}
export function tailRemove(tail: u32, length: u32, index: u32): u32 {
  if (length == 1) return 0;
  if (!index) return tail + 8;
  if (index == length - 1) return tail;
  const p = alloc((length - 1) * 8);
  memory.copy(p, tail, index * 8);
  memory.copy(p + index * 8, tail + (index + 1) * 8, (length - index - 1) * 8); return p;
}

// Attach complete immutable blocks. Input bytes become the actual leaves, not
// temporary staging that is copied into a second set of leaves.
function linkRange(root: u32, depth: u32, base: u32, start: u32, end: u32, input: u32, origin: u32): u32 {
  if (!depth) return input + (base - origin) * 8;
  const p = alloc(128);
  if (root) memory.copy(p, root, 128); else memory.fill(p, 0, 128);
  const span: u32 = 1 << (depth * 5);
  const first = (start - base) / span, last = (end - 1 - base) / span;
  for (let i = first; i <= last; i++) {
    const b = base + i * span;
    const lo = start > b ? start : b, hi = end < b + span ? end : b + span;
    store<u32>(p + i * 4, linkRange(root ? load<u32>(root + i * 4) : 0, depth - 1, b, lo, hi, input, origin));
  }
  return p;
}
export function vecLink(root: u32, depth: u32, newDepth: u32, start: u32, input: u32, count: u32): u32 {
  if (!count) return root;
  if (root) while (depth < newDepth) {
    const p = alloc(128); memory.fill(p, 0, 128); store<u32>(p, root); root = p; depth++;
  }
  return linkRange(root, newDepth, 0, start, start + count, input, start);
}

// Block AVL sequence: [left,right,itemCount,height,dataPointer,dataLength].
// Blocks contain 1..32 f64 values. Boundary deletion shares a shorter byte span.
@inline function bd(p: u32): u32 { return load<u32>(p + 16); }
@inline function bn(p: u32): u32 { return load<u32>(p + 20); }
function bnode(left: u32, data: u32, length: u32, right: u32): u32 {
  const p = alloc(24); store<u32>(p, left); store<u32>(p + 4, right);
  store<u32>(p + 8, seqSize(left) + length + seqSize(right));
  store<u32>(p + 12, max(sh(left), sh(right)) + 1);
  store<u32>(p + 16, data); store<u32>(p + 20, length); return p;
}
function bbal(left: u32, data: u32, length: u32, right: u32): u32 {
  if (sh(left) > sh(right) + 1) {
    const ll = sl(left), lr = sr(left);
    if (sh(ll) >= sh(lr)) return bnode(ll, bd(left), bn(left), bnode(lr, data, length, right));
    return bnode(bnode(ll, bd(left), bn(left), sl(lr)), bd(lr), bn(lr), bnode(sr(lr), data, length, right));
  }
  if (sh(right) > sh(left) + 1) {
    const rl = sl(right), rr = sr(right);
    if (sh(rr) >= sh(rl)) return bnode(bnode(left, data, length, rl), bd(right), bn(right), rr);
    return bnode(bnode(left, data, length, sl(rl)), bd(rl), bn(rl), bnode(sr(rl), bd(right), bn(right), rr));
  }
  return bnode(left, data, length, right);
}
export function blockAppend(root: u32, data: u32, length: u32): u32 {
  return root ? bbal(sl(root), bd(root), bn(root), blockAppend(sr(root), data, length)) : bnode(0, data, length, 0);
}
function blockPrepend(root: u32, data: u32, length: u32): u32 {
  return root ? bbal(blockPrepend(sl(root), data, length), bd(root), bn(root), sr(root)) : bnode(0, data, length, 0);
}
export function blockGet(root: u32, index: u32): f64 {
  while (root) {
    const before = seqSize(sl(root)), count = bn(root);
    if (index < before) root = sl(root);
    else if (index >= before + count) { index -= before + count; root = sr(root); }
    else return load<f64>(bd(root) + (index - before) * 8);
  }
  unreachable(); return 0;
}
export function blockInsert(root: u32, index: u32, value: f64): u32 {
  if (!root) return bnode(0, tailAppend(0, 0, value), 1, 0);
  const left = sl(root), right = sr(root), before = seqSize(left), length = bn(root), data = bd(root);
  if (index < before) return bbal(blockInsert(left, index, value), data, length, right);
  if (index > before + length) return bbal(left, data, length, blockInsert(right, index - before - length, value));
  const p = tailInsert(data, length, index - before, value);
  if (length < 32) return bnode(left, p, length + 1, right);
  return bbal(left, p, 16, blockPrepend(right, p + 128, 17));
}
function dropFirstBlock(root: u32): u32 {
  return sl(root) ? bbal(dropFirstBlock(sl(root)), bd(root), bn(root), sr(root)) : sr(root);
}
export function blockDelete(root: u32, index: u32): u32 {
  const left = sl(root), right = sr(root), before = seqSize(left), length = bn(root), data = bd(root);
  if (index < before) return bbal(blockDelete(left, index), data, length, right);
  if (index >= before + length) return bbal(left, data, length, blockDelete(right, index - before - length));
  if (length > 1) return bnode(left, tailRemove(data, length, index - before), length - 1, right);
  if (!left) return right;
  if (!right) return left;
  let first = right; while (sl(first)) first = sl(first);
  return bbal(left, bd(first), bn(first), dropFirstBlock(right));
}

export function mapNumber(root: u32, key: u32, len: u32, hash: u32): f64 {
  const p = mapFind(root, key, len, hash);
  return p ? load<f64>(p + 16 + len) : NaN;
}
// An ordered map needs order traversal, not indexed access. A persistent log
// records only new insertions. Overwrites and deletes only replace the HAMT.
export function orderCons(previous: u32, leaf: u32): u32 {
  const p = alloc(8); store<u32>(p, previous); store<u32>(p + 4, leaf); return p;
}

// Compressed nibble radix index. Digits 1..16 encode nibbles; zero is the
// end marker. Branch: [position+3,bitmap,size,representativeLeaf,children...].
export function radixSize(root: u32): u32 { return root ? (tag(root) ? load<u32>(root + 8) : 1) : 0; }
@inline function rdigit(key: u32, len: u32, position: u32): u32 {
  const i = position >> 1;
  return i < len ? ((<u32>load<u8>(key + i) >> ((position & 1) ? 0 : 4)) & 15) + 1 : 0;
}
@inline function representative(root: u32): u32 { return tag(root) ? load<u32>(root + 12) : root; }
function radixBranch(position: u32, bitmap: u32, size: u32, rep: u32): u32 {
  const p = alloc(16 + pc(bitmap) * 4);
  store<u32>(p, position + 3); store<u32>(p + 4, bitmap); store<u32>(p + 8, size); store<u32>(p + 12, rep); return p;
}
function radixCandidate(root: u32, key: u32, len: u32): u32 {
  while (root && tag(root)) {
    const bitmap = load<u32>(root + 4), bit: u32 = 1 << rdigit(key, len, tag(root) - 3);
    if (!(bitmap & bit)) return load<u32>(root + 12);
    root = load<u32>(root + 16 + pc(bitmap & (bit - 1)) * 4);
  }
  return root;
}
export function radixFind(root: u32, key: u32, len: u32): u32 {
  if (root && tag(root) == JOURNAL) {
    const p = journalFind(root, key, len, hashAt(key, len)); if (p) return p;
    root = load<u32>(root + 4);
  }
  const p = radixCandidate(root, key, len);
  return p && load<u32>(p + 8) == len && memory.compare(p + 16, key, len) == 0 ? p : 0;
}
function radixSplice(root: u32, leaf: u32, critical: u32, mark: u32): u32 {
  if (!root) return leaf;
  const kind = tag(root);
  if (!kind || kind - 3 > critical) {
    if (critical == 0xffffffff) return leaf;
    const rep = representative(root), a = rdigit(rep + 16, load<u32>(rep + 8), critical), b = rdigit(leaf + 16, load<u32>(leaf + 8), critical);
    const p = radixBranch(critical, (1 << a) | (1 << b), radixSize(root) + 1, leaf);
    store<u32>(p + 16, a < b ? root : leaf); store<u32>(p + 20, a < b ? leaf : root); return p;
  }
  const position = kind - 3, bitmap = load<u32>(root + 4), bit: u32 = 1 << rdigit(leaf + 16, load<u32>(leaf + 8), position);
  const offset = pc(bitmap & (bit - 1)), count = pc(bitmap), exists: u32 = bitmap & bit ? 1 : 0;
  const old = exists ? load<u32>(root + 16 + offset * 4) : 0;
  const oldSize = radixSize(old), child = radixSplice(old, leaf, critical, mark);
  if (root >= mark && exists) {
    store<u32>(root + 8, radixSize(root) - oldSize + radixSize(child));
    store<u32>(root + 12, leaf); store<u32>(root + 16 + offset * 4, child); return root;
  }
  if (exists) {
    const p = alloc(16 + count * 4); copyWords(p, root, 16 + count * 4);
    store<u32>(p + 8, radixSize(root) - oldSize + radixSize(child));
    store<u32>(p + 12, leaf); store<u32>(p + 16 + offset * 4, child); return p;
  }
  const p = radixBranch(position, bitmap | bit, radixSize(root) - oldSize + radixSize(child), leaf);
  copyWords(p + 16, root + 16, offset * 4); store<u32>(p + 16 + offset * 4, child);
  copyWords(p + 20 + offset * 4, root + 16 + (offset + exists) * 4, (count - offset - exists) * 4); return p;
}
function radixInsertOwned(root: u32, leaf: u32, mark: u32): u32 {
  if (!root) return leaf;
  const len = load<u32>(leaf + 8), old = radixCandidate(root, leaf + 16, len), oldLen = load<u32>(old + 8);
  const limit = min(len, oldLen); let i: u32 = 0;
  while (i + 8 <= limit && load<u64>(leaf + 16 + i) == load<u64>(old + 16 + i)) i += 8;
  while (i < limit && load<u8>(leaf + 16 + i) == load<u8>(old + 16 + i)) i++;
  if (i == limit && len == oldLen) return radixSplice(root, leaf, 0xffffffff, mark);
  const critical = i * 2 + (i < limit && (load<u8>(leaf + 16 + i) >> 4) == (load<u8>(old + 16 + i) >> 4) ? 1 : 0);
  return radixSplice(root, leaf, critical, mark);
}
export function radixInsert(root: u32, leaf: u32): u32 { return journalInsert(root, leaf, 2); }
function radixRemove(root: u32, key: u32, len: u32): u32 {
  const kind = tag(root);
  if (!kind) return load<u32>(root + 8) == len && memory.compare(root + 16, key, len) == 0 ? 0 : root;
  const bitmap = load<u32>(root + 4), bit: u32 = 1 << rdigit(key, len, kind - 3);
  if (!(bitmap & bit)) return root;
  const offset = pc(bitmap & (bit - 1)), count = pc(bitmap), old = load<u32>(root + 16 + offset * 4), child = radixRemove(old, key, len);
  if (old == child) return root;
  if (!child && count == 2) return load<u32>(root + 16 + (1 - offset) * 4);
  const p = radixBranch(kind - 3, child ? bitmap : bitmap & ~bit, radixSize(root) - 1, 0);
  copyWords(p + 16, root + 16, offset * 4);
  if (child) store<u32>(p + 16 + offset * 4, child);
  copyWords(p + 16 + (offset + (child ? 1 : 0)) * 4, root + 20 + offset * 4, (count - offset - 1) * 4);
  store<u32>(p + 12, representative(load<u32>(p + 16))); return p;
}
export function radixDelete(root: u32, key: u32, len: u32): u32 { root = materializeJournal(root, 2); return root ? radixRemove(root, key, len) : 0; }

// Single synchronous writer call: allocate the leaf, update the selected index,
// and report new metadata. STAGE and result words are not snapshot payloads.
const WRITE_STAGE: u32 = 16384;
let writeMapRoot: u32 = 0;
let writeMapSize: u32 = 0;
@inline
export function stagedWrite(root: u32, keyLen: u32, valueLen: u32, hash: u32, value: f64, mode: u32, kind: u32, order: u32, ordinal: u32): u32 {
  const previous = kind == 1 ? mapFind(root, WRITE_STAGE, keyLen, hash) : 0;
  const prefix: u32 = kind == 1 ? 4 : 0;
  const position = previous ? load<u32>(previous + 16 + keyLen) : ordinal;
  const leaf = mapLeaf(keyLen, valueLen + prefix);
  store<u32>(leaf + 4, hash);
  if (mode == 2 && prefix == 0) copyBytes(leaf + 16, WRITE_STAGE, keyLen + valueLen);
  else if (mode == 0 && keyLen <= 8) store<u64>(leaf + 16, load<u64>(WRITE_STAGE));
  else copyBytes(leaf + 16, WRITE_STAGE, keyLen);
  const destination = leaf + 16 + keyLen;
  if (prefix) store<u32>(destination, position);
  if (mode == 0) store<f64>(destination + prefix, value);
  else if (mode == 1) store<u8>(destination + prefix, <u8>value);
  else if (prefix) copyBytes(destination + prefix, WRITE_STAGE + keyLen, valueLen);
  const oldSize = kind == 2 ? 0 : root == writeMapRoot ? writeMapSize : mapSize(root);
  const next = kind == 2 ? radixInsert(root, leaf) : kind == 1 ? mapInsertIndexed(root, leaf, previous ? 0 : 1, oldSize) : mapInsertIndexed(root, leaf, 0xffffffff, oldSize);
  store<u32>(0, leaf); store<u32>(16, hash);
  store<u32>(4, kind == 1 && !previous ? orderCons(order, leaf) : order);
  const nextSize = kind == 2 ? radixSize(next) : oldSize + insertedCount;
  if (kind != 2) { writeMapRoot = next; writeMapSize = nextSize; }
  store<u32>(8, nextSize);
  store<u32>(12, kind == 1 && !previous ? ordinal + 1 : ordinal);
  return next;
}

// Bounded immutable update journal. The fifth distinct pending key folds the
// journal into a canonical index. Each published journal owns its pointer array.
const JOURNAL: u32 = 0xffffffff;
const JOURNAL_LIMIT: u32 = 4;
export function journalFind(root: u32, key: u32, len: u32, hash: u32): u32 {
  const count = load<u32>(root + 12);
  for (let i: u32 = 0; i < count; i++) {
    const leaf = load<u32>(root + 16 + i * 4);
    if (load<u32>(leaf + 4) == hash && load<u32>(leaf + 8) == len && memory.compare(leaf + 16, key, len) == 0) return leaf;
  }
  return 0;
}
function foldJournal(base: u32, input: u32, count: u32, kind: u32): u32 {
  if (kind != 2) return batchAt(base, input, count, 0);
  const mark = heapEnd;
  // Address ownership is valid only inside this synchronous construction call.
  // Published nodes are below mark; only new branch nodes may be edited here.
  for (let i: u32 = 0; i < count; i++) base = radixInsertOwned(base, load<u32>(input + i * 4), mark);
  return base;
}
function materializeJournal(root: u32, kind: u32): u32 {
  if (!root || tag(root) != JOURNAL) return root;
  const count = load<u32>(root + 12);
  copyWords(1024, root + 16, count * 4);
  return foldJournal(load<u32>(root + 4), 1024, count, kind);
}
function journalInsert(root: u32, leaf: u32, kind: u32, known: u32 = 0xffffffff): u32 {
  if (!root) return leaf;
  const pending = tag(root) == JOURNAL, count = pending ? load<u32>(root + 12) : 0;
  const base = pending ? load<u32>(root + 4) : root;
  let position = count;
  for (let i: u32 = 0; i < count; i++) if (sameKey(load<u32>(root + 16 + i * 4), leaf)) { position = i; break; }
  if (count == JOURNAL_LIMIT && position == count) {
    copyWords(1024, root + 16, count * 4); store<u32>(1024 + count * 4, leaf);
    return foldJournal(base, 1024, count + 1, kind);
  }
  const exists = known != 0xffffffff ? known != 0 : position < count || (kind == 2 ? radixFind(base, leaf + 16, load<u32>(leaf + 8)) : mapFind(base, leaf + 16, load<u32>(leaf + 8), load<u32>(leaf + 4))) != 0;
  const nextCount = count + (position == count ? 1 : 0), p = alloc(16 + nextCount * 4);
  store<u32>(p, JOURNAL); store<u32>(p + 4, base);
  store<u32>(p + 8, (kind == 2 ? radixSize(root) : mapSize(root)) + (exists ? 0 : 1));
  store<u32>(p + 12, nextCount);
  if (count) copyWords(p + 16, root + 16, count * 4);
  store<u32>(p + 16 + position * 4, leaf); return p;
}
export function compareLeaves(a: u32, b: u32): i32 {
  const an = load<u32>(a + 8), bn = load<u32>(b + 8);
  const cmp = memory.compare(a + 16, b + 16, min(an, bn));
  return cmp ? cmp : an < bn ? -1 : an > bn ? 1 : 0;
}

// The numeric command ABI passes only i32 metadata across the JS/WASM boundary.
// Value bytes and key bytes are in writer scratch; hashing stays inside WASM.
export function writeMapNumber(root: u32, len: u32): u32 {
  return stagedWrite(root, len, 8, hashAt(WRITE_STAGE, len), load<f64>(WRITE_STAGE - 8), 0, 0, 0, 0);
}
export function writeSortedNumber(root: u32, len: u32): u32 {
  return stagedWrite(root, len, 8, hashAt(WRITE_STAGE, len), load<f64>(WRITE_STAGE - 8), 0, 2, 0, 0);
}
export function writeOrderedNumber(root: u32, len: u32, head: u32, count: u32): u32 {
  return stagedWrite(root, len, 8, hashAt(WRITE_STAGE, len), load<f64>(WRITE_STAGE - 8), 0, 1, head, count);
}

// Scalar Map writes need only a root and a one-bit size change. Root pointers
// are below 2 GiB, so bit 31 can return the size change without a result buffer.
// The old command ABI remains available for ordered maps and generic codecs.
@inline function mapSetStaged(root: u32, keyLen: u32, valueLen: u32, numeric: bool, size: u32): u32 {
  const leaf = mapLeaf(keyLen, valueLen);
  store<u32>(leaf + 4, hashAt(WRITE_STAGE, keyLen));
  if (numeric) {
    copyBytes(leaf + 16, WRITE_STAGE, keyLen);
    store<f64>(leaf + 16 + keyLen, load<f64>(WRITE_STAGE - 8));
  } else copyBytes(leaf + 16, WRITE_STAGE, keyLen + valueLen);
  const next = mapInsertIndexed(root, leaf, 0xffffffff, size);
  return next | (insertedCount << 31);
}
export function mapSetNumber(root: u32, keyLen: u32, size: u32): u32 { return mapSetStaged(root, keyLen, 8, true, size); }
export function mapSetBytes(root: u32, keyLen: u32, valueLen: u32, size: u32): u32 { return mapSetStaged(root, keyLen, valueLen, false, size); }

// Private bulk builders: only freshly allocated branches can be changed.
export function radixBuild(input: u32, count: u32): u32 {
  const mark = heapEnd; let root: u32 = 0;
  for (let i: u32 = 0; i < count; i++) root = radixInsertOwned(root, load<u32>(input + i * 4), mark);
  return root;
}
function blockBuildRange(input: u32, first: u32, end: u32): u32 {
  if (first == end) return 0;
  const mid = first + ((end - first) >> 1);
  return bnode(blockBuildRange(input, first, mid), input + mid * 256, 32, blockBuildRange(input, mid + 1, end));
}
export function blockBuild(input: u32, blocks: u32): u32 { return blockBuildRange(input, 0, blocks); }

// Strings/JSON are already in writer scratch. No floating-point argument crosses
// the boundary and short records stay on the inline byte-copy path.
export function writeMapBytes(root: u32, keyLen: u32, valueLen: u32): u32 {
  return stagedWrite(root, keyLen, valueLen, hashAt(WRITE_STAGE, keyLen), 0, 2, 0, 0, 0);
}
export function writeOrderedBytes(root: u32, keyLen: u32, valueLen: u32, head: u32, count: u32): u32 {
  return stagedWrite(root, keyLen, valueLen, hashAt(WRITE_STAGE, keyLen), 0, 2, 1, head, count);
}
export function writeSortedBytes(root: u32, keyLen: u32, valueLen: u32): u32 {
  return stagedWrite(root, keyLen, valueLen, hashAt(WRITE_STAGE, keyLen), 0, 2, 2, 0, 0);
}
