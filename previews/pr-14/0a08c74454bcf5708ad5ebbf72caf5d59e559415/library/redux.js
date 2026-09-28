import {
  parseNestedType,
  structureRegistry,
  arenaOf,
  Arena,
  SharedMap2
} from "./chunk-4gh7gtyr.js";
import {
  SharedList2,
  SharedSet2,
  SharedStack2,
  SharedQueue2,
  SharedLinkedList2,
  SharedDoublyLinkedList2,
  SharedOrderedMap2,
  SharedOrderedSet2,
  SharedSortedMap2,
  SharedSortedSet2,
  SharedPriorityQueue2
} from "./chunk-agce78jt.js";
import {
  createSharedSession2
} from "./chunk-nfssr91z.js";

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
function isZerocopySerializable(value) {
  if (isSharedCollection(value)) {
    try {
      value.toWorkerData();
      return true;
    } catch {
      return false;
    }
  }
  return value == null || ["undefined", "string", "boolean", "number"].includes(typeof value) || Array.isArray(value) || isPlainRecord(value);
}
function getZerocopyEntries(value) {
  if (isSharedCollection(value) || value === null || typeof value !== "object")
    return [];
  return Object.entries(value);
}
var zerocopyMiddlewareOptions = Object.freeze({
  serializableCheck: Object.freeze({ isSerializable: isZerocopySerializable, getEntries: getZerocopyEntries })
});
function createSharedMapValueSelector(selectMap, selectKey) {
  let lastArena, lastLeaf = -1, lastType;
  let lastValue;
  return (state) => {
    const map = selectMap(state), key = selectKey(state), arena = arenaOf(map);
    const leaf = arena.find(map.root, key);
    if (arena !== lastArena || leaf !== lastLeaf || map.valueType !== lastType) {
      lastValue = leaf ? arena.leafValue(map.valueType, leaf) : undefined;
      lastArena = arena;
      lastLeaf = leaf;
      lastType = map.valueType;
    }
    return lastValue;
  };
}
function setSharedMapValue(map, key, value, equals = Object.is) {
  if (sharedCollectionKind(map) !== "SharedMap")
    throw new TypeError("Expected a frozen SharedMap");
  return map.has(key) && equals(map.get(key), value) ? map : map.set(key, value);
}
function summarizeZerocopyState(state) {
  const seen = new WeakMap;
  const walk = (value) => {
    if (isSharedCollection(value)) {
      let descriptor;
      try {
        descriptor = value.toWorkerData();
      } catch {
        descriptor = "local comparator";
      }
      return { $zerocopy: sharedCollectionKind(value), size: value.size, arena: arenaOf(value).id, snapshot: descriptor };
    }
    if (!value || typeof value !== "object" || !Array.isArray(value) && !isPlainRecord(value))
      return value;
    if (seen.has(value))
      return seen.get(value);
    const result = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
    seen.set(value, result);
    for (const key of Object.keys(value))
      Object.defineProperty(result, key, { value: walk(value[key]), enumerable: true, configurable: true, writable: true });
    return result;
  };
  return walk(state);
}
function assertDevToolsRecord(value) {
  const seen = new WeakSet, pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || isSharedCollection(item) || seen.has(item))
      continue;
    seen.add(item);
    if (Object.prototype.hasOwnProperty.call(item, "$jsan")) {
      throw new TypeError("zerocopy Redux: $jsan is reserved by DevTools; use createZerocopyCodec for this backup");
    }
    if (Array.isArray(item) || isPlainRecord(item))
      for (const child of Object.values(item))
        pending.push(child);
  }
}
function createZerocopyDevToolsOptions(options = {}) {
  const maxAge = options.maxAge ?? 50;
  if (!Number.isSafeInteger(maxAge) || maxAge < 2)
    throw new RangeError("DevTools maxAge must be at least 2");
  if (options.mode !== undefined && options.mode !== "summary" && options.mode !== "portable")
    throw new TypeError("Invalid DevTools mode");
  if (options.mode !== "portable")
    return { maxAge, stateSanitizer: summarizeZerocopyState, actionSanitizer: summarizeZerocopyState };
  const codec = options.codec ?? createZerocopyCodec();
  return {
    maxAge,
    serialize: {
      options: true,
      replacer(_key, value) {
        if (isSharedCollection(value))
          return codec.encode(value);
        if (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, "$jsan"))
          assertDevToolsRecord(value);
        if (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, "$zerocopyRedux")) {
          assertDevToolsRecord(value);
          return codec.encode(value);
        }
        return value;
      },
      reviver(_key, value) {
        if (isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, "$zerocopyRedux")) {
          const restored = codec.decode(value);
          assertDevToolsRecord(restored);
          return restored;
        }
        return value;
      }
    }
  };
}
export {
  bindRedux,
  createSharedMapValueSelector,
  createZerocopyCodec,
  createZerocopyDevToolsOptions,
  getZerocopyEntries,
  isSharedCollection,
  isZerocopySerializable,
  reduxSource,
  setSharedMapValue,
  summarizeZerocopyState,
  zerocopyMiddlewareOptions
};
