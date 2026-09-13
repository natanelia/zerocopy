import { Arena, FORMAT_VERSION, HEAP_START, MAX_SIZE, freezeJSON, hashBytes } from './arena';
import { compactMany, getWorkerData } from './shared';
import { structureRegistry } from './codec';
import { collectionConstructors, isPlainRecord, isZerocopyCollection } from './redux-internal';
import type { SharedCollection } from './redux-internal';

/** Resource limits for trusted, application-generated checkpoints. Not a hostile binary validator. */
export interface ZerocopyCodecOptions {
  /** Maximum combined decoded arena bytes. Default: 64 MiB. */
  maxBytes?: number;
  /** Maximum nodes in the surrounding JavaScript state tree. Default: 100,000. */
  maxNodes?: number;
  /** Maximum depth of the surrounding state tree. Default: 128. */
  maxDepth?: number;
}
interface Limits { maxBytes: number; maxNodes: number; maxDepth: number }
interface ArenaRecord { id: string; used: number; checksum: number; base64: string }
interface StructureRecord { type: string; arena: string; data: Record<string, unknown> }
export interface ZerocopyStatePacket {
  readonly codec: 'zerocopy-redux';
  readonly version: 1;
  readonly format: number;
  readonly tree: unknown;
  readonly arenas: readonly Readonly<ArenaRecord>[];
  readonly structures: Readonly<Record<string, Readonly<StructureRecord>>>;
}
const fail = (message: string): never => { throw new TypeError(`zerocopy/redux: ${message}`); };
function limits(options: ZerocopyCodecOptions): Limits {
  const result = { maxBytes: options.maxBytes ?? 64 * 1024 * 1024, maxNodes: options.maxNodes ?? 100000, maxDepth: options.maxDepth ?? 128 };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`${key} must be a positive safe integer`);
  }
  return result;
}
function toBase64(bytes: Uint8Array): string {
  // A multiple of three keeps padding out of all intermediate chunks.
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += 24576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 24576))));
  }
  return parts.join('');
}
function fromBase64(text: string, length: number): Uint8Array {
  if (text.length !== Math.ceil(length / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail('invalid base64 arena');
  const raw = atob(text);
  if (raw.length !== length) fail('arena length does not match its data');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) fail('state accessors are not supported');
  return descriptor.value;
}
function noSymbols(value: object): void {
  if (Object.getOwnPropertySymbols(value).length) fail('symbol properties are not supported');
}
function numberNode(value: number): unknown[] {
  return ['number', Number.isNaN(value) ? 'NaN' : value === Infinity ? '+Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : value];
}

/**
 * Encode a complete checkpoint, not just root pointers. The compact copy contains
 * only selected live data, not deleted values elsewhere in a source arena.
 * The tagged state tree also escapes user keys and preserves undefined and special numbers.
 */
export function encodeZerocopyState(state: unknown, options: ZerocopyCodecOptions = {}): ZerocopyStatePacket {
  const bound = limits(options), active = new WeakSet<object>(), names = new WeakMap<object, string>();
  const snapshots: Record<string, SharedCollection> = Object.create(null);
  let nodes = 0, count = 0;
  const visit = (value: unknown, depth: number): unknown[] => {
    if (++nodes > bound.maxNodes || depth > bound.maxDepth) fail('state tree exceeds codec limits');
    if (value === undefined) return ['undefined'];
    if (value === null) return ['null'];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value === 'number') return numberNode(value);
    if (isZerocopyCollection(value)) {
      // Reject a local comparator before allocating a compact copy.
      try { value.toWorkerData(); } catch { fail('custom comparator collections cannot be persisted; use data-only ordering or summary DevTools'); }
      let name = names.get(value);
      if (name === undefined) { name = `s${count++}`; names.set(value, name); snapshots[name] = value; }
      return ['snapshot', name];
    }
    if (!Array.isArray(value) && !isPlainRecord(value)) fail(`unsupported state value (${typeof value})`);
    const object = value as object;
    noSymbols(object);
    if (active.has(object)) fail('cyclic state is not supported');
    active.add(object);
    try {
      if (Array.isArray(value)) {
        if (value.length > bound.maxNodes) fail('array exceeds codec limits');
        for (const key of Object.keys(value)) {
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail('extra array properties are not supported');
        }
        const children: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          if (Object.hasOwn(value, i)) children.push(visit(ownValue(value, String(i)), depth + 1));
          else { if (++nodes > bound.maxNodes) fail('state tree exceeds codec limits'); children.push(['hole']); }
        }
        return ['array', children];
      }
      return [Object.getPrototypeOf(value) === null ? 'null-object' : 'object', Object.keys(value).map(key => [key, visit(ownValue(object, key), depth + 1)])];
    } finally { active.delete(object); }
  };
  const tree = visit(state, 0);
  const transport = getWorkerData(count ? compactMany(snapshots) : snapshots, { copy: true });
  let total = 0;
  const arenas = transport.arenas.map(source => {
    total += source.used;
    if (total > bound.maxBytes) fail('arena data exceeds maxBytes');
    const copy = source.copy!;
    return { id: source.id, used: source.used, checksum: hashBytes(copy), base64: toBase64(copy) };
  });
  return freezeJSON({ codec: 'zerocopy-redux', version: 1, format: FORMAT_VERSION, tree, arenas, structures: transport.structures }) as ZerocopyStatePacket;
}

