import {
  freezeJSON,
  parseNestedType,
  structureRegistry,
  FORMAT_VERSION,
  HEAP_START,
  MAX_SIZE,
  hashBytes,
  arenaOf,
  Arena
} from "./chunk-bngxdyck.js";
import {
  SharedMap2
} from "./chunk-fvjmff4x.js";
import {
  SharedList2
} from "./chunk-374wjbs3.js";
import {
  SharedSet2,
  SharedStack2,
  SharedQueue2,
  SharedLinkedList2,
  SharedDoublyLinkedList2,
  SharedOrderedMap2,
  SharedOrderedSet2,
  SharedSortedMap2,
  SharedSortedSet2,
  SharedPriorityQueue2,
  compactMany2,
  getWorkerData2
} from "./chunk-3vp3v6rm.js";
import {
  createSharedSession2
} from "./chunk-n5dt0egz.js";

// redux-heap-codec.ts
function readReduxHeap(heap, encode) {
  const arena = arenaOf(heap), nodes = heap.root ? [heap.root] : [], rows = [];
  for (let i = 0;i < nodes.length; i++) {
    if (nodes.length > heap.size)
      throw new TypeError("Invalid heap size");
    const node = nodes[i], left = arena.dv.getUint32(node + 16, true), right = arena.dv.getUint32(node + 20, true);
    const leftIndex = left ? nodes.push(left) - 1 : -1;
    const rightIndex = right ? nodes.push(right) - 1 : -1;
    rows.push([
      encode(arena.decode(heap.valueType, arena.dv.getFloat64(node + 8, true))),
      encode(arena.dv.getFloat64(node, true)),
      leftIndex,
      rightIndex
    ]);
  }
  if (rows.length !== heap.size)
    throw new TypeError("Invalid heap size");
  return rows;
}
function restoreReduxHeap(rows, type, isMaxHeap, arena, decode, check) {
  const bad = () => {
    throw new TypeError("zerocopy Redux: invalid heap topology or priority");
  };
  const parents = new Uint8Array(rows.length), ranks = new Uint32Array(rows.length), sizes = new Uint32Array(rows.length);
  const priorities = [], values = [];
  for (let i = 0;i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length !== 4)
      bad();
    const priority = decode(row[1]);
    if (typeof priority !== "number" || Number.isNaN(priority))
      bad();
    priorities.push(priority);
    const value = decode(row[0]);
    check(value);
    values.push(arena.encode(type, value));
    for (const child of [row[2], row[3]]) {
      if (!Number.isSafeInteger(child) || child < -1 || child >= rows.length || child !== -1 && child <= i)
        bad();
      if (child !== -1 && ++parents[child] !== 1)
        bad();
    }
  }
  for (let i = 1;i < rows.length; i++)
    if (parents[i] !== 1)
      bad();
  for (let i = rows.length - 1;i >= 0; i--) {
    const [, , left, right] = rows[i], leftRank = left === -1 ? 0 : ranks[left], rightRank = right === -1 ? 0 : ranks[right];
    if (leftRank < rightRank)
      bad();
    for (const child of [left, right])
      if (child !== -1 && (isMaxHeap ? priorities[child] > priorities[i] : priorities[child] < priorities[i]))
        bad();
    ranks[i] = rightRank + 1;
    sizes[i] = 1 + (left === -1 ? 0 : sizes[left]) + (right === -1 ? 0 : sizes[right]);
  }
  const root = rows.length ? arena.alloc(rows.length * 32) : 0, view = arena.dv;
  for (let i = 0;i < rows.length; i++) {
    const p = root + i * 32, [, , left, right] = rows[i];
    view.setFloat64(p, priorities[i], true);
    view.setFloat64(p + 8, values[i], true);
    view.setUint32(p + 16, left === -1 ? 0 : root + left * 32, true);
    view.setUint32(p + 20, right === -1 ? 0 : root + right * 32, true);
    view.setUint32(p + 24, ranks[i], true);
    view.setUint32(p + 28, sizes[i], true);
  }
  return new SharedPriorityQueue2(type, { root, size: rows.length, isMaxHeap }, arena);
}

