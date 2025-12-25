// Singly linked list WASM with full operations
const SCRATCH: u32 = 0;
const BLOB_BUF: u32 = 64;
const HEAP_START: u32 = 65600;
let heapEnd: u32 = HEAP_START;
let freeList: u32 = 0;

// Node: [next:4][value:8] = 12 bytes (aligned to 16)
const NODE_SIZE: u32 = 16;

function allocNode(): u32 {
  if (freeList) { const ptr = freeList; freeList = load<u32>(ptr); return ptr; }
  const ptr = heapEnd; heapEnd += NODE_SIZE;
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  return ptr;
}

function freeNode(ptr: u32): void { store<u32>(ptr, freeList); freeList = ptr; }

// Create node with f64 value
export function createNode(val: f64): u32 {
  const node = allocNode();
  store<u32>(node, 0);
  store<f64>(node + 4, val);
  return node;
}

// Create node with blob (string/object)
export function createNodeBlob(blobPtr: u32): u32 {
  const node = allocNode();
  store<u32>(node, 0);
  store<u32>(node + 4, blobPtr);
  return node;
}

// Get/set next pointer
export function getNext(node: u32): u32 { return node ? load<u32>(node) : 0; }
export function setNext(node: u32, next: u32): void { if (node) store<u32>(node, next); }

// Get value
export function getValue(node: u32): f64 { return node ? load<f64>(node + 4) : 0; }
export function getValueBlob(node: u32): u32 { return node ? load<u32>(node + 4) : 0; }

// Prepend: add to head, return new head
export function prepend(head: u32, val: f64): u32 {
  const node = allocNode();
  store<u32>(node, head);
  store<f64>(node + 4, val);
  return node;
}

export function prependBlob(head: u32, blobPtr: u32): u32 {
  const node = allocNode();
  store<u32>(node, head);
  store<u32>(node + 4, blobPtr);
  return node;
}

// Append: add to tail, return new tail (caller must update tail pointer)
export function append(tail: u32, val: f64): u32 {
  const node = allocNode();
  store<u32>(node, 0);
  store<f64>(node + 4, val);
  if (tail) store<u32>(tail, node);
  return node;
}

export function appendBlob(tail: u32, blobPtr: u32): u32 {
  const node = allocNode();
  store<u32>(node, 0);
  store<u32>(node + 4, blobPtr);
  if (tail) store<u32>(tail, node);
  return node;
}

// Insert after a node
export function insertAfter(node: u32, val: f64): u32 {
  if (!node) return 0;
  const newNode = allocNode();
  store<u32>(newNode, load<u32>(node));
  store<f64>(newNode + 4, val);
  store<u32>(node, newNode);
  return newNode;
}

export function insertAfterBlob(node: u32, blobPtr: u32): u32 {
  if (!node) return 0;
  const newNode = allocNode();
  store<u32>(newNode, load<u32>(node));
  store<u32>(newNode + 4, blobPtr);
  store<u32>(node, newNode);
  return newNode;
}

// Remove after a node, return removed node's next
export function removeAfter(node: u32): u32 {
  if (!node) return 0;
  const toRemove = load<u32>(node);
  if (!toRemove) return 0;
  const next = load<u32>(toRemove);
  store<u32>(node, next);
  freeNode(toRemove);
  return next;
}

// Get node at index (0-based), returns 0 if out of bounds
export function getAt(head: u32, index: u32): u32 {
  let curr = head;
  for (let i: u32 = 0; i < index && curr; i++) curr = load<u32>(curr);
  return curr;
}

// Count nodes from head
export function count(head: u32): u32 {
  let c: u32 = 0;
  let curr = head;
  while (curr) { c++; curr = load<u32>(curr); }
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
