// Red-Black Tree WASM for sorted map/set
const KEY_BUF: u32 = 0;
const BLOB_BUF: u32 = 1024;
const HEAP_START: u32 = 65600;
let heapEnd: u32 = HEAP_START;
let freeList: u32 = 0;

// Node: [color:4][left:4][right:4][parent:4][keyPacked:4][valPacked:4] = 24 bytes
// keyPacked/valPacked: ptr | (len << 20) for blobs, raw f64 bits for numbers
const NODE_SIZE: u32 = 24;
const RED: u32 = 0;
const BLACK: u32 = 1;

export function keyBuf(): u32 { return KEY_BUF; }
export function blobBuf(): u32 { return BLOB_BUF; }
export function getHeapEnd(): u32 { return heapEnd; }
export function setHeapEnd(v: u32): void { heapEnd = v; }
export function getFreeList(): u32 { return freeList; }
export function setFreeList(v: u32): void { freeList = v; }
export function reset(): void { heapEnd = HEAP_START; freeList = 0; }

function alloc(size: u32): u32 {
  if (freeList && size <= NODE_SIZE) {
    const ptr = freeList;
    freeList = load<u32>(ptr);
    return ptr;
  }
  const ptr = heapEnd;
  heapEnd += size;
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  return ptr;
}

function freeNode(ptr: u32): void {
  store<u32>(ptr, freeList);
  freeList = ptr;
}

export function allocBlob(len: u32): u32 {
  const ptr = alloc(len);
  memory.copy(ptr, BLOB_BUF, len);
  return ptr;
}

export function allocKeyBlob(len: u32): u32 {
  const ptr = alloc(len);
  memory.copy(ptr, KEY_BUF, len);
  return ptr;
}

// Node accessors
function getColor(n: u32): u32 { return n ? load<u32>(n) : BLACK; }
function setColor(n: u32, c: u32): void { if (n) store<u32>(n, c); }
function getLeft(n: u32): u32 { return n ? load<u32>(n + 4) : 0; }
function setLeft(n: u32, l: u32): void { if (n) store<u32>(n + 4, l); }
function getRight(n: u32): u32 { return n ? load<u32>(n + 8) : 0; }
function setRight(n: u32, r: u32): void { if (n) store<u32>(n + 8, r); }
function getParent(n: u32): u32 { return n ? load<u32>(n + 12) : 0; }
function setParent(n: u32, p: u32): void { if (n) store<u32>(n + 12, p); }
export function getKeyPacked(n: u32): u32 { return n ? load<u32>(n + 16) : 0; }
export function getValPacked(n: u32): u32 { return n ? load<u32>(n + 20) : 0; }
function setKeyPacked(n: u32, k: u32): void { store<u32>(n + 16, k); }
function setValPacked(n: u32, v: u32): void { store<u32>(n + 20, v); }

// Create node
export function createNode(keyPacked: u32, valPacked: u32): u32 {
  const n = alloc(NODE_SIZE);
  store<u32>(n, RED);
  store<u32>(n + 4, 0);
  store<u32>(n + 8, 0);
  store<u32>(n + 12, 0);
  store<u32>(n + 16, keyPacked);
  store<u32>(n + 20, valPacked);
  return n;
}

// Compare keys in KEY_BUF (len1) with blob at ptr2 (len2)
// Returns: -1 if key1 < key2, 0 if equal, 1 if key1 > key2
export function compareKeyBlob(len1: u32, ptr2: u32, len2: u32): i32 {
  const minLen = len1 < len2 ? len1 : len2;
  const cmp = memory.compare(KEY_BUF, ptr2, minLen);
  if (cmp != 0) return cmp;
  if (len1 < len2) return -1;
  if (len1 > len2) return 1;
  return 0;
}

