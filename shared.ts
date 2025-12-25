/**
 * Worker-friendly API for shared data structures
 */
import { SharedMap, sharedBuffer, resetMap, type ValueType } from './shared-map';
import { SharedList, sharedMemory, getAllocState, getBufferCopy, attachToMemory, attachToBufferCopy, resetSharedList, type SharedListType } from './shared-list';
import { SharedSet } from './shared-set';
import { SharedStack, sharedMemory as stackMemory, getAllocState as getStackAllocState, getBufferCopy as getStackBufferCopy, attachToMemory as attachStackToMemory, attachToBufferCopy as attachStackToBufferCopy, resetStack } from './shared-stack';
import { SharedQueue, resetQueue } from './shared-queue';
import { SharedLinkedList, sharedMemory as linkedListMemory, getAllocState as getLinkedListAllocState, getBufferCopy as getLinkedListBufferCopy, attachToMemory as attachLinkedListToMemory, resetLinkedList } from './shared-linked-list';
import { SharedDoublyLinkedList, sharedMemory as doublyLinkedListMemory, getAllocState as getDoublyLinkedListAllocState, getBufferCopy as getDoublyLinkedListBufferCopy, attachToMemory as attachDoublyLinkedListToMemory, resetDoublyLinkedList } from './shared-doubly-linked-list';
import { SharedOrderedMap, sharedMemory as orderedMapMemory, getAllocState as getOrderedMapAllocState, getBufferCopy as getOrderedMapBufferCopy, attachToMemory as attachOrderedMapToMemory, resetOrderedMap } from './shared-ordered-map';
import { SharedOrderedSet, resetOrderedSet } from './shared-ordered-set';
import { SharedSortedMap, sharedMemory as sortedMapMemory, getAllocState as getSortedMapAllocState, getBufferCopy as getSortedMapBufferCopy, attachToMemory as attachSortedMapToMemory, resetSortedMap } from './shared-sorted-map';
import { SharedSortedSet, resetSortedSet } from './shared-sorted-set';
import { SharedPriorityQueue, sharedMemory as priorityQueueMemory, getAllocState as getPriorityQueueAllocState, getBufferCopy as getPriorityQueueBufferCopy, attachToMemory as attachPriorityQueueToMemory, resetPriorityQueue } from './shared-priority-queue';

export { SharedMap, SharedList, SharedSet, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue };
export { resetMap, resetSharedList, resetStack, resetQueue, resetLinkedList, resetDoublyLinkedList, resetOrderedMap, resetOrderedSet, resetSortedMap, resetSortedSet, resetPriorityQueue };
export type { ValueType, SharedListType };

type SharedStructure = SharedMap<any> | SharedList<any> | SharedSet<any> | SharedStack<any> | SharedQueue<any> | SharedLinkedList<any> | SharedDoublyLinkedList<any> | SharedOrderedMap<any> | SharedOrderedSet<any> | SharedSortedMap<any> | SharedSortedSet<any> | SharedPriorityQueue<any>;

interface WorkerData {
  __shared: true;
  mapBuffer: SharedArrayBuffer;
  listMemory?: WebAssembly.Memory;
  listBufferCopy?: Uint8Array;
  listAllocState?: { heapEnd: number; freeNodes: number; freeLeaves: number };
  stackMemory?: WebAssembly.Memory;
  stackBufferCopy?: Uint8Array;
  stackAllocState?: { heapEnd: number; freeList: number };
  linkedListMemory?: WebAssembly.Memory;
  linkedListBufferCopy?: Uint8Array;
  linkedListAllocState?: { heapEnd: number; freeList: number };
  doublyLinkedListMemory?: WebAssembly.Memory;
  doublyLinkedListBufferCopy?: Uint8Array;
  doublyLinkedListAllocState?: { heapEnd: number; freeList: number };
  orderedMapMemory?: WebAssembly.Memory;
  orderedMapBufferCopy?: Uint8Array;
  orderedMapAllocState?: { heapEnd: number; freeList: number };
  sortedMapMemory?: WebAssembly.Memory;
  sortedMapBufferCopy?: Uint8Array;
  sortedMapAllocState?: { heapEnd: number; freeList: number };
  priorityQueueMemory?: WebAssembly.Memory;
  priorityQueueBufferCopy?: Uint8Array;
  priorityQueueAllocState?: { heapEnd: number; freeList: number };
  structures: Record<string, { type: string; data: any }>;
}

