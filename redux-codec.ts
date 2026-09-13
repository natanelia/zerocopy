import {
  SharedMap, SharedList, SharedSet, SharedStack, SharedQueue, SharedLinkedList,
  SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap,
  SharedSortedSet, SharedPriorityQueue,
} from './shared';
import { Arena, arenaOf } from './arena';
import { structureRegistry } from './codec';
import { parseNestedType } from './types';
import { readReduxHeap, restoreReduxHeap } from './redux-heap-codec';

const classes = Object.freeze({ SharedMap, SharedList, SharedSet, SharedStack,
  SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap,
  SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue });
export type SharedCollection = InstanceType<(typeof classes)[keyof typeof classes]>;
type Kind = keyof typeof classes;
const kinds = Object.freeze(Object.keys(classes) as Kind[]);
export type EncodedReduxValue = null | boolean | string | number | EncodedReduxValue[];
export interface ZerocopyCodecOptions {
  /** Limits apply to both encoding and decoding. Text length is in UTF-16 units. */
  maxDepth?: number;
  maxNodes?: number;
  maxCollectionSize?: number;
  maxTextLength?: number;
}
export interface ZerocopyReduxEnvelope {
  readonly $zerocopyRedux: 1;
  readonly value: EncodedReduxValue;
}

/** Exact built-in classes only. A prototype or worker descriptor is not a snapshot. */
export function sharedCollectionKind(value: unknown): Kind | undefined {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  const kind = kinds.find(key => prototype === classes[key].prototype);
  if (!kind) return undefined;
  try { arenaOf(value); return kind; } catch { return undefined; }
}
export function isSharedCollection(value: unknown): value is SharedCollection {
  return sharedCollectionKind(value) !== undefined;
}
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  let root = proto;
  while (Object.getPrototypeOf(root) !== null) root = Object.getPrototypeOf(root);
  return proto === root;
}
function fail(message: string): never { throw new TypeError(`zerocopy Redux: ${message}`); }
function hasOwn(value: object, key: PropertyKey): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function setKind(kind: Kind): boolean { return kind === 'SharedSet' || kind === 'SharedOrderedSet' || kind === 'SharedSortedSet'; }
function mapKind(kind: Kind): boolean { return kind === 'SharedMap' || kind === 'SharedOrderedMap' || kind === 'SharedSortedMap'; }
function checkValueType(type: unknown, depth = 0): asserts type is string {
  if (typeof type !== 'string' || depth > 64) fail('invalid value type');
  if (['string', 'number', 'boolean', 'object'].includes(type as string)) return;
  const nested = parseNestedType(type as string);
  if (!nested || !hasOwn(classes, nested.structureType)) fail('invalid nested value type');
  checkValueType(nested!.innerType, depth + 1);
}
/** Object-typed collections store JSON. Reject hand-written imports that would
 * lose values through JSON storage. Iteration avoids large argument-list limits.
 */
function checkJSON(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) continue;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) { if (!hasOwn(item, i)) fail('object values must be JSON'); pending.push(item[i]); }
    } else if (isPlainRecord(item) && Object.getPrototypeOf(item) !== null) {
      for (const key of Object.keys(item)) pending.push(item[key]);
    } else fail('object values must be JSON');
  }
}
function checkValue(type: string, value: unknown): void {
  const nested = parseNestedType(type);
  if (nested) {
    const kind = sharedCollectionKind(value);
    if (kind !== nested.structureType) fail('nested collection type mismatch');
    if (!setKind(kind!)) {
      const d = (value as SharedCollection).toWorkerData() as any;
      if ((d.valueType ?? d.type) !== nested.innerType) fail('nested value type mismatch');
    }
  } else if (type === 'object') checkJSON(value);
  else if (typeof value !== type) fail(`expected ${type}`);
}

/** Versioned value persistence. No arena IDs, memory, or root pointers are saved.
 * Repeated references are encoded by value; cyclic graphs are rejected. Restored
 * collections share a fresh writable arena, independent of current module arenas.
 */