function validDescriptor(value: unknown, used: number): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (['valueType', 'type'].includes(key)) { if (typeof item !== 'string' || !item.length || item.length > 1024) return false; }
    else if (['isMaxHeap', 'orderStable'].includes(key)) { if (typeof item !== 'boolean') return false; }
    else if (['root', 'head', 'tail', 'block', 'size', 'depth', 'tailSize'].includes(key)) {
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) return false;
      if (key === 'size' && item > MAX_SIZE) return false;
      if (['root', 'head', 'block'].includes(key) && item !== 0 && (item < HEAP_START || item >= used || item % 4 !== 0)) return false;
    } else return false;
  }
  return typeof value.size === 'number';
}

/**
 * Restore a trusted checkpoint. Version, lengths, checksums, references and tree
 * shape are checked. Checksums are not authentication or full WASM graph validation.
 * A second compaction gives every import a fresh arena identity. Reusing wire arena
 * IDs in writable copies would break nested sharing when two imports are combined.
 */
export function decodeZerocopyState<T = unknown>(input: unknown, options: ZerocopyCodecOptions = {}): T {
  const bound = limits(options);
  if (!isPlainRecord(input) || input.codec !== 'zerocopy-redux' || input.version !== 1 || input.format !== FORMAT_VERSION) fail('unsupported checkpoint version or binary format');
  if (!Array.isArray(input.arenas) || !isPlainRecord(input.structures)) fail('invalid checkpoint tables');
  if (input.arenas.length > bound.maxNodes || Object.keys(input.structures).length > bound.maxNodes) fail('checkpoint tables exceed codec limits');
  // Validate and decode all bytes before constructing a WASM instance.
  const copies = new Map<string, { used: number; copy: Uint8Array }>();
  let total = 0;
  for (const item of input.arenas) {
    if (!isPlainRecord(item) || typeof item.id !== 'string' || !item.id.length || item.id.length > 256 || copies.has(item.id)
      || typeof item.used !== 'number' || !Number.isSafeInteger(item.used) || item.used < HEAP_START || item.used > 0x7ffe0000
      || typeof item.base64 !== 'string' || typeof item.checksum !== 'number' || !Number.isInteger(item.checksum) || item.checksum < 0 || item.checksum > 0xffffffff) fail('invalid arena record');
    total += item.used as number;
    if (total > bound.maxBytes) fail('arena data exceeds maxBytes');
    const copy = fromBase64(item.base64 as string, item.used as number);
    if (hashBytes(copy) !== item.checksum) fail('arena checksum mismatch');
    copies.set(item.id as string, { used: item.used as number, copy });
  }
  const descriptors = new Map<string, StructureRecord>();
  for (const [name, item] of Object.entries(input.structures)) {
    if (!/^s(0|[1-9][0-9]*)$/.test(name) || !isPlainRecord(item) || typeof item.type !== 'string'
      || !Object.hasOwn(collectionConstructors, item.type) || typeof item.arena !== 'string' || !copies.has(item.arena)
      || !validDescriptor(item.data, copies.get(item.arena)!.used)) fail('invalid collection descriptor');
    descriptors.set(name, item as unknown as StructureRecord);
  }
  // Validate the state tree before reading a single collection node.
  let nodes = 0;
  const active = new WeakSet<object>();
  const walk = (node: unknown, depth: number, resolve?: Readonly<Record<string, SharedCollection>>): unknown => {
    if (++nodes > bound.maxNodes || depth > bound.maxDepth) fail('state tree exceeds codec limits');
    if (!Array.isArray(node) || active.has(node)) fail('invalid or cyclic state node');
    active.add(node);
    try {
      const tag = node[0], value = node[1];
      if (tag === 'null' && node.length === 1) return null;
      if (tag === 'undefined' && node.length === 1) return undefined;
      if (node.length !== 2) fail('invalid state node length');
      if (tag === 'string' && typeof value === 'string') return value;
      if (tag === 'boolean' && typeof value === 'boolean') return value;
      if (tag === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (value === 'NaN') return NaN;
        if (value === '+Infinity') return Infinity;
        if (value === '-Infinity') return -Infinity;
        if (value === '-0') return -0;
        fail('invalid number node');
      }
      if (tag === 'snapshot' && typeof value === 'string' && descriptors.has(value)) return resolve?.[value];
      if (tag === 'array' && Array.isArray(value)) {
        if (value.length > bound.maxNodes) fail('array exceeds codec limits');
        const array = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
          if (Array.isArray(value[i]) && value[i].length === 1 && value[i][0] === 'hole') { if (++nodes > bound.maxNodes) fail('state tree exceeds codec limits'); }
          else array[i] = walk(value[i], depth + 1, resolve);
        }
        return Object.freeze(array);
      }
      if ((tag === 'object' || tag === 'null-object') && Array.isArray(value)) {
        const object = tag === 'null-object' ? Object.create(null) : {};
        for (const pair of value) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || Object.hasOwn(object, pair[0])) fail('invalid object entry');
          Object.defineProperty(object, pair[0], { value: walk(pair[1], depth + 1, resolve), enumerable: true, writable: true, configurable: true });
        }
        return Object.freeze(object);
      }
      return fail('unknown or invalid state node');
    } finally { active.delete(node); }
  };
  walk(input.tree, 0);
  const arenas = new Map<string, Arena>();
  for (const [id, data] of copies) arenas.set(id, new Arena({ ...data, id, readOnly: true }));
  for (const arena of arenas.values()) for (const dependency of arenas.values()) if (arena !== dependency) arena.dependencies.set(dependency.id, dependency);
  const attached: Record<string, SharedCollection> = Object.create(null);
  for (const [name, item] of descriptors) attached[name] = structureRegistry[item.type].fromWorkerData(item.data, arenas.get(item.arena));
  const restored = descriptors.size ? compactMany(attached) : attached;
  nodes = 0;
  return walk(input.tree, 0, restored) as T;
}

export function serializeZerocopyState(state: unknown, options: ZerocopyCodecOptions = {}): string {
  return JSON.stringify(encodeZerocopyState(state, options));
}
export function deserializeZerocopyState<T = unknown>(text: string, options: ZerocopyCodecOptions = {}): T {
  if (typeof text !== 'string') fail('checkpoint must be a JSON string');
  return decodeZerocopyState<T>(JSON.parse(text), options);
}