const isBun = typeof Bun !== 'undefined';

export function getWorkerData(structures: Record<string, SharedStructure>): WorkerData {
  const serialized: Record<string, { type: string; data: any }> = {};
  let hasList = false, hasStack = false, hasLinkedList = false, hasDoublyLinkedList = false, hasOrderedMap = false, hasSortedMap = false, hasPriorityQueue = false;
  
  for (const [name, struct] of Object.entries(structures)) {
    if (struct instanceof SharedMap) {
      serialized[name] = { type: 'SharedMap', data: { root: (struct as any).root, valueType: (struct as any).valueType } };
    } else if (struct instanceof SharedList) {
      serialized[name] = { type: 'SharedList', data: struct.toWorkerData() };
      hasList = true;
    } else if (struct instanceof SharedSet) {
      serialized[name] = { type: 'SharedSet', data: { root: (struct as any)._map.root } };
    } else if (struct instanceof SharedStack) {
      serialized[name] = { type: 'SharedStack', data: struct.toWorkerData() };
      hasStack = true;
    } else if (struct instanceof SharedQueue) {
      serialized[name] = { type: 'SharedQueue', data: struct.toWorkerData() };
      hasStack = true;
    } else if (struct instanceof SharedLinkedList) {
      serialized[name] = { type: 'SharedLinkedList', data: struct.toWorkerData() };
      hasLinkedList = true;
    } else if (struct instanceof SharedDoublyLinkedList) {
      serialized[name] = { type: 'SharedDoublyLinkedList', data: struct.toWorkerData() };
      hasDoublyLinkedList = true;
    } else if (struct instanceof SharedOrderedMap) {
      serialized[name] = { type: 'SharedOrderedMap', data: struct.toWorkerData() };
      hasOrderedMap = true;
    } else if (struct instanceof SharedOrderedSet) {
      serialized[name] = { type: 'SharedOrderedSet', data: struct.toWorkerData() };
      hasOrderedMap = true;
    } else if (struct instanceof SharedSortedMap) {
      serialized[name] = { type: 'SharedSortedMap', data: struct.toWorkerData() };
      hasSortedMap = true;
    } else if (struct instanceof SharedSortedSet) {
      serialized[name] = { type: 'SharedSortedSet', data: struct.toWorkerData() };
      hasSortedMap = true;
    } else if (struct instanceof SharedPriorityQueue) {
      serialized[name] = { type: 'SharedPriorityQueue', data: struct.toWorkerData() };
      hasPriorityQueue = true;
    }
  }
  
  const result: WorkerData = { __shared: true, mapBuffer: sharedBuffer, structures: serialized };
  
  if (hasList) {
    result.listAllocState = getAllocState();
    if (isBun) result.listBufferCopy = getBufferCopy();
    else result.listMemory = sharedMemory;
  }
  if (hasStack) {
    result.stackAllocState = getStackAllocState();
    if (isBun) result.stackBufferCopy = getStackBufferCopy();
    else result.stackMemory = stackMemory;
  }
  if (hasLinkedList) {
    result.linkedListAllocState = getLinkedListAllocState();
    if (isBun) result.linkedListBufferCopy = getLinkedListBufferCopy();
    else result.linkedListMemory = linkedListMemory;
  }
  if (hasDoublyLinkedList) {
    result.doublyLinkedListAllocState = getDoublyLinkedListAllocState();
    if (isBun) result.doublyLinkedListBufferCopy = getDoublyLinkedListBufferCopy();
    else result.doublyLinkedListMemory = doublyLinkedListMemory;
  }
  if (hasOrderedMap) {
    result.orderedMapAllocState = getOrderedMapAllocState();
    if (isBun) result.orderedMapBufferCopy = getOrderedMapBufferCopy();
    else result.orderedMapMemory = orderedMapMemory;
  }
  if (hasSortedMap) {
    result.sortedMapAllocState = getSortedMapAllocState();
    if (isBun) result.sortedMapBufferCopy = getSortedMapBufferCopy();
    else result.sortedMapMemory = sortedMapMemory;
  }
  if (hasPriorityQueue) {
    result.priorityQueueAllocState = getPriorityQueueAllocState();
    if (isBun) result.priorityQueueBufferCopy = getPriorityQueueBufferCopy();
    else result.priorityQueueMemory = priorityQueueMemory;
  }
  
  return result;
}

