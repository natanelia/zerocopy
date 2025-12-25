// Doubly linked list WASM
const SCRATCH: u32 = 0;
const BLOB_BUF: u32 = 64;
const HEAP_START: u32 = 65600;
let heapEnd: u32 = HEAP_START;
let freeList: u32 = 0;

// Node: [prev:4][next:4][value:8] = 16 bytes (aligned to 16)
const NODE_SIZE: u32 = 16;

function allocNode(): u32 {
  if (freeList) { const ptr = freeList; freeList = load<u32>(ptr + 4); return ptr; }
  const ptr = heapEnd; heapEnd += NODE_SIZE;
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  return ptr;
}

function freeNode(ptr: u32): void { store<u32>(ptr + 4, freeList); freeList = ptr; }

// Create node
export function createNode(val: f64): u32 {
  const node = allocNode();
  store<u32>(node, 0); store<u32>(node + 4, 0);
  store<f64>(node + 8, val);
  return node;
}

export function createNodeBlob(blobPtr: u32): u32 {
  const node = allocNode();
  store<u32>(node, 0); store<u32>(node + 4, 0);
  store<u32>(node + 8, blobPtr);
  return node;
}

// Navigation
export function getPrev(node: u32): u32 { return node ? load<u32>(node) : 0; }
export function getNext(node: u32): u32 { return node ? load<u32>(node + 4) : 0; }
export function setPrev(node: u32, prev: u32): void { if (node) store<u32>(node, prev); }
export function setNext(node: u32, next: u32): void { if (node) store<u32>(node + 4, next); }

// Values
export function getValue(node: u32): f64 { return node ? load<f64>(node + 8) : 0; }
export function getValueBlob(node: u32): u32 { return node ? load<u32>(node + 8) : 0; }

// Prepend: add before head, return new head
export function prepend(head: u32, val: f64): u32 {
  const node = allocNode();
  store<u32>(node, 0); store<u32>(node + 4, head);
  store<f64>(node + 8, val);
  if (head) store<u32>(head, node);
  return node;
}

export function prependBlob(head: u32, blobPtr: u32): u32 {
  const node = allocNode();
  store<u32>(node, 0); store<u32>(node + 4, head);
  store<u32>(node + 8, blobPtr);
  if (head) store<u32>(head, node);
  return node;
}

// Append: add after tail, return new tail
export function append(tail: u32, val: f64): u32 {
  const node = allocNode();
  store<u32>(node, tail); store<u32>(node + 4, 0);
  store<f64>(node + 8, val);
  if (tail) store<u32>(tail + 4, node);
  return node;
}

export function appendBlob(tail: u32, blobPtr: u32): u32 {
  const node = allocNode();
  store<u32>(node, tail); store<u32>(node + 4, 0);
  store<u32>(node + 8, blobPtr);
  if (tail) store<u32>(tail + 4, node);
  return node;
}

// Insert after a node
export function insertAfter(node: u32, val: f64): u32 {
  if (!node) return 0;
  const newNode = allocNode();
  const next = load<u32>(node + 4);
  store<u32>(newNode, node); store<u32>(newNode + 4, next);
  store<f64>(newNode + 8, val);
  store<u32>(node + 4, newNode);
  if (next) store<u32>(next, newNode);
  return newNode;
}

export function insertAfterBlob(node: u32, blobPtr: u32): u32 {
  if (!node) return 0;
  const newNode = allocNode();
  const next = load<u32>(node + 4);
  store<u32>(newNode, node); store<u32>(newNode + 4, next);
  store<u32>(newNode + 8, blobPtr);
  store<u32>(node + 4, newNode);
  if (next) store<u32>(next, newNode);
  return newNode;
}

// Insert before a node
export function insertBefore(node: u32, val: f64): u32 {
  if (!node) return 0;
  const newNode = allocNode();
  const prev = load<u32>(node);
  store<u32>(newNode, prev); store<u32>(newNode + 4, node);
  store<f64>(newNode + 8, val);
  store<u32>(node, newNode);
  if (prev) store<u32>(prev + 4, newNode);
  return newNode;
}

export function insertBeforeBlob(node: u32, blobPtr: u32): u32 {
  if (!node) return 0;
  const newNode = allocNode();
  const prev = load<u32>(node);
  store<u32>(newNode, prev); store<u32>(newNode + 4, node);
  store<u32>(newNode + 8, blobPtr);
  store<u32>(node, newNode);
  if (prev) store<u32>(prev + 4, newNode);
  return newNode;
}

// Remove node, return [newPrev, newNext] packed as (prev << 16) | (next & 0xFFFF) - but we return next for simplicity
// Returns: next node (or 0), caller must handle head/tail updates
export function removeNode(node: u32): u32 {
  if (!node) return 0;
  const prev = load<u32>(node);
  const next = load<u32>(node + 4);
  if (prev) store<u32>(prev + 4, next);
  if (next) store<u32>(next, prev);
  freeNode(node);
  return next;
}

// Get prev of removed node (for head/tail tracking) - call before removeNode
export function getPrevOfNode(node: u32): u32 { return node ? load<u32>(node) : 0; }
export function getNextOfNode(node: u32): u32 { return node ? load<u32>(node + 4) : 0; }

// Get node at index from head
export function getAt(head: u32, index: u32): u32 {
  let curr = head;
  for (let i: u32 = 0; i < index && curr; i++) curr = load<u32>(curr + 4);
  return curr;
}

// Get node at index from tail (reverse)
export function getAtReverse(tail: u32, index: u32): u32 {
  let curr = tail;
  for (let i: u32 = 0; i < index && curr; i++) curr = load<u32>(curr);
  return curr;
}

// Count nodes
export function count(head: u32): u32 {
  let c: u32 = 0;
  let curr = head;
  while (curr) { c++; curr = load<u32>(curr + 4); }
  return c;
}

// Blob allocation
export function allocBlob(len: u32): u32 {
  const aligned = (len + 7) & ~7;
  const ptr = heapEnd; heapEnd += aligned;
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  memory.copy(ptr, BLOB_BUF, len);
  return ptr;
}

export function scratch(): u32 { return SCRATCH; }
export function blobBuf(): u32 { return BLOB_BUF; }
export function reset(): void { heapEnd = HEAP_START; freeList = 0; }
export function getHeapEnd(): u32 { return heapEnd; }
export function setHeapEnd(v: u32): void { heapEnd = v; }
export function getFreeList(): u32 { return freeList; }
export function setFreeList(v: u32): void { freeList = v; }
