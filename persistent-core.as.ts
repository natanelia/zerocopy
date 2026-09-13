// Immutable node engines. Only fresh allocations and private build scratch are written.
// Bytes below HEAP_START are writer scratch, never part of a published snapshot.
const HEAP_START: u32 = 65536;
let heapEnd: u32 = HEAP_START;
export function getHeapEnd(): u32 { return heapEnd; }
export function setHeapEnd(end: u32): void { heapEnd = end; }
export function getUsedBytes(): u32 { return heapEnd - HEAP_START; }
export function alloc(bytes: u32): u32 {
  // Keep pointers below 2 GiB; reject overflow and failed growth, never wrap.
  if (bytes > 0x7fff0000 || heapEnd > 0x7fff0000 - bytes - 8) unreachable();
  const p = heapEnd;
  const end = (p + bytes + 7) & ~7;
  const available = <u64>memory.size() << 16;
  if (<u64>end > available && memory.grow(<i32>((<u64>end - available + 65535) >> 16)) < 0) unreachable();
  heapEnd = end;
  return p;
}

// HAMT: leaf [0,hash,keyLen,valLen,key...,value...];
// branch [1,bitmap,size,unused,children...]; collision [2,hash,count,unused,leaves...].
@inline function tag(p: u32): u32 { return load<u32>(p); }
export function mapSize(p: u32): u32 { return p ? (tag(p) == 0 ? 1 : load<u32>(p + 8)) : 0; }
@inline function pc(n: u32): u32 { return <u32>popcnt(n); }
export function hashAt(p: u32, len: u32): u32 {
  let h: u32 = 2166136261;
  for (let i: u32 = 0; i < len; i++) h = (h ^ load<u8>(p + i)) * 16777619;
  return h;
}
export function mapLeaf(keyLen: u32, valLen: u32): u32 {
  const p = alloc(16 + keyLen + valLen);
  store<u32>(p, 0); store<u32>(p + 8, keyLen); store<u32>(p + 12, valLen);
  return p;
}
export function sealLeaf(p: u32): void { store<u32>(p + 4, hashAt(p + 16, load<u32>(p + 8))); }
@inline function sameKey(a: u32, b: u32): bool {
  const n = load<u32>(a + 8);
  return load<u32>(a + 4) == load<u32>(b + 4) && n == load<u32>(b + 8) && memory.compare(a + 16, b + 16, n) == 0;
}
function branch(bitmap: u32, size: u32): u32 {
  const p = alloc(16 + pc(bitmap) * 4);
  store<u32>(p, 1); store<u32>(p + 4, bitmap); store<u32>(p + 8, size); store<u32>(p + 12, 0);
  return p;
}
function bucket(hash: u32, count: u32): u32 {
  const p = alloc(16 + count * 4);
  store<u32>(p, 2); store<u32>(p + 4, hash); store<u32>(p + 8, count); store<u32>(p + 12, 0);
  return p;
}
function mergeHashed(a: u32, b: u32, shift: u32): u32 {
  const ai = (load<u32>(a + 4) >> shift) & 31;
  const bi = (load<u32>(b + 4) >> shift) & 31;
  const p = branch((1 << ai) | (1 << bi), mapSize(a) + mapSize(b));
  if (ai == bi) store<u32>(p + 16, mergeHashed(a, b, shift + 5));
  else {
    store<u32>(p + 16, ai < bi ? a : b);
    store<u32>(p + 20, ai < bi ? b : a);
  }
  return p;
}
function insertAt(root: u32, leaf: u32, shift: u32): u32 {
  if (!root) return leaf;
  const kind = tag(root);
  if (kind != 1) {
    if (load<u32>(root + 4) != load<u32>(leaf + 4)) return mergeHashed(root, leaf, shift);
    if (kind == 0) {
      if (sameKey(root, leaf)) return leaf;
      const p = bucket(load<u32>(leaf + 4), 2);
      store<u32>(p + 16, root); store<u32>(p + 20, leaf);
      return p;
    }
    const count = mapSize(root);
    let position = count;
    for (let i: u32 = 0; i < count; i++) if (sameKey(load<u32>(root + 16 + i * 4), leaf)) { position = i; break; }
    const p = bucket(load<u32>(leaf + 4), count + (position == count ? 1 : 0));
    memory.copy(p + 16, root + 16, count * 4);
    store<u32>(p + 16 + position * 4, leaf);
    return p;
  }
  const bitmap = load<u32>(root + 4), count = pc(bitmap);
  const bit: u32 = 1 << ((load<u32>(leaf + 4) >> shift) & 31);
  const position = pc(bitmap & (bit - 1));
  const old = bitmap & bit ? load<u32>(root + 16 + position * 4) : 0;
  const child = insertAt(old, leaf, shift + 5);
  const p = branch(bitmap | bit, mapSize(root) - mapSize(old) + mapSize(child));
  memory.copy(p + 16, root + 16, position * 4);
  store<u32>(p + 16 + position * 4, child);
  const skip: u32 = bitmap & bit ? 1 : 0;
  memory.copy(p + 20 + position * 4, root + 16 + (position + skip) * 4, (count - position - skip) * 4);
  return p;
}
export function mapInsert(root: u32, leaf: u32): u32 { return insertAt(root, leaf, 0); }
export function mapFind(root: u32, key: u32, len: u32, hash: u32): u32 {
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
    const bitmap = load<u32>(root + 4), bit: u32 = 1 << ((hash >> shift) & 31);
    if (!(bitmap & bit)) return 0;
    root = load<u32>(root + 16 + pc(bitmap & (bit - 1)) * 4);
    shift += 5;
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
    memory.copy(p + 16, root + 16, pos * 4);
    memory.copy(p + 16 + pos * 4, root + 20 + pos * 4, (count - pos - 1) * 4);
    return p;
  }
  const bitmap = load<u32>(root + 4), bit: u32 = 1 << ((hash >> shift) & 31);
  if (!(bitmap & bit)) return root;
  const count = pc(bitmap), pos = pc(bitmap & (bit - 1));
  const old = load<u32>(root + 16 + pos * 4);
  const child = deleteAt(old, key, len, hash, shift + 5);
  if (old == child) return root;
  if (!child && count == 1) return 0;
  if (!child && count == 2) {
    const remaining = load<u32>(root + 16 + (1 - pos) * 4);
    if (tag(remaining) != 1) return remaining;
  }
  if (child && count == 1 && tag(child) != 1) return child;
  const p = branch(child ? bitmap : bitmap & ~bit, mapSize(root) - 1);
  memory.copy(p + 16, root + 16, pos * 4);
  if (child) store<u32>(p + 16 + pos * 4, child);
  memory.copy(p + 16 + (pos + (child ? 1 : 0)) * 4, root + 20 + pos * 4, (count - pos - 1) * 4);
  return p;
}
export function mapDelete(root: u32, key: u32, len: u32, hash: u32): u32 { return deleteAt(root, key, len, hash, 0); }