// redux-codec.ts
var classes = Object.freeze({
  SharedMap: SharedMap2,
  SharedList: SharedList2,
  SharedSet: SharedSet2,
  SharedStack: SharedStack2,
  SharedQueue: SharedQueue2,
  SharedLinkedList: SharedLinkedList2,
  SharedDoublyLinkedList: SharedDoublyLinkedList2,
  SharedOrderedMap: SharedOrderedMap2,
  SharedOrderedSet: SharedOrderedSet2,
  SharedSortedMap: SharedSortedMap2,
  SharedSortedSet: SharedSortedSet2,
  SharedPriorityQueue: SharedPriorityQueue2
});
var kinds = Object.freeze(Object.keys(classes));
function sharedCollectionKind(value) {
  if (!value || typeof value !== "object" || !Object.isFrozen(value))
    return;
  const prototype = Object.getPrototypeOf(value);
  const kind = kinds.find((key) => prototype === classes[key].prototype);
  if (!kind)
    return;
  try {
    arenaOf(value);
    return kind;
  } catch {
    return;
  }
}
function isSharedCollection(value) {
  return sharedCollectionKind(value) !== undefined;
}
function isPlainRecord(value) {
  if (!value || typeof value !== "object")
    return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null)
    return true;
  let root = proto;
  while (Object.getPrototypeOf(root) !== null)
    root = Object.getPrototypeOf(root);
  return proto === root;
}
function fail(message) {
  throw new TypeError(`zerocopy Redux: ${message}`);
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function setKind(kind) {
  return kind === "SharedSet" || kind === "SharedOrderedSet" || kind === "SharedSortedSet";
}
function mapKind(kind) {
  return kind === "SharedMap" || kind === "SharedOrderedMap" || kind === "SharedSortedMap";
}
function checkValueType(type, depth = 0) {
  if (typeof type !== "string" || depth > 64)
    fail("invalid value type");
  if (["string", "number", "boolean", "object"].includes(type))
    return;
  const nested = parseNestedType(type);
  if (!nested || !hasOwn(classes, nested.structureType))
    fail("invalid nested value type");
  checkValueType(nested.innerType, depth + 1);
}
function checkJSON(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === "string" || typeof item === "boolean")
      continue;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0))
      continue;
    if (Array.isArray(item)) {
      for (let i = 0;i < item.length; i++) {
        if (!hasOwn(item, i))
          fail("object values must be JSON");
        pending.push(item[i]);
      }
    } else if (isPlainRecord(item) && Object.getPrototypeOf(item) !== null) {
      for (const key of Object.keys(item))
        pending.push(item[key]);
    } else
      fail("object values must be JSON");
  }
}
function checkValue(type, value) {
  const nested = parseNestedType(type);
  if (nested) {
    const kind = sharedCollectionKind(value);
    if (kind !== nested.structureType)
      fail("nested collection type mismatch");
    if (!setKind(kind)) {
      const d = value.toWorkerData();
      if ((d.valueType ?? d.type) !== nested.innerType)
        fail("nested value type mismatch");
    }
  } else if (type === "object")
    checkJSON(value);
  else if (typeof value !== type)
    fail(`expected ${type}`);
}
function createZerocopyCodec(options = {}) {
  const limits = {
    maxDepth: options.maxDepth ?? 128,
    maxNodes: options.maxNodes ?? 1e6,
    maxCollectionSize: options.maxCollectionSize ?? 1e6,
    maxTextLength: options.maxTextLength ?? 64 * 1024 * 1024
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`Invalid ${key}`);
  }
  function budget() {
    let nodes = 0;
    return (depth) => {
      if (depth > limits.maxDepth || ++nodes > limits.maxNodes)
        throw new RangeError("zerocopy Redux: codec limit exceeded");
    };
  }
  function size(length) {
    if (length > limits.maxCollectionSize)
      throw new RangeError("zerocopy Redux: collection limit exceeded");
  }
  function encode(value) {
    const visit = budget(), active = new WeakSet;
    function walk(input, depth) {
      visit(depth);
      if (input === null || typeof input === "string" || typeof input === "boolean")
        return input;
      if (typeof input === "number") {
        if (Number.isNaN(input))
          return ["n", "NaN"];
        if (!Number.isFinite(input))
          return ["n", input > 0 ? "Infinity" : "-Infinity"];
        return Object.is(input, -0) ? ["n", "-0"] : input;
      }
      if (input === undefined)
        return ["u"];
      if (typeof input !== "object")
        fail(`unsupported ${typeof input}`);
      const object = input;
      if (active.has(object))
        fail("cyclic state is not supported");
      active.add(object);
      try {
        const kind = sharedCollectionKind(input);
        if (kind) {
          const collection = input;
          size(collection.size);
          const d = collection.toWorkerData();
          const type = setKind(kind) ? "" : d.valueType ?? d.type;
          if (!setKind(kind))
            checkValueType(type);
          const items = [];
          if (mapKind(kind)) {
            for (const [key, item] of collection.entries())
              items.push([key, walk(item, depth + 1)]);
          } else if (kind === "SharedPriorityQueue") {
            return [
              "c",
              kind,
              type,
              collection.isMaxHeap,
              readReduxHeap(collection, (item) => walk(item, depth + 1))
            ];
          } else if (kind === "SharedStack") {
            let cursor = collection;
            while (!cursor.isEmpty) {
              items.push(walk(cursor.peek(), depth + 1));
              cursor = cursor.pop();
            }
          } else if (kind === "SharedQueue") {
            let cursor = collection;
            while (!cursor.isEmpty) {
              items.push(walk(cursor.peek(), depth + 1));
              cursor = cursor.dequeue();
            }
          } else
            collection.forEach((item) => items.push(walk(item, depth + 1)));
          return ["c", kind, type, null, items];
        }
        if (!Array.isArray(input) && !isPlainRecord(input))
          fail("only plain records, arrays, and shared collections are supported");
        const descriptors = Object.getOwnPropertyDescriptors(input);
        for (const key of Reflect.ownKeys(descriptors)) {
          const descriptor = descriptors[key];
          if (descriptor.enumerable && (typeof key === "symbol" || !hasOwn(descriptor, "value")))
            fail("enumerable symbols and accessors are not supported");
        }
        if (Array.isArray(input)) {
          size(input.length);
          if (Object.keys(input).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))
            fail("array properties are not supported");
          const entries = [];
          for (let i = 0;i < input.length; i++) {
            if (hasOwn(input, i))
              entries.push(walk(input[i], depth + 1));
            else {
              visit(depth + 1);
              entries.push(["h"]);
            }
          }
          return ["a", entries];
        }
        const keys = Object.keys(input);
        size(keys.length);
        return [Object.getPrototypeOf(input) === null ? "z" : "o", keys.map((key) => [key, walk(input[key], depth + 1)])];
      } finally {
        active.delete(object);
      }
    }
    return Object.freeze({ $zerocopyRedux: 1, value: walk(value, 0) });
  }
  function decode(envelope) {
    if (!isPlainRecord(envelope) || envelope.$zerocopyRedux !== 1 || !hasOwn(envelope, "value") || Object.keys(envelope).length !== 2)
      fail("invalid or unsupported persistence envelope");
    const visit = budget();
    let arena;
    const target = () => arena ??= new Arena;
    function array(value, payload = false) {
      if (!Array.isArray(value))
        fail("invalid encoded array");
      if (payload)
        size(value.length);
      return value;
    }
    function walk(input, depth) {
      visit(depth);
      if (input === null || typeof input === "string" || typeof input === "boolean")
        return input;
      if (typeof input === "number" && Number.isFinite(input))
        return input;
      const node = array(input), tag = node[0];
      if (tag === "u" && node.length === 1)
        return;
      if (tag === "n" && node.length === 2) {
        if (node[1] === "NaN")
          return NaN;
        if (node[1] === "Infinity")
          return Infinity;
        if (node[1] === "-Infinity")
          return -Infinity;
        if (node[1] === "-0")
          return -0;
        fail("invalid number tag");
      }
      if (tag === "a" && node.length === 2) {
        const values = array(node[1], true), result = new Array(values.length);
        for (let i = 0;i < values.length; i++) {
          if (Array.isArray(values[i]) && values[i].length === 1 && values[i][0] === "h") {
            visit(depth + 1);
            continue;
          }
          result[i] = walk(values[i], depth + 1);
        }
        return result;
      }
      if ((tag === "o" || tag === "z") && node.length === 2) {
        const result = tag === "z" ? Object.create(null) : {};
        for (const pair of array(node[1], true)) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || hasOwn(result, pair[0]))
            fail("invalid or duplicate object key");
          Object.defineProperty(result, pair[0], { value: walk(pair[1], depth + 1), enumerable: true, configurable: true, writable: true });
        }
        return result;
      }
      if (tag !== "c" || node.length !== 5 || typeof node[1] !== "string" || !hasOwn(classes, node[1]))
        fail("invalid collection tag");
      const kind = node[1], type = node[2], extra = node[3], items = array(node[4], true);
      if (setKind(kind)) {
        if (type !== "")
          fail("invalid set value type");
      } else
        checkValueType(type);
      if (kind === "SharedPriorityQueue" ? typeof extra !== "boolean" : extra !== null)
        fail("invalid collection options");
      if (kind === "SharedPriorityQueue")
        return restoreReduxHeap(items, type, extra, target(), (item) => walk(item, depth + 1), (value) => checkValue(type, value));
      const empty = { root: 0, head: 0, tail: 0, tailSize: 0, block: 0, depth: 0, size: 0, type, valueType: setKind(kind) ? "number" : type };
      let result = structureRegistry[kind].fromWorkerData(empty, target());
      if (mapKind(kind)) {
        const entries = items.map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string")
            fail("invalid map entry");
          const value = walk(pair[1], depth + 1);
          checkValue(type, value);
          return [pair[0], value];
        });
        if (kind === "SharedMap")
          result = result.setMany(entries);
        else
          for (const [key, value] of entries)
            result = result.set(key, value);
      } else {
        const values = items.map((item) => walk(item, depth + 1));
        if (setKind(kind)) {
          for (const value of values) {
            if (typeof value !== "string" && typeof value !== "number")
              fail("invalid set value");
            result = result.add(value);
          }
        } else {
          for (const value of values)
            checkValue(type, value);
          if (kind === "SharedList")
            result = result.pushMany(values);
          else if (kind === "SharedStack")
            for (let i = values.length - 1;i >= 0; i--)
              result = result.push(values[i]);
          else if (kind === "SharedQueue")
            for (const value of values)
              result = result.enqueue(value);
          else
            for (const value of values)
              result = result.append(value);
        }
      }
      if (result.size !== items.length)
        fail("duplicate collection entries");
      return result;
    }
    return walk(envelope.value, 0);
  }
  function stringify(value) {
    const text = JSON.stringify(encode(value));
    if (text.length > limits.maxTextLength)
      throw new RangeError("zerocopy Redux: text limit exceeded");
    return text;
  }
  function parse(text) {
    if (typeof text !== "string" || text.length > limits.maxTextLength)
      throw new RangeError("zerocopy Redux: text limit exceeded");
    return decode(JSON.parse(text));
  }
  return Object.freeze({ encode, decode, stringify, parse });
}

