/** Worker transport for immutable snapshots. Wire version 3 is not compatible with v1 pointers. */
import { SharedMap } from './shared-map';
import { SharedList } from './shared-list';
import { SharedSet } from './shared-set';
import { SharedStack } from './shared-stack';
import { SharedQueue } from './shared-queue';
import { SharedLinkedList } from './shared-linked-list';
import { SharedDoublyLinkedList } from './shared-doubly-linked-list';
import { SharedOrderedMap } from './shared-ordered-map';
import { SharedOrderedSet } from './shared-ordered-set';
import { SharedSortedMap } from './shared-sorted-map';
import { SharedSortedSet } from './shared-sorted-set';
import { SharedPriorityQueue } from './shared-priority-queue';
import { Arena, arenaOf, FORMAT_VERSION } from './arena';
import { structureRegistry } from './codec';

export { SharedMap, SharedList, SharedSet, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue };
export { resetMap } from './shared-map';
export { resetSharedList } from './shared-list';
export { resetStack } from './shared-stack';
export { resetQueue } from './shared-queue';
export { resetLinkedList } from './shared-linked-list';
export { resetDoublyLinkedList } from './shared-doubly-linked-list';
export { resetOrderedMap } from './shared-ordered-map';
export { resetOrderedSet } from './shared-ordered-set';
export { resetSortedMap } from './shared-sorted-map';
export { resetSortedSet } from './shared-sorted-set';
export { resetPriorityQueue } from './shared-priority-queue';
export type { ValueType } from './shared-map';
export type { SharedListType } from './shared-list';
export { json, map, list, stack, queue, linkedList, doublyLinkedList, orderedMap, sortedMap, priorityQueue, set, orderedSet, sortedSet } from './types';
export type { DeepReadonly, JsonValue, JsonObject, JsonType, NestedType, ValueOf } from './types';

const constructors = { SharedMap, SharedList, SharedSet, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue };
type SharedStructure = InstanceType<(typeof constructors)[keyof typeof constructors]>;
declare const workerTypes: unique symbol;
export interface WorkerData<T extends Record<string, SharedStructure> = Record<string, SharedStructure>> {
  /** Type-only link to the producer; no schema or functions are transported. */
  readonly [workerTypes]?: T;
  readonly __shared: true;
  readonly version: 4;
  readonly arenas: readonly { readonly id: string; readonly used: number; readonly memory?: WebAssembly.Memory; readonly copy?: Uint8Array }[];
  readonly structures: Readonly<Record<string, { readonly type: string; readonly arena: string; readonly data: any }>>;
}

export function getWorkerData<T extends Record<string, SharedStructure>>(structures: T, options: { copy?: boolean } = {}): WorkerData<T> {
  const copy = options.copy ?? (typeof Bun !== 'undefined');
  const found = new Map<string, Arena>();
  const collect = (arena: Arena): void => {
    if (found.has(arena.id)) return;
    found.set(arena.id, arena);
    for (const nested of arena.dependencies.values()) collect(nested);
  };
  const serialized: Record<string, { type: string; arena: string; data: any }> = Object.create(null);
  for (const [name, structure] of Object.entries(structures)) {
    const type = Object.entries(constructors).find(([, ctor]) => structure instanceof ctor)?.[0];
    if (!type) throw new TypeError(`Unsupported shared structure: ${name}`);
    const arena = arenaOf(structure);
    collect(arena);
    serialized[name] = Object.freeze({ type, arena: arena.id, data: structure.toWorkerData() });
  }
  const arenas = [...found.values()].map(arena => Object.freeze(copy ? { id: arena.id, used: arena.used, copy: arena.copy() } : { id: arena.id, used: arena.used, memory: arena.memory }));
  return Object.freeze({ __shared: true, version: FORMAT_VERSION, arenas: Object.freeze(arenas), structures: Object.freeze(serialized) });
}

export function initWorker<T extends Record<string, SharedStructure>>(data: WorkerData<T>): Promise<Readonly<T>>;
/** Legacy untyped payloads require the caller to supply the application type. */
export function initWorker<T extends Record<string, SharedStructure>>(data: WorkerData): Promise<Readonly<T>>;
export async function initWorker<T extends Record<string, SharedStructure>>(data: WorkerData<T> | WorkerData): Promise<Readonly<T>> {
  if (!data?.__shared || data.version !== FORMAT_VERSION) throw new Error('Unsupported worker data; create a v4 payload with getWorkerData()');
  const arenas = new Map<string, Arena>();
  for (const source of data.arenas) {
    if ((!source.memory && !source.copy) || arenas.has(source.id)) throw new Error('Invalid arena transport');
    if (!Number.isSafeInteger(source.used) || source.used < 65536 || source.used > (source.memory?.buffer.byteLength ?? source.copy!.byteLength)) throw new Error('Invalid arena length');
    arenas.set(source.id, new Arena({ ...source, readOnly: true }));
  }
  // Resolve all dependencies before reconstructing any nested value. Sessions are
  // scoped to this payload, so later initWorker calls cannot change older views.
  for (const arena of arenas.values()) for (const dependency of arenas.values()) if (arena !== dependency) arena.dependencies.set(dependency.id, dependency);
  const result: Record<string, SharedStructure> = Object.create(null);
  for (const [name, item] of Object.entries(data.structures)) {
    const arena = arenas.get(item.arena), factory = structureRegistry[item.type];
    if (!arena || !Object.hasOwn(constructors, item.type) || !factory) throw new Error(`Invalid structure: ${name}`);
    result[name] = factory.fromWorkerData(item.data, arena);
  }
  return Object.freeze(result) as Readonly<T>;
}

export { compact, compactMany } from './compaction';
