// Binary Heap WASM for priority queue
const BLOB_BUF: u32 = 0;
const HEAP_START: u32 = 65536;
let heapEnd: u32 = HEAP_START;
let freeList: u32 = 0;

// Entry: [priority:f64][valuePacked:u32][pad:u32] = 16 bytes
const ENTRY_SIZE: u32 = 16;
// Heap array: [capacity:u32][size:u32][entries...]
const HEAP_HEADER: u32 = 8;

export function blobBuf(): u32 { return BLOB_BUF; }
export function getHeapEnd(): u32 { return heapEnd; }
export function setHeapEnd(v: u32): void { heapEnd = v; }
export function getFreeList(): u32 { return freeList; }
export function setFreeList(v: u32): void { freeList = v; }
export function reset(): void { heapEnd = HEAP_START; freeList = 0; }

function alloc(size: u32): u32 {
  const ptr = heapEnd;
  heapEnd += size;
  const memBytes = <u32>memory.size() << 16;
  if (heapEnd > memBytes) memory.grow(((heapEnd - memBytes) >> 16) + 1);
  return ptr;
}

export function allocBlob(len: u32): u32 {
  const ptr = alloc(len);
  memory.copy(ptr, BLOB_BUF, len);
  return ptr;
}

export function createHeap(initialCapacity: u32): u32 {
  const cap = initialCapacity > 0 ? initialCapacity : 16;
  const ptr = alloc(HEAP_HEADER + cap * ENTRY_SIZE);
  store<u32>(ptr, cap);
  store<u32>(ptr + 4, 0);
  return ptr;
}

function getCapacity(heap: u32): u32 { return load<u32>(heap); }
function getSize(heap: u32): u32 { return load<u32>(heap + 4); }
function setSize(heap: u32, s: u32): void { store<u32>(heap + 4, s); }

function entryPtr(heap: u32, i: u32): u32 { return heap + HEAP_HEADER + i * ENTRY_SIZE; }
function getPriority(heap: u32, i: u32): f64 { return load<f64>(entryPtr(heap, i)); }
function getValue(heap: u32, i: u32): u32 { return load<u32>(entryPtr(heap, i) + 8); }
function setEntry(heap: u32, i: u32, priority: f64, value: u32): void {
  const p = entryPtr(heap, i);
  store<f64>(p, priority);
  store<u32>(p + 8, value);
}

function copyEntry(heap: u32, from: u32, to: u32): void {
  const src = entryPtr(heap, from);
  const dst = entryPtr(heap, to);
  store<f64>(dst, load<f64>(src));
  store<u32>(dst + 8, load<u32>(src + 8));
}

// Returns new heap ptr (may reallocate)
export function insert(heap: u32, priority: f64, valuePacked: u32, isMaxHeap: u32): u32 {
  let h = heap;
  const size = getSize(h);
  const cap = getCapacity(h);
  
  if (size >= cap) {
    const newCap = cap * 2;
    const newHeap = alloc(HEAP_HEADER + newCap * ENTRY_SIZE);
    memory.copy(newHeap, h, HEAP_HEADER + size * ENTRY_SIZE);
    store<u32>(newHeap, newCap);
    h = newHeap;
  }
  
  setEntry(h, size, priority, valuePacked);
  siftUp(h, size, isMaxHeap);
  setSize(h, size + 1);
  return h;
}

function siftUp(heap: u32, i: u32, isMaxHeap: u32): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const cmp = getPriority(heap, i) - getPriority(heap, parent);
    const shouldSwap = isMaxHeap ? cmp > 0 : cmp < 0;
    if (!shouldSwap) break;
    // Swap
    const pi = getPriority(heap, i), vi = getValue(heap, i);
    copyEntry(heap, parent, i);
    setEntry(heap, parent, pi, vi);
    i = parent;
  }
}

export function extract(heap: u32, isMaxHeap: u32): void {
  const size = getSize(heap);
  if (size == 0) return;
  if (size == 1) { setSize(heap, 0); return; }
  copyEntry(heap, size - 1, 0);
  setSize(heap, size - 1);
  siftDown(heap, 0, size - 1, isMaxHeap);
}

function siftDown(heap: u32, i: u32, size: u32, isMaxHeap: u32): void {
  while (true) {
    const left = (i << 1) + 1;
    const right = left + 1;
    let best = i;
    
    if (left < size) {
      const cmp = getPriority(heap, left) - getPriority(heap, best);
      if (isMaxHeap ? cmp > 0 : cmp < 0) best = left;
    }
    if (right < size) {
      const cmp = getPriority(heap, right) - getPriority(heap, best);
      if (isMaxHeap ? cmp > 0 : cmp < 0) best = right;
    }
    if (best == i) break;
    
    const pi = getPriority(heap, i), vi = getValue(heap, i);
    copyEntry(heap, best, i);
    setEntry(heap, best, pi, vi);
    i = best;
  }
}

export function peekPriority(heap: u32): f64 {
  return getSize(heap) > 0 ? getPriority(heap, 0) : 0;
}

export function peekValue(heap: u32): u32 {
  return getSize(heap) > 0 ? getValue(heap, 0) : 0;
}

export function heapSize(heap: u32): u32 { return getSize(heap); }