// Prefix-fused batch update. Partition the private input array by the next
// 5-bit digit with an in-place American-flag pass, then merge directly into the
// old trie. There is no JS sort, intermediate patch trie, or mutable owner epoch.
@inline function childAt(root: u32, digit: u32, shift: u32): u32 {
  if (!root) return 0;
  if (tag(root) != 1) return ((load<u32>(root + 4) >> shift) & 31) == digit ? root : 0;
  const bitmap = load<u32>(root + 4), bit: u32 = 1 << digit;
  return bitmap & bit ? load<u32>(root + 16 + pc(bitmap & (bit - 1)) * 4) : 0;
}
function batchAt(old: u32, input: u32, count: u32, shift: u32): u32 {
  if (!count) return old;
  if (count == 1) return insertAt(old, load<u32>(input), shift);
  if (shift >= 32) {
    if (!old) {
      const p = bucket(load<u32>(load<u32>(input) + 4), count);
      memory.copy(p + 16, input, count * 4); return p;
    }
    // Exact full-hash collisions require full-key comparisons. Correctness does
    // not depend on hash uniqueness; this rare path can be quadratic in count.
    for (let i: u32 = 0; i < count; i++) old = insertAt(old, load<u32>(input + i * 4), shift);
    return old;
  }
  // Per-depth counts and cursors. Only this synchronous writer uses the scratch.
  const frame: u32 = 8192 + (shift / 5) * 256;
  memory.fill(frame, 0, 256);
  for (let i: u32 = 0; i < count; i++) {
    const digit = (load<u32>(load<u32>(input + i * 4) + 4) >> shift) & 31;
    store<u32>(frame + digit * 4, load<u32>(frame + digit * 4) + 1);
  }
  let offset: u32 = 0;
  for (let digit: u32 = 0; digit < 32; digit++) {
    store<u32>(frame + 128 + digit * 4, offset);
    offset += load<u32>(frame + digit * 4);
  }
  let start: u32 = 0;
  for (let digit: u32 = 0; digit < 32; digit++) {
    const end = start + load<u32>(frame + digit * 4), cursor = frame + 128 + digit * 4;
    while (load<u32>(cursor) < end) {
      const pos = load<u32>(cursor), leaf = load<u32>(input + pos * 4);
      const target = (load<u32>(leaf + 4) >> shift) & 31;
      if (target == digit) store<u32>(cursor, pos + 1);
      else {
        const targetCursor = frame + 128 + target * 4, dest = load<u32>(targetCursor);
        store<u32>(input + pos * 4, load<u32>(input + dest * 4));
        store<u32>(input + dest * 4, leaf); store<u32>(targetCursor, dest + 1);
      }
    }
    start = end;
  }
  let bitmap: u32 = 0, children: u32 = 0, size: u32 = 0;
  start = 0;
  for (let digit: u32 = 0; digit < 32; digit++) {
    const n = load<u32>(frame + digit * 4);
    const child = batchAt(childAt(old, digit, shift), input + start * 4, n, shift + 5);
    if (child) {
      bitmap |= 1 << digit; size += mapSize(child);
      store<u32>(frame + 128 + children++ * 4, child);
    }
    start += n;
  }
  const p = branch(bitmap, size);
  memory.copy(p + 16, frame + 128, children * 4); return p;
}
export function mapBatch(old: u32, input: u32, count: u32): u32 { return batchAt(old, input, count, 0); }

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
function fillRange(root: u32, depth: u32, base: u32, start: u32, end: u32, input: u32, origin: u32): u32 {
  const bytes: u32 = depth ? 128 : 256;
  const p = alloc(bytes);
  if (root) memory.copy(p, root, bytes); else memory.fill(p, 0, bytes);
  if (!depth) memory.copy(p + (start - base) * 8, input + (start - origin) * 8, (end - start) * 8);
  else {
    const span: u32 = 1 << (depth * 5);
    const first = (start - base) / span, last = (end - 1 - base) / span;
    for (let i = first; i <= last; i++) {
      const b = base + i * span;
      const lo = start > b ? start : b, hi = end < b + span ? end : b + span;
      store<u32>(p + i * 4, fillRange(root ? load<u32>(root + i * 4) : 0, depth - 1, b, lo, hi, input, origin));
    }
  }
  return p;
}
export function vecAppend(root: u32, depth: u32, newDepth: u32, size: u32, input: u32, count: u32): u32 {
  if (!count) return root;
  if (root) while (depth < newDepth) {
    const p = alloc(128); memory.fill(p, 0, 128); store<u32>(p, root); root = p; depth++;
  }
  return fillRange(root, newDepth, 0, size, size + count, input, size);
}

