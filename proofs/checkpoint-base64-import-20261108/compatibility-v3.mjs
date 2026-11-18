import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run in a fresh process for each mode so the optional method is captured only
// after the desired environment is installed. This is correctness, not timing.
const [beforeArg, afterArg, mode = 'auto'] = process.argv.slice(2);
assert.ok(beforeArg && afterArg);
assert.ok(['auto', 'buffer', 'buffer-offset', 'portable-missing', 'portable-noncallable'].includes(mode));
const before = resolve(beforeArg), after = resolve(afterArg);
const original = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
const originalBuffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
const native = Uint8Array.fromBase64;
const actualBuffer = globalThis.Buffer, actualBufferFrom = actualBuffer?.from;
let nativeCalls = 0, bufferCalls = 0, maximumByteOffset = 0;
const selected = mode.startsWith('portable-') ? 'portable' : mode === 'auto' && typeof native === 'function' ? 'Uint8Array' : 'Buffer';
if (selected === 'Uint8Array') {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    configurable: true, writable: true, value: function (text) {
      assert.strictEqual(this, Uint8Array); nativeCalls++;
      return Reflect.apply(native, this, [text]);
    },
  });
  // The preferred standard API must not inspect an optional Buffer fallback.
  Object.defineProperty(globalThis, 'Buffer', { configurable: true, get() { throw new Error('Buffer should not be read when the standard API is available'); } });
} else {
  Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, writable: true,
    value: mode === 'portable-noncallable' || mode === 'buffer' ? 7 : undefined });
  if (selected === 'Buffer') {
    assert.equal(typeof actualBufferFrom, 'function');
    const installedBuffer = { from(text, encoding) {
      assert.strictEqual(this, installedBuffer); assert.equal(encoding, 'base64'); bufferCalls++;
      const bytes = Reflect.apply(actualBufferFrom, actualBuffer, [text, encoding]);
      if (mode !== 'buffer-offset') return bytes;
      const padded = actualBuffer.alloc(bytes.length + 37, 0xa7); padded.set(bytes, 17);
      const view = padded.subarray(17, 17 + bytes.length); maximumByteOffset = Math.max(maximumByteOffset, view.byteOffset);
      return view;
    } };
    Object.defineProperty(globalThis, 'Buffer', { configurable: true, writable: true, value: installedBuffer });
  } else Object.defineProperty(globalThis, 'Buffer', { configurable: true, writable: true,
    value: mode === 'portable-noncallable' ? { from: 7 } : undefined });
}
const B = await import(pathToFileURL(join(before, 'dist/redux.js')));
const A = await import(pathToFileURL(join(after, 'dist/redux.js')));
const S = await import(pathToFileURL(join(before, 'dist/shared.js')));
if (original) Object.defineProperty(Uint8Array, 'fromBase64', original); else delete Uint8Array.fromBase64;
if (originalBuffer) Object.defineProperty(globalThis, 'Buffer', originalBuffer); else delete globalThis.Buffer;
const cases = [];
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const clone = packet => JSON.parse(JSON.stringify(packet));
const errorOf = run => {
  try { run(); return null; }
  catch (error) { return { name: error.name, message: error.message }; }
};
const packets = new Map();
for (let length = 0; length < 24 && packets.size < 3; length++) {
  const value = '\0\u007f\u0080街道🙂' + 'x'.repeat(length);
  const packet = B.encodeZerocopyState(new S.SharedList('string').push(value));
  packets.set(packet.arenas[0].used % 3, { packet, value });
}
assert.deepEqual([...packets.keys()].sort(), [0, 1, 2]);
for (const [remainder, { packet, value }] of packets) {
  assert.deepEqual(B.decodeZerocopyState(packet).toArray(), [value]);
  assert.deepEqual(A.decodeZerocopyState(packet).toArray(), [value]);
  cases.push({ name: `padding-${remainder}`, status: 'passed' });
  if (remainder) {
    const p = clone(packet), text = p.arenas[0].base64;
    const index = text.length - (remainder === 1 ? 3 : 2);
    p.arenas[0].base64 = text.slice(0, index) + alphabet[alphabet.indexOf(text[index]) | 1] + text.slice(index + 1);
    assert.deepEqual(B.decodeZerocopyState(p).toArray(), [value]);
    assert.deepEqual(A.decodeZerocopyState(p).toArray(), [value]);
    cases.push({ name: `unused-padding-bits-${remainder}`, status: 'passed' });
  }
}
const sample = packets.get(1).packet;
const invalid = [
  ['space', arena => { arena.base64 = ' ' + arena.base64.slice(1); }],
  ['newline', arena => { arena.base64 = '\n' + arena.base64.slice(1); }],
  ['url-safe-minus', arena => { arena.base64 = '-' + arena.base64.slice(1); }],
  ['url-safe-underscore', arena => { arena.base64 = '_' + arena.base64.slice(1); }],
  ['unicode', arena => { arena.base64 = 'é' + arena.base64.slice(1); }],
  ['interior-padding', arena => { arena.base64 = arena.base64.slice(0, 9) + '=' + arena.base64.slice(10); }],
  ['truncated', arena => { arena.base64 = arena.base64.slice(0, -1); }],
  ['extra-padding', arena => { arena.base64 = arena.base64.slice(0, -3) + '==='; }],
  ['decoded-length', arena => { arena.base64 = arena.base64.replace(/=/g, 'A'); }],
  ['record-length', arena => { arena.used++; }],
  ['checksum', arena => { arena.checksum = (arena.checksum + 1) >>> 0; }],
];
for (const [name, change] of invalid) {
  const packet = clone(sample); change(packet.arenas[0]);
  const expected = errorOf(() => B.decodeZerocopyState(packet));
  const actual = errorOf(() => A.decodeZerocopyState(packet));
  assert.ok(expected); assert.deepEqual(actual, expected);
  cases.push({ name, error: actual, status: 'passed' });
}

// Direct API inputs can have getters. Preserve the portable coercions if a
// later read returns a String object after initial primitive-string validation.
function coerciblePacket() {
  const packet = clone(sample), arena = packet.arenas[0], text = arena.base64, log = [];
  let reads = 0;
  const value = { get length() { log.push('length'); return text.length; },
    toString() { log.push('toString'); return text; } };
  Object.defineProperty(arena, 'base64', { enumerable: true, get() { log.push(`base64-${++reads}`); return reads === 1 ? text : value; } });
  return { packet, log };
}
const first = coerciblePacket(), second = coerciblePacket();
assert.deepEqual(A.decodeZerocopyState(second.packet).toArray(), B.decodeZerocopyState(first.packet).toArray());
assert.deepEqual(second.log, first.log);
cases.push({ name: 'dynamic-coercible-base64', log: second.log, status: 'passed' });

assert.equal(nativeCalls > 0, selected === 'Uint8Array');
assert.equal(bufferCalls > 0, selected === 'Buffer');
if (mode === 'buffer-offset') assert.equal(maximumByteOffset, 17);
console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, mode,
  nativeAvailable: typeof native === 'function', bufferAvailable: typeof actualBufferFrom === 'function', selected,
  nativeCalls, bufferCalls, maximumByteOffset, cases }, null, 2));
