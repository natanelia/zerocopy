import {
  SharedMap, SharedList, SharedSet, SharedStack, SharedQueue,
  SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap,
  SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue,
} from './shared';
import { arenaOf } from './arena';

export const collectionConstructors = Object.freeze({
  SharedMap, SharedList, SharedSet, SharedStack, SharedQueue,
  SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap,
  SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue,
});
export type CollectionKind = keyof typeof collectionConstructors;
export type SharedCollection = InstanceType<(typeof collectionConstructors)[CollectionKind]>;
const prototypes = new Map<object, CollectionKind>(
  Object.entries(collectionConstructors).map(([name, C]) => [C.prototype, name as CollectionKind]),
);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** Exact public classes only. A frozen object with a forged prototype is not a snapshot. */
export function collectionKind(value: unknown): CollectionKind | undefined {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return undefined;
  const kind = prototypes.get(Object.getPrototypeOf(value));
  if (!kind) return undefined;
  try { arenaOf(value); return kind; } catch { return undefined; }
}

export function isZerocopyCollection(value: unknown): value is SharedCollection {
  return collectionKind(value) !== undefined;
}

export function isSerializable(value: unknown): boolean {
  if (isZerocopyCollection(value)) {
    // This is fixed-size metadata, not iteration. Custom comparators cannot be
    // reconstructed from data and must not silently pass a serializability check.
    try { value.toWorkerData(); return true; } catch { return false; }
  }
  return value == null || ['string', 'boolean', 'number'].includes(typeof value)
    || Array.isArray(value) || isPlainRecord(value);
}

/** Collection payloads are encoded and immutable already. Never inspect WASM, caches, or entries. */
export function getEntries(value: unknown): [string, unknown][] {
  return isZerocopyCollection(value) || value == null ? [] : Object.entries(value);
}