// Compare two f64 numbers
export function compareNum(a: f64, b: f64): i32 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Rotations
function rotateLeft(root: u32, n: u32): u32 {
  const r = getRight(n);
  setRight(n, getLeft(r));
  if (getLeft(r)) setParent(getLeft(r), n);
  setParent(r, getParent(n));
  if (!getParent(n)) root = r;
  else if (n == getLeft(getParent(n))) setLeft(getParent(n), r);
  else setRight(getParent(n), r);
  setLeft(r, n);
  setParent(n, r);
  return root;
}

function rotateRight(root: u32, n: u32): u32 {
  const l = getLeft(n);
  setLeft(n, getRight(l));
  if (getRight(l)) setParent(getRight(l), n);
  setParent(l, getParent(n));
  if (!getParent(n)) root = l;
  else if (n == getRight(getParent(n))) setRight(getParent(n), l);
  else setLeft(getParent(n), l);
  setRight(l, n);
  setParent(n, l);
  return root;
}

// Fix tree after insert
function fixInsert(root: u32, n: u32): u32 {
  while (n != root && getColor(getParent(n)) == RED) {
    const p = getParent(n);
    const g = getParent(p);
    if (p == getLeft(g)) {
      const u = getRight(g);
      if (getColor(u) == RED) {
        setColor(p, BLACK);
        setColor(u, BLACK);
        setColor(g, RED);
        n = g;
      } else {
        if (n == getRight(p)) { n = p; root = rotateLeft(root, n); }
        setColor(getParent(n), BLACK);
        setColor(getParent(getParent(n)), RED);
        root = rotateRight(root, getParent(getParent(n)));
      }
    } else {
      const u = getLeft(g);
      if (getColor(u) == RED) {
        setColor(p, BLACK);
        setColor(u, BLACK);
        setColor(g, RED);
        n = g;
      } else {
        if (n == getLeft(p)) { n = p; root = rotateRight(root, n); }
        setColor(getParent(n), BLACK);
        setColor(getParent(getParent(n)), RED);
        root = rotateLeft(root, getParent(getParent(n)));
      }
    }
  }
  setColor(root, BLACK);
  return root;
}

// Insert for blob keys - key in KEY_BUF, returns [newRoot, insertedNode, existingNode]
// If key exists, returns existing node (for update), else returns new node
export function insertBlob(root: u32, keyLen: u32, valPacked: u32): u32 {
  let parent: u32 = 0;
  let curr = root;
  let cmp: i32 = 0;
  
  while (curr) {
    parent = curr;
    const kp = getKeyPacked(curr);
    const ptr = kp & 0xFFFFF;
    const len = kp >>> 20;
    cmp = compareKeyBlob(keyLen, ptr, len);
    if (cmp == 0) {
      // Key exists - update value
      setValPacked(curr, valPacked);
      store<u32>(BLOB_BUF, root);
      store<u32>(BLOB_BUF + 4, curr);
      store<u32>(BLOB_BUF + 8, 1); // existed
      return root;
    }
    curr = cmp < 0 ? getLeft(curr) : getRight(curr);
  }
  
  // Allocate key blob
  const keyPtr = allocKeyBlob(keyLen);
  const keyPacked = keyPtr | (keyLen << 20);
  const n = createNode(keyPacked, valPacked);
  setParent(n, parent);
  
  if (!parent) {
    setColor(n, BLACK);
    store<u32>(BLOB_BUF, n);
    store<u32>(BLOB_BUF + 4, n);
    store<u32>(BLOB_BUF + 8, 0); // new
    return n;
  }
  
  if (cmp < 0) setLeft(parent, n);
  else setRight(parent, n);
  
  root = fixInsert(root, n);
  store<u32>(BLOB_BUF, root);
  store<u32>(BLOB_BUF + 4, n);
  store<u32>(BLOB_BUF + 8, 0); // new
  return root;
}

