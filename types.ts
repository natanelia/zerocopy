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
type SetStructureType = 'SharedSet' | 'SharedOrderedSet' | 'SharedSortedSet';

/** Decoded JSON is deeply frozen, including arrays and tuple elements. */
// Interface indirection prevents eager expansion of recursive JSON arrays.
interface ReadonlyElements<T> extends ReadonlyArray<DeepReadonly<T>> {}
export type DeepReadonly<T> =
  T extends readonly unknown[] ? T[number][] extends T ? ReadonlyElements<T[number]> : { readonly [K in keyof T]: DeepReadonly<T[K]> } :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }

type Same<A, B> = (<V>() => V extends A ? 1 : 2) extends (<V>() => V extends B ? 1 : 2) ? true : false;
type SeenShape<T, Seen extends readonly unknown[]> =
  Seen extends readonly [infer First, ...infer Rest] ? Same<T, First> extends true ? true : SeenShape<T, Rest> : false;

// Validate whole unions before distributing, so recursive unions terminate.
// Only an exactly repeated shape may stop recursion: a subtype can add invalid
// fields. Required<T> checks optional any even without exactOptionalPropertyTypes.
type JsonIssue<T, Seen extends readonly unknown[] = []> =
  0 extends (1 & T) ? 'any' :
  SeenShape<T, Seen> extends true ? never : JsonMemberIssue<T, [...Seen, T]>;
type JsonMemberIssue<T, Seen extends readonly unknown[]> =
  T extends string | number | boolean | null ? never :
  T extends (...args: never[]) => unknown ? 'function' :
  T extends readonly unknown[] ?
    Exclude<keyof T, keyof any[] | `${number}`> extends never ? JsonIssue<T[number], Seen> : 'array properties' :
  T extends object ? keyof T extends never ? 'unspecified object' :
    { [K in keyof T]-?: K extends string | number ? JsonIssue<Required<T>[K], Seen> : 'symbol key' }[keyof T] :
  'non-JSON value';

type JsonArguments<T> =
  [T] extends [never] ? [invalidJsonShape: never] :
  [T] extends [object] ? [JsonIssue<T>] extends [never] ? [] : [invalidJsonShape: never] :
  [invalidJsonShape: never];

declare const descriptorValue: unique symbol;
declare const descriptorWire: unique symbol;
type Descriptor<V, Wire extends string> = Wire & {
  readonly [descriptorValue]: V;
  readonly [descriptorWire]: Wire;
};
export type JsonType<T extends object> = Descriptor<DeepReadonly<T>, 'object'>;
/** The exact runtime string, without the application-value brand. */
export type WireType<T extends string> = T extends { readonly [descriptorWire]: infer W extends string } ? W : T;

/**
 * Add a compile-time shape to the existing object codec. Returns 'object' at
 * runtime; writes use native JSON.stringify without an extra validation pass.
 * Without a type argument, accept JSON objects/arrays rather than unchecked any.
 * Supply JSON-compatible plain data and validate unknown input before insertion.
 */
export function json<T = JsonObject | readonly JsonValue[]>(..._check: JsonArguments<T>): JsonType<Extract<T, object>> {
  return 'object' as JsonType<Extract<T, object>>;
}

// Dynamic descriptors still get runtime validation. Literal descriptors must
// have valid leaves and sets cannot contain objects or other collections.
type CheckedDescriptor<T extends string> =
  string extends T ? T :
  T extends { readonly [descriptorWire]: string } ? T :
  T extends PrimitiveType ? T :
  T extends `${infer S extends StructureType}<${infer I}>` ?
    S extends SetStructureType ? I extends 'string' | 'number' ? T : never :
    I extends CheckedDescriptor<I> ? T : never :
  never;

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
  T extends `${infer S extends StructureType}<${infer I}>` ? T extends CheckedDescriptor<T> ? Structures<I>[S] : never :
  never;

export type NestedType<S extends StructureType, T extends string> = Descriptor<Structures<T>[S], `${S}<${WireType<T>}>`>;

function nested<S extends StructureType, T extends ValueType>(structure: S, type: T): NestedType<S, T> {
  if (typeof type !== 'string') throw new TypeError('Value descriptors must be strings');
  const wire = `${structure}<${type}>`;
  if (!parseNestedType(wire)) throw new TypeError(`Unknown value type: ${wire}`);
  return wire as NestedType<S, T>;
}