export function createZerocopyCodec(options: ZerocopyCodecOptions = {}) {
  const limits = { maxDepth: options.maxDepth ?? 128, maxNodes: options.maxNodes ?? 1_000_000,
    maxCollectionSize: options.maxCollectionSize ?? 1_000_000, maxTextLength: options.maxTextLength ?? 64 * 1024 * 1024 };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${key}`);
  }
  function budget() {
    let nodes = 0;
    return (depth: number) => {
      if (depth > limits.maxDepth || ++nodes > limits.maxNodes) throw new RangeError('zerocopy Redux: codec limit exceeded');
    };
  }
  function size(length: number): void {
    if (length > limits.maxCollectionSize) throw new RangeError('zerocopy Redux: collection limit exceeded');
  }
  function encode(value: unknown): ZerocopyReduxEnvelope {
    const visit = budget(), active = new WeakSet<object>();
    function walk(input: unknown, depth: number): EncodedReduxValue {
      visit(depth);
      if (input === null || typeof input === 'string' || typeof input === 'boolean') return input as null | string | boolean;
      if (typeof input === 'number') {
        if (Number.isNaN(input)) return ['n', 'NaN'];
        if (!Number.isFinite(input)) return ['n', input > 0 ? 'Infinity' : '-Infinity'];
        return Object.is(input, -0) ? ['n', '-0'] : input;
      }
      if (input === undefined) return ['u'];
      if (typeof input !== 'object') fail(`unsupported ${typeof input}`);
      const object = input as object;
      if (active.has(object)) fail('cyclic state is not supported');
      active.add(object);
      try {
        const kind = sharedCollectionKind(input);
        if (kind) {
          const collection = input as SharedCollection;
          size(collection.size);
          // Reject local comparators rather than silently dropping their behavior.
          const d = collection.toWorkerData() as any;
          const type = setKind(kind) ? '' : d.valueType ?? d.type;
          if (!setKind(kind)) checkValueType(type);
          const items: EncodedReduxValue[] = [];
          if (mapKind(kind)) {
            for (const [key, item] of (collection as SharedMap<any>).entries()) items.push([key, walk(item, depth + 1)]);
          } else if (kind === 'SharedPriorityQueue') {
            return ['c', kind, type, (collection as SharedPriorityQueue<any>).isMaxHeap,
              readReduxHeap(collection as SharedPriorityQueue<any>, item => walk(item, depth + 1))];
          } else if (kind === 'SharedStack') {
            let cursor = collection as SharedStack<any>;
            while (!cursor.isEmpty) { items.push(walk(cursor.peek(), depth + 1)); cursor = cursor.pop(); }
          } else if (kind === 'SharedQueue') {
            let cursor = collection as SharedQueue<any>;
            while (!cursor.isEmpty) { items.push(walk(cursor.peek(), depth + 1)); cursor = cursor.dequeue(); }
          } else (collection as SharedList<any>).forEach(item => items.push(walk(item, depth + 1)));
          return ['c', kind, type, null, items];
        }
        if (!Array.isArray(input) && !isPlainRecord(input)) fail('only plain records, arrays, and shared collections are supported');
        const descriptors = Object.getOwnPropertyDescriptors(input);
        for (const key of Reflect.ownKeys(descriptors)) {
          const descriptor = descriptors[key as string];
          if (descriptor.enumerable && (typeof key === 'symbol' || !hasOwn(descriptor, 'value'))) fail('enumerable symbols and accessors are not supported');
        }
        if (Array.isArray(input)) {
          size(input.length);
          if (Object.keys(input).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) fail('array properties are not supported');
          const entries: EncodedReduxValue[] = [];
          for (let i = 0; i < input.length; i++) {
            if (hasOwn(input, i)) entries.push(walk(input[i], depth + 1));
            else { visit(depth + 1); entries.push(['h']); }
          }
          return ['a', entries];
        }
        const keys = Object.keys(input); size(keys.length);
        return [Object.getPrototypeOf(input) === null ? 'z' : 'o', keys.map(key => [key, walk((input as Record<string, unknown>)[key], depth + 1)])];
      } finally { active.delete(object); }
    }
    return Object.freeze({ $zerocopyRedux: 1 as const, value: walk(value, 0) });
  }
  function decode(envelope: unknown): unknown {
    if (!isPlainRecord(envelope) || envelope.$zerocopyRedux !== 1 || !hasOwn(envelope, 'value') || Object.keys(envelope).length !== 2) fail('invalid or unsupported persistence envelope');
    const visit = budget();
    let arena: Arena | undefined;
    const target = () => arena ??= new Arena();
    function array(value: unknown, payload = false): any[] {
      if (!Array.isArray(value)) fail('invalid encoded array');
      if (payload) size((value as unknown[]).length);
      return value as any[];
    }
    function walk(input: unknown, depth: number): any {
      visit(depth);
      if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
      if (typeof input === 'number' && Number.isFinite(input)) return input;
      const node = array(input), tag = node[0];
      if (tag === 'u' && node.length === 1) return undefined;
      if (tag === 'n' && node.length === 2) {
        if (node[1] === 'NaN') return NaN;
        if (node[1] === 'Infinity') return Infinity;
        if (node[1] === '-Infinity') return -Infinity;
        if (node[1] === '-0') return -0;
        fail('invalid number tag');
      }
      if (tag === 'a' && node.length === 2) {
        const values = array(node[1], true), result = new Array(values.length);
        for (let i = 0; i < values.length; i++) {
          if (Array.isArray(values[i]) && values[i].length === 1 && values[i][0] === 'h') { visit(depth + 1); continue; }
          result[i] = walk(values[i], depth + 1);
        }
        return result;
      }
      if ((tag === 'o' || tag === 'z') && node.length === 2) {
        const result = tag === 'z' ? Object.create(null) : {};
        for (const pair of array(node[1], true)) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || hasOwn(result, pair[0])) fail('invalid or duplicate object key');
          Object.defineProperty(result, pair[0], { value: walk(pair[1], depth + 1), enumerable: true, configurable: true, writable: true });
        }
        return result;
      }
      if (tag !== 'c' || node.length !== 5 || typeof node[1] !== 'string' || !hasOwn(classes, node[1])) fail('invalid collection tag');
      const kind = node[1] as Kind, type = node[2], extra = node[3], items = array(node[4], true);
      if (setKind(kind)) { if (type !== '') fail('invalid set value type'); }
      else checkValueType(type);
      if (kind === 'SharedPriorityQueue' ? typeof extra !== 'boolean' : extra !== null) fail('invalid collection options');
      if (kind === 'SharedPriorityQueue') return restoreReduxHeap(items, type, extra, target(), item => walk(item, depth + 1), value => checkValue(type, value));
      const empty = { root: 0, head: 0, tail: 0, tailSize: 0, block: 0, depth: 0, size: 0, type, valueType: setKind(kind) ? 'number' : type };
      let result: any = structureRegistry[kind].fromWorkerData(empty, target());
      if (mapKind(kind)) {
        const entries: [string, any][] = items.map(pair => {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') fail('invalid map entry');
          const value = walk(pair[1], depth + 1); checkValue(type, value); return [pair[0], value];
        });
        if (kind === 'SharedMap') result = result.setMany(entries);
        else for (const [key, value] of entries) result = result.set(key, value);
      } else {
        const values = items.map(item => walk(item, depth + 1));
        if (setKind(kind)) {
          for (const value of values) {
            if (typeof value !== 'string' && typeof value !== 'number') fail('invalid set value');
            result = result.add(value);
          }
        } else {
          for (const value of values) checkValue(type, value);
          if (kind === 'SharedList') result = result.pushMany(values);
          else if (kind === 'SharedStack') for (let i = values.length - 1; i >= 0; i--) result = result.push(values[i]);
          else if (kind === 'SharedQueue') for (const value of values) result = result.enqueue(value);
          else for (const value of values) result = result.append(value);
        }
      }
      if (result.size !== items.length) fail('duplicate collection entries');
      return result;
    }
    return walk(envelope.value, 0);
  }
  function stringify(value: unknown): string {
    const text = JSON.stringify(encode(value));
    if (text.length > limits.maxTextLength) throw new RangeError('zerocopy Redux: text limit exceeded');
    return text;
  }
  function parse(text: string): unknown {
    if (typeof text !== 'string' || text.length > limits.maxTextLength) throw new RangeError('zerocopy Redux: text limit exceeded');
    return decode(JSON.parse(text));
  }
  return Object.freeze({ encode, decode, stringify, parse });
}
export type ZerocopyCodec = ReturnType<typeof createZerocopyCodec>;
