import { expect, test, vi } from 'vitest';
import { Arena } from './arena';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';

const encoder = new TextEncoder();
const nativeDecode = TextDecoder.prototype.decode;
const reference = new TextDecoder('utf-8', { ignoreBOM: true });
function ascii(length: number): string {
  return String.fromCharCode(...Array.from({ length }, (_, i) => (i * 37 + length * 11) & 127));
}
function record(arena: Arena, bytes: Uint8Array): [number, number] {
  const pointer = arena.alloc(Math.max(1, bytes.length));
  arena.buf.set(bytes, pointer);
  return [pointer, bytes.length];
}

for (const copy of [false, true]) test(`ordinary string values and map keys preserve ASCII boundaries (copy=${copy})`, async () => {
  const values = Array.from({ length: 41 }, (_, length) => ascii(length));
  const list = new SharedList('string').pushMany(values);
  const map = new SharedMap('number').setMany(values.map((value, i) => [value, i] as const));
  const attached = await initWorker<{ list: typeof list; map: typeof map }>(getWorkerData({ list, map }, { copy }));
  for (const reader of [list, attached.list]) {
    for (let pass = 0; pass < 2; pass++) values.forEach((value, i) => expect(reader.get(i)).toBe(value));
  }
  for (const reader of [map, attached.map]) {
    const keys = [...reader.keys()];
    expect(keys).toHaveLength(values.length);
    expect(new Set(keys)).toEqual(new Set(values));
  }
});

test('unaligned strings and scalar tails stop at the end of shared memory', () => {
  const arena = new Arena(), end = arena.buf.length;
  for (let length = 35; length >= 0; length--) {
    const text = ascii(length), pointer = end - length;
    arena.buf.set(encoder.encode(text), pointer);
    expect(arena.string(pointer, length)).toBe(text);
  }
});

test('Unicode, BOM and malformed UTF-8 use the entire original byte range', () => {
  const arena = new Arena();
  const endings = [
    [0xc3, 0xa9, 0x7a], [0xef, 0xbb, 0xbf], [0xf0, 0x9f, 0x99, 0x82],
    [0xff], [0xc3], [0xe2, 0x82], [0x80, 0, 0x7a],
  ];
  for (let prefix = 0; prefix < 32; prefix++) for (const ending of endings) {
    const bytes = Uint8Array.from([...Array<number>(prefix).fill(0x61), ...ending]);
    expect(arena.string(...record(arena, bytes))).toBe(reference.decode(bytes));
  }
});

test('empty ranges, cached values and reentrant decoder overrides keep their behavior', () => {
  const arena = new Arena();
  const asciiText = 'ASCII\0with\ttail', outerText = 'abcdefghé\ufeff🙂tail', innerText = 'nested界';
  const asciiRecord = record(arena, encoder.encode(asciiText));
  const outer = record(arena, encoder.encode(outerText)), inner = record(arena, encoder.encode(innerText));
  const retained: ArrayBufferView[] = [], receivers: TextDecoder[] = [];
  let reentered = false;
  const decode = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (input, options) {
    expect(ArrayBuffer.isView(input)).toBe(true);
    retained.push(input as ArrayBufferView); receivers.push(this);
    if (!reentered) {
      reentered = true;
      expect(arena.string(...inner)).toBe(innerText);
      arena.memory.grow(1);
    }
    return Reflect.apply(nativeDecode, this, [input, options]);
  });
  try {
    expect(arena.string(...asciiRecord)).toBe(asciiText);
    expect(decode).not.toHaveBeenCalled();
    expect(arena.string(outer[0], 0)).toBe('');
    expect(arena.string(...outer)).toBe(outerText);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(arena.string(...outer)).toBe(outerText);
    expect(arena.string(...inner)).toBe(innerText);
    expect(arena.string(outer[0], 0)).toBe('');
    expect(decode).toHaveBeenCalledTimes(2);
    expect(receivers[0]).toBe(receivers[1]);
    expect(retained.map(bytes => Reflect.apply(nativeDecode, reference, [bytes]))).toEqual([outerText, innerText]);
  } finally { decode.mockRestore(); }
});

test('failed decoding is not cached and the string-entry cache remains bounded', () => {
  const arena = new Arena(), bytes = encoder.encode('abcdé'), entry = record(arena, bytes);
  const failure = new Error('decoder failure');
  const throwing = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => { throw failure; });
  try { expect(() => arena.string(...entry)).toThrow(failure); }
  finally { throwing.mockRestore(); }
  expect(arena.string(...entry)).toBe('abcdé');

  const full = new Arena();
  for (let i = 0; i < 2048; i++) expect(full.string(...record(full, encoder.encode('abcd')))).toBe('abcd');
  const uncached = record(full, bytes), decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    expect(full.string(...uncached)).toBe('abcdé');
    expect(full.string(...uncached)).toBe('abcdé');
    expect(decode).toHaveBeenCalledTimes(2);
  } finally { decode.mockRestore(); }
});