// Insert for numeric keys
export function insertNum(root: u32, key: f64, valPacked: u32): u32 {
  let parent: u32 = 0;
  let curr = root;
  let cmp: i32 = 0;
  
  while (curr) {
    parent = curr;
    const existingKey = reinterpret<f64>((<u64>load<u32>(curr + 16)) | ((<u64>load<u32>(curr + 20)) << 32));
    // For numeric, we store key as f64 in keyPacked+valPacked positions temporarily during search
    // Actually, let's use a different approach - store key bits in a scratch area
    cmp = compareNum(key, load<f64>(curr + 16));
    if (cmp == 0) {
      // Key exists - but for sorted map we need separate key/val storage
      // Let's redesign: for numbers, keyPacked stores the f64 key, valPacked stores value
      store<u32>(BLOB_BUF, root);
      store<u32>(BLOB_BUF + 4, curr);
      store<u32>(BLOB_BUF + 8, 1);
      return root;
    }
    curr = cmp < 0 ? getLeft(curr) : getRight(curr);
  }
  
  const n = alloc(32); // Larger node for f64 key + value
  store<u32>(n, RED);
  store<u32>(n + 4, 0);
  store<u32>(n + 8, 0);
  store<u32>(n + 12, 0);
  store<f64>(n + 16, key);
  store<u32>(n + 24, valPacked);
  setParent(n, parent);
  
  if (!parent) {
    setColor(n, BLACK);
    store<u32>(BLOB_BUF, n);
    store<u32>(BLOB_BUF + 4, n);
    store<u32>(BLOB_BUF + 8, 0);
    return n;
  }
  
  if (cmp < 0) setLeft(parent, n);
  else setRight(parent, n);
  
  root = fixInsert(root, n);
  store<u32>(BLOB_BUF, root);
  store<u32>(BLOB_BUF + 4, n);
  store<u32>(BLOB_BUF + 8, 0);
  return root;
}

// Find blob key - returns node or 0
export function findBlob(root: u32, keyLen: u32): u32 {
  let curr = root;
  while (curr) {
    const kp = getKeyPacked(curr);
    const ptr = kp & 0xFFFFF;
    const len = kp >>> 20;
    const cmp = compareKeyBlob(keyLen, ptr, len);
    if (cmp == 0) return curr;
    curr = cmp < 0 ? getLeft(curr) : getRight(curr);
  }
  return 0;
}

// Find numeric key
export function findNum(root: u32, key: f64): u32 {
  let curr = root;
  while (curr) {
    const nodeKey = load<f64>(curr + 16);
    if (key < nodeKey) curr = getLeft(curr);
    else if (key > nodeKey) curr = getRight(curr);
    else return curr;
  }
  return 0;
}

// Get minimum node in subtree
export function getMin(n: u32): u32 {
  if (!n) return 0;
  while (getLeft(n)) n = getLeft(n);
  return n;
}

// Get maximum node in subtree
export function getMax(n: u32): u32 {
  if (!n) return 0;
  while (getRight(n)) n = getRight(n);
  return n;
}

// Get successor (next node in order)
export function getNext(n: u32): u32 {
  if (!n) return 0;
  if (getRight(n)) return getMin(getRight(n));
  let p = getParent(n);
  while (p && n == getRight(p)) { n = p; p = getParent(p); }
  return p;
}

// Get predecessor
export function getPrev(n: u32): u32 {
  if (!n) return 0;
  if (getLeft(n)) return getMax(getLeft(n));
  let p = getParent(n);
  while (p && n == getLeft(p)) { n = p; p = getParent(p); }
  return p;
}

// Get numeric key from node (for numeric trees)
export function getNumKey(n: u32): f64 {
  return n ? load<f64>(n + 16) : 0;
}

// Get value packed from numeric node
export function getNumValPacked(n: u32): u32 {
  return n ? load<u32>(n + 24) : 0;
}

// Set value for numeric node
export function setNumValPacked(n: u32, v: u32): void {
  if (n) store<u32>(n + 24, v);
}

