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

export { SharedMap, SharedList, SharedSet, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList };
export { resetMap, resetSharedList, resetStack, resetQueue, resetLinkedList, resetDoublyLinkedList };
export type { ValueType, SharedListType };

type SharedStructure = SharedMap<any> | SharedList<any> | SharedSet<any> | SharedStack<any> | SharedQueue<any> | SharedLinkedList<any> | SharedDoublyLinkedList<any>;

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
  structures: Record<string, { type: string; data: any }>;
}

const isBun = typeof Bun !== 'undefined';

export function getWorkerData(structures: Record<string, SharedStructure>): WorkerData {
  const serialized: Record<string, { type: string; data: any }> = {};
  let hasList = false, hasStack = false, hasLinkedList = false, hasDoublyLinkedList = false;
  
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
    }
  }
  return result as T;
}
