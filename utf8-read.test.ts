import { describe, expect, test, vi } from 'vitest';
import { decodeUtf8 } from './utf8';

const encoder = new TextEncoder(), nativeDecode = TextDecoder.prototype.decode;
function shared(bytes: Uint8Array): Uint8Array {
  const buffer = new SharedArrayBuffer(bytes.length + 11);
  new Uint8Array(buffer).fill(0xee);
  const view = new Uint8Array(buffer, 5, bytes.length); view.set(bytes);
  return view;
}
async function fallback(check: (decode: typeof decodeUtf8) => void): Promise<void> {
  vi.resetModules();
  // Fail only the import-time capability probe. Keep the real native decoder
  // so these tests also exercise the borrowed-buffer path on Node and Bun.
  vi.stubGlobal('SharedArrayBuffer', class { constructor() { throw new TypeError('Shared decoding probe unavailable'); } });
  try {
    const fresh = await import('./utf8');
    vi.unstubAllGlobals();
    check(fresh.decodeUtf8);
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
}

describe('bounded shared UTF-8 decoding', () => {
  test('preserves native Unicode, BOM, invalid-byte and streaming behavior', async () => {
    await fallback(decode => {
      const inputs = ['', 'ASCII\0text', '\ufeff界🙂', '\ud800', 'é'.repeat(32768), 'x'.repeat(65537)]
        .map(text => encoder.encode(text)).concat([Uint8Array.of(0xc3), Uint8Array.of(0xff, 0, 0x80)]);
      for (const bytes of inputs) for (const ignoreBOM of [false, true]) {
        const options = { ignoreBOM };
        expect(decode(new TextDecoder('utf-8', options), shared(bytes))).toBe(new TextDecoder('utf-8', options).decode(bytes));
      }
      const fatal = new TextDecoder('utf-8', { fatal: true });
      expect(() => decode(fatal, shared(Uint8Array.of(0xc3)))).toThrow(TypeError);
      expect(decode(fatal, shared(encoder.encode('after🙂')))).toBe('after🙂');
      const streaming = new TextDecoder();
      streaming.decode(Uint8Array.of(0xe2), { stream: true });
      expect(decode(streaming, shared(Uint8Array.of(0x82, 0xac)))).toBe('€');
    });
  });

  test('reuses one bounded ordinary buffer and copies oversized inputs independently', async () => {
    await fallback(decode => {
      const short = shared(encoder.encode('界🙂')), boundary = shared(encoder.encode('x'.repeat(65536)));
      const large = shared(encoder.encode('y'.repeat(65537))), buffers = new Set<ArrayBufferLike>();
      const set = Uint8Array.prototype.set;
      const copying = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (source, offset) {
        buffers.add(this.buffer); return Reflect.apply(set, this, [source, offset]);
      });
      const slicing = vi.spyOn(Uint8Array.prototype, 'slice');
      try {
        for (let i = 0; i < 3; i++) expect(decode(new TextDecoder(), short)).toBe('界🙂');
        expect(decode(new TextDecoder(), boundary)).toHaveLength(65536);
        expect(slicing).not.toHaveBeenCalled(); expect(buffers.size).toBe(1);
        expect([...buffers][0]).toBeInstanceOf(ArrayBuffer); expect([...buffers][0].byteLength).toBe(65536);
        expect(decode(new TextDecoder(), large)).toHaveLength(65537);
        expect(slicing).toHaveBeenCalledTimes(1);
      } finally { copying.mockRestore(); slicing.mockRestore(); }
    });
  });

  test('copies before a reentrant decoder getter and reads that getter once', async () => {
    await fallback(decode => {
      for (const text of ['outer界', 'outer界'.repeat(12000)]) {
        const bytes = shared(encoder.encode(text)), inner = shared(encoder.encode('inner🙂'));
        const decoder = new TextDecoder(), nested = new TextDecoder(); let getters = 0;
        Object.defineProperty(nested, 'decode', { get() { inner.fill(0x78); return nativeDecode; } });
        Object.defineProperty(decoder, 'decode', { get() {
          getters++; expect(decode(nested, inner)).toBe('inner🙂');
          bytes.fill(0x78); return nativeDecode;
        } });
        expect(decode(decoder, bytes)).toBe(text); expect(getters).toBe(1);
      }
    });
  });

  test('custom decoders receive independently retained bytes and the original receiver', async () => {
    await fallback(decode => {
      const decoder = new TextDecoder(), retained: Uint8Array[] = [];
      Object.defineProperty(decoder, 'decode', { value: function (input: Uint8Array) {
        expect(this).toBe(decoder); retained.push(input);
        expect(decode(new TextDecoder(), shared(encoder.encode('nested')))).toBe('nested');
        return Reflect.apply(nativeDecode, this, [input]);
      } });
      for (const text of ['first🙂', 'second', 'x'.repeat(65537)]) expect(decode(decoder, shared(encoder.encode(text)))).toBe(text);
      expect(decode(new TextDecoder(), shared(encoder.encode('overwrite scratch')))).toBe('overwrite scratch');
      expect(retained.map(bytes => new TextDecoder().decode(bytes))).toEqual(['first🙂', 'second', 'x'.repeat(65537)]);
      expect(new Set(retained.map(bytes => bytes.buffer)).size).toBe(3);
    });
  });

  test('releases borrowed storage after native, getter and custom decoder errors', async () => {
    await fallback(decode => {
      const bytes = shared(encoder.encode('kept')), error = new Error('decoder failed');
      const getter = new TextDecoder(); Object.defineProperty(getter, 'decode', { get() { throw error; } });
      const custom = new TextDecoder(); let retained: Uint8Array;
      Object.defineProperty(custom, 'decode', { value(input: Uint8Array) { retained = input; throw error; } });
      expect(() => decode(getter, bytes)).toThrow(error); expect(() => decode(custom, bytes)).toThrow(error);
      expect(() => decode(new TextDecoder('utf-8', { fatal: true }), shared(Uint8Array.of(0xff)))).toThrow(TypeError);
      const slicing = vi.spyOn(Uint8Array.prototype, 'slice');
      try { expect(decode(new TextDecoder(), bytes)).toBe('kept'); expect(slicing).not.toHaveBeenCalled(); }
      finally { slicing.mockRestore(); }
      expect(new TextDecoder().decode(retained!)).toBe('kept');
    });
  });

  test('passes ordinary input through to custom decoders unchanged', () => {
    const bytes = encoder.encode('ordinary'); let calls = 0;
    const custom = { decode(input: Uint8Array) { calls++; expect(input).toBe(bytes); return 'custom'; } } as unknown as TextDecoder;
    expect(decodeUtf8(custom, bytes)).toBe('custom'); expect(calls).toBe(1);
  });
});
