/** Worker transport for immutable snapshots. Wire version 4 uses arena-scoped descriptors. */
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
import { constructors, reconstructWorkerData } from './worker-attachment';

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
export type { TextSearchOptions } from './text-search';
export { json, map, list, stack, queue, linkedList, doublyLinkedList, orderedMap, sortedMap, priorityQueue, set, orderedSet, sortedSet } from './types';
export type { DeepReadonly, JsonValue, JsonObject, JsonType, NestedType, ValueOf, WireType } from './types';

const constructorEntries = Object.entries(constructors);
export type SharedStructure = InstanceType<(typeof constructors)[keyof typeof constructors]>;
// Named interfaces do not need a string index signature. Symbol keys cannot be
// represented by Object.entries or the worker wire format.
type StructureRecord<T> = Record<keyof T, SharedStructure> & Record<Extract<keyof T, symbol>, never>;
type SerializedStructure<S extends SharedStructure = SharedStructure> = {
  readonly type: string;
  readonly arena: string;
  readonly data: ReturnType<S['toWorkerData']>;
};
declare const workerTypes: unique symbol;
export interface WorkerData<T extends StructureRecord<T> = Record<string, SharedStructure>> {
  /** Type-only link to the producer; no schema or functions are transported. */
  readonly [workerTypes]?: { [K in keyof T]: T[K] };
  readonly __shared: true;
  readonly version: 4;
  readonly arenas: readonly { readonly id: string; readonly used: number; readonly memory?: WebAssembly.Memory; readonly copy?: Uint8Array }[];
  readonly structures: { readonly [K in keyof T]: SerializedStructure<T[K]> };
}

export function getWorkerData<T extends StructureRecord<T>>(structures: T, options: { copy?: boolean } = {}): WorkerData<T> {
  if (Object.getOwnPropertySymbols(structures).length) throw new TypeError('Worker structure names must be strings');
  const copy = options.copy ?? (typeof Bun !== 'undefined');
  const found = new Map<string, Arena>();
  const collect = (root: Arena): void => {
    let arena: Arena | undefined = root, pending: Arena[] | undefined;
    while (arena) {
      if (!found.has(arena.id)) {
        found.set(arena.id, arena);
        const dependencies = arena.transportDependencies ?? arena.dependencies;
        // Empty owned maps, including one-arena payloads, need no iterator or
        // DFS stack. Nonempty ordinary maps still follow their values verbatim.
        if (dependencies.size) {
          const members = arena.readOnly ? arena.sharedDependencyMembers : undefined;
          if (members) {
            // A closed payload is a complete graph. Legacy DFS visits its root,
            // then all unseen members in reverse insertion order. Drain it here
            // without revisiting each arena or allocating a deduplication Set.
            for (let i = members.length - 1; i >= 0; i--) {
              const nested = members[i];
              if (nested !== arena && !found.has(nested.id)) found.set(nested.id, nested);
            }
          } else {
            // Observing a mutable dependency map opens the whole registry;
            // preserve its original per-arena DFS order and first-ID precedence.
            pending ??= [];
            for (const nested of dependencies.values()) pending.push(nested);
          }
        }
      }
      arena = pending?.pop();
    }
  };
  const serialized: Record<string, SerializedStructure> = Object.create(null);
  for (const [name, structure] of Object.entries(structures) as [string, SharedStructure][]) {
    const type = constructorEntries.find(([, ctor]) => structure instanceof ctor)?.[0];
    if (!type) throw new TypeError(`Unsupported shared structure: ${name}`);
    const arena = arenaOf(structure);
    collect(arena);
    serialized[name] = Object.freeze({ type, arena: arena.id, data: structure.toWorkerData() });
  }
  const arenas = [...found.values()].map(arena => Object.freeze(copy ? { id: arena.id, used: arena.used, copy: arena.copy() } : { id: arena.id, used: arena.used, memory: arena.memory }));
  return Object.freeze({ __shared: true, version: FORMAT_VERSION, arenas: Object.freeze(arenas), structures: Object.freeze(serialized) }) as WorkerData<T>;
}

export function initWorker<T extends StructureRecord<T>>(data: WorkerData<T>): Promise<Readonly<T>>;
/** Legacy untyped payloads require the caller to supply the application type. */
export function initWorker<T extends StructureRecord<T>>(data: WorkerData): Promise<Readonly<T>>;
export async function initWorker<T extends StructureRecord<T>>(data: WorkerData<T> | WorkerData): Promise<Readonly<T>> {
  return reconstructWorkerData(data as WorkerData) as Readonly<T>;
}

export { compact, compactMany } from './compaction';

export { configureMemory } from './memory';
