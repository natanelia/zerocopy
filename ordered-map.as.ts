// Ordered Map WASM - HAMT + DoublyLinkedList for insertion order
const KEY_BUF: u32 = 0;
const BLOB_BUF: u32 = 1024;
const HEAP_START: u32 = 65600;
let heapEnd: u32 = HEAP_START;
let freeList: u32 = 0;

const BITS: u32 = 5;
const MASK: u32 = 31;

export function keyBuf(): u32 { return KEY_BUF; }
export function blobBuf(): u32 { return BLOB_BUF; }
export function getHeapEnd(): u32 { return heapEnd; }
export function setHeapEnd(v: u32): void { heapEnd = v; }
export function getFreeList(): u32 { return freeList; }
export function setFreeList(v: u32): void { freeList = v; }
export function reset(): void { heapEnd = HEAP_START; freeList = 0; }

function alloc(size: u32): u32 {
  const ptr = heapEnd;
  heapEnd += (size + 7) & ~7;
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  return ptr;
}

export function allocBlob(len: u32): u32 {
  const ptr = alloc(len);
  memory.copy(ptr, BLOB_BUF, len);
  return ptr;
}

function pc(n: u32): u32 { return <u32>popcnt(n); }

function hash(len: u32): u32 {
  let h: u32 = 2166136261;
  for (let i: u32 = 0; i < len; i++) h = (h ^ load<u8>(KEY_BUF + i)) * 16777619;
  return h;
}

// Linked list node: [prev:4][next:4][keyHash:4][keyLen:2][valLen:2][key...][val...]
// HAMT leaf stores pointer to linked list node

// Create linked list node
function createListNode(keyHash: u32, keyLen: u32, valLen: u32): u32 {
  const ptr = alloc(16 + keyLen + valLen);
  store<u32>(ptr, 0);      // prev
  store<u32>(ptr + 4, 0);  // next
  store<u32>(ptr + 8, keyHash);
  store<u16>(ptr + 12, <u16>keyLen);
  store<u16>(ptr + 14, <u16>valLen);
  memory.copy(ptr + 16, KEY_BUF, keyLen);
  return ptr;
}

export function getListPrev(n: u32): u32 { return n ? load<u32>(n) : 0; }
export function getListNext(n: u32): u32 { return n ? load<u32>(n + 4) : 0; }
export function getListKeyLen(n: u32): u32 { return n ? <u32>load<u16>(n + 12) : 0; }
export function getListValLen(n: u32): u32 { return n ? <u32>load<u16>(n + 14) : 0; }
export function getListKeyPtr(n: u32): u32 { return n + 16; }
export function getListValPtr(n: u32): u32 { return n + 16 + <u32>load<u16>(n + 12); }

function setListPrev(n: u32, p: u32): void { if (n) store<u32>(n, p); }
function setListNext(n: u32, next: u32): void { if (n) store<u32>(n + 4, next); }

// Link node to end of list
function linkToTail(node: u32, tail: u32): void {
  if (tail) {
    store<u32>(tail + 4, node);
    store<u32>(node, tail);
  }
}

// Unlink node from list
function unlinkNode(node: u32, head: u32, tail: u32): void {
  const prev = load<u32>(node);
  const next = load<u32>(node + 4);
  if (prev) store<u32>(prev + 4, next);
  if (next) store<u32>(next, prev);
}

// HAMT node: [bitmap:4][children...]
// HAMT leaf: [0:4][listNodePtr:4]

function allocHamtNode(bm: u32, cnt: u32): u32 {
  const ptr = alloc(4 + (cnt << 2));
  store<u32>(ptr, bm);
  return ptr;
}

function allocHamtLeaf(listNode: u32): u32 {
  const ptr = alloc(8);
  store<u32>(ptr, 0);
  store<u32>(ptr + 4, listNode);
  return ptr;
}

function isLeaf(ptr: u32): bool { return load<u32>(ptr) == 0; }
function getLeafListNode(ptr: u32): u32 { return load<u32>(ptr + 4); }

function keycmp(ptr: u32, len: u32): bool {
  return memory.compare(KEY_BUF, ptr, len) == 0;
}