// redux-jsan.ts
var TEXT_TAG = "$zerocopyReduxText";

class Decoded {
  #value;
  constructor(value) {
    this.#value = value;
  }
  unwrap() {
    return this.#value;
  }
}
function createPortableSerialization(codec = createZerocopyCodec()) {
  const decodedObjects = new WeakSet;
  const wrap = (value) => ({ [TEXT_TAG]: codec.stringify(value) });
  const unwrap = (value) => {
    if (value instanceof Decoded) {
      const result = value.unwrap();
      if (result !== null && typeof result === "object")
        decodedObjects.add(result);
      return result;
    }
    if (!Array.isArray(value) && !isPlainRecord(value) || decodedObjects.has(value))
      return value;
    for (const key of Object.keys(value)) {
      Object.defineProperty(value, key, { value: unwrap(value[key]), enumerable: true, configurable: true, writable: true });
    }
    return value;
  };
  return {
    options: {
      date: undefined,
      refs: false,
      circular() {
        throw new TypeError("zerocopy Redux: cyclic DevTools state is not supported");
      }
    },
    replacer(_key, value) {
      if (isSharedCollection(value))
        return wrap(value);
      if (value === undefined || typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)) || value === "$jsan")
        return wrap(value);
      if (isPlainRecord(value) && (Object.getPrototypeOf(value) === null || Object.hasOwn(value, "") || Object.hasOwn(value, "__proto__") || Object.hasOwn(value, "$jsan") || Object.hasOwn(value, "$zerocopyRedux") || Object.hasOwn(value, TEXT_TAG)))
        return wrap(value);
      if (Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length !== value.length || keys.some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
          return wrap(value);
      } else if (value !== null && typeof value === "object" && !isPlainRecord(value)) {
        return wrap(value);
      }
      if (["function", "symbol", "bigint"].includes(typeof value))
        return wrap(value);
      return value;
    },
    reviver(key, value) {
      let result = value;
      if (isPlainRecord(value) && Object.keys(value).length === 1 && typeof value[TEXT_TAG] === "string") {
        result = new Decoded(codec.parse(value[TEXT_TAG]));
      }
      return key === "" ? unwrap(result) : result;
    }
  };
}
// redux-internal.ts
var collectionConstructors = Object.freeze({
  SharedMap: SharedMap2,
  SharedList: SharedList2,
  SharedSet: SharedSet2,
  SharedStack: SharedStack2,
  SharedQueue: SharedQueue2,
  SharedLinkedList: SharedLinkedList2,
  SharedDoublyLinkedList: SharedDoublyLinkedList2,
  SharedOrderedMap: SharedOrderedMap2,
  SharedOrderedSet: SharedOrderedSet2,
  SharedSortedMap: SharedSortedMap2,
  SharedSortedSet: SharedSortedSet2,
  SharedPriorityQueue: SharedPriorityQueue2
});
var prototypes = new Map(Object.entries(collectionConstructors).map(([name, C]) => [C.prototype, name]));
function isPlainRecord2(value) {
  if (value === null || typeof value !== "object")
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
function collectionKind(value) {
  if (value === null || typeof value !== "object" || !Object.isFrozen(value))
    return;
  const kind = prototypes.get(Object.getPrototypeOf(value));
  if (!kind)
    return;
  try {
    arenaOf(value);
    return kind;
  } catch {
    return;
  }
}
function isZerocopyCollection(value) {
  return collectionKind(value) !== undefined;
}

// redux-checkpoint.ts
function fail2(message) {
  throw new TypeError(`zerocopy/redux: ${message}`);
}
function limits(options) {
  const result = { maxBytes: options.maxBytes ?? 64 * 1024 * 1024, maxNodes: options.maxNodes ?? 1e5, maxDepth: options.maxDepth ?? 128 };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1)
      fail2(`${key} must be a positive safe integer`);
  }
  return result;
}
function toBase64(bytes) {
  const parts = [];
  for (let start = 0;start < bytes.length; start += 24576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 24576))));
  }
  return parts.join("");
}
function fromBase64(text, length) {
  if (text.length !== Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    fail2("invalid base64 arena");
  const raw = atob(text);
  if (raw.length !== length)
    fail2("arena length does not match its data");
  const bytes = new Uint8Array(length);
  for (let i = 0;i < length; i++)
    bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor))
    fail2("state accessors are not supported");
  return descriptor.value;
}
function noSymbols(value) {
  if (Object.getOwnPropertySymbols(value).length)
    fail2("symbol properties are not supported");
}
function numberNode(value) {
  return ["number", Number.isNaN(value) ? "NaN" : value === Infinity ? "+Infinity" : value === -Infinity ? "-Infinity" : Object.is(value, -0) ? "-0" : value];
}
function encodeZerocopyState(state, options = {}) {
  const bound = limits(options), active = new WeakSet, names = new WeakMap;
  const snapshots = Object.create(null);
  let nodes = 0, count = 0;
  const visit = (value, depth) => {
    if (++nodes > bound.maxNodes || depth > bound.maxDepth)
      fail2("state tree exceeds codec limits");
    if (value === undefined)
      return ["undefined"];
    if (value === null)
      return ["null"];
    if (typeof value === "string" || typeof value === "boolean")
      return [typeof value, value];
    if (typeof value === "number")
      return numberNode(value);
    if (isZerocopyCollection(value)) {
      try {
        value.toWorkerData();
      } catch {
        fail2("custom comparator collections cannot be persisted; use data-only ordering or summary DevTools");
      }
      let name = names.get(value);
      if (name === undefined) {
        name = `s${count++}`;
        names.set(value, name);
        snapshots[name] = value;
      }
      return ["snapshot", name];
    }
    if (!Array.isArray(value) && !isPlainRecord2(value))
      fail2(`unsupported state value (${typeof value})`);
    const object = value;
    noSymbols(object);
    if (active.has(object))
      fail2("cyclic state is not supported");
    active.add(object);
    try {
      if (Array.isArray(value)) {
        if (value.length > bound.maxNodes)
          fail2("array exceeds codec limits");
        for (const key of Object.keys(value)) {
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
            fail2("extra array properties are not supported");
        }
        const children = [];
        for (let i = 0;i < value.length; i++) {
          if (Object.hasOwn(value, i))
            children.push(visit(ownValue(value, String(i)), depth + 1));
          else {
            if (++nodes > bound.maxNodes)
              fail2("state tree exceeds codec limits");
            children.push(["hole"]);
          }
        }
        return ["array", children];
      }
      return [Object.getPrototypeOf(value) === null ? "null-object" : "object", Object.keys(value).map((key) => [key, visit(ownValue(object, key), depth + 1)])];
    } finally {
      active.delete(object);
    }
  };
  const tree = visit(state, 0);
  const transport = getWorkerData2(count ? compactMany2(snapshots) : snapshots, { copy: true });
  let total = 0;
  const arenas = transport.arenas.map((source) => {
    total += source.used;
    if (total > bound.maxBytes)
      fail2("arena data exceeds maxBytes");
    const copy = source.copy;
    return { id: source.id, used: source.used, checksum: hashBytes(copy), base64: toBase64(copy) };
  });
  return freezeJSON({ codec: "zerocopy-redux", version: 1, format: FORMAT_VERSION, tree, arenas, structures: transport.structures });
}
function validDescriptor(value, used) {
  if (!isPlainRecord2(value))
    return false;
  for (const [key, item] of Object.entries(value)) {
    if (["valueType", "type"].includes(key)) {
      if (typeof item !== "string" || !item.length || item.length > 1024)
        return false;
    } else if (["isMaxHeap", "orderStable"].includes(key)) {
      if (typeof item !== "boolean")
        return false;
    } else if (["root", "head", "tail", "block", "size", "depth", "tailSize"].includes(key)) {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
        return false;
      if (key === "size" && item > MAX_SIZE)
        return false;
      if (["root", "head", "block"].includes(key) && item !== 0 && (item < HEAP_START || item >= used || item % 4 !== 0))
        return false;
    } else
      return false;
  }
  return typeof value.size === "number";
}
function decodeZerocopyState(input, options = {}) {
  const bound = limits(options);
  if (!isPlainRecord2(input) || input.codec !== "zerocopy-redux" || input.version !== 1 || input.format !== FORMAT_VERSION)
    fail2("unsupported checkpoint version or binary format");
  if (!Array.isArray(input.arenas) || !isPlainRecord2(input.structures))
    fail2("invalid checkpoint tables");
  if (input.arenas.length > bound.maxNodes || Object.keys(input.structures).length > bound.maxNodes)
    fail2("checkpoint tables exceed codec limits");
  const copies = new Map;
  let total = 0;
  for (const item of input.arenas) {
    if (!isPlainRecord2(item) || typeof item.id !== "string" || !item.id.length || item.id.length > 256 || copies.has(item.id) || typeof item.used !== "number" || !Number.isSafeInteger(item.used) || item.used < HEAP_START || item.used > 2147352576 || typeof item.base64 !== "string" || typeof item.checksum !== "number" || !Number.isInteger(item.checksum) || item.checksum < 0 || item.checksum > 4294967295)
      fail2("invalid arena record");
    total += item.used;
    if (total > bound.maxBytes)
      fail2("arena data exceeds maxBytes");
    const copy = fromBase64(item.base64, item.used);
    if (hashBytes(copy) !== item.checksum)
      fail2("arena checksum mismatch");
    copies.set(item.id, { used: item.used, copy });
  }
  const descriptors = new Map;
  for (const [name, item] of Object.entries(input.structures)) {
    if (!/^s(0|[1-9][0-9]*)$/.test(name) || !isPlainRecord2(item) || typeof item.type !== "string" || !Object.hasOwn(collectionConstructors, item.type) || typeof item.arena !== "string" || !copies.has(item.arena) || !validDescriptor(item.data, copies.get(item.arena).used))
      fail2("invalid collection descriptor");
    descriptors.set(name, item);
  }
  let nodes = 0;
  const active = new WeakSet;
  const walk = (node, depth, resolve) => {
    if (++nodes > bound.maxNodes || depth > bound.maxDepth)
      fail2("state tree exceeds codec limits");
    if (!Array.isArray(node) || active.has(node))
      fail2("invalid or cyclic state node");
    active.add(node);
    try {
      const tag = node[0], value = node[1];
      if (tag === "null" && node.length === 1)
        return null;
      if (tag === "undefined" && node.length === 1)
        return;
      if (node.length !== 2)
        fail2("invalid state node length");
      if (tag === "string" && typeof value === "string")
        return value;
      if (tag === "boolean" && typeof value === "boolean")
        return value;
      if (tag === "number") {
        if (typeof value === "number" && Number.isFinite(value))
          return value;
        if (value === "NaN")
          return NaN;
        if (value === "+Infinity")
          return Infinity;
        if (value === "-Infinity")
          return -Infinity;
        if (value === "-0")
          return -0;
        fail2("invalid number node");
      }
      if (tag === "snapshot" && typeof value === "string" && descriptors.has(value))
        return resolve?.[value];
      if (tag === "array" && Array.isArray(value)) {
        if (value.length > bound.maxNodes)
          fail2("array exceeds codec limits");
        const array = new Array(value.length);
        for (let i = 0;i < value.length; i++) {
          if (Array.isArray(value[i]) && value[i].length === 1 && value[i][0] === "hole") {
            if (++nodes > bound.maxNodes)
              fail2("state tree exceeds codec limits");
          } else
            array[i] = walk(value[i], depth + 1, resolve);
        }
        return Object.freeze(array);
      }
      if ((tag === "object" || tag === "null-object") && Array.isArray(value)) {
        const object = tag === "null-object" ? Object.create(null) : {};
        for (const pair of value) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || Object.hasOwn(object, pair[0]))
            fail2("invalid object entry");
          Object.defineProperty(object, pair[0], { value: walk(pair[1], depth + 1, resolve), enumerable: true, writable: true, configurable: true });
        }
        return Object.freeze(object);
      }
      return fail2("unknown or invalid state node");
    } finally {
      active.delete(node);
    }
  };
  walk(input.tree, 0);
  const arenas = new Map;
  for (const [id, data] of copies)
    arenas.set(id, new Arena({ ...data, id, readOnly: true }));
  for (const arena of arenas.values())
    for (const dependency of arenas.values())
      if (arena !== dependency)
        arena.dependencies.set(dependency.id, dependency);
  const attached = Object.create(null);
  for (const [name, item] of descriptors)
    attached[name] = structureRegistry[item.type].fromWorkerData(item.data, arenas.get(item.arena));
  const restored = descriptors.size ? compactMany2(attached) : attached;
  nodes = 0;
  return walk(input.tree, 0, restored);
}
function serializeZerocopyState(state, options = {}) {
  return JSON.stringify(encodeZerocopyState(state, options));
}
function deserializeZerocopyState(text, options = {}) {
  if (typeof text !== "string")
    fail2("checkpoint must be a JSON string");
  return decodeZerocopyState(JSON.parse(text), options);
}
// worker-redux.ts
function reduxSource(store, select) {
  return {
    getSnapshot: () => select(store.getState()),
    subscribe: (listener) => store.subscribe(listener)
  };
}
function bindRedux(store, options) {
  const { select, ...sessionOptions } = options;
  return createSharedSession2({ source: reduxSource(store, select) }, sessionOptions);
}

