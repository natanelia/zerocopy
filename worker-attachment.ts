/** Internal attachment implementation. Public one-shot readers have no reuse context. */
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
import { Arena, createArenaRegistry, FORMAT_VERSION } from './arena';
import { structureRegistry } from './codec';
import { ReaderValues } from './reader-values';
import type { SharedStructure, WorkerData } from './shared';

// The registry checks class identity, not its generic value parameter.
// Explicit erasure avoids InstanceType inferring string (whose ValueOf is never).
export const constructors = {
  SharedMap: SharedMap<any>,
  SharedList: SharedList<any>,
  SharedSet: SharedSet<string | number>,
  SharedStack: SharedStack<any>,
  SharedQueue: SharedQueue<any>,
  SharedLinkedList: SharedLinkedList<any>,
  SharedDoublyLinkedList: SharedDoublyLinkedList<any>,
  SharedOrderedMap: SharedOrderedMap<any>,
  SharedOrderedSet: SharedOrderedSet<string | number>,
  SharedSortedMap: SharedSortedMap<any>,
  SharedSortedSet: SharedSortedSet<string | number>,
  SharedPriorityQueue: SharedPriorityQueue<any>,
};

export type ReaderAttachments = Map<string, { memory: WebAssembly.Memory; values: ReaderValues }>;
interface AttachmentContext { previous: ReaderAttachments; next: ReaderAttachments }

/** Retire only cache handles that no longer belong to the live publication. */
export function retireReaderAttachments(previous: ReaderAttachments, next?: ReaderAttachments): void {
  for (const [id, entry] of previous) if (next?.get(id)?.values !== entry.values) entry.values.deactivate();
}

/** Synchronous core keeps public and session entry points to one async boundary. */
export function reconstructWorkerData(data: WorkerData, context?: AttachmentContext): Readonly<Record<string, SharedStructure>> {
  if (!data?.__shared || data.version !== FORMAT_VERSION) throw new Error('Unsupported worker data; create a v4 payload with getWorkerData()');
  const arenas = new Map<string, Arena>();
  // A solitary reader needs only its original empty owned dependency Map.
  const registry = data.arenas?.length < 2 ? undefined : createArenaRegistry(arenas);
  for (const source of data.arenas) {
    if ((!source.memory && !source.copy) || arenas.has(source.id)) throw new Error('Invalid arena transport');
    if (!Number.isSafeInteger(source.used) || source.used < 65536 || source.used > (source.memory?.buffer.byteLength ?? source.copy!.byteLength)) throw new Error('Invalid arena length');
    // Use the same single source spread as one-shot attachment. Inspect the
    // captured fields for reuse; do not observe transport getters again.
    const options = { ...source, readOnly: true, registry, readerValues: undefined as ReaderValues | undefined };
    if (context && options.memory && !options.copy) {
      const previous = context.previous.get(options.id);
      options.readerValues = previous?.memory === options.memory ? previous.values : new ReaderValues();
      context.next.set(options.id, { memory: options.memory, values: options.readerValues });
    }
    const arena = new Arena(options);
    arenas.set(source.id, arena);
    registry?.members.push(arena);
  }
  // The complete registry is available before reconstructing any nested value.
  // It belongs only to this payload; later attachments cannot change old views.
  const result: Record<string, SharedStructure> = Object.create(null);
  for (const [name, item] of Object.entries(data.structures)) {
    const arena = arenas.get(item.arena), factory = structureRegistry[item.type];
    if (!arena || !Object.hasOwn(constructors, item.type) || !factory) throw new Error(`Invalid structure: ${name}`);
    result[name] = factory.fromWorkerData(item.data, arena);
  }
  return Object.freeze(result);
}

export async function attachSessionWorker(data: WorkerData, previous: ReaderAttachments, next: ReaderAttachments): Promise<Readonly<Record<string, SharedStructure>>> {
  // Reconstruction may warm an existing pure-value cache before a later error.
  // The budget remains bounded; only the caller commits next after all checks.
  try { return reconstructWorkerData(data, { previous, next }); }
  catch (error) {
    // A factory can retain a new attachment before a later factory fails.
    // Keep its local cache usable, but do not leave an orphan reusable cache.
    retireReaderAttachments(next, previous); next.clear();
    throw error;
  }
}
