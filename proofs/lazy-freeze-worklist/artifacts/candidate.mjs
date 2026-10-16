// utf8.ts
var acceptsSharedInput = (() => {
  try {
    new TextDecoder().decode(new Uint8Array(new SharedArrayBuffer(1)));
    return true;
  } catch {
    return false;
  }
})();
function decodeUtf8(decoder, bytes) {
  const input = !acceptsSharedInput && bytes.buffer instanceof SharedArrayBuffer ? bytes.slice() : bytes;
  return decoder.decode(input);
}
var supportsEncodeInto = typeof TextEncoder.prototype.encodeInto === "function";

// freeze-json.ts
function freezeJSON(value) {
  if (value === null || typeof value !== "object")
    return value;
  let item = value;
  let todo;
  while (true) {
    if (Array.isArray(item)) {
      for (let i = 0;i < item.length; i++) {
        const child = item[i];
        if (child !== null && typeof child === "object")
          (todo ??= []).push(child);
      }
    } else {
      for (const child of Object.values(item)) {
        if (child !== null && typeof child === "object")
          (todo ??= []).push(child);
      }
    }
    Object.freeze(item);
    if (!todo?.length)
      break;
    item = todo.pop();
  }
  return value;
}

// types.ts
var STRUCTURE_TYPES = new Set(["SharedMap", "SharedSet", "SharedList", "SharedStack", "SharedQueue", "SharedLinkedList", "SharedDoublyLinkedList", "SharedOrderedMap", "SharedOrderedSet", "SharedSortedMap", "SharedSortedSet", "SharedPriorityQueue"]);
var SET_TYPES = new Set(["SharedSet", "SharedOrderedSet", "SharedSortedSet"]);
var nestedTypes = new Map;
var MAX_CACHED_TYPES = 256;
var MAX_CACHED_TYPE_LENGTH = 4096;
function primitive(type) {
  return type === "string" || type === "number" || type === "boolean" || type === "object";
}
function parseNestedType(type) {
  if (typeof type !== "string" || !type.startsWith("Shared"))
    return null;
  const cached = nestedTypes.get(type);
  if (cached)
    return cached;
  let start = 0, end = type.length, outerEnd = -1;
  let outer;
  for (;; ) {
    const open = type.indexOf("<", start);
    if (open < 0 || open >= end) {
      if (!primitive(type.slice(start, end)))
        return null;
      break;
    }
    if (type.charCodeAt(end - 1) !== 62)
      return null;
    const structure = type.slice(start, open);
    if (!STRUCTURE_TYPES.has(structure))
      return null;
    if (outer === undefined) {
      outer = structure;
      outerEnd = open;
    }
    start = open + 1;
    end--;
    if (SET_TYPES.has(structure)) {
      const leaf = type.slice(start, end);
      if (leaf !== "string" && leaf !== "number")
        return null;
      break;
    }
  }
  if (outer === undefined)
    return null;
  const info = Object.freeze({ structureType: outer, innerType: type.slice(outerEnd + 1, -1) });
  if (type.length <= MAX_CACHED_TYPE_LENGTH) {
    if (nestedTypes.size >= MAX_CACHED_TYPES)
      nestedTypes.delete(nestedTypes.keys().next().value);
    nestedTypes.set(type, info);
  }
  return info;
}

// codec.ts
var encoder = new TextEncoder;
var decoder = new TextDecoder;
function strLen(s) {
  let len = 0;
  for (let i = 0;i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128)
      len++;
    else if (c < 2048)
      len += 2;
    else if (c >= 55296 && c <= 56319 && s.charCodeAt(i + 1) >= 56320 && s.charCodeAt(i + 1) <= 57343) {
      len += 4;
      i++;
    } else
      len += 3;
  }
  return len;
}
var codecs = {
  string: {
    size: (v) => strLen(v),
    encode: (v, buf, ptr) => encoder.encodeInto(v, buf.subarray(ptr)).written,
    decode: (buf, ptr, len) => decodeUtf8(decoder, buf.subarray(ptr, ptr + len))
  },
  number: {
    size: () => 8,
    encode: (v, buf, ptr) => {
      new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setFloat64(ptr, v, true);
      return 8;
    },
    decode: (buf, ptr) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(ptr, true)
  },
  boolean: {
    size: () => 1,
    encode: (v, buf, ptr) => {
      buf[ptr] = v ? 1 : 0;
      return 1;
    },
    decode: (buf, ptr) => buf[ptr] === 1
  },
  object: {
    size: (v) => strLen(JSON.stringify(v)),
    encode: (v, buf, ptr) => encoder.encodeInto(JSON.stringify(v), buf.subarray(ptr)).written,
    decode: (buf, ptr, len) => freezeJSON(JSON.parse(decodeUtf8(decoder, buf.subarray(ptr, ptr + len))))
  }
};
var structureRegistry = {};
function createNestedCodec(structureType, innerType) {
  return {
    size: (v) => strLen(JSON.stringify({ __t: structureType, __i: innerType, __d: v.toWorkerData() })),
    encode: (v, buf, ptr) => {
      const json = JSON.stringify({ __t: structureType, __i: innerType, __d: v.toWorkerData() });
      return encoder.encodeInto(json, buf.subarray(ptr)).written;
    },
    decode: (buf, ptr, len) => {
      const { __t, __i, __d } = JSON.parse(decodeUtf8(decoder, buf.subarray(ptr, ptr + len)));
      const factory = structureRegistry[__t];
      if (!factory)
        throw new Error(`Unknown structure type: ${__t}`);
      return factory.fromWorkerData({ ...__d, valueType: __d.valueType ?? __i });
    }
  };
}
function getCodec(type) {
  if (type in codecs)
    return codecs[type];
  const nested = parseNestedType(type);
  if (nested)
    return createNestedCodec(nested.structureType, nested.innerType);
  throw new Error(`Unknown type: ${type}`);
}
export {
  freezeJSON,
  getCodec
};