// redux.ts
var isZerocopyCollection2 = isSharedCollection;
function isZerocopySerializable(value) {
  if (isSharedCollection(value)) {
    try {
      value.toWorkerData();
      return true;
    } catch {
      return false;
    }
  }
  return value == null || ["string", "boolean", "number"].includes(typeof value) || Array.isArray(value) || isPlainRecord(value);
}
function getZerocopyEntries(value) {
  if (isSharedCollection(value) || value === null || typeof value !== "object")
    return [];
  return Object.entries(value);
}
var zerocopySerializableCheck = Object.freeze({ isSerializable: isZerocopySerializable, getEntries: getZerocopyEntries });
var zerocopyImmutableCheck = Object.freeze({
  isImmutable(value) {
    return value === null || typeof value !== "object" || Object.isFrozen(value);
  }
});
var zerocopyMiddlewareOptions = Object.freeze({ serializableCheck: zerocopySerializableCheck, immutableCheck: zerocopyImmutableCheck });
function createSharedMapEntrySelector(selectMap, selectKey) {
  let lastArena, lastLeaf = -1, lastType;
  let lastValue;
  return (state, ...args) => {
    const map = selectMap(state, ...args), key = selectKey(state, ...args);
    if (sharedCollectionKind(map) !== "SharedMap")
      throw new TypeError("Expected a frozen SharedMap");
    const arena = arenaOf(map), leaf = arena.find(map.root, key);
    if (arena !== lastArena || leaf !== lastLeaf || map.valueType !== lastType) {
      lastValue = leaf ? arena.leafValue(map.valueType, leaf) : undefined;
      lastArena = arena;
      lastLeaf = leaf;
      lastType = map.valueType;
    }
    return lastValue;
  };
}
function createSharedMapValueSelector(selectMap, selectKey) {
  return createSharedMapEntrySelector(selectMap, selectKey);
}
function setSharedMapValue(map, key, value, equals = Object.is) {
  if (sharedCollectionKind(map) !== "SharedMap")
    throw new TypeError("Expected a frozen SharedMap");
  return map.has(key) && equals(map.get(key), value) ? map : map.set(key, value);
}
function sanitizeZerocopyState(state) {
  const seen = new WeakMap;
  const visit = (value, depth) => {
    if (isSharedCollection(value)) {
      return Object.freeze({ $zerocopy: sharedCollectionKind(value), size: value.size, valueType: "valueType" in value ? value.valueType : "string | number" });
    }
    if (!Array.isArray(value) && !isPlainRecord(value) || value === null)
      return value;
    if (seen.has(value))
      return seen.get(value);
    if (depth > 128)
      return "[Depth limit]";
    const result = Array.isArray(value) ? new Array(value.length) : Object.create(null);
    seen.set(value, result);
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      Object.defineProperty(result, key, { value: "value" in property ? visit(property.value, depth + 1) : "[Accessor]", enumerable: true, configurable: true, writable: true });
    }
    return Object.freeze(result);
  };
  return visit(state, 0);
}
var summarizeZerocopyState = sanitizeZerocopyState;
function createZerocopyDevToolsOptions(options = {}) {
  const maxAge = options.maxAge ?? 50;
  if (!Number.isSafeInteger(maxAge) || maxAge < 2)
    throw new RangeError("DevTools maxAge must be at least 2");
  if (options.mode !== undefined && options.mode !== "summary" && options.mode !== "portable")
    throw new TypeError("Invalid DevTools mode");
  if (options.mode !== "portable")
    return {
      maxAge,
      stateSanitizer: sanitizeZerocopyState,
      actionSanitizer: sanitizeZerocopyState,
      features: { pause: true, lock: true, jump: true, skip: true, reorder: true, dispatch: true, import: false, export: false, persist: false, test: false }
    };
  return { maxAge, serialize: createPortableSerialization(options.codec ?? createZerocopyCodec()) };
}
var createZerocopyDevTools = createZerocopyDevToolsOptions;
export {
  bindRedux,
  createSharedMapEntrySelector,
  createSharedMapValueSelector,
  createZerocopyCodec,
  createZerocopyDevTools,
  createZerocopyDevToolsOptions,
  decodeZerocopyState,
  deserializeZerocopyState,
  encodeZerocopyState,
  getZerocopyEntries,
  isSharedCollection,
  isZerocopyCollection2 as isZerocopyCollection,
  isZerocopySerializable,
  reduxSource,
  sanitizeZerocopyState,
  serializeZerocopyState,
  setSharedMapValue,
  summarizeZerocopyState,
  zerocopyImmutableCheck,
  zerocopyMiddlewareOptions,
  zerocopySerializableCheck
};
