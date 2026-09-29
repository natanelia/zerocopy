/** The actual WASM must not read past a string ending at the memory boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const module = new WebAssembly.Module(readFileSync(process.env.TEXT_KERNEL_ENTRY ?? new URL('../persistent-core.wasm', import.meta.url)));

test('packed text search is read-only and bounded at every final memory byte', () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const { textContains16 } = new WebAssembly.Instance(module, { env: { memory } }).exports;
  assert.equal(typeof textContains16, 'function');
  const bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
  const encoder = new TextEncoder();
  for (let length = 1; length <= 16; length++) {
    const needle = 'a'.repeat(length - 1) + 'b';
    for (const sensitive of [true, false]) {
      const word = new Uint32Array(4), mask = new Uint32Array(4);
      for (let i = 0; i < length; i++) {
        word[i >>> 2] |= needle.charCodeAt(i) << ((i & 3) * 8);
        if (!sensitive) mask[i >>> 2] |= 32 << ((i & 3) * 8);
      }
      for (let offset = 0; offset < 32; offset++) {
        for (const input of ['', 'a'.repeat(offset), 'x'.repeat(offset) + needle, 'x'.repeat(offset) + needle.toUpperCase(), needle + 'x'.repeat(offset)]) {
          const encoded = encoder.encode(input), raw = bytes.length - encoded.length - 4;
          view.setUint32(raw, encoded.length, true); bytes.set(encoded, raw + 4);
          const before = bytes.slice(raw);
          assert.equal(textContains16(raw, length, ...word, ...mask, !sensitive) !== 0,
            (sensitive ? input : input.toLowerCase()).includes(needle), JSON.stringify({ input, needle, sensitive }));
          assert.deepEqual(bytes.subarray(raw), before);
        }
      }
    }
  }
  // Invalid lengths return before any header read, rather than touching memory.
  assert.equal(textContains16(bytes.length, 0, 0,0,0,0, 0,0,0,0, false), -1);
  assert.equal(textContains16(bytes.length, 17, 0,0,0,0, 0,0,0,0, false), -1);
});
