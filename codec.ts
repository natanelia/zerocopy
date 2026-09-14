import { decodeUtf8 } from './utf8';
// Shared codec utilities for encoding/decoding values
import type { ValueOf, PrimitiveType } from './types.ts';
import { parseNestedType } from './types.ts';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export type Codec<T> = {
  size: (v: T) => number;
  encode: (v: T, buf: Uint8Array, ptr: number) => number;
  decode: (buf: Uint8Array, ptr: number, len: number) => T;
};

function strLen(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) len++;
    else if (c < 2048) len += 2;
    else if (c >= 0xd800 && c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { len += 4; i++; }
    else len += 3;
  }
  return len;
}

function freezeDecoded(value: any): any {
  if (value === null || typeof value !== 'object') return value;
  const todo = [value];
  while (todo.length) {
    const item = todo.pop();
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') todo.push(child);
    Object.freeze(item);
  }
  return value;
}

export const codecs: Record<PrimitiveType, Codec<any>> = {
  string: {
    size: (v: string) => strLen(v),
    encode: (v: string, buf: Uint8Array, ptr: number) => encoder.encodeInto(v, buf.subarray(ptr)).written!,
    decode: (buf: Uint8Array, ptr: number, len: number) => decodeUtf8(decoder, buf.subarray(ptr, ptr + len)),
  },
  number: {
    size: () => 8,
    encode: (v: number, buf: Uint8Array, ptr: number) => { new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setFloat64(ptr, v, true); return 8; },
    decode: (buf: Uint8Array, ptr: number) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(ptr, true),
  },
  boolean: {
    size: () => 1,
    encode: (v: boolean, buf: Uint8Array, ptr: number) => { buf[ptr] = v ? 1 : 0; return 1; },
    decode: (buf: Uint8Array, ptr: number) => buf[ptr] === 1,
  },
  object: {
    size: (v: object) => strLen(JSON.stringify(v)),
    encode: (v: object, buf: Uint8Array, ptr: number) => encoder.encodeInto(JSON.stringify(v), buf.subarray(ptr)).written!,
    decode: (buf: Uint8Array, ptr: number, len: number) => freezeDecoded(JSON.parse(decodeUtf8(decoder, buf.subarray(ptr, ptr + len)))),
  },
};

// Registry for nested structure reconstruction - populated by each structure module
export const structureRegistry: Record<string, {
  fromWorkerData: (data: any, arena?: any) => any;
}> = {};

export function createNestedCodec(structureType: string, innerType: string): Codec<any> {
  return {
    size: (v: any) => strLen(JSON.stringify({ __t: structureType, __i: innerType, __d: v.toWorkerData() })),
    encode: (v: any, buf: Uint8Array, ptr: number) => {
      const json = JSON.stringify({ __t: structureType, __i: innerType, __d: v.toWorkerData() });
      return encoder.encodeInto(json, buf.subarray(ptr)).written!;
    },
    decode: (buf: Uint8Array, ptr: number, len: number) => {
      const { __t, __i, __d } = JSON.parse(decodeUtf8(decoder, buf.subarray(ptr, ptr + len)));
      const factory = structureRegistry[__t];
      if (!factory) throw new Error(`Unknown structure type: ${__t}`);
      return factory.fromWorkerData({ ...__d, valueType: __d.valueType ?? __i });
    },
  };
}

export function getCodec<T extends string>(type: T): Codec<ValueOf<T>> {
  if (type in codecs) return codecs[type as PrimitiveType];
  const nested = parseNestedType(type);
  if (nested) return createNestedCodec(nested.structureType, nested.innerType);
  throw new Error(`Unknown type: ${type}`);
}
