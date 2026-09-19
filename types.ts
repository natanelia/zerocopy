import type { SharedMap } from './shared-map';
import type { SharedSet } from './shared-set';
import type { SharedList } from './shared-list';
import type { SharedStack } from './shared-stack';
import type { SharedQueue } from './shared-queue';
import type { SharedLinkedList } from './shared-linked-list';
import type { SharedDoublyLinkedList } from './shared-doubly-linked-list';
import type { SharedOrderedMap } from './shared-ordered-map';
import type { SharedOrderedSet } from './shared-ordered-set';
import type { SharedSortedMap } from './shared-sorted-map';
import type { SharedSortedSet } from './shared-sorted-set';
import type { SharedPriorityQueue } from './shared-priority-queue';

export type PrimitiveType = 'string' | 'number' | 'boolean' | 'object';
export type StructureType = 'SharedMap' | 'SharedSet' | 'SharedList' | 'SharedStack' | 'SharedQueue' | 'SharedLinkedList' | 'SharedDoublyLinkedList' | 'SharedOrderedMap' | 'SharedOrderedSet' | 'SharedSortedMap' | 'SharedSortedSet' | 'SharedPriorityQueue';
export type ValueType = PrimitiveType | `${StructureType}<${string}>`;

/** Decoded JSON is deeply frozen, including arrays and tuple elements. */
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }

// A mapped shape accepts interfaces without requiring an index signature.
// Optional properties retain their optional modifier; omit them instead of
// storing undefined. Functions and known non-JSON members become never.
type JsonShape<T> =
  0 extends (1 & T) ? never :
  T extends string | number | boolean | null ? T :
  T extends (...args: never[]) => unknown ? never :
  T extends object ? { [K in keyof T]: K extends string | number ? JsonShape<T[K]> : never } :
  never;

type JsonArguments<T> =
  0 extends (1 & T) ? [invalid: never] :
  [T] extends [object] ? [T] extends [JsonShape<T>] ? [] : [invalid: never] :
  [invalid: never];

declare const descriptorValue: unique symbol;
type Descriptor<V, Wire extends string> = Wire & { readonly [descriptorValue]: V };
export type JsonType<T extends object> = Descriptor<DeepReadonly<T>, 'object'>;

/**
 * Add a compile-time shape to the existing object codec. Returns 'object' at
 * runtime; writes use native JSON.stringify without an extra validation pass.
 * Supply JSON-compatible plain data and validate unknown input before insertion.
 */
export function json<T>(..._check: JsonArguments<T>): JsonType<Extract<T, object>> {
  return 'object' as JsonType<Extract<T, object>>;
}

type Structures<T extends string> = {
  SharedMap: SharedMap<T>;
  SharedList: SharedList<T>;
  SharedStack: SharedStack<T>;
  SharedQueue: SharedQueue<T>;
  SharedLinkedList: SharedLinkedList<T>;
  SharedDoublyLinkedList: SharedDoublyLinkedList<T>;
  SharedOrderedMap: SharedOrderedMap<T>;
  SharedSortedMap: SharedSortedMap<T>;
  SharedPriorityQueue: SharedPriorityQueue<T>;
  SharedSet: T extends 'string' ? SharedSet<string> : T extends 'number' ? SharedSet<number> : never;
  SharedOrderedSet: T extends 'string' ? SharedOrderedSet<string> : T extends 'number' ? SharedOrderedSet<number> : never;
  SharedSortedSet: T extends 'string' ? SharedSortedSet<string> : T extends 'number' ? SharedSortedSet<number> : never;
};

export type ValueOf<T extends string> =
  T extends { readonly [descriptorValue]: infer V } ? V :
  T extends 'string' ? string :
  T extends 'number' ? number :
  T extends 'boolean' ? boolean :
  T extends 'object' ? object :
  T extends `${infer S extends StructureType}<${infer I}>` ? Structures<I>[S] :
  never;

export type NestedType<S extends StructureType, T extends string> = Descriptor<Structures<T>[S], `${S}<${T}>`>;

function nested<S extends StructureType, T extends ValueType>(structure: S, type: T): NestedType<S, T> {
  if (typeof type !== 'string') throw new TypeError('Value descriptors must be strings');
  if (!validType(`${structure}<${type}>`)) throw new TypeError(`Unknown value type: ${structure}<${type}>`);
  return `${structure}<${type}>` as NestedType<S, T>;
}

/** Compose descriptors rather than interpolating them, which loses the brand. */
export function map<T extends ValueType>(type: T): NestedType<'SharedMap', T> { return nested('SharedMap', type); }
export function list<T extends ValueType>(type: T): NestedType<'SharedList', T> { return nested('SharedList', type); }
export function stack<T extends ValueType>(type: T): NestedType<'SharedStack', T> { return nested('SharedStack', type); }
export function queue<T extends ValueType>(type: T): NestedType<'SharedQueue', T> { return nested('SharedQueue', type); }
export function linkedList<T extends ValueType>(type: T): NestedType<'SharedLinkedList', T> { return nested('SharedLinkedList', type); }
export function doublyLinkedList<T extends ValueType>(type: T): NestedType<'SharedDoublyLinkedList', T> { return nested('SharedDoublyLinkedList', type); }
export function orderedMap<T extends ValueType>(type: T): NestedType<'SharedOrderedMap', T> { return nested('SharedOrderedMap', type); }
export function sortedMap<T extends ValueType>(type: T): NestedType<'SharedSortedMap', T> { return nested('SharedSortedMap', type); }
export function priorityQueue<T extends ValueType>(type: T): NestedType<'SharedPriorityQueue', T> { return nested('SharedPriorityQueue', type); }
export function set<T extends 'string' | 'number'>(type: T): NestedType<'SharedSet', T> { return nested('SharedSet', type); }
export function orderedSet<T extends 'string' | 'number'>(type: T): NestedType<'SharedOrderedSet', T> { return nested('SharedOrderedSet', type); }
export function sortedSet<T extends 'string' | 'number'>(type: T): NestedType<'SharedSortedSet', T> { return nested('SharedSortedSet', type); }

export interface NestedTypeInfo {
  structureType: StructureType;
  innerType: string;
}

const STRUCTURE_TYPES = new Set<string>(['SharedMap', 'SharedSet', 'SharedList', 'SharedStack', 'SharedQueue', 'SharedLinkedList', 'SharedDoublyLinkedList', 'SharedOrderedMap', 'SharedOrderedSet', 'SharedSortedMap', 'SharedSortedSet', 'SharedPriorityQueue']);

export function parseNestedType(type: string): NestedTypeInfo | null {
  if (!type) return null;
  const match = type.match(/^(Shared\w+)<(.+)>$/);
  if (!match || !STRUCTURE_TYPES.has(match[1])) return null;
  return { structureType: match[1] as StructureType, innerType: match[2] };
}

export function isNestedType(type: string): boolean { return parseNestedType(type) !== null; }

function validType(type: string): boolean {
  if (typeof type !== 'string') return false;
  let inner = type;
  for (;;) {
    if (inner === 'string' || inner === 'number' || inner === 'boolean' || inner === 'object') return true;
    const info = parseNestedType(inner);
    if (!info) return false;
    if (info.structureType === 'SharedSet' || info.structureType === 'SharedOrderedSet' || info.structureType === 'SharedSortedSet') {
      return info.innerType === 'string' || info.innerType === 'number';
    }
    inner = info.innerType;
  }
}