// Find in HAMT - returns list node ptr or 0
function findInternal(node: u32, keyHash: u32, keyLen: u32, shift: u32): u32 {
  if (!node) return 0;
  if (isLeaf(node)) {
    const ln = getLeafListNode(node);
    if (load<u32>(ln + 8) == keyHash && <u32>load<u16>(ln + 12) == keyLen) {
      if (keycmp(ln + 16, keyLen)) return ln;
    }
    return 0;
  }
  const bm = load<u32>(node);
  const bit: u32 = 1 << ((keyHash >> shift) & MASK);
  if (!(bm & bit)) return 0;
  const pos = pc(bm & (bit - 1));
  return findInternal(load<u32>(node + 4 + (pos << 2)), keyHash, keyLen, shift + BITS);
}

export function find(root: u32, keyLen: u32): u32 {
  return findInternal(root, hash(keyLen), keyLen, 0);
}

// Merge two leaves
function merge(l1: u32, h1: u32, l2: u32, h2: u32, shift: u32): u32 {
  if (shift >= 32) {
    // Collision - shouldn't happen with good hash
    const ptr = allocHamtNode(0, 2);
    store<u32>(ptr + 4, l1);
    store<u32>(ptr + 8, l2);
    return ptr;
  }
  const i1 = (h1 >> shift) & MASK;
  const i2 = (h2 >> shift) & MASK;
  if (i1 == i2) {
    const child = merge(l1, h1, l2, h2, shift + BITS);
    const ptr = allocHamtNode(1 << i1, 1);
    store<u32>(ptr + 4, child);
    return ptr;
  }
  const ptr = allocHamtNode((1 << i1) | (1 << i2), 2);
  if (i1 < i2) {
    store<u32>(ptr + 4, l1);
    store<u32>(ptr + 8, l2);
  } else {
    store<u32>(ptr + 4, l2);
    store<u32>(ptr + 8, l1);
  }
  return ptr;
}

// Insert into HAMT - returns new root
function insertInternal(node: u32, leaf: u32, keyHash: u32, shift: u32): u32 {
  if (!node) return leaf;
  
  if (isLeaf(node)) {
    const ln = getLeafListNode(node);
    const existingHash = load<u32>(ln + 8);
    const existingKeyLen = <u32>load<u16>(ln + 12);
    if (existingHash == keyHash && existingKeyLen == <u32>load<u16>(getLeafListNode(leaf) + 12)) {
      if (keycmp(ln + 16, existingKeyLen)) {
        return leaf; // Replace
      }
    }
    return merge(node, existingHash, leaf, keyHash, shift);
  }
  
  const bm = load<u32>(node);
  const bit: u32 = 1 << ((keyHash >> shift) & MASK);
  const pos = pc(bm & (bit - 1));
  const cnt = pc(bm);
  
  if (bm & bit) {
    const oldChild = load<u32>(node + 4 + (pos << 2));
    const newChild = insertInternal(oldChild, leaf, keyHash, shift + BITS);
    const ptr = allocHamtNode(bm, cnt);
    for (let j: u32 = 0; j < cnt; j++) {
      store<u32>(ptr + 4 + (j << 2), j == pos ? newChild : load<u32>(node + 4 + (j << 2)));
    }
    return ptr;
  }
  
  const ptr = allocHamtNode(bm | bit, cnt + 1);
  for (let j: u32 = 0; j < pos; j++) {
    store<u32>(ptr + 4 + (j << 2), load<u32>(node + 4 + (j << 2)));
  }
  store<u32>(ptr + 4 + (pos << 2), leaf);
  for (let j = pos; j < cnt; j++) {
    store<u32>(ptr + 4 + ((j + 1) << 2), load<u32>(node + 4 + (j << 2)));
  }
  return ptr;
}

