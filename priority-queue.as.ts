// Persistent Leftist Heap WASM for priority queue
// Leftist heap: tree-based, O(log n) merge/insert/extractMin with structural sharing
const BLOB_BUF: u32 = 0;
const HEAP_START: u32 = 65536;
let heapEnd: u32 = HEAP_START;
let freeList: u32 = 0;

// Node: [priority:f64][valuePacked:u32][rank:u32][left:u32][right:u32] = 24 bytes
const NODE_SIZE: u32 = 24;

export function blobBuf(): u32 { return BLOB_BUF; }
export function getHeapEnd(): u32 { return heapEnd; }
export function setHeapEnd(v: u32): void { heapEnd = v; }
export function getFreeList(): u32 { return freeList; }
export function setFreeList(v: u32): void { freeList = v; }
export function reset(): void { heapEnd = HEAP_START; freeList = 0; }

function alloc(): u32 {
  if (freeList) {
    const ptr = freeList;
    freeList = load<u32>(ptr + 16); // use right child slot for free list
    return ptr;
  }
  const ptr = heapEnd;
  heapEnd += NODE_SIZE;
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  return ptr;
}

export function allocBlob(len: u32): u32 {
  const ptr = heapEnd;
  heapEnd += (len + 7) & ~7; // align to 8
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  memory.copy(ptr, BLOB_BUF, len);
  return ptr;
}

// Node accessors
function getPriority(n: u32): f64 { return load<f64>(n); }
function getValue(n: u32): u32 { return load<u32>(n + 8); }
function getRank(n: u32): u32 { return n ? load<u32>(n + 12) : 0; }
function getLeft(n: u32): u32 { return n ? load<u32>(n + 16) : 0; }
function getRight(n: u32): u32 { return n ? load<u32>(n + 20) : 0; }

function createNode(priority: f64, value: u32, rank: u32, left: u32, right: u32): u32 {
  const n = alloc();
  store<f64>(n, priority);
  store<u32>(n + 8, value);
  store<u32>(n + 12, rank);
  store<u32>(n + 16, left);
  store<u32>(n + 20, right);
  return n;
}

// Merge two heaps - core operation, O(log n)
// isMaxHeap: 0 = min-heap, 1 = max-heap
export function merge(h1: u32, h2: u32, isMaxHeap: u32): u32 {
  if (!h1) return h2;
  if (!h2) return h1;
  
  // Ensure h1 has better priority (smaller for min-heap, larger for max-heap)
  const p1 = getPriority(h1);
  const p2 = getPriority(h2);
  const swap = isMaxHeap ? (p2 > p1) : (p2 < p1);
  if (swap) {
    const tmp = h1; h1 = h2; h2 = tmp;
  }
  
  // Merge h2 with right subtree of h1
  const newRight = merge(getRight(h1), h2, isMaxHeap);
  const left = getLeft(h1);
  
  // Maintain leftist property: rank(left) >= rank(right)
  const rankLeft = getRank(left);
  const rankRight = getRank(newRight);
  
  if (rankLeft >= rankRight) {
    return createNode(getPriority(h1), getValue(h1), rankRight + 1, left, newRight);
  } else {
    return createNode(getPriority(h1), getValue(h1), rankLeft + 1, newRight, left);
  }
}

// Insert: merge with singleton node
export function insert(heap: u32, priority: f64, valuePacked: u32, isMaxHeap: u32): u32 {
  const singleton = createNode(priority, valuePacked, 1, 0, 0);
  return merge(heap, singleton, isMaxHeap);
}

// Extract min/max: return new heap (merge of children)
export function extractTop(heap: u32, isMaxHeap: u32): u32 {
  if (!heap) return 0;
  return merge(getLeft(heap), getRight(heap), isMaxHeap);
}

// Peek operations
export function peekPriority(heap: u32): f64 {
  return heap ? getPriority(heap) : 0;
}

export function peekValue(heap: u32): u32 {
  return heap ? getValue(heap) : 0;
}