// Delete fixup
function fixDelete(root: u32, x: u32, xParent: u32): u32 {
  while (x != root && getColor(x) == BLACK) {
    if (x == getLeft(xParent)) {
      let w = getRight(xParent);
      if (getColor(w) == RED) {
        setColor(w, BLACK);
        setColor(xParent, RED);
        root = rotateLeft(root, xParent);
        w = getRight(xParent);
      }
      if (getColor(getLeft(w)) == BLACK && getColor(getRight(w)) == BLACK) {
        setColor(w, RED);
        x = xParent;
        xParent = getParent(x);
      } else {
        if (getColor(getRight(w)) == BLACK) {
          setColor(getLeft(w), BLACK);
          setColor(w, RED);
          root = rotateRight(root, w);
          w = getRight(xParent);
        }
        setColor(w, getColor(xParent));
        setColor(xParent, BLACK);
        setColor(getRight(w), BLACK);
        root = rotateLeft(root, xParent);
        x = root;
      }
    } else {
      let w = getLeft(xParent);
      if (getColor(w) == RED) {
        setColor(w, BLACK);
        setColor(xParent, RED);
        root = rotateRight(root, xParent);
        w = getLeft(xParent);
      }
      if (getColor(getRight(w)) == BLACK && getColor(getLeft(w)) == BLACK) {
        setColor(w, RED);
        x = xParent;
        xParent = getParent(x);
      } else {
        if (getColor(getLeft(w)) == BLACK) {
          setColor(getRight(w), BLACK);
          setColor(w, RED);
          root = rotateLeft(root, w);
          w = getLeft(xParent);
        }
        setColor(w, getColor(xParent));
        setColor(xParent, BLACK);
        setColor(getLeft(w), BLACK);
        root = rotateRight(root, xParent);
        x = root;
      }
    }
  }
  setColor(x, BLACK);
  return root;
}

// Transplant helper
function transplant(root: u32, u: u32, v: u32): u32 {
  if (!getParent(u)) root = v;
  else if (u == getLeft(getParent(u))) setLeft(getParent(u), v);
  else setRight(getParent(u), v);
  if (v) setParent(v, getParent(u));
  return root;
}

// Delete node from tree
export function deleteNode(root: u32, z: u32): u32 {
  if (!z) return root;
  
  let y = z;
  let yOrigColor = getColor(y);
  let x: u32 = 0;
  let xParent: u32 = 0;
  
  if (!getLeft(z)) {
    x = getRight(z);
    xParent = getParent(z);
    root = transplant(root, z, getRight(z));
  } else if (!getRight(z)) {
    x = getLeft(z);
    xParent = getParent(z);
    root = transplant(root, z, getLeft(z));
  } else {
    y = getMin(getRight(z));
    yOrigColor = getColor(y);
    x = getRight(y);
    if (getParent(y) == z) {
      xParent = y;
    } else {
      xParent = getParent(y);
      root = transplant(root, y, getRight(y));
      setRight(y, getRight(z));
      setParent(getRight(y), y);
    }
    root = transplant(root, z, y);
    setLeft(y, getLeft(z));
    setParent(getLeft(y), y);
    setColor(y, getColor(z));
  }
  
  freeNode(z);
  
  if (yOrigColor == BLACK && root) {
    root = fixDelete(root, x, xParent);
  }
  
  return root;
}

// Delete by blob key
export function deleteBlob(root: u32, keyLen: u32): u32 {
  const n = findBlob(root, keyLen);
  return n ? deleteNode(root, n) : root;
}

// Delete by numeric key
export function deleteNum(root: u32, key: f64): u32 {
  const n = findNum(root, key);
  return n ? deleteNode(root, n) : root;
}

// Count nodes in tree
export function countNodes(n: u32): u32 {
  if (!n) return 0;
  return 1 + countNodes(getLeft(n)) + countNodes(getRight(n));
}