// Indexed AVL sequence. No next/previous pointers are ever changed in old nodes.
// [left:u32,right:u32,size:u32,height:u32,value:f64] = 24 bytes.
@inline function sl(p: u32): u32 { return p ? load<u32>(p) : 0; }
@inline function sr(p: u32): u32 { return p ? load<u32>(p + 4) : 0; }
export function seqSize(p: u32): u32 { return p ? load<u32>(p + 8) : 0; }
@inline function sh(p: u32): u32 { return p ? load<u32>(p + 12) : 0; }
function sn(left: u32, value: f64, right: u32): u32 {
  const p = alloc(24); store<u32>(p, left); store<u32>(p + 4, right);
  store<u32>(p + 8, seqSize(left) + seqSize(right) + 1);
  store<u32>(p + 12, max(sh(left), sh(right)) + 1); store<f64>(p + 16, value); return p;
}
function sb(left: u32, value: f64, right: u32): u32 {
  if (sh(left) > sh(right) + 1) {
    const ll = sl(left), lr = sr(left), lv = load<f64>(left + 16);
    if (sh(ll) >= sh(lr)) return sn(ll, lv, sn(lr, value, right));
    return sn(sn(ll, lv, sl(lr)), load<f64>(lr + 16), sn(sr(lr), value, right));
  }
  if (sh(right) > sh(left) + 1) {
    const rl = sl(right), rr = sr(right), rv = load<f64>(right + 16);
    if (sh(rr) >= sh(rl)) return sn(sn(left, value, rl), rv, rr);
    return sn(sn(left, value, sl(rl)), load<f64>(rl + 16), sn(sr(rl), rv, rr));
  }
  return sn(left, value, right);
}
export function seqInsert(root: u32, index: u32, value: f64): u32 {
  if (!root) return sn(0, value, 0);
  const left = sl(root), right = sr(root), rank = seqSize(left), old = load<f64>(root + 16);
  return index <= rank ? sb(seqInsert(left, index, value), old, right) : sb(left, old, seqInsert(right, index - rank - 1, value));
}
export function seqNode(root: u32, index: u32): u32 {
  while (root) {
    const rank = seqSize(sl(root));
    if (rank == index) return root;
    if (index < rank) root = sl(root); else { index -= rank + 1; root = sr(root); }
  }
  return 0;
}
export function seqDelete(root: u32, index: u32): u32 {
  const left = sl(root), right = sr(root), rank = seqSize(left), value = load<f64>(root + 16);
  if (index < rank) return sb(seqDelete(left, index), value, right);
  if (index > rank) return sb(left, value, seqDelete(right, index - rank - 1));
  if (!left) return right;
  if (!right) return left;
  return sb(left, load<f64>(seqNode(right, 0) + 16), seqDelete(right, 0));
}
// Same AVL balancing machinery, but values are map-leaf pointers, ordered by key.
@inline function leafCompare(a: u32, b: u32): i32 {
  const an = load<u32>(a + 8), bn = load<u32>(b + 8);
  const c = memory.compare(a + 16, b + 16, min(an, bn));
  return c != 0 ? c : (an < bn ? -1 : an > bn ? 1 : 0);
}
export function treeInsert(root: u32, leaf: u32): u32 {
  if (!root) return sn(0, <f64>leaf, 0);
  const old = <u32>load<f64>(root + 16), c = leafCompare(leaf, old);
  if (!c) return sn(sl(root), <f64>leaf, sr(root));
  return c < 0 ? sb(treeInsert(sl(root), leaf), <f64>old, sr(root)) : sb(sl(root), <f64>old, treeInsert(sr(root), leaf));
}
export function treeDelete(root: u32, leaf: u32): u32 {
  if (!root) return 0;
  const old = <u32>load<f64>(root + 16), c = leafCompare(leaf, old);
  if (!c) return seqDelete(root, seqSize(sl(root)));
  if (c < 0) { const child = treeDelete(sl(root), leaf); return child == sl(root) ? root : sb(child, <f64>old, sr(root)); }
  const child = treeDelete(sr(root), leaf); return child == sr(root) ? root : sb(sl(root), <f64>old, child);
}

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
export function heapMerge(a: u32, b: u32, isMax: bool): u32 {
  if (!a) return b; if (!b) return a;
  const ap = load<f64>(a), bp = load<f64>(b);
  if (isMax ? bp > ap : bp < ap) { const t = a; a = b; b = t; }
  return hn(load<f64>(a), load<f64>(a + 8), load<u32>(a + 16), heapMerge(load<u32>(a + 20), b, isMax));
}
export function heapInsert(root: u32, priority: f64, value: f64, isMax: bool): u32 {
  return heapMerge(root, hn(priority, value, 0, 0), isMax);
}
export function heapPop(root: u32, isMax: bool): u32 { return root ? heapMerge(load<u32>(root + 16), load<u32>(root + 20), isMax) : 0; }

export function vecPush(root: u32, depth: u32, newDepth: u32, index: u32, value: f64): u32 {
  if (root) while (depth < newDepth) {
    const p = alloc(128); memory.fill(p, 0, 128); store<u32>(p, root); root = p; depth++;
  }
  return vecSetAt(root, newDepth, index, value);
}