// Set key-value, returns [newRoot, newHead, newTail, isNew]
// Value should be written to BLOB_BUF before calling
export function set(root: u32, head: u32, tail: u32, keyLen: u32, valLen: u32): u32 {
  const keyHash = hash(keyLen);
  const existing = findInternal(root, keyHash, keyLen, 0);
  
  if (existing) {
    // Update existing - create new list node with same position
    const newNode = createListNode(keyHash, keyLen, valLen);
    memory.copy(newNode + 16 + keyLen, BLOB_BUF, valLen);
    
    // Copy links
    const prev = load<u32>(existing);
    const next = load<u32>(existing + 4);
    store<u32>(newNode, prev);
    store<u32>(newNode + 4, next);
    if (prev) store<u32>(prev + 4, newNode);
    if (next) store<u32>(next, newNode);
    
    const newHead = existing == head ? newNode : head;
    const newTail = existing == tail ? newNode : tail;
    
    const leaf = allocHamtLeaf(newNode);
    const newRoot = insertInternal(root, leaf, keyHash, 0);
    
    store<u32>(BLOB_BUF + 60000, newRoot);
    store<u32>(BLOB_BUF + 60004, newHead);
    store<u32>(BLOB_BUF + 60008, newTail);
    store<u32>(BLOB_BUF + 60012, 0); // not new
    return newRoot;
  }
  
  // New entry - append to list
  const newNode = createListNode(keyHash, keyLen, valLen);
  memory.copy(newNode + 16 + keyLen, BLOB_BUF, valLen);
  linkToTail(newNode, tail);
  
  const newHead = head ? head : newNode;
  const newTail = newNode;
  
  const leaf = allocHamtLeaf(newNode);
  const newRoot = insertInternal(root, leaf, keyHash, 0);
  
  store<u32>(BLOB_BUF + 60000, newRoot);
  store<u32>(BLOB_BUF + 60004, newHead);
  store<u32>(BLOB_BUF + 60008, newTail);
  store<u32>(BLOB_BUF + 60012, 1); // is new
  return newRoot;
}

// Get result pointers
export function getResultRoot(): u32 { return load<u32>(BLOB_BUF + 60000); }
export function getResultHead(): u32 { return load<u32>(BLOB_BUF + 60004); }
export function getResultTail(): u32 { return load<u32>(BLOB_BUF + 60008); }
export function getResultIsNew(): u32 { return load<u32>(BLOB_BUF + 60012); }

// Delete from HAMT
function deleteInternal(node: u32, keyHash: u32, keyLen: u32, shift: u32): u32 {
  if (!node) return 0;
  
  if (isLeaf(node)) {
    const ln = getLeafListNode(node);
    if (load<u32>(ln + 8) == keyHash && <u32>load<u16>(ln + 12) == keyLen) {
      if (keycmp(ln + 16, keyLen)) return 0; // Found - remove
    }
    return node; // Not found
  }
  
  const bm = load<u32>(node);
  const bit: u32 = 1 << ((keyHash >> shift) & MASK);
  if (!(bm & bit)) return node;
  
  const pos = pc(bm & (bit - 1));
  const cnt = pc(bm);
  const oldChild = load<u32>(node + 4 + (pos << 2));
  const newChild = deleteInternal(oldChild, keyHash, keyLen, shift + BITS);
  
  if (newChild == oldChild) return node;
  
  if (!newChild) {
    if (cnt == 1) return 0;
    const ptr = allocHamtNode(bm & ~bit, cnt - 1);
    for (let j: u32 = 0; j < pos; j++) {
      store<u32>(ptr + 4 + (j << 2), load<u32>(node + 4 + (j << 2)));
    }
    for (let j = pos + 1; j < cnt; j++) {
      store<u32>(ptr + 4 + ((j - 1) << 2), load<u32>(node + 4 + (j << 2)));
    }
    return ptr;
  }
  
  const ptr = allocHamtNode(bm, cnt);
  for (let j: u32 = 0; j < cnt; j++) {
    store<u32>(ptr + 4 + (j << 2), j == pos ? newChild : load<u32>(node + 4 + (j << 2)));
  }
  return ptr;
}

// Delete key, returns new root (updates head/tail in result area)
export function del(root: u32, head: u32, tail: u32, keyLen: u32): u32 {
  const keyHash = hash(keyLen);
  const existing = findInternal(root, keyHash, keyLen, 0);
  
  if (!existing) {
    store<u32>(BLOB_BUF + 60000, root);
    store<u32>(BLOB_BUF + 60004, head);
    store<u32>(BLOB_BUF + 60008, tail);
    return root;
  }
  
  // Unlink from list
  const prev = load<u32>(existing);
  const next = load<u32>(existing + 4);
  if (prev) store<u32>(prev + 4, next);
  if (next) store<u32>(next, prev);
  
  const newHead = existing == head ? next : head;
  const newTail = existing == tail ? prev : tail;
  
  const newRoot = deleteInternal(root, keyHash, keyLen, 0);
  
  store<u32>(BLOB_BUF + 60000, newRoot);
  store<u32>(BLOB_BUF + 60004, newHead);
  store<u32>(BLOB_BUF + 60008, newTail);
  return newRoot;
}