/** Compose descriptors rather than interpolating them, which loses the brand. */
export function map<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedMap', T> { return nested<'SharedMap', T>('SharedMap', type); }
export function list<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedList', T> { return nested<'SharedList', T>('SharedList', type); }
export function stack<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedStack', T> { return nested<'SharedStack', T>('SharedStack', type); }
export function queue<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedQueue', T> { return nested<'SharedQueue', T>('SharedQueue', type); }
export function linkedList<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedLinkedList', T> { return nested<'SharedLinkedList', T>('SharedLinkedList', type); }
export function doublyLinkedList<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedDoublyLinkedList', T> { return nested<'SharedDoublyLinkedList', T>('SharedDoublyLinkedList', type); }
export function orderedMap<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedOrderedMap', T> { return nested<'SharedOrderedMap', T>('SharedOrderedMap', type); }
export function sortedMap<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedSortedMap', T> { return nested<'SharedSortedMap', T>('SharedSortedMap', type); }
export function priorityQueue<T extends ValueType>(type: T & CheckedDescriptor<T>): NestedType<'SharedPriorityQueue', T> { return nested<'SharedPriorityQueue', T>('SharedPriorityQueue', type); }
export function set<T extends 'string' | 'number'>(type: T): NestedType<'SharedSet', T> { return nested('SharedSet', type); }
export function orderedSet<T extends 'string' | 'number'>(type: T): NestedType<'SharedOrderedSet', T> { return nested('SharedOrderedSet', type); }
export function sortedSet<T extends 'string' | 'number'>(type: T): NestedType<'SharedSortedSet', T> { return nested('SharedSortedSet', type); }

export interface NestedTypeInfo {
  readonly structureType: StructureType;
  readonly innerType: string;
}

const STRUCTURE_TYPES = new Set<string>(['SharedMap', 'SharedSet', 'SharedList', 'SharedStack', 'SharedQueue', 'SharedLinkedList', 'SharedDoublyLinkedList', 'SharedOrderedMap', 'SharedOrderedSet', 'SharedSortedMap', 'SharedSortedSet', 'SharedPriorityQueue']);
const SET_TYPES = new Set<string>(['SharedSet', 'SharedOrderedSet', 'SharedSortedSet']);
const nestedTypes = new Map<string, NestedTypeInfo>();
const MAX_CACHED_TYPES = 256;
const MAX_CACHED_TYPE_LENGTH = 4096;

function primitive(type: string): type is PrimitiveType {
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'object';
}

/** Validate the complete descriptor, not just its outer collection name. */
export function parseNestedType(type: string): NestedTypeInfo | null {
  // Primitive JSON values take this path on reads, writes and compaction.
  if (typeof type !== 'string' || !type.startsWith('Shared')) return null;
  const cached = nestedTypes.get(type);
  if (cached) return cached;

  // Scan inwards using offsets: no recursion or repeated scans of the whole
  // remaining descriptor. Even very deep, uncached input takes linear work.
  let start = 0, end = type.length, outerEnd = -1;
  let outer: StructureType | undefined;
  for (;;) {
    const open = type.indexOf('<', start);
    if (open < 0 || open >= end) {
      if (!primitive(type.slice(start, end))) return null;
      break;
    }
    if (type.charCodeAt(end - 1) !== 62) return null;
    const structure = type.slice(start, open);
    if (!STRUCTURE_TYPES.has(structure)) return null;
    if (outer === undefined) { outer = structure as StructureType; outerEnd = open; }
    start = open + 1;
    end--;
    if (SET_TYPES.has(structure)) {
      const leaf = type.slice(start, end);
      if (leaf !== 'string' && leaf !== 'number') return null;
      break;
    }
  }
  if (outer === undefined) return null;
  const info = Object.freeze({ structureType: outer, innerType: type.slice(outerEnd + 1, -1) });
  // Bound both count and key length; arbitrary descriptors must not grow a
  // process-lifetime cache without limit. Invalid descriptors are never cached.
  if (type.length <= MAX_CACHED_TYPE_LENGTH) {
    if (nestedTypes.size >= MAX_CACHED_TYPES) nestedTypes.delete(nestedTypes.keys().next().value!);
    nestedTypes.set(type, info);
  }
  return info;
}

export function isNestedType(type: string): boolean { return parseNestedType(type) !== null; }