let workerInitialized = false;

export async function initWorker<T extends Record<string, SharedStructure>>(data: WorkerData): Promise<T> {
  if (!data.__shared) throw new Error('Invalid worker data - use getWorkerData() on main thread');
  
  if (!workerInitialized) {
    if (data.listAllocState) {
      if (data.listMemory) attachToMemory(data.listMemory, data.listAllocState);
      else if (data.listBufferCopy) attachToBufferCopy(data.listBufferCopy, data.listAllocState);
    }
    if (data.stackAllocState) {
      if (data.stackMemory) attachStackToMemory(data.stackMemory, data.stackAllocState);
      else if (data.stackBufferCopy) attachStackToBufferCopy(data.stackBufferCopy, data.stackAllocState);
    }
    if (data.linkedListAllocState) {
      if (data.linkedListMemory) attachLinkedListToMemory(data.linkedListMemory, data.linkedListAllocState);
    }
    if (data.doublyLinkedListAllocState) {
      if (data.doublyLinkedListMemory) attachDoublyLinkedListToMemory(data.doublyLinkedListMemory, data.doublyLinkedListAllocState);
    }
    if (data.orderedMapAllocState) {
      if (data.orderedMapMemory) attachOrderedMapToMemory(data.orderedMapMemory, data.orderedMapAllocState);
    }
    if (data.sortedMapAllocState) {
      if (data.sortedMapMemory) attachSortedMapToMemory(data.sortedMapMemory, data.sortedMapAllocState);
    }
    if (data.priorityQueueAllocState) {
      if (data.priorityQueueMemory) attachPriorityQueueToMemory(data.priorityQueueMemory, data.priorityQueueAllocState);
    }
    workerInitialized = true;
  }
  
  const result: Record<string, SharedStructure> = {};
  for (const [name, { type, data: structData }] of Object.entries(data.structures)) {
    switch (type) {
      case 'SharedMap': result[name] = SharedMap.fromWorkerData(structData.root, structData.valueType); break;
      case 'SharedList': result[name] = SharedList.fromWorkerData(structData); break;
      case 'SharedSet': result[name] = SharedSet.fromWorkerData(structData.root); break;
      case 'SharedStack': result[name] = SharedStack.fromWorkerData(structData); break;
      case 'SharedQueue': result[name] = SharedQueue.fromWorkerData(structData); break;
      case 'SharedLinkedList': result[name] = SharedLinkedList.fromWorkerData(structData); break;
      case 'SharedDoublyLinkedList': result[name] = SharedDoublyLinkedList.fromWorkerData(structData); break;
      case 'SharedOrderedMap': result[name] = SharedOrderedMap.fromWorkerData(structData); break;
      case 'SharedOrderedSet': result[name] = SharedOrderedSet.fromWorkerData(structData); break;
      case 'SharedSortedMap': result[name] = SharedSortedMap.fromWorkerData(structData); break;
      case 'SharedSortedSet': result[name] = SharedSortedSet.fromWorkerData(structData); break;
      case 'SharedPriorityQueue': result[name] = SharedPriorityQueue.fromWorkerData(structData); break;
    }
  }
  return result as T;
}
